# 0021 — Go analyzer: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

A fifth analyzer, for Go, on `go/ast` and `go/types` — both standard library, so parsing needs no
third-party dependency the way the C# analyzer needs Roslyn's package or the way most non-trivial Go
tooling needs `golang.org/x/tools`. The roadmap calls Go "the strongest candidate after the four that
exist," and names the reason precisely: unlike Rust, the Go compiler does not stop you dropping an
error. Rust's analyzer taught this project that a rule pack can be honest and still be thin, because
the compiler already refused most of what the pack would otherwise catch. Go inverts that condition —
the language has a real, well-known set of escape hatches and a compiler that is deliberately silent
about most of them — so the question this spec has to answer is not "does the rule model fit," it is
"which of these four rules is `go/ast` alone enough for, and which one is the reason `go/types` needs
to be here at all."

**Not verified on this machine before writing this spec.** 0004 opened by recording that .NET was
installed and `dotnet new console` worked before a line of C# spec was written. This spec cannot make
the same claim: `go` is not on this machine's `PATH`. Every factual claim below about `go vet`'s
default analyzers and about `go/types`' package-scoped checking is drawn from the documented behavior
of the toolchain, not from running it here. Requirement 1 and the Open Questions section say what that
means for implementation: the first task under this spec is to verify `go version`, run `go vet -help`
against the actual installed version, and confirm `go run` behaves as expected on the target platform,
before any rule is coded against an assumption this document could not check.

## Requirement 1 — The honest scope question, answered before any rule exists

**User story:** As someone about to write a Go rule, I want to know what the compiler and `go vet`
already refuse, so that I do not ship a rule whose only effect is costing a process launch to repeat
what the toolchain already told the user for free.

1. Before any rule is designed, this spec SHALL enumerate, separately:
   - What the **compiler** already refuses to build: an unused import, an unused local variable
     (not a package-level variable, a struct field, or a function parameter — those are permitted),
     a function with a declared return type that has a code path missing a `return`, and any
     type mismatch the compiler can prove statically. A rule duplicating any of these is not a rule,
     it is a slower compiler error.
   - What `go vet`'s default analyzer set already refuses at `go build`/`go test` time without an
     opt-in flag: `printf`-style format-argument mismatches, copying a value that contains a
     `sync.Mutex` or similar lock, struct tags with malformed syntax, and — the one closest to this
     pack's territory — `ifaceassert`, which flags an interface-to-interface type assertion that
     **cannot possibly succeed for any value**, decided from the two interfaces' method sets alone.
     That is a narrow, compile-time-provable subset. It is not the same claim as "this type assertion
     has no safety net," which is true of the overwhelming majority of assertions in real code and is
     exactly what `ifaceassert` does *not* flag.
   - `unusedresult`, `go vet`'s check closest to "you ignored a return value," is a curated allowlist
     of specific known functions (a short list including things like `fmt.Sprintf` and
     `sort.Reverse`), configurable but narrow by default. It does not fire on an arbitrary
     project-defined function whose result — including an `error` — is silently discarded by calling
     it as a bare statement. That gap is real and it is the gap this pack's semantic rule fills.
2. This spec SHALL state plainly that `go vet` has no opinion at all on the breadth of `interface{}`/
   `any` used at an API boundary, and no opinion on whether `panic` is reachable from exported,
   non-`main`, non-test code. Both are left entirely to human review today, which is what makes them
   legitimate targets rather than duplicated ones.
3. A rule that a careful reading of `go vet -help` and the language spec shows is already covered
   SHALL NOT be shipped in this pack. Genuinely open ground, demonstrated above, is: the general case
   of a discarded `error`-bearing return, a type assertion without the comma-ok form used outside the
   narrow class `ifaceassert` already catches, the empty-interface escape hatch as an API smell, and
   `panic` reachable from library code. These are Requirement 4's four rules, in that order, and no
   others are proposed for the starter pack.

## Requirement 2 — Execution

1. The analyzer SHALL declare `exec.type: "process"`.
2. It SHALL read one `AnalyzeRequest` as JSON from stdin and write one `AnalyzeResponse` as JSON to
   stdout; stdout SHALL carry nothing else, and human-readable diagnostics SHALL go to stderr, which
   the core folds into the response.
3. WHEN the request is malformed THEN it SHALL emit a well-formed response whose diagnostics explain
   the problem and exit non-zero — never a Go panic trace on stdout. A panic inside the analyzer's own
   `main` is exactly the failure Requirement 4's `no-panic-in-library` rule exists to stop other Go
   code from committing; the analyzer's own entry point SHALL recover from any internal panic and
   report it as a diagnostic rather than crash uncaught.
4. It SHALL NOT require a project or solution flag to analyze a single file; Requirement 7 describes
   what it does need instead, which is not the same thing.

## Requirement 3 — Real semantic analysis, and its failure mode

1. At least one rule (`no-ignored-error`, Requirement 4) SHALL require `go/types`, not syntax alone —
   mirroring `no-any`'s role in the TypeScript pack and `no-dynamic`'s in the C# pack.
2. WHERE a package's imports cannot be fully resolved — a third-party module not present in the local
   module cache, a build-tag-excluded file, a file that does not belong to a buildable package on
   disk — the analyzer SHALL report that condition as a skipped file or diagnostic and SHALL NOT run
   `no-ignored-error` against a degraded type graph. The TypeScript analyzer's 91 fabricated findings
   from an unresolved `tsconfig` is the precedent this requirement exists to not repeat.
3. Rules that need only `go/ast` SHALL still run when `go/types` resolution fails for a file, since
   nothing about their evidence depends on it — a resolution failure degrades only the semantic rule,
   and the response's `diagnostics` SHALL say which rule was affected and why.

## Requirement 4 — Starter rules, and the evidence each one earns

The analyzer SHALL ship a `core-go` pack with exactly these four rules. Each is stated here with its
evidence classification and the reasoning behind it, because getting this wrong in either direction is
the harm `evidence` exists to prevent — understating it hides a real finding behind false modesty,
overstating it lends a shape-match the authority of a type-checked one.

1. **`no-empty-interface`** — a parameter, field, or return declared with the empty interface,
   written either as the literal `interface{}` or the predeclared identifier `any`.
   **Evidence: syntax.** The literal `interface{}` is not a name lookup at all — Go's grammar for an
   interface type with zero methods means exactly one thing regardless of scope, so `go/ast` alone is
   sound for it. The identifier `any` is a predeclared alias, not a keyword, so it is technically
   possible for a file to shadow it with a locally declared type or variable of the same name; `go/ast`
   cannot rule that out without a symbol-table lookup, which by the manifest's own definition of
   `semantic` would make this rule's `any` half stronger evidence than its `interface{}` half. This
   spec's call is to leave the whole rule `syntax` and document the shadowing case as a known,
   accepted limitation — identical in kind to the Python analyzer's `set()`-shadowing example — on the
   grounds that shadowing a name chosen specifically to avoid collisions is rare enough that paying for
   `go/types` on every file to rule it out is not proportionate to a starter rule. A reviewer who
   disagrees should treat this as the first thing to push back on; the alternative (mark it `semantic`,
   or split it into two rules with two evidence values) is a legitimate different answer.
2. **`no-unchecked-type-assertion`** — a type assertion `x.(T)` used as a single value, rather than
   the two-value comma-ok form `v, ok := x.(T)`.
   **Evidence: syntax.** Whether an assertion appears as the sole value on an assignment's right side
   or as the two-value comma-ok form is visible entirely from `go/ast`'s shape of the surrounding
   `AssignStmt` — no type information is needed to know which form was written. This mirrors Rust's
   `no-unwrap`: the rule does not claim the assertion *will* fail, only that the code did not choose
   the form that can report failure instead of panicking.
3. **`no-ignored-error`** — a function call whose result includes a trailing `error`, made as a bare
   expression statement or assigned entirely to blank identifiers (`_ = call()`, `_, _ = call()`),
   with the error position discarded either way.
   **Evidence: semantic.** `go/ast` sees `call()` as a statement or an assignment shape; it has no way
   to know that the discarded value is an `error` rather than an `int` nobody cares about, or that a
   discarded position in a multi-value assignment lines up with the function's error-typed result.
   That requires resolving the call's signature through `go/types`. This is the rule this pack exists
   to add, because Requirement 1 showed nothing in the standard toolchain covers it generally.
4. **`no-panic-in-library`** — a `panic(...)` call reachable from code that is not `package main` and
   not a `_test.go` file.
   **Evidence: syntax.** Finding a `panic` call is a straightforward `go/ast` walk; "is this library
   code" is decided from the file's package clause and path, not from anything `go/types` resolves, so
   this stays a syntax classification the same way Rust's `no-panic-in-library` did.

## Requirement 5 — The interlock

1. `notFixes` SHALL only name rule ids that exist in this pack, and the graph SHALL be built from real
   Go remediation habits, not manufactured to make the pack look more connected than it is.
2. **`no-empty-interface` → `no-unchecked-type-assertion`.** The concrete, common dead end for "stop
   accepting `any`" is to keep the parameter typed `any` and recover the concrete type inside the
   function body with a bare type assertion. This does not restore compile-time checking at the
   boundary — every caller still compiles no matter what it passes — it only relocates the failure
   from a compile error at the call site to a runtime panic (or a comma-ok check) inside the callee.
   This is the same shape as the C# pack's `no-dynamic` → `no-unchecked-cast` edge, arrived at
   independently rather than copied, because both languages have the same underlying dead end: an
   escape-hatch type "fixed" by casting back out of it.
3. **`no-ignored-error` → `no-ignored-error` (self-reference).** The tempting rewrite of a bare
   `call()` that silently drops an error is `_ = call()` — assigning the discarded result to a blank
   identifier explicitly, which reads as intentional to a reviewer skimming for bare statement calls.
   It changes nothing: the error is still unexamined. Because the rule's own detection already covers
   both the bare-statement and explicit-blank-assignment forms (Requirement 4.3), this is not a
   different violation to launder into — it is the same one, still caught. This spec records it as a
   notFix anyway, with `rule` pointing back at `no-ignored-error` itself, because the whole reason to
   document a non-fix is to stop an agent from trying it, and an agent that tries it here will simply
   see the same finding again rather than a clean pass. Whether the schema should allow a notFix's
   `rule` to equal its own rule id is flagged in Open Questions — neither the Rust nor the C# pack
   needed this, and this may be the first analyzer where it comes up honestly rather than by accident.
4. **`no-unchecked-type-assertion`'s dead end has no rule to point to.** The comma-ok form's own
   escape hatch — `v, _ := x.(T)`, discarding `ok` instead of branching on it — genuinely swallows the
   failure rather than handling it, the same shape as `except Exception: pass` in the Python pack. But
   nothing in this four-rule pack catches a discarded `ok` boolean: `no-ignored-error` is scoped to
   `error`-typed results specifically (Requirement 4.3), and generalizing it to any discarded
   comma-ok boolean — which would also cover map lookups (`v, ok := m[k]`) and channel receives
   (`v, ok := <-ch`) — is a larger rule than this starter pack takes on. This spec records the gap in
   the `notFix`'s `because` text, with no `rule` field, rather than pretend it is covered.
5. **`no-panic-in-library` is terminal, and is said to be.** The one candidate edge — return an error
   instead of panicking, then have the caller do `if err != nil { panic(err) }` — either lands in
   `main`, where panicking on an unrecoverable startup condition is idiomatic and not a violation at
   all, or lands in another library function, where it simply re-trips this same rule at the new
   location rather than laundering into a different one. Unlike Rust's pack, where three rules'
   dead ends converge on `no-unsafe-block`, this pack has no sibling "dangerous but explicit" rule for
   a relocated panic to fall into. Per the Rust README's precedent for `no-unsafe-block`, this rule
   ships with no cross-rule `notFixes` entries rather than an invented one.

## Requirement 6 — Packaging and invocation

1. `exec.command` SHALL NOT name a built binary path. The Rust manifest originally did exactly this,
   named a `.exe` path, passed all 11 conformance checks on the machine that wrote it, and would have
   silently loaded nothing anywhere else — the failure mode is not a crash, it is a report that comes
   back clean because nothing ran. Go's own toolchain makes the same trap available: `go build`
   appends `.exe` on Windows and nothing on every other platform it targets, so a manifest naming
   `./bin/analyzer-go` would repeat the mistake exactly.
2. Instead, `exec` SHALL invoke the `go` toolchain launcher itself and let it resolve the platform
   difference — the same fix the Rust manifest received, going through `cargo run` instead of a raw
   artifact path: `{ "type": "process", "command": "go", "args": ["run", "./cmd/analyze"] }`, resolved
   relative to the manifest's own directory the way `writing-an-analyzer.md` already specifies for
   relative `exec` paths. `go`, like `dotnet` and `cargo`, is a PATH-resolved launcher with a stable
   name across platforms; the artifact it produces is not.
3. `go run` recompiles on every invocation, with `GOCACHE` absorbing most of the repeated cost after
   the first run. If that cost turns out to dominate real usage, moving to a prebuilt binary belongs in
   the caching work (roadmap 0013) behind a proper cross-platform build step, not as a shortcut taken
   here to save a process launch.
4. WHEN the `go` toolchain is absent from `PATH`, the spawn failure SHALL be surfaced as a clear,
   named report — "the Go analyzer is configured but the `go` toolchain was not found" — never a raw
   spawn error and never a silent skip. This is the same requirement the C# analyzer carries for a
   missing .NET runtime, applied to the one toolchain this analyzer actually needs.
5. The analyzer's own module SHALL ship a `go.mod`, the same way the Rust analyzer ships a
   `Cargo.toml`; `go run` needs a module context to resolve even its own standard-library imports
   predictably across Go versions.

## Requirement 7 — The unit `go/types` checks is a package, not a file

1. `go/types.Config.Check` takes the full set of `*ast.File`s belonging to one package at once, not
   one file at a time. This is stronger than the analogous limitation in the TypeScript or C# packs:
   in Go, a symbol declared in one file of a package is visible in every other file of that same
   package with no import statement at all. Type-checking a single file of a multi-file package in
   isolation does not merely lose precision, it produces `undefined: X` for every sibling-file symbol
   the file actually uses — a false positive, not a degraded-but-honest result.
2. Therefore, for `no-ignored-error` (the one `scope: 'file'` rule needing `go/types`), a hook
   invocation that sends a single edited file under `mode: 'file'` is not enough by itself. The
   analyzer SHALL locate that file's sibling `.go` files on disk (same directory, same package clause,
   respecting the default build configuration), parse and type-check the whole set together, and then
   filter reported violations down to the file(s) the request actually asked about. This is reading
   more than was requested in order to answer honestly about what was requested — not a scope
   violation of `mode: 'file'`, which governs which *rules* run, not which files may be read to make
   a file-scope rule's answer sound.
3. WHERE the edited file cannot be placed in a buildable package this way — it sits outside any
   directory `go` recognizes as a package, or its sibling files fail to parse — the analyzer SHALL
   report the file as skipped with that reason rather than either fabricate a single-file type check
   or silently fall back to running `no-ignored-error` as if it were a syntax rule. Silently downgrading
   evidence without saying so is the exact harm the `evidence` field exists to prevent, and it applies
   to the analyzer's own runtime behavior, not only to its manifest's static claims.
4. `scope: 'project'` rules — none are proposed in Requirement 4, but the manifest's `scope` field
   still needs a real answer for this analyzer, since a future rule (an unused-exported-symbol check,
   for instance) would need one — require the full module's package graph, which this analyzer SHALL
   obtain by invoking the `go` toolchain itself (`go list`) rather than re-implementing Go's package
   discovery, build-tag matching, and module resolution by hand. Hand-rolled package discovery that
   drifts from what `go build` actually does is precisely the kind of silent wrongness this project
   has already found expensive once, in the TypeScript analyzer's tsconfig resolution.
5. `mode: 'project'` is therefore the only mode in which this analyzer can make an unqualified semantic
   claim about a whole package's error handling; `mode: 'file'` makes the same claim about one file
   only by first reading its whole package and then narrowing the report, and that narrowing SHALL be
   stated as what it is rather than left as folklore, the same way `writing-an-analyzer.md` already
   requires for the `scope` field generally.

## Requirement 8 — Registration

The analyzer SHALL NOT be added to this repository's own `checkyourvibe.json` by default, for the same
reason the Python and Rust analyzers are not: there is no Go source in checkyourvibe to check, and
registering an analyzer that will never match a file would add a `go` toolchain prerequisite to every
contributor's environment, plus a `go run` spawn on every check, for zero findings. `cyv verify-analyzer`
against the manifest, and the fixture suite, are the conformance path — neither requires the analyzer
to be wired into this project's own configuration.

## Non-goals

Resolving third-party module imports through anything beyond the standard library's own `go/importer`
— `golang.org/x/tools/go/packages`, despite being maintained by the Go team, is not part of the
standard library and is out of scope for this spec; how far `go/importer` alone gets in practice is an
open question, not a settled design. CGo-aware analysis — files using `import "C"` go through a
preprocessing step `go/parser` does not perform. Per-build-tag analysis across the GOOS/GOARCH matrix —
a rule runs once, against the default build configuration, and a file that only exists under a
different constraint tag is not analyzed by this spec's design. Generic-instantiation-specific
findings. Competing with `go vet` or reproducing anything in Requirement 1's enumeration. Editor/LSP
delivery (0014). A warm, cached session across invocations (0013, though `capabilities.session` remains
reserved for it). Any rule requiring cross-module analysis of a dependency's own source.

## Open questions

1. **Toolchain verification is a prerequisite task, not a paragraph in this document.** This spec was
   written without a working `go` on the authoring machine. Before Requirement 4's rules are coded,
   an implementation task SHALL run `go version`, `go vet -help`, and a `go run` smoke test on the
   actual target platform(s) and record the results — the same discipline 0004 applied to .NET before
   writing a line of C#, applied here after the fact instead of before.
2. **Self-referential `notFixes`.** Requirement 5.3 proposes a `notFix` whose `rule` equals its own
   rule's id. The schema and validator currently allow it — nothing in `rule-manifest.ts` forbids
   `rule === id` — but no existing pack has needed it. Is a self-pointing dead end useful documentation
   or a sign the rule's own detection should simply be described more precisely as covering both
   forms without a `notFixes` entry at all?
3. **How far does `go/importer` alone reach?** Requirement 3 and the Non-goals both depend on knowing,
   for a real Go module with third-party dependencies, whether the standard library's own import
   resolution is sufficient in practice or whether its gaps are common enough that `no-ignored-error`
   would degrade to skipped-file status too often to be useful. This is an empirical question the
   toolchain-verification task should answer with a real module, not assume.
4. **Should `no-unchecked-type-assertion`'s undefended gap (Requirement 5.4) be closed by broadening
   `no-ignored-error`, or does that overreach a rule that is deliberately scoped to `error` alone?**
   Left open rather than decided here, because deciding it changes Requirement 4.3's rule definition.
