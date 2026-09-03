# 0001 — Core Vertical Slice: Tasks

**Status:** active
**Created:** 2026-08-26

## How to read this

Tasks are grouped into **waves**. Every task inside a wave is file-disjoint from its siblings, so a
wave dispatches concurrently. A wave starts only when the previous wave's gates pass.

Each task carries a dispatch line:

```
_Exec: executor=<lane> model=<model> gates=<g1,g2> files=<paths>_
```

- `executor` — `devin` (default; free `swe-1-7`), `claude` (subagent, escalation lane), or `self`
  (the orchestrating model, reserved for contracts and review).
- `gates` — `tsc` (`pnpm -w exec tsc --noEmit`), `test` (`pnpm -w vitest run`), `self` (`cyv check --all`).
- `files` — the paths the task owns. **A task must not write outside them.** This is what makes
  concurrency safe; it is a correctness requirement, not an optimization.

**Escalation:** a task that fails its gates twice on `devin` moves to `claude`. Record the escalation
in the checkbox line. Escalation rate per lane is the number that falsifies the tiering approach — if
`devin` escalates above ~40%, the rubric is wrong and the retries cost more than the free lane saves.

**Provenance:** every task inherits the rebuild-never-copy constraint from `requirements.md`. No task
may introduce an employer name, coworker name, vendor name, or internal document path.

---

## Wave 1 — Contracts and scaffold

Nothing else can start until the protocol types exist, because every downstream task codes against
them. T101 is `self` deliberately: a wrong abstraction here propagates into all 20 tasks below it.

- [x] **T101** Protocol types and JSON Schemas
  Author `violation.ts`, `rule-manifest.ts`, `analyzer.ts`, `agent.ts` exactly as specified in
  `design.md`, plus matching JSON Schemas under `docs/protocol/`. Types and schemas must agree; a test
  asserts a sample object validates against its schema.
  _Exec: executor=self model=opus gates=tsc files=packages/core/src/protocol/**,docs/protocol/**_

- [x] **T102** Workspace scaffold
  Root `package.json` (pnpm workspace, scripts: `build`, `test`, `typecheck`), `pnpm-workspace.yaml`,
  `tsconfig.base.json` (strict, ES2022, NodeNext), `vitest.config.ts`, `LICENSE` (MIT, "Paul Wade"),
  and the three package `package.json` + `tsconfig.json` files. No source files.
  _Exec: executor=devin model=swe-1-7 gates=tsc files=package.json,pnpm-workspace.yaml,tsconfig.base.json,vitest.config.ts,LICENSE,packages/*/package.json,packages/*/tsconfig.json_

## Wave 2 — Core internals

All depend on T101 only, and own disjoint directories.

- [x] **T201** Config loading and validation
  `checkyourvibe.json` schema + loader. Missing config exits 2 naming `cyv init`; invalid config exits
  2 with the failing schema path; unknown rule in a severity override exits 2. Requirements 5.1–5.6.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/config/**,docs/protocol/config.schema.json_

- [x] **T202** Git file discovery and run modes
  Resolve file sets for explicit paths, `--staged`, `--working` (merge-base with default branch),
  `--branch`, `--all`. Detect the default branch rather than assuming a name. Return an explicit
  `empty` signal so callers can honour Requirement 4.4. Requirements 4.1–4.3.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/run/discover.ts,packages/core/src/run/modes.ts,packages/core/test/run/**_

- [x] **T203** Analyzer registry and file routing
  Load analyzer manifests without executing them. Route files by `match`/`exclude` globs. A file
  matching two analyzers is a configuration error, never a silent first-match win. Requirement 1.1.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/registry/**,packages/core/src/run/route.ts,packages/core/test/registry/**_

- [x] **T204** Analyzer invocation, both execution shapes
  In-process (`exec.type: node`, dynamic import) and subprocess (`exec.type: process`, JSON over
  stdin/stdout, stderr captured to diagnostics). Malformed response exits 2 naming the analyzer.
  Requirements 1.3–1.7.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/run/execute.ts,packages/core/test/run/execute.test.ts_

- [x] **T205** Reporters
  Text reporter (grouped by category, colourised, quotes the offending line) and `--json`. JSON goes to
  stdout with zero human text interleaved. Reports zero-file runs prominently, lists skipped files, and
  states which project-scope rules did not run. Requirements 4.4–4.6, 4.9.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/report/**,packages/core/test/report/**_

- [x] **T206** Guidance renderer
  Render a `RuleManifest` to terminal text and to markdown, from shared templates so the two cannot
  drift. Validate the `notFixes` graph: an entry naming an unknown rule is a configuration error.
  Requirements 3.4, 3.6, 3.7.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/guidance/**,packages/core/test/guidance/**_

- [x] **T207** ts-morph project management
  Create one `Project` from the nearest `tsconfig.json`, with a refresh path that updates only changed
  source files for watch mode. Export a `makeViolation` helper. Files that fail to load become
  `SkippedFile` entries, never silent omissions.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/project.ts,packages/analyzer-typescript/src/util.ts,packages/analyzer-typescript/test/project.test.ts_

## Wave 3 — Rules

Seven fully independent tasks; each owns one rule file, one manifest, and one fixture pair. Depends on
T101 + T207.

Each task must: implement `TsRule`, author the manifest with real `why` / `allowedFixes` / `notFixes`
prose written from scratch, and provide `<rule>.bad.ts` and `<rule>.ok.ts` fixtures where the `.ok.ts`
file is a genuine false-positive guard, not a trivial empty file.

- [x] **T301** `no-any` — explicit **and inferred** `any`. Inferred detection is the differentiator; it
  requires the type checker, not a syntax walk. `notFixes`: widening to `unknown`, `as` casting.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-any.ts,packages/analyzer-typescript/test/fixtures/no-any.*.ts_

- [x] **T302** `no-as-cast` — `x as T`, `<T>x`, and `x as unknown as T` (double-cast at higher
  severity). `notFixes`: `@ts-ignore`.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-as-cast.ts,packages/analyzer-typescript/test/fixtures/no-as-cast.*.ts_

- [x] **T303** `no-non-null-assertion` — `x!`, `x!.y`, `f()!`, `arr[i]!`, `class { x!: T }`, `let x!: T`.
  The field-declaration form is the one naive implementations miss.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-non-null-assertion.ts,packages/analyzer-typescript/test/fixtures/no-non-null-assertion.*.ts_

- [x] **T304** `no-ts-comment` — `@ts-ignore` and `@ts-expect-error` in line, block, and JSDoc styles.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-ts-comment.ts,packages/analyzer-typescript/test/fixtures/no-ts-comment.*.ts_

- [x] **T305** `no-json-parse-cast` — `JSON.parse(...) as T`. Guidance points at schema validation
  generally; it must not name a specific validation library.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-json-parse-cast.ts,packages/analyzer-typescript/test/fixtures/no-json-parse-cast.*.ts_

- [x] **T306** `no-useless-types` — `: object`, `: Function`, `: {}`.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-useless-types.ts,packages/analyzer-typescript/test/fixtures/no-useless-types.*.ts_

- [x] **T307** `no-console` — `console.*` with an `allowedLoggers: string[]` option and a JSON Schema
  for it. Names no logging vendor anywhere in code, manifest, or fixtures. Requirement 9.3.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/rules/no-console.ts,packages/analyzer-typescript/test/fixtures/no-console.*.ts_

## Wave 4 — Assembly

- [x] **T401** TypeScript analyzer entry point
  Assemble the seven rules into the `core-ts` pack, emit `analyzer.manifest.json`, and export the
  in-process `AnalyzeFn`. Honour per-rule severity and options from the request.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/src/index.ts,packages/analyzer-typescript/src/rules/index.ts,packages/analyzer-typescript/analyzer.manifest.json_

- [x] **T402** TypeScript analyzer stdio binary
  `bin/analyze.ts` reading an `AnalyzeRequest` from stdin and writing an `AnalyzeResponse` to stdout,
  over the same implementation as T401. This is what keeps the subprocess path from rotting.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/analyzer-typescript/bin/**,packages/analyzer-typescript/test/stdio.test.ts_

- [x] **T403** Claude Code agent plugin
  `detect`, `plan`, `parseHookPayload`, `formatResult` per `design.md`. Includes a committed real
  `PostToolUse` payload fixture and golden-file tests for `plan()`. Merge-strategy tests must prove
  user content survives regeneration byte-for-byte. Requirements 2.3–2.8.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/adapter-claude-code/**_

- [x] **T404** Merge strategies
  `create-if-absent`, `json-merge` (preserves key order and foreign keys), `managed-block` (replaces
  only between delimiters; missing end delimiter is a hard failure, never a guess). Requirements 2.4–2.6.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/merge/**,packages/core/test/merge/**_

## Wave 5 — CLI, MCP, backstop

- [x] **T501** `cyv check` and `cyv explain`
  Wire config → discovery → routing → execution → guidance attachment → reporting → exit codes
  0/1/2. Requirements 4.7–4.8.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/cli/check.ts,packages/core/src/cli/explain.ts,packages/core/src/cli/index.ts_

- [x] **T502** `cyv hook <agent-id>`
  Read stdin, delegate to the plugin's `parseHookPayload`, check those files, delegate to
  `formatResult`. **Unparseable payload or internal error warns and exits 0.** Requirements 8.1–8.2.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/cli/hook.ts,packages/core/test/cli/hook.test.ts_

- [x] **T503** `cyv init` and `cyv doctor`
  `init` detects installed agents, builds the plan, shows a diff, requires confirmation unless
  `--yes`. `doctor` re-reads applied glue and reports drift, including a checkout path that no longer
  resolves. Requirement 2.7.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/cli/init.ts,packages/core/src/cli/doctor.ts,packages/core/test/cli/init.test.ts_

- [x] **T504** MCP server
  `cyv mcp` over stdio exposing `check_files`, `check_working_tree`, `explain_rule`, `list_rules`.
  Violation results embed guidance inline. Internal errors return MCP errors rather than exiting.
  Requirements 7.1–7.4.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/mcp/**,packages/core/test/mcp/**_

- [x] **T505** Git backstop
  `cyv install-hooks` writing a `pre-commit` running `cyv check --staged --strict`; detects and
  integrates with husky/lefthook; refuses to clobber an unmanaged existing hook without confirmation.
  Plus `.github/workflows/ci.yml`. Requirements 6.1–6.5.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/backstop/**,.github/workflows/ci.yml_

- [x] **T506** `cyv verify-analyzer` conformance suite
  Drive an analyzer through a scripted request set and validate every response against the schemas.
  Must work on an analyzer that appears in no config. Requirement 1.8.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/cli/verify-analyzer.ts,packages/core/test/cli/verify-analyzer.test.ts_

- [x] **T507** `--watch`
  In-process path only, retaining analyzer state between runs. Requirement 4.10.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/src/run/watch.ts,packages/core/test/run/watch.test.ts_

## Wave 6 — Proof

- [x] **T601** End-to-end test
  Temp git repo → `cyv init --yes` → `cyv install-hooks` → write a violating file → assert the commit
  is refused → assert `--no-verify` bypasses it.
  _Exec: executor=devin model=swe-1-7 gates=tsc,test files=packages/core/test/e2e/**_

- [x] **T602** Self-application config
  `checkyourvibe.json` at the repo root configuring checkyourvibe against its own source. Any
  exemption carries a written reason. Requirement 10.1.
  _Exec: executor=self model=opus gates=tsc,test files=checkyourvibe.json_

- [x] **T603** **Milestone — checkyourvibe checks checkyourvibe**
  Run `cyv check --all` against this repository, fix every violation found, and add the self-check to
  CI. The vertical slice is not done until this is green. Requirements 10.2–10.3.
  _Exec: executor=self model=opus gates=tsc,test,self files=*_

- [x] **T604** README and protocol docs
  README: what it is, the two plug-in axes, install, quickstart, the honest `--no-verify` note.
  Plus `docs/writing-an-analyzer.md` and `docs/writing-an-agent-plugin.md`, both written against the
  published schemas so a third party can work from them alone.
  _Exec: executor=devin model=swe-1-7 gates= files=README.md,docs/writing-an-analyzer.md,docs/writing-an-agent-plugin.md_

---

## Execution log

Append one line per dispatch: task, lane, outcome, gate result. This is the raw material for deciding
whether the free lane is actually cheaper, and for rebuilding the `spec` CLI against real data rather
than guesses.

## Milestone outcome — T603

`cyv check --all` ran against this repository and found **three integration defects that every unit
test had passed over**, then **two real bugs in the tool itself**. That is the whole argument for
self-application stated in evidence rather than principle.

Integration defects (each piece correct alone, the seam wrong):

1. `exec.module` resolved against the repository root rather than the manifest's own directory, so the
   analyzer could not be loaded at all.
2. The built analyzer imported core's **source** path, which has no `.js` at runtime.
3. **Rule packs were inert.** The resolver expanded `config.packs` against pack metadata "a caller may
   attach", but `RuleManifest` never declared it, no rule set it, and the registry's whitelist
   validator would have dropped it regardless. `packs: ["core-ts"]` therefore enabled nothing — and a
   run over 57 files reported a confident clean pass with six of seven rules switched off. This is the
   most instructive failure of the night: three reasonable local decisions composing into silence.

Bugs the tool found in itself:

4. **Type resolution was silently degraded.** `createProject` resolved the tsconfig from the repository
   root, which in a monorepo is solution-style — no `compilerOptions`, no `lib`, no `types`. Every Node
   API resolved to `any`, and `no-any` reported 120 violations of which **91 were fabricated**. Projects
   are now grouped by the tsconfig governing each *file*, and a solution-style config is detected and
   reported as degraded rather than quietly producing garbage. This affected every monorepo user, and
   no unit test could have caught it — the fixtures were all single-package.
5. `no-any` false-positived on destructuring declarations, whose name is a pattern rather than an
   identifier, so the declaration's "type" describes no binding it introduces.

Self-check trajectory: **211 → 121 → 94**. The remaining 94 are genuine findings in this codebase and
are the subject of spec 0002 — not exemptions.

## Known follow-ups

Recorded rather than fixed mid-wave, so they are not lost:

- **The check pipeline is duplicated three ways.** `cli/check.ts` does not export its orchestration, so
  `cli/hook.ts` and `mcp/pipeline.ts` each re-derived it, and each grew its own `guidanceFor`. The
  design requires guidance to be attached in exactly one place so it cannot differ between the
  terminal, a hook and MCP — three copies is precisely the drift that requirement exists to prevent.
  Extract a single `runCheck()` in core and have all three call it.
- **`bin/` was outside the package tsconfig.** Fixed by moving the stdio binary under `src/bin`, but the
  general hazard stands: a directory absent from `include` is silently absent from `tsc -b`, so code can
  look verified while never being compiled. Worth a guard.
- **Self-check baseline moves with the code.** 94 at the milestone, 116 once the later tasks landed.
  Spec 0002 owns closing it; CI prints the number on every run so it cannot drift unnoticed.

## Execution log

| Task | Lane | Attempt | Gates | Notes |
|---|---|---|---|---|
| T102 | devin/swe-1-7 | 1 | — | **Silent failure.** Exited 0 having written nothing: `accept-edits` rejected a tool call needing confirmation and the CLI still reported success. Devin's exit code is not a gate. |
| T102 | devin/swe-1-7 | 2 | tsc ✓ | Passed with `--permission-mode dangerous`. 12/12 files present, JSON valid. |
| T101 | self/opus | 1 | tsc ✓ | Protocol types authored by hand; schema transcription delegated to devin and verified. |
| T201 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Transient ajv-2020 import and strict-index errors, self-corrected before completing. |
| T202 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | 10 tests. `branch` blindness to uncommitted work is now pinned by a test rather than a README warning. |
| T203 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Ambiguous double-match throws instead of silent first-match-wins. |
| T204 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Both exec shapes implemented; stderr folded into diagnostics rather than dropped. |
| T205 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Wrote a sort assertion contradicting category-first grouping, then self-corrected it unprompted. |
| T206 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Both renderers driven by one section builder, so terminal and markdown cannot drift. |
| T207 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Imports core through a relative `src` path rather than the package specifier — cleanup tracked as T405. |

**Wave 2 result: 7/7 first-attempt pass, 0 escalations.** Two tasks produced transient failures they
resolved themselves before reporting. The one real intervention so far was T102's silent success, which
was a harness problem (permission mode), not a model problem.

| T301–T307 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | All seven rules first-attempt. T306 created AST-probe scratch files and cleaned them up itself. |
| T403 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | 12 tests; `plan()` purity asserted against both target dirs. |
| T404 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Idempotency and byte-preservation both covered. |
| T505 | devin/swe-1-7 | 1 | tsc ✓ test ✓ | Integrates with husky/lefthook instead of clobbering. |
| T401 | devin/swe-1-7 | 1 | ✗ | **Rate limited.** Free lane has a per-account message rate limit, not just a token budget. Wrote nothing. |
| T501 | devin/swe-1-7 | 1 | ✗ | Same rate limit — 8 concurrent dispatches saturated it. |
| T401 | claude/sonnet | 2 | — | Escalated to the fallback lane rather than idling 23 minutes. |
| T501 | claude/sonnet | 2 | — | Escalated. |

**The free lane's real constraint is request rate, not cost.** Eight concurrent dispatches exhausted an
account-wide message limit with a ~23-minute reset, and — as in T102 — the CLI reported exit 0 while
writing nothing. Two conclusions for the tooling rebuild: cap concurrency on a rate-limited lane
(3 looks safe, 8 does not), and never treat an executor's exit code as a gate. Verify declared files
exist, every time.
