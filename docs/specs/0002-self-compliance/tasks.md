# 0002 — Self-compliance: Tasks

**Status:** active
**Baseline at spec open:** 158 violations across 90 files (69 `no-as-cast`, 47 `no-non-null-assertion`,
17 `no-console`, 13 `no-json-parse-cast`, 12 `no-any`).

The count is higher than the 94 recorded when 0001's milestone landed, because 0001's later tasks added
code. That is the system working: new code, new findings.

## Rules of engagement

- **No exclusions to reduce the count.** Requirement 1.
- **No validation library.** Our own rule guidance names none, so the implementation must stand behind
  that. Hand-written type guards.
- Fixture directories (`packages/*/test/fixtures/**`) stay excluded — they exist to contain violations.
- Every task must keep `npx tsc -b` and `npx vitest run` green. A fix that breaks a test is not a fix.

---

## Wave 1 — Make honest compliance expressible

- [x] **T2001** Per-path rule overrides in configuration
  17 of the violations are `no-console` in CLI command modules. A command-line tool writing to stdout
  is not a defect — `no-console` exists to stop *library* code printing. Today configuration has one
  global posture, so the only ways to resolve this are to disable the rule everywhere or to pretend
  the CLI is wrong. Both are dishonest.
  Add `overrides: [{ files: [glob...], rules: { ... } }]` to `checkyourvibe.json`, applied in order
  after the base `rules`, matched per file. Later overrides win. This is table stakes for any linter
  in a monorepo and it is the difference between a considered posture and a blanket exemption.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/config/**,docs/protocol/config.schema.json,packages/core/test/config/**_

## Wave 2 — Boundary validation (independent, parallel)

- [x] **T2002** `merge/apply.ts` and its tests — 37 violations
  Mostly `arr[i]!` and `dp[i-1]!` in the diff algorithm under `noUncheckedIndexedAccess`. Resolve by
  handling the `undefined` case or restructuring so the invariant is checkable — never by relocating
  the assertion. Measure before claiming any performance exemption.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/merge/**,packages/core/test/merge/**_

- [x] **T2003** Loaders that consume untrusted input — ~18 violations
  `registry/load.ts`, `config/load.ts`, `run/execute.ts`. These parse JSON from disk and subprocesses
  and then assert its shape. Replace each cast with a hand-written type guard that actually inspects
  the value, and replace `err as NodeJS.ErrnoException` with a predicate checking the properties used.
  This is the territory the rules were aimed at, so the fixes should read as better code, not as
  ceremony.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/registry/**,packages/core/src/config/load.ts,packages/core/src/run/execute.ts,packages/core/test/registry/**_

- [x] **T2004** Analyzer and adapter packages
  `analyzer-typescript` and `adapter-claude-code` source and tests.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/analyzer-typescript/**,packages/adapter-claude-code/**_

## Wave 3 — Depends on T2001

- [x] **T2005** CLI modules
  `cli/init.ts`, `cli/doctor.ts`, `cli/index.ts` and friends. Once overrides exist, declare the CLI's
  posture explicitly in `checkyourvibe.json` with a written reason, then fix the remaining casts and
  assertions on their merits.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/cli/**,packages/core/test/cli/**_

- [x] **T2006** Remaining test files
  Test code is not exempt. Where a test needs a deliberately malformed value, build it through a helper
  whose own types are honest rather than casting inline.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/test/**_

## Wave 4 — Close it

- [x] **T2007** Flip CI to blocking
  `cyv check --all --strict` becomes a required step; drop `continue-on-error`. Record the final count
  and every surviving exemption with its reason in `requirements.md`.
  _Exec: executor=self model=opus gates=tsc,test,self files=.github/workflows/ci.yml,checkyourvibe.json,docs/specs/0002-self-compliance/requirements.md_

## Execution log

| Task | Lane | Attempt | Gates | Violations after | Notes |
|---|---|---|---|---|---|
