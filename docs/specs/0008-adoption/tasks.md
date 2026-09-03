# 0008 — Adoption on an existing codebase: Tasks

**Status:** active

## Done

- [x] **T8001** The baseline file, and the command that writes it
  `cyv baseline` records every current violation with a durable identity (rule, file, and a
  normalised snippet rather than a bare `file:line`, so an added import above a finding does not
  invalidate it), the commit it was taken against, and when. One entry per line, sorted, so a diff
  shows a team accepting new debt. Writing it is always an explicit act and never a side effect of a
  check.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/baseline/**_

- [x] **T8002** `cyv check --since-baseline`, and the line that keeps it honest
  Reports only violations absent from the baseline, recognises a moved-but-unchanged violation as the
  same one, and names baseline entries that no longer match anything. The deferred count prints on
  **every** run, not only under `--since-baseline` — a mode that reports a clean run while knowing
  about unfixed violations is the one thing Requirement 4.4 forbids.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/cli/check.ts_

- [x] **T8003** Suppression with a reason and an expiry
  A suppression carries a written reason and an expiry date; neither is optional, and there is no
  path through the loader that produces one without both. A suppression naming an unknown rule is a
  configuration error, because that is what a rename nobody propagated looks like.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/baseline/suppressions.ts_

- [x] **T8004** Burn-down: `cyv baseline --status`
  Remaining count by rule and by file, the files where effort pays best, and baseline entries whose
  rule is no longer enabled. A number and a direction — no scores, no streaks.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/baseline/status.ts_

## Open — found by dogfooding

- [x] **T8005** Suppressions are inert in the enforcement path
  Found by reading `cyv check` against Requirement 3 rather than against its tests. `check.ts` loads
  the baseline and never loads suppressions: nothing is ever suppressed by a check run, so
  Requirement 3.3 ("an expired suppression's violation SHALL be reported again") is vacuously
  satisfied by a violation that was never hidden. Suppressions are validated and counted by
  `cyv baseline --status` alone — a validator for a feature that does not exist.
  This is the same failure this project keeps finding in itself: the code is present, the tests pass,
  and the wiring is missing. Apply suppressions in `check`, report the active count and the number
  expiring within 30 days on every run (Requirement 3.4), and report an expired suppression by name
  at the moment its violation comes back.
  Done. `cyv check` now loads and applies them, exits 2 on a suppression naming an unknown rule,
  prints the active and expiring counts and the number suppressed on every run, and names an expired
  suppression at the moment its violation reappears.
  _Exec: executor=devin model=swe gates=tsc,test,self-check files=packages/core/src/cli/check.ts,packages/core/src/run/check.ts,packages/core/test/**_

- [x] **T8009** A suppression is per-file, and Requirement 4.3 says that is too coarse
  Raised by the implementation of T8005, honestly, in its own doc comment. A `Suppression` carries a
  `ruleId` and a `target` glob and nothing else — no snippet fingerprint, no occurrence index — so it
  suppresses *every* occurrence of that rule under the matched path. A new violation of the same rule,
  added to a file already covered, is silently suppressed the moment it is written.
  Requirement 4.3 forbids exactly this: "Per-file suppression is too coarse and is how baselines become
  permanent." The baseline already solved the same problem with a durable
  (path, ruleId, fingerprint, occurrence) identity in `baseline/identity.ts`; a suppression should use
  it. This cannot be fixed by a cleverer matcher — the fields are not in the schema.

  The first use of this feature proves the point. The agent that built it needed
  `check --all --strict` to exit 0 while a separate rule was being narrowed, and wrote a suppression
  covering `packages/core/src/**` for a whole rule. The feature let it, in one line, with a reason
  that reads as reasonable. That is the failure mode.
  Until this lands, the run's "N findings suppressed this run" count is the only thing standing
  between a wholesale suppression and invisibility. Keep it prominent.
  Done. A suppression now takes one of two forms. Without a `fingerprint` it is the path glob it
  always was, and the run still names it as unpinned. With one, `occurrence` is required and
  `target` must be an exact repo-relative path, so the four fields spell out a `BaselineEntry` key
  and `evaluateSuppressions` matches them through `entryKey` — a pinned suppression defers at most
  one finding, and writing new code cannot increase what is hidden.
  The two fields existed before this task closed but narrowed nothing: a fingerprint hashes the
  offending snippet, and for `no-any` that snippet is the word `any`, identical in every file.
  On a scratch repository with three `no-any` findings across two files, one suppression carrying a
  glob target and that shared fingerprint deferred all three and the run exited 0. That
  configuration is now rejected at load; the pinned form defers one and reports the other two.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/baseline/suppressions.ts,packages/core/src/baseline/identity.ts,docs/protocol/config.schema.json,packages/core/test/baseline/**_

- [x] **T8006** The backstop is not baseline-aware
  Requirement 4.1: `cyv check --staged --strict` in a pre-commit hook must default to baseline-aware
  behaviour, or adopting the hook blocks every commit on pre-existing debt and the team removes the
  hook. Neither the installed hook nor `install-hooks` mentions the baseline today. It must stay
  baseline-*aware*, not baseline-*silent*: the total, including deferred findings, is reported on
  every run, and a new violation in a file that already has baselined ones is still reported (4.3).
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/cli/install-hooks.ts,packages/core/src/hooks/**_

- [x] **T8007** `cyv init` does not offer a baseline
  Requirement 6.1. Running `init` on a repository with thousands of violations currently ends with a
  wall of findings and no path forward, which is the exact moment adoption fails. Offer to take a
  baseline, and explain plainly that it defers debt rather than resolving it — never take one without
  being asked.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/cli/init.ts_

- [x] **T8008** Documentation: the adoption path
  Requirement 6.2 and 6.3. Baseline, gate new code, burn down deliberately — and an honest statement
  that a baseline is deferred debt. Belongs beside the README section written for the sceptical
  reader, not in a separate document nobody opens.
  _Exec: executor=claude model=sonnet gates=none files=README.md,docs/adoption.md_

## Tracked elsewhere

Requirement 3.6 — suppressions visible in the dashboard beside the rules they suppress — is
[T6005](../0006-web-dashboard/tasks.md), because it is a dashboard change rather than an adoption
one. T8005 has landed, so it is no longer blocked; it should show the coarseness described in T8009
rather than presenting a path-glob suppression as if it named a single finding.
