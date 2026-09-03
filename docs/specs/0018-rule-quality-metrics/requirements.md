# 0018 — Rule quality metrics: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0006, 0008

## Introduction

Every rule in this project already carries a name, a category, and a severity. What it does not carry
is any record of how it behaves once it is running against real code: whether it ever finds anything,
whether the team routes around it, whether its findings get fixed or just accumulate. That record
already exists — in the run history spec 0006 built, and the baseline and suppression list spec 0008
built beside it — but nothing reads it back as a judgement about the *rules themselves*.

This spec is that read-back, and it starts from a sentence spec 0008 already wrote in passing
(Requirement 3.6): **a rule that is suppressed everywhere is a rule the team disagrees with, and that
is information about the rule, not the team.** Every metric defined here exists to make statements of
that shape — about a rule, never about the people working around it.

The project has already paid for the hard lesson this spec is built on. The never-fired view in
`packages/core/src/dashboard/model.ts`, pointed at this repository at zero violations, once announced
that thirteen enabled rules had produced no finding and named every one as suspect. The truth was
simpler and duller: the codebase was clean, so every rule was trivially never-fired, and the view was
reporting silence as if it were evidence. The fix — recorded as T6002 in
`docs/specs/0006-web-dashboard/tasks.md` — was to report the *asymmetry*, how much other rules found in
the same runs, rather than the silence alone. That fix is the template for this entire spec: **every
metric here can be read two ways, and the wrong reading is always the flattering one** — flattering to
the rule when silence means "this rule doesn't need to fire," flattering to the team when a high
suppression rate means "this rule is simply wrong," never the less comfortable alternative. A metric
that cannot tell the two readings apart has no business producing a verdict, and Requirement 1 makes
that refusal the spine of this spec rather than a caveat appended to each metric afterward.

## Requirement 1 — Evidence before verdict

**User story:** As a team reading a rule-quality report, I want a metric that has not seen enough to
mean anything to say so plainly, so that I never mistake "not enough data" for "this rule is fine" or
"this rule is broken" — both of which are verdicts, and neither of which a silent zero is entitled to
assert.

1.1. Every metric defined in this spec SHALL declare, as part of its own definition, the minimum
   evidence it needs before it produces a verdict — a minimum fired count, a minimum number of recorded
   runs, or a minimum elapsed time, as fits the metric.

1.2. WHEN a metric's minimum evidence is not met THEN it SHALL report a distinct "insufficient
   evidence" state, named as such. It SHALL NOT report a zero, an empty list, or any value a reader
   could mistake for a computed answer. `NeverFiredView`'s three states (`no-history`, `no-evidence`,
   `never-fired`) are this spec's precedent for what "distinct" means in practice, not an example to
   imitate loosely.

1.3. A metric's "insufficient evidence" state and its "evidence exists and the honest answer is zero"
   state SHALL both be representable and SHALL be visually and programmatically distinguishable
   wherever the metric is rendered. Collapsing them is the exact failure this requirement exists to
   rule out.

1.4. Every metric SHALL also declare the action a team is meant to take from a genuine, evidence-met
   reading. A metric with no stated action is decoration, not a metric, and SHALL NOT ship as part of
   this spec's surface. "Consider deleting the rule" is an acceptable action; "notice the number" is
   not.

1.5. For each metric defined in Requirements 2 through 5, this spec states explicitly what the
   confounded reading is — the plausible alternative explanation that produces the same raw number for
   a reason having nothing to do with rule quality — and what evidence distinguishes the two. This is
   required of every metric individually; a metric whose confound is not stated has not been designed
   yet, only measured.

## Requirement 2 — Rules that never fire

**User story:** As a team maintaining a rule pack, I want to know which enabled rules have never caught
anything, so I can ask whether they are redundant, mis-targeted, or simply waiting for a pattern this
codebase has not produced yet — without being told the codebase itself is broken.

2.1. This metric SHALL be computed from the enabled rule manifest set and the run history's per-run
   `ruleCounts` (`packages/core/src/dashboard/history.ts`), exactly as `buildNeverFiredView` and
   `computeNeverFired` in `packages/core/src/dashboard/model.ts` already do. This spec adopts that
   implementation as the canonical form of Requirement 1 applied to this metric, and does not propose a
   second one.

2.2. The confounded reading: a codebase where **no** rule has fired in any recorded run looks
   identical, one rule at a time, to a codebase where every other rule fires constantly and one
   specific rule never does. Only the second is evidence about that rule. The minimum evidence for this
   metric is therefore not "at least one recorded run" but "at least one recorded run in which some
   other enabled rule fired" — the asymmetry `NeverFiredView`'s `no-evidence` state already gates on.

2.3. WHERE the evidence in 2.2 is met, a rule that still produced zero findings across every recorded
   run genuinely indicates one of: the rule is redundant with another that fires on the same shape, the
   rule's pattern does not occur in this codebase's style, or the rule is wired incorrectly and
   silently never runs. It does NOT, on its own, indicate which of the three — that judgement is the
   team's, not the metric's.

2.4. Action: for a rule meeting 2.2's evidence bar, a team SHOULD confirm the rule still matches its
   intended pattern against a fixture, and if it does, ask honestly whether the pattern is one this
   codebase's other conventions already prevent structurally. Where the answer is yes, deleting the
   rule is the correct action, not leaving it enabled to explain to every new contributor.

## Requirement 3 — Rules suppressed most often

**User story:** As a team lead reading suppression data, I want to know which rules the team routes
around, and to be able to tell a rule with real evidence of disagreement apart from a rule that has
barely fired at all, so a single early suppression does not read as a verdict.

3.1. This metric SHALL be computed from active suppressions (`loadSuppressions`,
   `evaluateSuppressions` in `packages/core/src/baseline/suppressions.ts`) matched against violations,
   cross-referenced with that rule's total fired count from run history (Requirement 2.1's source). The
   reported quantity is a suppression RATE — suppressed count over fired count — never a raw suppressed
   count in isolation.

3.2. The confounded reading, first form: a rule that has fired twice and been suppressed both times
   reports the same 100% rate as a rule that has fired five hundred times and been suppressed five
   hundred times, but only the second is evidence of anything. The minimum evidence for this metric is
   a minimum total-fired count, below which the rule's state SHALL be "insufficient evidence," not a
   rate.

3.3. The confounded reading, second form: a single suppression entry with a broad glob target can match
   hundreds of violations from one decision, made once, by one person, at one time — indistinguishable,
   as a raw suppressed-violation count, from the same rule being independently suppressed by hundreds
   of separate, narrowly-targeted entries written over months by many people. Those are different
   facts. This metric SHALL report both the suppressed-violation count and the count of distinct
   suppression entries contributing to it, and SHALL NOT collapse the two into one number.

3.4. Genuinely indicates, with 3.2's bar met: a rule with a high, broad-based suppression rate is a
   rule a meaningful fraction of the team disagrees with in practice, per 0008 Requirement 3.6. It does
   NOT indicate the rule is wrong outright — a rule correctly catching a real but low-priority pattern
   during a deliberate migration window is expected to show exactly this shape for that window, which
   is why the suppression's required `reason` field (0008 Requirement 3.1) is part of what this metric
   surfaces, not just the rate.

3.5. Action: this metric SHALL surface a sample of the actual suppression `reason` text alongside the
   rate, not the rate alone — the reasons are the qualitative signal a number cannot give, and this
   project already requires every suppression to carry one for exactly this purpose. Where the evidence
   and the reasons agree the rule is broadly disputed rather than temporarily deferred, "consider
   deleting the rule," loosening its default severity, or narrowing its options are all actions this
   metric SHALL be capable of recommending explicitly.

## Requirement 4 — Time to fix, and deferral without end

**User story:** As a team wanting to know whether a rule's findings get fixed or just pile up in the
baseline, I want an honest answer built from data that actually exists, not a precise-looking number
built by inventing data that does not.

4.1. What this metric can be computed from, precisely: two or more recorded points in time — either two
   `RunRecord`s from run history (`packages/core/src/dashboard/history.ts`), or two
   `cyv baseline --status` snapshots (`packages/core/src/baseline/status.ts`) — compared for a given
   rule's fired count or baselined count. This yields a *bounded window*: some number of that rule's
   violations were resolved somewhere between the two timestamps. It does not yield *which* violations,
   nor a point-in-time duration for any one of them.

4.2. What this metric SHALL NOT claim: a duration for an individual violation ("this finding took six
   days to fix"). Neither `RunRecord` (aggregate `ruleCounts`, per rule, per run) nor a `BaselineEntry`
   (a single point-in-time snapshot with no fix-timestamp field, see `packages/core/src/baseline/types.ts`)
   records when a specific `(path, ruleId, fingerprint, occurrence)` identity first appeared or stopped
   matching. Two baseline entries of the same rule that took very different numbers of days to clear
   are indistinguishable in the data that exists today, and this spec SHALL NOT report a number that
   looks precise when it is not.

4.3. Per Requirement 8, this gap SHALL be declared rather than filled by inventing collection: no new
   persisted per-violation timestamp store, and no reconstruction by mining the committed baseline
   file's git history. That is tempting, since the baseline is committed and diffable per 0008
   Requirement 1.4 — but correctly handling a squashed, rebased, or force-pushed history to recover
   per-entry fix dates is a distinct, non-trivial capability this spec does not design and does not
   assume exists.

4.4. What this metric SHALL ship instead: a per-rule burn-rate figure — count remaining for rule X now
   versus count remaining for rule X at an earlier recorded point — reported as "resolved somewhere
   between run A and run B," never as a point estimate or an average duration. The minimum evidence is
   two recorded points for that rule; fewer than two reports "insufficient evidence," reusing the
   precedent `buildTrend`'s `insufficient-data` state already set (0006 Requirement 4.5).

4.5. "Deferred indefinitely" reads as: a baseline entry whose rule and file still match at every
   recorded observation across a stated minimum span since the baseline was taken — bounded by
   observation, never asserted as a claim about intent. The confound: a young baseline entry looks
   identical, at a single glance, to a permanently deferred one. The minimum evidence is a minimum
   elapsed time, or minimum number of recorded status checks, since `BaselineHeader.takenAt`, below
   which this metric SHALL report "insufficient evidence" rather than "indefinitely deferred."

4.6. Action: rules whose baselined findings persist the longest, once 4.5's bar is met, are a candidate
   for a team decision this metric SHALL name explicitly as the choice being deferred: schedule the
   fix, or accept the debt permanently and reconsider whether the rule belongs enabled at its current
   severity — not leave it as baseline noise nobody has actually decided about, which is the failure
   0008 Requirement 5 already exists to prevent at the whole-baseline level.

## Requirement 5 — Rules that fire too often to be catching something real

**User story:** As a team seeing one rule dominate a run's findings, I want to know whether it is
catching a real widespread problem or is simply too broad to be useful, without being told those look
the same from a raw count alone — because they do.

5.1. This metric SHALL be computed from per-run `ruleCounts` relative to that run's `filesChecked`
   (`packages/core/src/dashboard/history.ts`), expressed as a findings-per-file-checked rate, compared
   against the same run's *other enabled rules'* rates — never against a fixed absolute threshold. This
   is the same asymmetry discipline the never-fired fix established: a raw count means nothing on its
   own; what a rule found relative to what its peers found in the same run is the signal.

5.2. The confounded reading: a rule firing far above its peers' rate reads identically whether it is
   (a) too broadly scoped, matching a shape wider than the actual problem, or (b) correctly and
   narrowly scoped against a codebase with a genuinely widespread real problem. A single run cannot
   distinguish them — a large generated file, one bad merge, or a rule freshly enabled against
   pre-existing code before a baseline was taken can each produce (a)'s number while meaning neither.
   The minimum evidence is the outlier rate sustained across multiple recorded runs, not one.

5.3. What distinguishes (a) from (b), where 5.2's bar is met, is not computable from this metric alone:
   it is read off Requirement 3 and Requirement 4 — is the outlier rule's disposal rate (suppressed, or
   resolved) comparable to its peers, or disproportionate? A high-firing rule whose findings get fixed
   at an ordinary rate is plausibly catching something real; one whose findings are suppressed or
   baselined at a rate its peers are not is a stronger signal of (a). This metric SHALL be reported
   alongside that context, never as a fire-count in isolation — a bare "rule X fired 400 times" is
   exactly the number this whole spec exists to refuse to publish unadorned.

5.4. Action: narrow the rule's pattern or options, split it into two rules of different confidence (the
   `evidence: 'syntax' | 'semantic'` field spec 0009 added is one axis a split could follow), or — where
   5.3's cross-check shows the rule is doing its job against a real, widespread pattern — leave it
   enabled and treat the count as the honest size of the problem it found. This metric SHALL NOT
   recommend or perform automatic disabling; a human reads a sample of the actual findings before
   acting on any of these.

## Requirement 6 — Never a leaderboard, never a score

**User story:** As a team using this report to decide what to do next, I want numbers I can act on
directly, not a single figure that only tells me to move the figure.

6.1. This spec SHALL NOT compute, store, or display a composite "rule quality score" — any function
   combining two or more of Requirements 2 through 5's metrics into a single ranked value.

6.2. This extends 0008 Requirement 5.5 ("no scores, no streaks") without qualification, and for a
   stronger reason than burn-down had. A burn-down number describes a team's own remaining work, chosen
   and owned by the team that reads it. A rule-quality score would describe someone else's decision —
   which rule to write, keep, tighten, or delete — collapsed into a number that invites being *moved*
   rather than acted on. Faced with a bad score, the path of least resistance is not the honest response
   Requirements 2 through 5 each name (fix it, delete it, narrow it, or leave it and say why) — it is
   whatever nudges the number: loosen the rule, or route suppressions to avoid the metric watching them.
   A number nobody can act on directly, but everybody can move indirectly, is worse than no number,
   which is why this spec refuses to build one rather than building one carefully.

6.3. A sorted list of one metric at a time, showing its own real value per rule — the same pattern
   `StatusReport.byRule` already uses (`packages/core/src/baseline/status.ts`) — is data, not a score,
   and remains permitted. The line this requirement draws is at combination: the moment two different
   metrics are added, weighted, or averaged into one figure that ranks rules against each other, it has
   crossed from a sorted list into a leaderboard, and 6.1 applies.

## Requirement 7 — This must not become a measure of people

**User story:** As a developer working under these rules, I want a guarantee that nothing here can be
turned into a report about me, so that using this tool honestly never becomes a professional risk.

7.1. No metric in this spec SHALL be keyed, grouped, filtered, or joined by commit author, committer,
   assignee, reviewer, or any other identity of a person. Every metric in Requirements 2 through 5 is
   per-rule, and where a finer grain is useful, per-file or per-directory — the same grain
   `StatusReport.byFile` already reports at, and no finer than that.

7.2. Requirement 4 (time to fix) is the sharpest case, because it is the metric one join away from a
   person: `RunRecord.commit` already records a commit hash, and resolving an author from that hash is
   one command away. That join SHALL NOT be implemented anywhere this spec's surface reaches — not in a
   report, not in an export, not behind a flag, not as an "advanced" or "debug" option.

7.3. No export format this spec defines SHALL include a per-violation blame, commit author, or
   committer field, and no command this spec defines SHALL accept an option to group its output by
   author.

7.4. Stated plainly, because it is the reason for 7.1 through 7.3 and not merely their consequence: the
   moment "which rule gets suppressed most" becomes readable as "who suppresses rules most," or "how
   fast findings get fixed" becomes "whose commits take longest," this tool has stopped measuring rules
   and started measuring the people who write code under them — exactly what this spec's founding
   premise refuses. A tool that makes it easy to build a per-developer shame report is a tool
   developers will find a way to stop running, correctly, and that would cost the project every metric
   in this spec, not only the one that got misused.

## Requirement 8 — Where the data comes from, and where it stops

**User story:** As someone deciding whether to turn this on, I want confidence that nothing here calls
out to a network, needs a credential, or spends a token, so enabling rule-quality metrics carries none
of the cost this project has always refused to add.

8.1. Every metric in this spec SHALL be computed only from data already produced by this project: the
   run history (`readHistory`, `packages/core/src/dashboard/history.ts`), the baseline
   (`readBaseline`/`Baseline`/`BaselineEntry`, `packages/core/src/baseline/types.ts`), and the
   suppression list (`loadSuppressions`, `packages/core/src/baseline/suppressions.ts`). This spec SHALL
   NOT introduce a new persisted store to compute any metric it defines.

8.2. A metric that cannot be computed from those three sources at their current shape SHALL be declared
   as such — the specific missing input named — rather than have new collection invented to produce it.
   Requirement 4 is this spec's standing example: it ships the burn-rate proxy today's data supports and
   explicitly declines to invent per-violation timestamping to compute a sharper number.

8.3. No code path this spec defines — computing a metric, rendering it in the dashboard, or printing it
   from the CLI — SHALL make a network request, require an API key, or spend a language-model token.
   This project's standing constraint (`docs/ROADMAP.md`, "Subscriptions, not metered APIs") already
   forbids this generally; this spec states it again specifically because every metric here is
   arithmetic over data already on disk, and a reviewer should not have to infer that from the general
   rule.

8.4. A metric lacking the evidence Requirement 1 requires SHALL wait for more runs to accumulate. It
   SHALL NOT be backfilled by synthesizing plausible historical data, and SHALL NOT be filled by
   replaying old commits through an analyzer to manufacture runs that `--record-history` never actually
   recorded — a replayed run reflects today's rule set applied retroactively, not what actually fired at
   the time, and would look exactly like real evidence while being exactly the confound Requirement 1
   exists to catch.

## Non-goals

Automatic rule disabling or deletion triggered by any metric — every action this spec names is a
recommendation a human acts on, never a side effect of a report running. A composite score in any form
(Requirement 6). Author or committer attribution of any kind (Requirement 7). Continuous or
live-updating metrics computed on every edit — these are report-time computations over recorded
history, not another watch-mode surface. Cross-repository or cross-team comparison — benchmarking one
team's suppression rate against another's would reintroduce the leaderboard Requirement 6 refuses, at a
larger and more damaging scope. Alerting or notification when a metric crosses a threshold — decoration
that becomes nagging, and the kind of feature that would need naming a specific messaging product this
project's rule guidance already refuses to name. Per-violation fix-time tracking via new persisted
timestamps (Requirement 4.3) — declared out of scope, not merely deferred.

## Open questions

- **Rule tenure for the never-fired metric.** `RunRecord` records what fired, not which rules were
  enabled at the time. A rule enabled only for the last few recorded runs currently reads identically
  to one that has been enabled and silent for the whole recorded history, and `runCount` is the only
  proxy a reader has for telling them apart today. Recording the enabled rule set per run would fix
  this precisely, but that is new collection Requirement 8.2 declares out of scope for this spec rather
  than invents — worth its own follow-up if the imprecision proves to matter in practice.
- **Where the sorted-list-versus-leaderboard line sits for visual treatment, not just combination.**
  Requirement 6.3 draws the line at combining metrics into one figure; it does not settle whether, say,
  color-coding a single metric's rows by the severity of the value (a rule at a 95% suppression rate
  rendered differently from one at 20%) crosses from "showing a real number clearly" into the same
  competitive framing a composite score would create. Left to spec 0031, which owns the actual
  dashboard surface.
- **Whether the suppression-rate evidence minimum (Requirement 3.2) should be a fixed constant or
  configurable.** A fixed number matches this project's general aversion to knobs nobody asked for, but
  an unmotivated constant is exactly the kind of number that deserves a second opinion before it ships.
- **What "peer rules" means for Requirement 5's asymmetry baseline** — the same category, the same
  pack, the same analyzer, or every enabled rule regardless of grouping? This spec assumes a comparison
  group exists without settling which one; getting it wrong would understate or overstate the asymmetry
  depending on how rules happen to be grouped in a given repository.
- **Whether this spec needs a cold-start story of its own**, the way spec 0008 needed one for adoption.
  A team turning this on against a mature codebase starts with zero recorded runs and years of baseline
  debt whose age is genuinely unknown — Requirement 1's evidence gates will correctly report
  "insufficient evidence" for a long time in that case, which is honest but may read as the feature not
  working. Whether that deserves its own onboarding guidance, or is simply what honesty about a cold
  start looks like, is not resolved here.
