# 0036 — The orchestrator's own survival

**Status:** active
**Created:** 2026-08-31
**Depends on:** 0011

## Introduction

Spec 0011 built the executor surface and then declined, explicitly, to solve one
problem it had identified:

> This spec does not resolve how orchestrator exhaustion would be surfaced from
> inside the orchestrator's own session; see Open Questions. — 0011 R6.3

This spec resolves it, and closes the two defects that make it urgent.

The asymmetry 0011 named is real and is not going away: cyv is invoked **by**
the orchestrator, so there is no subprocess for cyv to watch fail. An exhausted
caller simply stops calling. Every dispatched lane can be healthy, idle, and
paid for, while nothing is scheduled and nobody is told. That is a silent
success — the failure mode this project's second principle names as the enemy.

The consequence is not evenly distributed. A dispatched lane hitting its limit
costs one task, and 0011 R7.4 already routes around it. The orchestrating lane
hitting its limit costs **the whole run**, and leaves every other subscription
the user pays for sitting idle. The orchestrator is the single point of failure
in a design whose entire value proposition is not having one.

### What is already broken, today, in this repository

Two findings, both from reading the current configuration and code rather than
from reasoning about them:

**The orchestrating lane is also the first-choice judgment lane.**
`checkyourvibe.json` declares `claude-code-cli` with `orchestrator: true`, and
that same lane's `judgment-required` ordering is `["opus", "sonnet"]` — first in
the list. Every judgment task dispatched during a run is charged to the same
subscription that is planning the run. The orchestrator competes with itself for
its own quota, and wins right up until it loses everything.

**An abandoned dispatch is indistinguishable from a running one.** A dispatch
writes an `opened` entry when scheduled and a `closed` entry when it finishes
(`executor/store.ts`). There is no pid, no heartbeat, and no lease. An
orchestrator that dies mid-run leaves `opened` entries that no longer correspond
to any process, and they read as in-flight forever. 0011 R6.4 requires a second
orchestrator to be able to read full state from disk — it can, but it cannot
tell which of that state is still true. This is the same failure AGENTS.md
records against spec 0033, where a dispatched agent died mid-run and left work
nobody could account for.

### What this spec may not do

0011 R7.1 stands unchanged and this spec inherits it: **a subscription's
remaining quota is not observable.** Nothing here queries a usage endpoint,
estimates a token budget, or draws a meter implying the account's real headroom
is known. The orchestrator's own quota is no more observable than any other
lane's — less so, because cyv is downstream of it.

Everything below is therefore built from three things only: what the
configuration declares, what the dispatch log records, and what the orchestrator
says about itself while it still can.

## Requirement 1 — The orchestrating lane does not spend itself on dispatched work

**User story:** As a user driving a run from one subscription, I want that
subscription's capacity reserved for planning, reviewing and dispatching, so
that the session which keeps everything else moving is not the first one to run
out.

1.1. A lane declaration SHALL support an `acceptsDispatch` boolean, stating
   whether the lane may receive ordinary dispatched work.

1.2. WHEN a lane declares `orchestrator: true` and does not declare
   `acceptsDispatch` THEN `acceptsDispatch` SHALL default to `false`. The lane
   that drives the run is not a dispatch target unless its author says so.

1.3. WHEN a lane declares `orchestrator: true` and `acceptsDispatch: true` THEN
   the configuration SHALL load and the lane SHALL be an eligible target, and
   the run SHALL report that the orchestrating lane is accepting dispatched work
   and is therefore spending the capacity the run depends on. Self-dispatch stays
   permitted — 0011 R6.2 requires it to be governed, not forbidden — but it stops
   being something a reader has to infer from two fields in different places.

1.4. A lane with `acceptsDispatch: false` SHALL NOT be chosen by the
   distribution rule of 0011 R7.3, and SHALL NOT be chosen as an escalation
   target under 0011 R3.3.

1.5. WHEN every lane eligible for a task kind has `acceptsDispatch: false` THEN
   the dispatch SHALL refuse with a message naming the task kind, the lanes that
   were considered, and the reason each was excluded. It SHALL NOT silently fall
   back to the orchestrating lane.

1.6. The repository's own `checkyourvibe.json` SHALL be corrected as part of this
   spec: `claude-code-cli` shall stop being the first-choice `judgment-required`
   target, and the run's judgment capacity shall come from lanes the orchestrator
   does not depend on.

## Requirement 2 — Declared lanes match the machine, or the run says so

**User story:** As a user with several agent CLIs installed, I want to know which
declared lanes cannot actually run and which installed CLIs I am not using, so
that a run does not discover a dead lane at the moment it needs to fail over
onto it.

2.1. `cyv doctor` SHALL report, for every declared lane, whether that lane's
   program was found on `PATH` by the resolution `executor/program.ts` performs.

2.2. A declared lane whose program is not found SHALL be reported as
   unavailable, naming the lane id and the program names that were tried. It
   SHALL NOT be reported as an error — an unavailable lane is a legitimate state
   on a machine that has not installed that CLI — but it SHALL NOT be counted as
   capacity anywhere.

2.3. `cyv doctor` SHALL report an agent adapter that ships with the tool, whose
   program IS on `PATH`, and which no declared lane names. This is unused
   capacity the user is already paying for, which is the exact waste this
   project exists to prevent.

2.4. The distribution rule of 0011 R7.3 SHALL consider only lanes whose program
   was found. An unavailable lane SHALL NOT enter cooldown, because nothing was
   dispatched to it.

2.5. This repository's own configuration SHALL be corrected as part of this
   spec: the `codex-cli` lane names a program that is not installed on the
   development machine, and the installed `gemini` CLI is named by no lane while
   `adapter-gemini` ships complete.

## Requirement 3 — Orchestrator state is self-reported, and labelled as such

**User story:** As a user reading the dashboard after a run went quiet, I want to
know whether the orchestrator said anything about its own condition before it
stopped, without the tool pretending it measured something it was told.

3.1. cyv SHALL provide a command by which the orchestrating session records its
   own state: healthy, degraded, or exhausted, with an optional free-text reason
   and the model or plan it believes it is running under.

3.2. A record written by 3.1 SHALL be stored with the dispatch log (0011 R6.4)
   so that it survives the session that wrote it and is readable by any later
   reader from disk alone.

3.3. Everywhere such a record is displayed it SHALL be attributed as
   **self-reported**, visually and textually distinct from a measured fact. cyv
   SHALL NOT describe it as observed, detected, or measured. The orchestrator
   saying it is healthy is evidence of nothing except that it was able to speak.

3.4. cyv SHALL NOT infer orchestrator health from the absence of a self-report.
   A missing report means unknown, and SHALL be shown as unknown — the third
   state the review UI already distinguishes, not collapsed into either healthy
   or exhausted.

3.5. No surface SHALL render a percentage, a meter, a remaining-token count, or
   a projected time-to-exhaustion for the orchestrating lane. 0011 R7.1 and 0011
   R10.5 apply to the orchestrator with full force.

## Requirement 4 — The stall signal: what cyv can honestly measure

**User story:** As a user whose run went quiet an hour ago, I want the tool to
tell me that nothing is happening while work is available and lanes are free,
because that is the symptom I actually care about — whatever caused it.

4.1. cyv SHALL derive a **stall** state from the dispatch log alone, defined as:
   dispatchable open work exists, at least one available lane is below its
   declared concurrency cap and not in cooldown, and no dispatch has been opened
   within a configured interval.

4.2. The stall state SHALL be a measured fact about the system and SHALL be
   presented as one. It describes what is and is not happening; it SHALL NOT be
   labelled as, or reported as evidence of, orchestrator exhaustion. A stall has
   several possible causes — an exhausted orchestrator, a human who closed the
   terminal, a session waiting on a question — and cyv can distinguish none of
   them.

4.3. WHEN a stall is reported THEN the report SHALL name the idle capacity it
   found: which lanes are available, below cap, and not in cooldown. Naming the
   waste is the point of the signal.

4.4. The interval of 4.1 SHALL be configurable and SHALL have a documented
   default. The default SHALL be justified in `design.md` as a choice about
   reporting latency, and SHALL NOT be presented as derived from any
   subscription's reset window — no such data exists in this project (0011 R7.5).

4.5. A stall SHALL NOT by itself change scheduling: it reports, and does not
   re-dispatch. Automatic recovery from a stall requires knowing what caused it,
   and 4.2 states that cyv does not.

## Requirement 5 — An abandoned dispatch is distinguishable from a running one

**User story:** As a second orchestrator picking up a run whose first session
died, I want to know which in-flight dispatches are still real, so that I neither
wait forever on work nobody is doing nor start a second copy of work already
underway.

5.1. An `opened` dispatch entry SHALL carry enough information for a later
   reader, in a different process, to form a judgement about whether the
   dispatch is still live.

5.2. cyv SHALL distinguish at least three states for an entry with no `closed`
   entry: **live**, **abandoned**, and **undetermined**. `design.md` SHALL state
   what evidence separates them and SHALL NOT claim a separation the evidence
   does not support.

5.3. An abandoned dispatch SHALL NOT be silently closed, reopened, or
   re-dispatched. It SHALL be surfaced for a decision, carrying what is known:
   the lane, the task, when it opened, and why it is judged abandoned.

5.4. An undetermined dispatch SHALL be reported as undetermined. Guessing in
   either direction has a specific cost — waiting forever on nothing, or running
   two agents against the same files, which the scope discipline in AGENTS.md
   exists to prevent — and both costs SHALL be stated where the state is shown.

5.5. Whatever evidence 5.1 introduces SHALL be written into the log at open
   time, not maintained by the live session. A liveness mechanism that requires
   the orchestrator to keep writing is a mechanism that fails exactly when the
   orchestrator fails, which is the case this Requirement is written for.

## Requirement 6 — Handoff: a second orchestrator can take over

**User story:** As a user whose orchestrating subscription is exhausted, I want
to hand the run to another agent I already pay for, rather than waiting for a
reset window while four idle lanes do nothing.

6.1. cyv SHALL provide a single command that reports everything a relieving
   orchestrator needs to resume: open work, in-flight dispatches with their
   liveness judgement (Requirement 5), lane availability and cooldown, the last
   self-reported orchestrator state (Requirement 3), and whether the run is
   stalled (Requirement 4).

6.2. The output of 6.1 SHALL be readable from disk alone, with no dependency on
   the session that started the run, per 0011 R6.4 and R6.5.

6.3. The output SHALL be available in a form an agent can consume without
   parsing prose.

6.4. Handing over SHALL NOT require the relieving orchestrator to be the same
   agent, the same model, or the same vendor as the session it relieves. The
   ability to move orchestration across subscriptions is the point.

6.5. cyv SHALL NOT perform the handoff automatically. Choosing which
   subscription to spend next is a decision with a cost the user owns, and
   nothing in this project spends a user's capacity without being asked.

## Requirement 7 — The dashboard shows the orchestrator as a lane

**User story:** As a user glancing at the dashboard, I want the health of the
thing that drives everything to be visible in the same place as the things it
drives.

7.1. The dashboard SHALL show the orchestrating lane alongside dispatched lanes,
   marked as the orchestrator, per 0011 R6.1.

7.2. The orchestrating lane's row SHALL show its self-reported state
   (Requirement 3) with self-reported attribution, and SHALL show unknown when
   there is no report.

7.3. A stall (Requirement 4) SHALL be shown as an attention state naming the
   idle lanes it found.

7.4. Dispatches judged abandoned or undetermined (Requirement 5) SHALL be shown
   as needing a person, not filed among completed work.

7.5. This Requirement's surface is the dashboard that spec 0037 consolidates.
   Requirements here describe what must be shown; where it is shown is 0037's
   decision.

## Requirement 9 — Lane capability is discovered, not hand-written

**User story:** As a user declaring a lane, I want the tool to tell me which
CLIs are installed, which can actually authenticate, what models each offers and
which of them cost nothing, so that I am not maintaining that list by hand
against vendors who change it without telling me.

The evidence for this Requirement is what it took to declare one lane. Finding
which CLIs were present needed a `PATH` check; finding that one of them could
not authenticate needed running it; finding the real model names needed
`devin models list`; and finding which models were free rather than billed per
token needed reading a price column in that output. None of it was in the tool,
all of it changes over time, and every piece of it was hand-copied into
`checkyourvibe.json` where it silently rots.

Two lanes in this repository's own configuration were wrong at the moment this
was written: one named a program that is not installed, and one model list named
models that had to be checked by hand against the vendor's own output.

9.1. cyv SHALL discover, for each agent it can invoke: whether the program is on
   `PATH`, whether an invocation authenticates, and — where the CLI can report
   it — which models it offers.

9.2. Presence on `PATH` SHALL NOT be reported as availability. A CLI that is
   installed and cannot authenticate is not capacity, and the difference is only
   visible by running it. `gemini` on this machine resolves on `PATH` and fails
   with an ineligible-tier error; reporting it as available is the kind of
   silent wrongness this project exists to catch.

9.3. WHERE a CLI reports its own model catalogue, cyv SHALL be able to read it
   and SHALL report a lane declaring a model that catalogue does not contain.

9.4. WHERE a CLI reports what a model costs, cyv SHALL surface which models are
   free to the user under their existing plan and which are billed per use, and
   SHALL report a lane declaring `billing.kind` of `subscription` whose models
   the vendor prices per token.

9.5. Requirement 9.4 is not a quota reading and does not weaken 0011 R7.1. A
   published price list is a fact the vendor states about a model; remaining
   balance is a fact about an account. cyv reads the first and still never asks
   for the second. Every surface built on 9.4 SHALL keep that distinction in its
   wording.

9.6. Discovery SHALL NOT rewrite the user's configuration. It reports what it
   found and what the configuration says, and leaves the edit to the person
   whose subscriptions are being spent (0011 R1.3).

9.7. Every discovered fact SHALL carry when it was discovered. A vendor's
   lineup changes, so a cached answer that does not say how old it is becomes
   indistinguishable from a current one.

9.8. A discovery that cannot be performed — no CLI, no catalogue command, an
   unparseable output — SHALL be reported as not determined, and SHALL NOT fall
   back to a built-in list of model names. A stale name shipped inside cyv is
   worse than no name, because it looks authoritative.

## Requirement 10 — A cooling lane can be reached deliberately

**User story:** As a user whose lane went quiet after one bad dispatch, I want to
be able to try it again on purpose, so that a subscription I pay for is not
benched until some unrelated lane happens to fail a gate.

Found by dispatching T38001. Its second attempt reported success and changed
nothing, so `devin-cli` entered cooldown under 0011 R7.4 — correct behaviour.
What followed is not:

- 0011 R7.4 stops the scheduler dispatching to a lane in cooldown.
- 0011 R7.5 clears cooldown only on a subsequent observed-effect success **on
  that lane**, deliberately refusing time-based recovery.
- 0011 R7.6 leaves a cooling lane reachable as an escalation target.
- Nothing anywhere clears it, and no command exists to try.

Together those make a livelock. The only event that clears cooldown is a success
on the lane; the only route to the lane is an escalation, which requires a
different lane to fail a gate first. A free lane that produced nothing once —
for any reason, including a transient one — is removed from service until an
unrelated failure happens to revive it. That is idle paid-for capacity created
by the mechanism meant to protect it.

10.1. WHEN a dispatch explicitly names a lane THEN cooldown SHALL NOT refuse it.
   Cooldown is a constraint on automatic scheduling, not a lock on the lane
   (0011 R7.6 already calls it a scheduling state rather than a demotion).

10.2. A dispatch that reaches a lane under 10.1 SHALL report that the lane was
   in cooldown and that the caller named it anyway, so the choice is visible in
   the record rather than inferred from the absence of a refusal.

10.3. An observed-effect success from such a dispatch SHALL clear cooldown by
   0011 R7.5's existing rule. This is what makes 10.1 a recovery path rather
   than a way to keep hitting an exhausted lane: the success is still the only
   thing that clears it, and a second produced-nothing leaves it cooling.

10.4. The core SHALL still NOT choose a cooling lane on its own. 10.1 changes
   what a human may ask for, not what the scheduler decides, and 0011 R7.3's
   distribution rule is unchanged.

10.5. This SHALL NOT introduce a backoff duration, a retry count, or a clock.
   0011 R7.5's refusal to invent a reset window stands: the recovery path is a
   person deciding to try, which is evidence of intent rather than a fabricated
   guess about a vendor's limit.

10.6. `cyv doctor` and the dashboard SHALL name a lane in cooldown and state how
   it is cleared. A state a reader cannot get out of, and cannot see the exit
   from, reads as a broken tool.

## Requirement 11 — What the executor said is kept

11.1. The dispatch record SHALL keep what the executor wrote to its output
   streams. `ChildObservation` captures both and `reportFromObservation`
   currently discards both, so the log keeps a status and an exit code and
   nothing else.

11.2. This matters most for the outcome that carries a consequence.
   `produced-nothing` puts a lane in cooldown, and the record of it reads
   `status: success, exitCode: 0` — from which no reader can tell a refusal
   from a timeout from a crash from a machine that went to sleep.

11.3. Captured output SHALL be truncated to a stated length rather than kept
   whole, and any truncation SHALL be reported with the original length. A
   reader must never be left unsure whether they are looking at all of it.

11.4. The tail SHALL be kept where a stream is truncated, because a process
   explains itself as it fails.

11.5. Requirement 3.3's rate-limit detection already reads these streams. Keeping
   them makes that judgement auditable: today the detector reads the output,
   decides, and the evidence is gone before anyone can check the decision.

## Requirement 12 — Exhaustion is established, never assumed

**User story:** As a user whose lanes all went quiet, I want the tool to find out
what is actually wrong before it benches the subscriptions I pay for, because
"every account ran out at once" is almost never the true explanation.

Found by watching it happen. Two lanes entered cooldown for
`produced-nothing`, and a two-second probe against each agent — a trivial prompt
with a known answer — got a correct reply from both. Neither was exhausted.
`devin-cli` had produced nothing because an escalated retry found the previous
attempt's work already on disk, which is success; `antigravity-cli` produced
nothing for a reason the record did not keep (Requirement 11).

12.1. `produced-nothing` SHALL NOT by itself be treated as evidence of
   exhaustion. It is consistent with exhaustion and with several other things,
   and 0011 R3.3 says only that the two are consistent — not that one implies
   the other.

12.2. WHEN a dispatch outcome would put a lane in cooldown THEN the core SHALL
   support establishing the lane's condition by **probe**: a minimal dispatch
   with a known expected answer, whose result distinguishes three states.
   - **available** — the probe answered. The lane is not exhausted, and the
     failure belongs to the task rather than to the lane.
   - **exhausted** — the probe failed with the vendor's own rate-limit wording,
     which Requirement 11 now keeps in the record.
   - **broken** — the probe failed some other way: authentication, a model the
     vendor no longer serves, a network error. This is a third state the tool
     does not currently have, and cooling such a lane hides the real fault
     behind a state that implies waiting will fix it.

12.3. A probe SHALL be minimal and deterministic, so that its failure is
   unambiguous. It SHALL NOT carry the work of the dispatch that prompted it.

12.4. A probe SHALL NOT read, request, or infer a quota. It observes whether the
   lane answers. 0011 R7.1 stands unchanged: this is behaviour, not a reading of
   the account.

12.5. WHEN a probe reports available THEN the lane SHALL NOT enter cooldown for
   that outcome, and the dispatch SHALL be recorded as having failed for reasons
   that are not the lane's.

12.6. WHEN every declared lane is in cooldown, or would enter it, THEN the core
   SHALL report that as a condition in its own right and SHALL say that
   simultaneous exhaustion of independent subscriptions is unlikely. A broken
   task brief, a bad gate, an unavailable model or a sleeping machine will do
   this to every lane at once; running out will not.

12.7. The core SHALL NOT probe automatically on every ambiguous outcome without
   the user having asked for it. A probe spends capacity, and spending it to
   find out whether there is capacity is a trade the user owns.

## Open questions

- **Does an orchestrator's own agent CLI expose its rate-limit state to a hook?**
  If a session can be made to write a 3.1 record automatically when its vendor
  reports a limit, the self-report stops depending on the session's goodwill at
  the moment it is least able to act. This is a per-adapter question and each
  answer is a fact about that vendor, not about the model. Not assumed here.

- **Should a stall notify rather than wait to be read?** 4.5 deliberately stops
  at reporting. A push notification is a different kind of promise and would be
  its own spec.

- **Can `concurrencyCap` be adjusted from observed cooldown frequency?** 0011
  R3.1 left this open and this spec does not close it. Every mechanism here is
  declared or observed, never predicted.
