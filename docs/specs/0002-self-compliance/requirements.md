# 0002 — Self-compliance: Requirements

**Status:** complete
**Created:** 2026-08-26
**Depends on:** 0001 (core vertical slice)

## Introduction

Spec 0001 reached the point where checkyourvibe runs against its own source. It reported **94
violations** at that moment — and 158 by the time this spec opened, because 0001's later tasks added
code. They were real: the tool worked and this codebase did not pass it.

**Closed at 0.** See the Outcome section at the end.

This spec is about closing that gap honestly. The tempting alternative — adding exclusions until the
run goes green — would make the self-check a decoration. A tool that exempts itself from its own
standards has no standing to enforce them on anyone else.

## Baseline

Measured at the close of 0001, `cyv check --all`, 57 files:

| Rule | Count | Character of the findings |
|---|---:|---|
| `no-non-null-assertion` | 47 | Overwhelmingly `arr[i]!` / `dp[i-1]!`. With `noUncheckedIndexedAccess` on, indexing yields `T \| undefined`, and the code silences it rather than handling it. Concentrated in the merge module's diff loop. |
| `no-as-cast` | 43 | Casting after validation, and `err as NodeJS.ErrnoException` in catch blocks. Mostly in the loaders that consume `unknown` input. |
| `no-json-parse-cast` | 2 | Configuration loading types the parse result directly. |
| `no-any` | 2 | Remaining inferred-`any` bindings. |

Split roughly evenly between `src` (50) and `test` (44).

The concentration is informative rather than embarrassing: **the violations cluster exactly where the
codebase meets untrusted input** — parsing configuration, reading manifests, handling errno objects,
walking arrays. That is precisely the territory these rules exist to govern, so the findings are
evidence the rules are aimed correctly.

## Requirement 1 — No exemption-driven greening

1. This work SHALL NOT be closed by adding rule exclusions, per-file disables, or `exclude` globs to
   `checkyourvibe.json` in order to reduce the count.
2. WHERE an exemption is genuinely warranted, it SHALL be recorded in configuration with a written
   reason naming why the code cannot satisfy the rule.
3. Test fixtures that deliberately contain violations (`packages/*/test/fixtures/**`) SHALL remain
   excluded; their whole purpose is to contain the patterns the rules detect.

## Requirement 2 — Index access

1. Every `no-non-null-assertion` violation arising from index access SHALL be resolved by handling the
   `undefined` case, not by relocating the assertion.
2. WHERE a loop invariant genuinely guarantees presence, the code SHALL express that invariant in a
   way the checker can verify — restructuring the loop, destructuring with a default, or an explicit
   guard — rather than asserting it.
3. Performance-sensitive paths SHALL be measured before any exemption is considered on performance
   grounds.

## Requirement 3 — Boundary validation

1. Every `no-as-cast` and `no-json-parse-cast` violation on data entering from outside the process
   (configuration files, analyzer manifests, hook payloads, subprocess output) SHALL be resolved with
   a validating type guard that actually inspects the value.
2. The project SHALL NOT adopt a third-party validation library to do this. Rule guidance deliberately
   names no validator, and the implementation must be able to stand behind that.
3. `err as NodeJS.ErrnoException` in catch blocks SHALL be replaced by a predicate that checks for the
   properties actually used.

## Requirement 4 — Tests are not exempt

1. Test code SHALL satisfy the same rules as source, excepting the fixture directories in 1.3.
2. WHERE a test needs a deliberately malformed value, it SHALL construct it through a helper whose
   own types are honest, rather than casting inline.

## Requirement 5 — CI enforcement

1. WHEN this spec completes, CI SHALL run `cyv check --all --strict` as a blocking step.
2. Until then, CI MAY run it as a reporting-only step, and the count SHALL be visible in the run.
3. The baseline count SHALL be recorded in this document and updated as it falls, so the direction of
   travel is auditable.

## Non-goals

Adding rules, adding analyzers, adding agent integrations, or changing rule semantics to make existing
code pass. If a rule turns out to be wrong, that is a bug fixed on its own merits and evidence — not a
means of reducing this number.

## Outcome

`cyv check --all --strict` now reports **0 violations** across 112 files.

The self-compliance count opened at **158** and closed at **0**. No exemptions survived: every remaining
source violation was resolved with a hand-written type guard or an explicit `undefined` check, following
the patterns already established in `packages/core/src/config/load.ts`,
`packages/core/src/registry/load.ts`, and `packages/core/src/merge/apply.ts`. The test suite remained at
**307 passing tests**.

CI now runs the self-check as a blocking step. `.github/workflows/ci.yml` sets up .NET 9, builds the C#
analyzer with `dotnet build -c Release` in `packages/analyzer-csharp/src`, then runs
`node packages/core/dist/cli/index.js check --all --strict`.
