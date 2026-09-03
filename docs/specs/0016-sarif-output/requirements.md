# 0016 — SARIF output: Requirements

**Status:** complete
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

`cyv check --sarif` emits SARIF 2.1.0, the format GitHub's code scanning tab and other security
tooling consume. A pure output format with no new analysis behind it — the same `RunReport` every
other renderer already consumes — so the roadmap called it cheap. It is the difference between a
local tool and one a security team will accept without a bespoke import step.

## Outcome

`renderSarif(report, repoRoot)` produces a `runs[0]` with a `tool.driver` naming every rule that
fired, a `results` array of findings, an `invocations` entry, and a `properties` block. `cyv check
--sarif` writes it to stdout; `--json` and `--sarif` together is a parse-time error, not a silent
choice between them, because there is exactly one stdout and two formats claiming it. CI runs the
check once, uploads the file regardless of the check's own exit code, and only then acts on that
exit code — covered in its own section below.

## Requirements met

1. `$schema` and `version: '2.1.0'` are present and correct; `tool.driver.name` is `checkyourvibe`
   with a repository `informationUri`.
2. Each fired rule appears once in `tool.driver.rules`, built from the `RuleGuidance` carried on its
   first violation — `shortDescription` from `summary`, `fullDescription` from `why`.
3. `help.markdown` renders `allowedFixes` under an "Allowed fixes" heading and, when present,
   `notFixes` under a "Do not" heading, each entry naming the pattern, the reason, and — when the
   `notFixes` entry has a `rule` field — which sibling rule it would trip instead. A rule with no
   `notFixes` gets no "Do not" section rather than an empty one.
4. `properties.analyzer` and `properties.evidence` are set on a rule when the report carries that
   information (`report.ruleAnalyzers`, `guidance.evidence`), and omitted — not emitted empty —
   when it does not.
5. Every result's `locations[0].physicalLocation.artifactLocation.uri` is repository-relative with
   forward slashes on every platform, and carries a `ruleIndex` into the driver's rule array.
6. `region` carries `startLine`/`startColumn` always, `endLine`/`endColumn` only when the violation
   has them.
7. Severity maps to SARIF level: `error` stays `error`; every other severity becomes `warning`.
8. `--json` and `--sarif` together throws before any analysis runs, with a message naming both flags
   and explaining they are two formats for one stdout.
9. The baseline/suppression notice — the one line that reports a deferred count — goes to stderr
   whenever a machine format (`--json` or `--sarif`) is selected, so stdout stays parseable by a
   SARIF or JSON consumer and the notice still reaches a human running the command directly.

## The repository root cannot be inferred from the findings

The first implementation took no `repoRoot` argument and inferred one from the common directory of
the files in the report's violations, on the theory that a run over an entire repository would
naturally converge on the root. It is wrong in the ordinary case, not an edge case: a run over a
single file has that file's own directory as the common prefix of a one-element set, so the
"repository root" resolved to wherever that file lived, `path.relative` against it collapsed every
URI to a bare basename, and every result pointed at the wrong location in the repository.

Nothing in that path fails loudly. The SARIF is well-formed, `$schema` and `version` are correct,
and a consumer showing `file.ts:12` instead of `packages/core/src/report/file.ts:12` does not look
broken until someone clicks through and lands nowhere. `repoRoot` is now a required parameter to
`renderSarif`, threaded from the same `result.repoRoot` that `runCheck` already resolves for every
other renderer, so there is no inference step left to get wrong. The lesson generalizes past this
one function: a value that can be derived from the data in the common case and is wrong in the
narrow one should be passed in, not derived, the moment the narrow case is a real call path and not
a hypothetical.

## An empty results array is ambiguous, and SARIF has somewhere to say so

Zero results looks identical whether 149 files were checked and came back clean or whether the run
checked nothing — an empty glob, a repository with no matching files, a mode that skipped every
project-scoped rule. Every SARIF consumer this format targets renders both cases as "no alerts,"
because `results.length === 0` is the only signal most of them read.

The run now carries `invocations[0].toolExecutionNotifications` — one entry when `filesChecked` is
zero, stating plainly that nothing was examined, plus one per skipped file and one per
project-scoped rule that mode could not run — and `properties` with `filesChecked`, `mode`,
`strict`, and `rulesEnabled`. A consumer that only reads `results` still shows "no alerts"; the
distinction exists for the one that looks further, which is the best SARIF's own schema allows for a
format whose headline field has no room to distinguish "clean" from "unexamined."

## Separating the report from the gate

CI runs the check exactly once, captures its exit code, and only afterward decides what to do with
it — deliberately, not as an artifact of how the steps happened to get written. Folding the SARIF
upload inside the check step forces a choice between two failures: skip the upload whenever the
check step fails, which loses the report at exactly the moment someone would want to see what
tripped it, or make the check step succeed unconditionally so the upload always runs, which turns a
build gate into a notification with no enforcement behind it. Running once, uploading unconditionally
via `if: always()`, and gating on the recorded exit code afterward keeps both properties: the report
reaches the security tab every time, and the build still fails when the check does.

## Non-goals

SARIF rule `defaultConfiguration` or suppression states — this repository's own suppression model
(baseline, `since-baseline`, expiring suppressions) already exists and is reported separately, not
translated into SARIF's parallel mechanism. Multi-run SARIF logs; every invocation of `cyv check
--sarif` produces exactly one run. Baseline-aware SARIF output — `--sarif` reports the same
post-suppression violation set every other renderer does, and no flag currently changes that.
