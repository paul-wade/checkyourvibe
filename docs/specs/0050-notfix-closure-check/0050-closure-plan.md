# 0050 plan — notFix closure check

Spec: docs/specs/0050-notfix-closure-check/requirements.md
Recon facts: C:\Users\paulw\AppData\Local\Temp\claude\R--checkyourvibe\1c597e01-891a-4b0a-b811-1eb10e93eb7b\scratchpad\closure-recon.md

## Global Constraints

- Branch: `public/fixes`. Commit each task. Do not push. Do not touch the
  pre-existing uncommitted changes in the working tree (dashboard files,
  README, .gitignore, untracked benchmark/analyzer-eslint dirs); commit only
  the files your task changes, by explicit path.
- Commit trailer, every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01J1juTt13f3WArLP4nLJZKX
  ```
- checkyourvibe itself runs as a PostToolUse hook on every TypeScript edit
  in this session. If the hook reports a violation, run `cyv explain
  <rule-id>` and fix it properly. Never suppress, cast, or `!` your way out.
- Build: `pnpm build` (runs `tsc -b`, copies schemas). Typecheck: `pnpm
  typecheck`. Tests: `pnpm test` (vitest, root config, all packages) or
  `pnpm vitest run <path>` for a focused file. No lint script exists.
- The analyzer-typescript manifest JSON is generated from source: after
  editing any rule in `packages/analyzer-typescript/src/rules/*.ts`, run
  `pnpm build` then `node packages/analyzer-typescript/test/sync-manifest.mjs`
  and commit the regenerated `packages/analyzer-typescript/analyzer.manifest.json`.
  `analyze.test.ts` fails on drift.
- The new field on `NotFix` is named exactly `example` (type `string`,
  optional in the schema and TS type). JSON schema lives at
  `docs/protocol/rule-manifest.schema.json` (`$defs.NotFix` has
  `additionalProperties: false`, so the field must be added there or every
  manifest fails schema validation).
- The new conformance check is named `notFixClosure` in `CHECK_NAMES`, with
  the description string: `"every notFix that names a rule carries an
  example, and the analyzer reports that rule on it"`.
- Closure check semantics (Requirement 2, 3): for each rule, for each
  notFix with `rule` set: if `example` is missing, record
  `<ruleId> -> <notFix.rule>: no example`; otherwise write `example` to a
  file in the temp dir and, after ONE analyze request covering all example
  files with all rules enabled (`fullRuleSettings`), require that at least
  one violation on that file has `ruleId === notFix.rule`; if not, record
  `<ruleId> -> <notFix.rule>: <notFix.rule> did not report`. Any recorded
  entry fails the check; the fail detail lists every entry. The pass detail
  states the number of edges verified and, as information only, how many
  examples the source rule itself still reported on.
- File extension for example files: derive from the analyzer's own
  bad-example handling in `checkCatchesOwnConstruct` (it already picks a
  file name for `examples.bad`; reuse the same extension logic so rust gets
  `.rs`, csharp `.cs`, typescript `.ts`). Name files
  `notfix-<ruleId>-<index>.<ext>` so a failure names its edge.
- Do not render `example` anywhere. Do not touch `guidance/templates.ts`
  or `dashboard/render.ts`.
- Between Task 1 and the end of Task 3, the test
  `"verifyAnalyzer — this repo's own analyzer"` in
  `packages/core/test/conformance/suite.test.ts` and the analyzer-level
  conformance expectations WILL fail on the closure check because examples
  are not yet populated. That is expected and must be stated in the Task 1
  report; it is not a reason to weaken the check. Everything is green after
  Task 3.
- TDD for every task: failing test first, then implementation.

## Task 1: `example` field and the closure conformance check

Time budget: 75 minutes.

Files:
- `packages/core/src/protocol/rule-manifest.ts`: add `example?: string` to
  `NotFix` with a doc comment: "Source text in which this non-fix has been
  applied. Required when `rule` is set; the conformance suite runs the
  analyzer on it and requires `rule` to report." Update `isNotFix` to
  accept an optional string `example` and reject a non-string one.
- `docs/protocol/rule-manifest.schema.json`: add `example` (`type: string`)
  to `$defs.NotFix.properties`. Not in `required`.
- Do NOT change `packages/core/src/guidance/validate.ts`. Controller ruling
  (see ledger): `validateRules` runs on the `cyv check` hot path, so a hard
  throw for a missing example would break every `cyv check` run — including
  this machine's PostToolUse hook — for any analyzer that has not adopted
  examples yet. Requirement 3 is satisfied by the conformance check, which
  records a missing example as a failure. Leave the hot path alone.
- `packages/core/src/conformance/suite.ts`: add `checkNotFixClosure` in the
  scripted-execution family, modelled on `checkCatchesOwnConstruct`
  (lines 373-443), with the semantics from Global Constraints. Register it
  after `checkCatchesOwnConstruct` and feed its violations into
  `allViolations` like the other scripted checks. When the manifest cannot
  be loaded, it gets the same "could not be executed" placeholder as the
  other execution checks.
- `docs/writing-an-analyzer.md`: in the section that lists `RuleManifest`
  fields (around line 340), document `example` on notFixes and the closure
  check in three or four sentences.
- `packages/core/src/cli/new-rule.ts`: the scaffolded notFix (around line
  193) should include an `example` placeholder so a new rule starts with a
  closed edge. Keep the change minimal.

Tests, in `packages/core/test/conformance/suite.test.ts` following the
existing `describe('verifyAnalyzer — broken analyzers ...')` pattern
(read `compliantManifest()` and the fixture analyzer used there first; the
fixture analyzer is a scripted node analyzer, so an example that "trips"
a rule is whatever that fixture reports on):
1. compliant manifest whose rule-bearing notFix carries an example the
   fixture analyzer reports the named rule on: `notFixClosure` passes.
2. rule-bearing notFix with no `example`: `notFixClosure` fails and the
   detail contains `no example`.
3. rule-bearing notFix whose example the named rule does not report on:
   fails and the detail names the edge and `did not report`.
4. a notFix with no `rule` and no `example` does not affect the check.
Also a unit test for `isNotFix` accepting a string `example` and rejecting
a numeric one (find the existing rule-manifest guard tests).

Commit message subject: `Prove each notFix edge: run the analyzer on the
shortcut and require the named rule to fire`.

## Task 2: Populate `example` for every rule-bearing notFix in analyzer-typescript

Time budget: 90 minutes.

Depends on Task 1.

For all 15 rules in `packages/analyzer-typescript/src/rules/*.ts`, add
`example` to each of the 50 notFixes that names a `rule` (the recon file
lists every edge per rule). Each example is a small, complete TypeScript
snippet, typically 2-8 lines, showing the shortcut applied to a situation
like the rule's own `examples.bad`. It must be code an agent would
plausibly write to make the source rule's finding go away. Do not add
`example` to the 19 rule-less notFixes.

Process:
1. Write a first pass of all 50 examples.
2. `pnpm build && node packages/analyzer-typescript/test/sync-manifest.mjs`.
3. Run the closure check against the real manifest:
   `pnpm vitest run packages/core/test/conformance/suite.test.ts` (the
   "this repo's own analyzer" test) and/or
   `node packages/core/dist/cli/index.js verify-analyzer packages/analyzer-typescript/analyzer.manifest.json`
   (confirm the exact bin path from `packages/core/package.json`).
4. For every edge that fails, decide and record in the report:
   - The example was wrong (the shortcut as written does not exercise the
     named rule): rewrite the example.
   - The example is a faithful shortcut and the named rule does not catch
     it: that is a detection gap. Fix the rule's `check()` if the fix is
     local and clearly correct, with a fixture test under
     `packages/analyzer-typescript/test/fixtures/` and a case in the rule's
     test. If the gap is not fixable within budget, change the notFix to
     drop `rule` (making it a rule-less "bad idea" entry, which requires
     no example) and record the gap explicitly in the report under
     "Detection gaps found". Never leave a failing edge.
5. Final: `pnpm test` green, manifest regenerated and committed.

Report must contain a table: edge, outcome (passed first time / example
rewritten / rule fixed / edge dropped), one-line reason.

Commit in two commits if natural: examples, then any rule fixes.

## Task 3: Populate `example` for rust, csharp and unreal notFix edges

Time budget: 45 minutes.

Depends on Task 1. Independent of Task 2.

Edges: analyzer-rust 6, analyzer-csharp 2, analyzer-unreal 2, all in the
respective `packages/analyzer-*/analyzer.manifest.json` (hand-authored
JSON; no generation step). Add `example` to each. Python, eslint and
comments analyzers have no rule-bearing notFixes and need no change.

Toolchains present on this machine: cargo and dotnet are both on PATH.
Run each analyzer's conformance the same way Task 2 does, with that
analyzer's manifest path. If an analyzer's conformance cannot execute on
this machine for a reason unrelated to this change, say so in the report
with the exact error; do not guess whether the examples pass. Apply the
same failure-handling rules as Task 2 step 4.

Commit message subject: `Close the rust, csharp and unreal notFix edges
with examples`.

## Amendments after Task 1 review

- Batching stands: ONE analyze request over all example files. Per-edge
  requests would mean one analyzer invocation per edge (50 for
  analyzer-typescript), which exceeds the vitest timeout and makes the
  check unrunnable from the test suite.
- Because all examples share one analyzer project, an example that
  declares a top-level name another example also declares can collide and
  degrade type resolution, which in turn can make the named rule withhold
  its finding. Therefore: every `example` MUST contain at least one
  `export` so the file is a module and its declarations are scoped to it.
  This binds Task 2 and Task 3. An edge reported as "did not report" that
  turns out to be interference is fixed by isolating the example, not by
  weakening the check.
- Recorded-entry wording: the implementer's richer format is accepted in
  place of the format this plan first specified. It names the owning rule,
  the notFix pattern and the target rule, which is what the format was
  for. Diagnostic text only; never rendered.
