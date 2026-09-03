# Writing an analyzer

An analyzer adds support for a language. It owns parsing, type resolution (if the language
has types), and rule execution; the core owns everything else — configuration, file
discovery, routing, reporting, the git backstop, and the MCP server. This document describes
the contract an analyzer must satisfy, written so a third party can implement one without
reading checkyourvibe's own source.

The contract has two parts: a static manifest the core reads at startup, and a
request/response exchange the core drives at check time.

## The static manifest

Every analyzer ships a JSON file, conventionally `analyzer.manifest.json` at the package
root, describing the analyzer without running any of its code. The core's registry resolves
an analyzer's `package` entry from `checkyourvibe.json` (either a path to this file, a path to
a directory containing it, or an installed package name) and reads it as plain JSON — it is
never imported or executed to be inspected.

The manifest's shape, in TypeScript, is:

```ts
interface AnalyzerManifest {
  protocol: 1;
  id: string;
  match: string[];
  exclude?: string[];
  rules: RuleManifest[];
  capabilities?: { session?: boolean }; // reserved, unused today
  exec:
    | { type: 'node'; module: string }
    | { type: 'process'; command: string; args?: string[] };
}
```

- `protocol` is the version of this contract. It is `1` today.
- `id` is the analyzer's identifier. It must match the `id` a user configures for it in
  `checkyourvibe.json`; a mismatch is a configuration error.
- `match` and `exclude` are glob patterns, relative to the repository root, that decide which
  files route to this analyzer. A file matching more than one analyzer's `match` globs is a
  configuration error — the core will not silently pick a winner.
- `rules` is the full list of this analyzer's rule manifests (see `rule-manifest.schema.json`
  in `docs/protocol/` for the shape of one rule). This is how `cyv explain`, the rule table in
  generated agent guidance, and `cyv init`'s plan all learn what rules exist, without ever
  starting your analyzer.
- `exec` says how the core reaches your analyzer at check time. See the next section.

### Why the manifest must be readable without executing anything

`cyv explain <rule-id>`, agent-glue generation, and the `cyv init` plan all need rule metadata
long before any file is actually analyzed — sometimes for an analyzer nobody has configured
yet, as part of `cyv verify-analyzer` (below). None of those operations should have to pay the
cost of booting a JVM, a .NET runtime, or a native toolchain, and none of them should have to
trust arbitrary analyzer code just to answer "what rules does this have." Keeping the manifest
static — plain JSON, no code path that runs to produce it — is what makes that possible.

## The request/response contract

At check time, the core builds an `AnalyzeRequest` and expects an `AnalyzeResponse` back. Both
shapes are published as JSON Schemas in `docs/protocol/` (`analyze-request.schema.json`,
`analyze-response.schema.json`, referencing `rule-manifest.schema.json` and
`violation.schema.json`), and the corresponding TypeScript types live in
`packages/core/src/protocol/analyzer.ts`, `violation.ts`, and `rule-manifest.ts`.

```ts
interface AnalyzeRequest {
  protocol: 1;
  repoRoot: string;
  mode: 'file' | 'project';
  files: string[];                                    // absolute paths
  rules: Record<string, { severity: 'error' | 'warning' } & Record<string, unknown>>;
  options?: Record<string, unknown>;
}

interface AnalyzeResponse {
  protocol: 1;
  violations: Violation[];
  skipped: SkippedFile[];
  diagnostics: Diagnostic[];
  degraded?: DegradedResolution[];
}
```

`mode` matters: `file` means the core only wants file-scope rules run, because it is checking
one file at a time (an editor hook, an explicit path). `project` means project-scope rules —
the ones that need the whole tree, such as a cross-file check — should run too. `rules` is
already filtered to the enabled set; if a rule id is not a key in `rules`, do not run it.

### Both exec shapes, and when to pick each

An analyzer can be reached two ways, and both must satisfy the identical request/response
schemas — an analyzer that supports both should produce byte-for-byte-equivalent results
either way.

**`{ type: 'node', module: '<specifier>' }`** — the core imports `module` into its own process
and calls its default export, an `AnalyzeFn`:

```ts
type AnalyzeFn = (request: AnalyzeRequest) => Promise<AnalyzeResponse>;
```

```js
// analyzer.mjs — the whole entry point contract for exec.type 'node'
export default async function analyze(request) {
  return { protocol: 1, violations: [], skipped: [], diagnostics: [] };
}
```

Nothing is spawned. The request arrives as the function's argument and the response is the
promise's value. Your module is never sent a request on stdin, and its stdout is not read for a
response — those belong to the subprocess shape described below. A module that reads stdin at
import time blocks on input that is never written: the import never settles, so the run stops with
no error and no output. Keep import-time work to what the module needs in order to define its
function.

This path has no serialization cost, and it is the only path `--watch` uses, because it lets
the analyzer hold state (a parsed project, a warm type checker) between runs instead of paying
startup cost on every keystroke. Use it when your analyzer is already a Node module — this is
what makes it worth choosing over the subprocess path, not a general preference.

The value of `module` is interpreted once, when the manifest is read:

- `./dist/index.js` or `../shared/index.js` — resolved against **the directory holding the
  manifest**, not the repository being checked. An installed analyzer package is not inside the
  repository, so its own directory is the only base that means the same thing everywhere.
  Resolution happens in the registry loader, before the analyzer is ever invoked, and the
  absolute result is what the runner imports.
- An absolute path, or a `file:` URL — used as written.
- Anything else (`@scope/pkg/dist/index.js`, `my-analyzer`) — a package specifier, handed to Node
  unchanged and therefore resolved from the checkyourvibe core package's own location, not from
  your manifest and not from the repository. Prefer a `./`-relative path, which does not depend
  on where the core happens to be installed.

The module must be loadable as ESM, because the core reaches it with a dynamic `import()`. A
CommonJS file works if Node can interoperate with it; the default export is then `module.exports`.

**`{ type: 'process', command: '<command>', args?: string[] }`** — the core spawns `command`
(with `args`), writes the `AnalyzeRequest` as JSON to its stdin, and reads an `AnalyzeResponse`
as JSON from its stdout. This is the shape to pick for any language that isn't Node — a
Roslyn-based analyzer, one built on libclang, or anything else that can read a line of JSON
from stdin and write one to stdout qualifies, without the core needing to know anything about
that runtime. Anything the process writes to stderr is captured as diagnostics rather than
discarded, so use stderr for logging you want surfaced, not for the response itself — the
response is stdout only.

If your analyzer returns something that doesn't parse as a well-formed `AnalyzeResponse`, the
core treats that as an internal error: it exits with code 2 and names your analyzer. This is
deliberate and not negotiable — a response the core cannot read means files whose results are
unknown, and silently treating that as a clean pass is the exact failure this project exists
to prevent. Malformed output is a hard stop, not something to coerce into an empty result.

### Skipped files are part of the contract

`AnalyzeResponse.skipped` is not a log — it is how an analyzer tells the core "I could not
check this file," as a first-class fact rather than an omission:

```ts
interface SkippedFile {
  file: string;
  reason: string;
}
```

A file your analyzer silently drops is a file nobody actually checked, and a report that comes
back clean over unchecked files is worse than no report at all — it tells the user everything
is fine when nothing was verified. Report every file you could not process here, with a
reason a human can act on (parse failure, unsupported syntax, missing project configuration).
The core lists these in its output, and under `--strict` a non-empty `skipped` list is treated
as a failing run.

### Degraded resolution: saying when the type graph is not the real one

An analyzer that resolves types, symbols, or imports has to say when it resolved them with
something other than the project's own configuration. That is what `AnalyzeResponse.degraded` is
for:

```ts
interface DegradedResolution {
  files: string[]; // absolute paths
  reason: string;
}
```

The core keys off it directly. For each file listed, it withholds every violation whose rule does
not declare `evidence: 'syntax'`, counts what it withheld, and prints your `reason` — so the user
sees "these findings were held back, and here is what to fix" instead of a confident list built on
types nobody resolved. An analyzer that never populates `degraded` gets none of that: its semantic
findings are trusted unconditionally.

**Not requiring a project file and reporting degraded resolution are different obligations.** An
analyzer must be able to analyse a single file with no project or solution file, because editor
hooks invoke it on one path at a time. Analysing one file in isolation and finding that some
external types are not visible is that mode working as intended, not a degraded run. What must be
reported is narrower: the analyzer resolved with something the project did not specify, or its
toolchain told it that a reference it needed did not resolve.

Three outcomes, and the line between them:

1. **`skipped`** — no model at all. The file could not be read or parsed, or the type system itself
   is unusable (the standard library could not be located, so nothing would resolve). Nothing was
   checked, and the response says so per file.
2. **`degraded`** — a model exists, but not the one the code actually needs. The analyzer
   substituted a configuration the project did not specify (no project file found, one that could
   not be parsed, an invented default set of options), or the toolchain reported that a type,
   namespace, or assembly the file depends on did not resolve. Keep analysing: syntax rules still
   run and their findings are still reported. Listing a file here is not a reason to drop it to
   `skipped`, which would discard sound syntax findings to avoid an unsound semantic one.
3. **Neither** — one construct inside an otherwise resolved file whose type the analyzer could not
   determine. The rule that needed that type declines to evaluate that construct and records a
   `diagnostics` entry naming the rule, the location, and the fact that it was not evaluated. One
   unresolvable node is a statement about that node, not about the file's configuration, so it does
   not degrade the file — and it does not become a finding either, because a finding derived from
   an error type is a guess.

Granularity is per file, grouped by shared `reason`. Report the whole request only when the failure
really is request-wide — a reference failure with no source location, a missing standard library.
The `reason` names what was missing and what would fix it. The TypeScript analyzer's is the
standard to match:

> No usable tsconfig.json governs these files (none found, or the nearest one is solution-style).
> Analysed with default compiler options, so inferred-type findings may be unreliable.

The two analyzers in this repository that resolve types apply the line like this — the Python,
Rust, and comment analyzers are syntax-only end to end and report no degradation at all:

- **TypeScript** groups the requested files by the tsconfig that governs each one, resolved from
  each file's own directory. A file with a real governing config is not degraded. A file with none
  — no tsconfig found, or the nearest is solution-style and neither its referenced projects nor a
  sibling base config covers the file — is analysed with default compiler options and reported as
  degraded, with every file in that group sharing the one reason. Degradation is decided by which
  configuration was used, not by counting unresolved imports.
- **C#** reads no project file at all: it compiles the request's files together against the .NET
  runtime's trusted platform assemblies. Single-file analysis is therefore its normal mode, and a
  file using only base class library types is not degraded. A file for which the compiler reports
  an unresolved type, namespace, or assembly reference is, and a reference failure with no source
  location degrades every file in the request. If the standard library cannot be located, every
  file is `skipped` instead. Below all that, a cast whose operand or target type did not resolve is
  left unevaluated by `no-unchecked-cast`, with a diagnostic naming the line.

A rule declaring `evidence: 'semantic'` in its manifest is a claim that the finding rests on real
resolution, so declaring it takes on this obligation for every file that rule can run against. An
analyzer with no reduced mode — nothing in its resolution model can vary, because it never resolves
external configuration — has nothing to report here, and reporting nothing is the complete answer
for it.

### Guidance is attached by the core — analyzers must not populate it

`Violation.guidance` exists on the `Violation` type, but an analyzer must never set it:

```ts
interface Violation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  ruleId: string;
  message: string;
  snippet: string;
  severity: 'error' | 'warning';
  guidance?: RuleGuidance; // populated by the core, not by analyzers
}
```

Report the fact — which rule, where, what the offending text was, and a `message` describing
the specific problem at that location. The core looks up your rule's manifest by `ruleId` and
attaches its `RuleGuidance` (summary, why, allowed fixes, not-fixes, examples) after your
analyzer returns. Leaving `guidance` unset in every response you produce is what guarantees
the same rule always explains itself identically, whether the violation surfaced in the
terminal, an agent hook, or the MCP server, and regardless of which analyzer found it. An
analyzer that invented its own wording here would make that guarantee false.

## The conformance suite

`cyv verify-analyzer <path>` exercises an analyzer against a scripted set of requests and
validates every response against the published schemas — including malformed-input and
skipped-file cases — without that analyzer needing to appear in any `checkyourvibe.json`. This
is the intended way to check a new analyzer implementation before wiring it into a real
project: point it at your manifest, and it tells you where your responses deviate from the
contract described above.

## A minimal worked example

The following is pseudocode for a subprocess analyzer (`exec.type: 'process'`) in a
non-Node language. It implements exactly one rule, ignores project-scope entirely, and skips
any file it cannot read — which is enough to satisfy the contract, if not to be useful.

```
# analyzer entry point, invoked as: mylang-analyzer

function main():
    request_text = read_all(stdin)
    request = parse_json(request_text)

    violations = []
    skipped = []
    diagnostics = []

    if request.rules does not contain "no-todo-comment":
        write_json(stdout, {
            protocol: 1,
            violations: [],
            skipped: [],
            diagnostics: [],
        })
        return

    for file_path in request.files:
        try:
            source = read_file(file_path)
        catch error:
            skipped.append({ file: file_path, reason: describe(error) })
            continue

        for line_number, line_text in enumerate(split_lines(source), start=1):
            offset = index_of(line_text, "TODO")
            if offset >= 0:
                violations.append({
                    file: file_path,
                    line: line_number,
                    column: offset + 1,
                    ruleId: "no-todo-comment",
                    message: "TODO comment left in committed source.",
                    snippet: truncate(trim(line_text), 200),
                    severity: request.rules["no-todo-comment"].severity,
                    # no "guidance" key: the core attaches it, not this analyzer
                })

    write_json(stdout, {
        protocol: 1,
        violations: violations,
        skipped: skipped,
        diagnostics: diagnostics,
    })

main()
```

The matching `analyzer.manifest.json` for this analyzer would declare the same rule's full
manifest (`id`, `category`, `scope`, `severity`, `summary`, `why`, `allowedFixes`, `notFixes`,
`examples`, and an optional `optionsSchema`) alongside:

```json
{
  "protocol": 1,
  "id": "mylang",
  "match": ["**/*.mylang"],
  "rules": [ /* ... the no-todo-comment rule manifest ... */ ],
  "exec": { "type": "process", "command": "mylang-analyzer" }
}
```
