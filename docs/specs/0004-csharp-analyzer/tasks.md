# 0004 — C# analyzer (Roslyn): Tasks

**Status:** active

## Wave 1 — The analyzer

- [x] **T4001** Roslyn analyzer, `core-cs` pack, fixtures, conformance
  A .NET 9 console project reading one `AnalyzeRequest` from stdin and writing one `AnalyzeResponse`
  to stdout. Four rules — `no-dynamic`, `no-unchecked-cast`, `no-null-forgiving`, `no-empty-catch` —
  each with a full manifest written from first principles for C#.
  Semantic analysis is real: `no-dynamic` uses `GetTypeInfo` so a local merely *named* `dynamic` is
  not flagged, and `no-unchecked-cast` uses `ClassifyConversion` to flag only reference downcasts and
  unboxing. Where a cast's type is genuinely unresolvable, that cast is skipped with a diagnostic
  rather than guessed at — Requirement 3.2, written because the TypeScript analyzer once produced 91
  fabricated findings from a degraded type graph.
  **11/11 conformance checks pass.**
  _Exec: executor=claude model=sonnet gates=dotnet,fixtures,verify-analyzer files=packages/analyzer-csharp/**_

## Wave 2 — Defects it found in the published protocol

Building an analyzer that may not read the core's source is the point of this spec. It found five
gaps; these are the ones fixed so far.

- [x] **T4002** Resolve relative paths in `exec.args`, not only `exec.command`
  The portable invocation for any managed or interpreted analyzer is a runtime plus a relative
  artefact — `dotnet ./bin/analyzer.dll`, `python ./analyze.py` — where `command` is a bare PATH
  lookup and the only relative path is in `args`. Args were never resolved, and the conformance suite
  spawns with `cwd` set to a temp directory, so the natural manifest failed outright. The analyzer was
  forced onto an OS-specific `.exe` apphost that would not run on a Linux CI runner.
  _Exec: executor=self model=opus gates=tsc,verify-analyzer files=packages/core/src/registry/load.ts_

- [x] **T4003** Publish the snippet length numerically
  `violation.schema.json` said "truncated to SNIPPET_MAX_LENGTH" — a constant that exists only in the
  core's TypeScript, which a non-Node analyzer has no business reading.
  _Exec: executor=self model=opus gates= files=docs/protocol/violation.schema.json_

- [x] **T4004** Document `exec` path resolution and the working directory
  Neither the schema nor the guide said where process-type paths resolve, or that the spawned
  process's working directory is not guaranteed to be the repository root.
  _Exec: executor=self model=opus gates= files=docs/protocol/analyzer-manifest.schema.json_

- [x] **T4005** Reconcile "no project file needed" with "report degraded compilation"
  Requirements 2.5 and 3.2 are in genuine tension and no document resolves them. Analysing one file
  with no project guarantees some external types will not resolve — that is normal, not degraded. The
  analyzer had to invent its own dividing line (skip the specific unresolvable node, with a
  diagnostic, rather than the whole file). A third party has no way to know how conservative to be, or
  at what granularity. Write the guidance.
  _Exec: executor=self model=opus gates= files=docs/writing-an-analyzer.md_

- [x] **T4006** Fix the `node` exec-type documentation
  The schema says `module` resolves relative to the manifest's directory. The loader does that; the
  executor resolves against the repo root. Nothing distinguishes load-time from exec-time resolution,
  and the executor's fallback contradicts its stated contract if reached directly.
  _Exec: executor=claude model=sonnet gates=tsc,test files=docs/protocol/analyzer-manifest.schema.json,packages/core/src/run/execute.ts_

## Wave 3 — Coexistence and CI

- [x] **T4007** Both analyzers configured at once
  Route `.ts` to one and `.cs` to the other in this repository's own config, aggregate into one
  report, and make clear which analyzer produced a finding.
  _Exec: executor=claude model=sonnet gates=tsc,test,self files=checkyourvibe.json,packages/core/src/report/**_

- [x] **T4008** CI builds and verifies the C# analyzer
  `dotnet build`, the fixture runner, and `cyv verify-analyzer` on every push. Also: report clearly
  when the .NET runtime is absent, so a user who never asked for C# is not confused by a spawn error.
  _Exec: executor=claude model=sonnet gates=tsc files=.github/workflows/ci.yml,packages/core/src/run/execute.ts_

## Open design question — the rule-id namespace

Adding a second analyzer surfaced this immediately, and it will recur for every language added.

The TypeScript pack gained a `no-empty-catch` rule. The C# analyzer already shipped one with that
exact id, and `allRules` correctly refused: rule ids are a single flat namespace, so two analyzers
cannot both define one. The TypeScript rule was renamed to `no-swallowed-catch` to unblock.

That rename is a workaround, not an answer. "Empty catch", "unchecked cast", "unsafe index access" are
concepts every typed language has, and forcing each analyzer author to invent a globally unique name
produces worse names the more languages exist.

Two options:

1. **Qualified ids** — the core addresses rules as `typescript/no-empty-catch`, while a manifest keeps
   short ids internally and `notFixes` continue to reference siblings locally. Correct, and it scales.
   But it changes how configuration, baselines, suppressions, the dashboard and every report refer to a
   rule, so it is a breaking change to make deliberately rather than at 3am.
2. **Keep the flat namespace and document it** — analyzers must choose distinct ids, the way lint
   plugins conventionally prefix their rules. Simpler, no code change, and it pushes the naming tax
   onto every analyzer author forever.

Recommendation: option 1, before anything is published and while there are only two analyzers. Nothing
is published, so the cost is at its minimum right now and rises with every adopter.

## Measured

Startup cost, warm, this machine: ~85ms with no rule enabled; **~510–600ms once a real
`CSharpCompilation` is built**, dominated by loading the BCL reference set. Nearly flat from 1 to 4
files per request, so batching amortises well — but every subprocess invocation pays it fresh.

**Finding (Requirement 2.6):** at roughly half a second per invocation, a keystroke-triggered hook
would feel laggy. Save-triggered and pre-commit are fine. This is a property of the one-shot process
protocol: unlike the `node` exec type, it cannot hold a warm compilation between runs. Worth revisiting
if a `session` capability is ever implemented — the flag is already reserved in the manifest.

- [x] **T4009** Three fixture harnesses that nothing ever ran, and the one that had stopped working
  Found while trying to verify T7008's C# half. Each non-TypeScript analyzer ships a
  `test/run-fixtures.mjs` that drives the real analyzer subprocess against every `.bad`/`.ok` pair.
  None of the three was referenced by CI, by a package script, or by anything else — the fixtures are
  C#, Python and Rust, so `vitest run` never collects them, and no other command invoked them.

  Orphaned long enough for one to break. The C# harness dropped the manifest's `exec.args` and
  spawned a bare `dotnet` with nothing to run, then guarded that with an `existsSync` on the command
  — which a bare `dotnet` can never satisfy, so it died before spawning anything. It is the only
  manifest using a command-plus-args exec shape, which is exactly the case the harness lost. Python
  and Rust name their binary directly and were unaffected.

  The harness now resolves `command` and `args` the way the core loader does, resolves a relative
  value in either position against the manifest directory, and only stats a command that looks like
  a path. All three run green: C# 4 rules, Python 4, Rust 4, plus each one's malformed-request
  check.

  Wired into CI as an `Analyzer fixtures` step that loops over
  `packages/analyzer-*/test/run-fixtures.mjs`, so a fifth analyzer is covered the moment it ships one
  rather than needing the step edited. The neighbouring `verify-analyzer` step proves a manifest
  still loads; it does not run a single rule. Rules whose fixtures nobody executes have no coverage
  at all.

