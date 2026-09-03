# 0008 — Adoption on an existing codebase: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

Everything built so far assumes a codebase that already passes, or one small enough to fix. Neither
describes the projects this tool is for.

A team turning checkyourvibe on for the first time will see hundreds or thousands of violations. Their
options today are: fix everything before getting any value, disable the rules that hurt, or turn the
tool off. All three are failures, and the third is the likely one.

The evidence is close to hand. **This repository reports 96 violations against itself** — written
knowing the rules, by contributors told not to break them, with the checker running throughout. A
codebase that has never seen these rules is a different order of magnitude.

So the goal is not "make adoption easier". It is: **a team can turn this on today, block new
violations immediately, and burn down the existing ones on their own schedule** — without the tool ever
lying about what it checked.

## Requirement 1 — The baseline

**User story:** As a team lead, I want to record what is already broken, so that the tool can tell me
about new problems without drowning me in old ones.

1. `cyv baseline` SHALL record every current violation to a baseline file.
2. The file SHALL be committed to the repository — a baseline that lives only on one machine cannot
   gate a pull request.
3. Each entry SHALL identify a violation durably enough to survive unrelated edits to the same file.
   A bare `file:line` breaks the moment someone adds an import above it.
4. The format SHALL be reviewable in a diff. A reviewer must be able to see that a change *adds* to
   the baseline, because that is a team quietly accepting new debt.
5. It SHALL record when the baseline was taken and against which commit.
6. Regenerating the baseline SHALL be an explicit command, never an automatic side effect of a check.

## Requirement 2 — Reporting against the baseline

1. `cyv check --since-baseline` SHALL report only violations absent from the baseline.
2. A violation that has MOVED but not changed SHALL be recognised as the same violation, not reported
   as new.
3. WHEN a baselined violation no longer exists THEN the run SHALL say so, so the baseline can shrink.
4. The run SHALL always state how many baselined violations remain. A team that has forgotten it has
   4,000 suppressed findings is in a worse position than one that never adopted the tool, and this is
   the single most important line of output in this spec.
5. `--since-baseline` SHALL NOT be the default. A user who types `cyv check` sees the truth.

## Requirement 3 — Suppression with an expiry

**User story:** As a developer, I want to say "not this one, and here is why", without that becoming
permanent by accident.

1. A suppression SHALL carry a written reason. A bare ignore directive SHALL NOT be supported — this
   project's rule guidance argues against exactly that pattern, and shipping one would be incoherent.
2. A suppression SHALL carry an expiry date.
3. WHEN a suppression has expired THEN its violation SHALL be reported again, and the run SHALL name
   the expired suppression specifically.
4. `cyv check` SHALL report how many suppressions are active and how many expire within 30 days.
5. A suppression naming a rule that does not exist SHALL be a configuration error — the usual sign of
   a rename nobody propagated.
6. Suppressions SHALL be visible in the dashboard alongside the rules they suppress. A rule that is
   suppressed everywhere is a rule the team disagrees with, and that is information about the rule.

## Requirement 4 — The backstop still tells the truth

1. `cyv check --staged --strict` in a pre-commit hook SHALL default to baseline-aware behaviour, so
   adopting the hook does not block every commit on pre-existing debt.
2. It SHALL nonetheless report the total, including baselined violations, on every run.
3. WHERE a commit adds a violation to a file that already has baselined violations, the new one SHALL
   be reported. Per-file suppression is too coarse and is how baselines become permanent.
4. The tool SHALL NOT acquire a mode in which it reports a clean run while knowing about unfixed
   violations. Baselined findings are *deferred*, never *invisible*.

## Requirement 5 — Burn-down

**User story:** As a team, we want to see the debt shrinking, or know that it is not.

1. `cyv baseline --status` SHALL report remaining count, by rule and by file.
2. It SHALL identify the files with the most baselined violations — where effort pays best.
3. It SHALL identify baselined violations whose rule is no longer enabled, since those are dead
   entries.
4. WHERE run history exists (spec 0006), the trend SHALL be shown.
5. It SHALL NOT gamify this. No scores, no streaks. A number and a direction.

## Requirement 6 — Adoption path

1. `cyv init` SHALL offer to take a baseline when the repository has violations, and SHALL explain
   plainly what that means.
2. Documentation SHALL describe the intended path: baseline, gate new code, burn down deliberately.
3. Documentation SHALL be honest that a baseline is deferred debt, not a solution.

## Non-goals

Automatic fixing. Per-file rule disabling (too coarse — see 3.3). Any format that cannot be reviewed
in a pull request. Deleting baseline entries automatically when they stop matching, which would hide a
rule silently breaking.
