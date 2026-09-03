# 0011 — The executor surface: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001, 0003

## Introduction

The third plug-in axis, after analyzers and agent plugins. `AgentSurface` has declared `'executor'`
since 0001 and nothing implements it: an agent plugin that lists `executor` in `surfaces` is asserting
a lane it cannot yet be asked to use. This spec closes that gap.

An executor is not another way to report a violation. Every surface built so far — `hook`,
`instructions`, `guidance`, `mcp` — reacts to work a human already directed: an edit already made, a
question already asked. An executor is the opposite shape: the core hands it a bounded, file-scoped
task and the executor is expected to go do it, unattended, and report back. That inversion is why this
is a third axis and not a sixth surface bolted onto the same reactive contract — everything downstream
of "the core initiated this and has to judge the result" is new.

The judging is the hard part, and it is not hypothetical. This project's own build log
(`docs/specs/0001-core-vertical-slice/tasks.md`) already recorded both failure modes this spec exists
to close: a dispatch that exited 0 having written nothing, because a permission gate rejected it
without surfacing that as failure — and a burst of concurrent dispatches against one account that
silently exhausted a per-account rate limit, again reported as though nothing was wrong. Neither was a
model problem. Both were the harness trusting a signal — exit code — that was never a promise about
what happened on disk. This spec turns those two incidents into requirements instead of institutional
memory that evaporates the next time someone rebuilds the dispatch loop.

The constraint carried over from the roadmap is absolute: an executor dispatches to a **subscription
the user already pays for** — Claude Code, Codex, Cursor, Gemini, or Antigravity running as an
authenticated CLI — never to a metered API billed per token or per request. That constraint is
Requirement 1 because everything after it assumes the lane being scheduled, capped, and escalated to
is free at the margin. A metered lane breaks that assumption, so it gets a narrower rule of its own.

## Requirement 1 — What an executor is, and the subscription constraint

**User story:** As a user with a handful of agent-CLI subscriptions and no interest in a metered bill,
I want dispatched work to run inside subscriptions I already hold, so that spreading work across
executors costs nothing beyond what I already pay.

1.1. An executor SHALL be implemented by an agent plugin that declares `executor` in its `surfaces`
   array and additionally implements this spec's dispatch operations — it is not a separate registry
   alongside `AgentPlugin`, because the agent identity (how it authenticates, what CLI it wraps) is
   already owned there.

1.2. An executor's ordinary path SHALL invoke a CLI authenticated against a subscription the user
   already holds. It SHALL NOT require a metered API key to run its default configuration.

1.3. An executor backed by a metered endpoint MAY exist, but SHALL be opt-in: absent from any
   configuration `cyv init` produces unprompted, and enabled only by an explicit choice recorded in
   configuration — never inferred because a subscription lane was unavailable.

1.4. Every place an executor is named to the user — the dispatch record (Requirement 4), `cyv doctor`,
   generated configuration, `cyv init`'s summary — SHALL label a metered executor as billed at that
   point, not only once in documentation the user may never read.

1.5. A metered executor SHALL NOT be a candidate the core selects automatically, at any point in this
   spec. It can only be reached by a dispatch that names it explicitly; it is never the concurrency
   cap's overflow (Requirement 3) or an inferred default when a subscription lane is unconfigured.

## Requirement 2 — Failure attribution across heterogeneous executors

**User story:** As the operator of a dispatch loop, I want to know whether an executor actually did the
work, so that a CLI that exits 0 while touching nothing is never reported as a success.

This is the real design problem this spec exists to answer, and it is written from a documented
failure, not a hypothetical: see the Introduction.

2.1. The core SHALL NOT treat an executor's exit code, alone, as evidence that a dispatch succeeded or
   failed. Exit-code conventions vary per vendor and, as observed, can be reported as success by a CLI
   that performed no work at all.

2.2. Success SHALL be determined by observed effect: whether the files declared as this dispatch's
   ownership (Requirement 4) actually changed on disk, and whether the gates named for that dispatch
   passed against the changed result.

2.3. A dispatch whose executor reported success (by exit code or its own status output) but whose
   declared files show no change SHALL be recorded as a distinct outcome — reported success, produced
   nothing — and SHALL NOT be folded into either an ordinary success or an ordinary failure. Silently
   treating it as either loses the information that the harness, not the task, is what broke.

2.4. This distinct outcome SHALL be visible wherever dispatch results are surfaced — the dispatch
   record and any run summary — not left as a log line a caller has to go looking for.

2.5. WHEN an executor writes to a path outside its declared ownership THEN the dispatch SHALL be
   recorded as failed regardless of exit code or gate results. An out-of-scope write is a correctness
   violation in its own right, not a success with an incidental side effect.

2.6. The observed-effect check SHALL be computed from the file system state before and after the
   dispatch, against the declared ownership set. It SHALL NOT depend on parsing the executor's own
   stdout or stderr as a self-report of what it did — that is the same trust the exit code already
   betrayed.

2.7. A dispatch SHALL declare up front whether it is expected to change files. Some work legitimately
   produces none — confirming a property already holds, investigating a report, answering a question —
   and under 2.3 alone every such dispatch would be recorded as the harness failing.
   WHERE a dispatch declares that it expects no file changes, its success SHALL be determined by its
   gates alone, and a dispatch that nonetheless changes files SHALL be reported, because that is a
   dispatch that did something other than what was asked.
   The declaration is made when the work is dispatched, never inferred afterwards from what happened:
   inferring it would make "produced nothing" unfalsifiable, which is exactly the outcome 2.3 exists
   to keep visible.

## Requirement 3 — Rate limits, concurrency, and escalation

**User story:** As someone running several dispatches at once against one account, I want the lane to
protect itself from a limit I cannot see coming, and I want to know when it did.

3.1. Each executor SHALL declare a concurrency cap: the maximum number of simultaneous dispatches the
   core will schedule against it at once. This exists because the limit that actually bites is
   per-account request rate, which is invisible until a dispatch is already running against it — not a
   token budget that can be estimated in advance.

3.2. The core SHALL NOT exceed an executor's declared concurrency cap. Additional queued work SHALL
   wait rather than fire immediately.

3.3. WHEN a dispatch's outcome is consistent with rate exhaustion — a reported-success-produced-nothing
   result (2.3) or an explicit rate-limit error from the executor — THEN the core SHALL support
   escalating that unit of work to a second, declared executor rather than retrying it against the same
   exhausted lane.

3.4. An escalation SHALL be reported as an escalation: which lane the work moved from, which lane it
   moved to, and why. It SHALL NOT be merged silently into a plain completion, which would read as
   though the original lane had simply done the work.

3.5. An escalation target SHALL itself be a subscription-backed executor unless the user has
   explicitly configured a metered one as that dispatch's named escalation target (1.5); the core SHALL
   NOT choose a metered lane on its own when a subscription lane is exhausted.

3.6. WHEN the primary lane is exhausted and no escalation target is configured THEN the dispatch SHALL
   be reported as blocked. It SHALL NOT be dropped silently, and SHALL NOT be retried against the same
   lane indefinitely.

## Requirement 4 — The dispatch record and declared file ownership

**User story:** As someone debugging why a dispatch went wrong, I want a record of exactly what was
asked, who was asked, what they were allowed to touch, and what actually happened — not just "the
executor failed."

4.1. Every dispatch SHALL produce a record capturing, at minimum: the task handed to the executor,
   which executor (and lane/model, where the plugin distinguishes one) ran it, the files it was
   permitted to own, which gates ran and their result, and the observed effect (Requirement 2).

4.2. Every dispatch SHALL declare the paths it owns before it runs. This is a correctness requirement,
   not bookkeeping: two executors writing the same path concurrently is how one silently discards the
   other's work, and that must not be discoverable only as a merge conflict or a clobbered file after
   the fact.

4.3. WHEN two dispatches the core would run concurrently declare overlapping file ownership THEN the
   core SHALL refuse to schedule the second one, and SHALL report the refusal naming both dispatches
   and the overlapping paths.

4.4. Ownership SHALL be declared ahead of the dispatch, not inferred from what the executor actually
   touched afterward. Inference cannot prevent a collision — by the time ownership is known, the
   collision has already happened.

4.5. A dispatch record SHALL remain available after the dispatch completes, so that a subsequent
   failure — a failed gate, a rejected review — can be traced to the specific dispatch, executor, and
   file set that produced it, rather than to "the executor" as an undifferentiated category.

## Requirement 5 — Trust boundary and consent

**User story:** As a user deciding whether to turn this on, I want to understand exactly what I am
granting before repository write access is handed to a process I am not directly operating.

5.1. Enabling an executor SHALL be understood, and stated plainly wherever it is offered, as granting a
   third-party CLI the ability to write anywhere within the paths a dispatch permits, running under the
   user's own authenticated session with that vendor.

5.2. Consent to enable an executor SHALL be separate from consent to enable that same agent's other
   surfaces. Configuring an agent plugin for `hook`, `instructions`, `guidance`, or `mcp` SHALL NOT
   enable its `executor` surface as a side effect.

5.3. `cyv init` SHALL NOT enable any executor by default, including for an agent it has already
   detected and is otherwise configuring. Executor consent SHALL always require its own explicit step.

5.4. Wherever that consent is requested, the prompt SHALL name what is being granted — write access to
   the repository, exercised by a process outside the user's own editing session — rather than present
   as a generic permission confirmation indistinguishable from the other surfaces.

5.5. Disabling an executor in configuration SHALL take effect before the next dispatch is scheduled,
   and SHALL require nothing beyond that configuration change to take effect.

## Requirement 6 — The orchestrating lane and its own exhaustion

**User story:** As a user driving dispatch from a single agent session, I want that session's own
subscription treated as a lane subject to the same accounting as everything it dispatches to, so that a
fleet of healthy executors never hides the one failure that actually stops me: the orchestrator itself
running out.

6.1. The agent session issuing dispatches — the orchestrator — SHALL be named explicitly wherever a
   dispatch record or the localhost view (Requirement 10) shows which lane did what. It is not exempt
   from being a lane merely because it is the one asking rather than the one asked.

6.2. WHERE the orchestrator itself also accepts dispatched work — self-dispatch, delegating a unit of
   work to the same CLI session that is planning the run — that dispatch SHALL be subject to Requirement
   3 identically to any other lane: its own declared concurrency cap, its own escalation target, its own
   rate-exhaustion detection. Nothing in this spec exempts the orchestrating lane's capacity from the
   rules that apply to a lane it dispatches to.

6.3. cyv's own process is downstream of the orchestrator, not upstream of it: the orchestrator invokes
   cyv, not the reverse. Consequently cyv SHALL NOT claim to detect the orchestrator's own exhaustion the
   way Requirement 3.3 detects a dispatched executor's exhaustion — there is no subprocess to observe
   failing, because the orchestrator is the caller, and an exhausted caller simply stops calling. This
   spec does not resolve how orchestrator exhaustion would be surfaced from inside the orchestrator's own
   session; see Open Questions.

6.4. What cyv SHALL guarantee instead: every dispatch record (Requirement 4) and everything the
   localhost view shows about it SHALL remain complete and readable independent of the orchestrating
   session that created it being active, healthy, or reachable. A second orchestrating session — the same
   one restarted, or a different agent picking up mid-run — SHALL be able to read the full state of
   in-flight and completed dispatches from what is on disk alone, with no dependency on the first
   session's memory or continued existence.

6.5. This durability requirement exists specifically because the failure this Requirement is written for
   is the orchestrator being the thing that is down: every dispatched lane can be reported healthy in a
   record that nonetheless nobody is currently able to read, if the record's only home was the
   orchestrator's own context. It SHALL NOT be.

## Requirement 7 — What "capacity" can honestly mean, and distributing dispatches across it

**User story:** As a user who pays for several lanes at once, I want dispatches to go where there is
room, so that a lane sitting idle is not wasted while another is driven into a limit I never see coming —
without the tool pretending to know something about my accounts that it cannot know.

7.1. A subscription's remaining quota SHALL NOT be treated as observable. No lane's plugin SHALL be
   assumed to expose, and the core SHALL NOT query, an API that reports remaining usage, tokens, or
   requests against a subscription's cap — no vendor CLI in this project's scope documents such an
   endpoint, and Requirement 1.2's constraint (authenticate as the user's own CLI session, nothing more
   privileged) gives the core no channel to ask for one even if it existed.

7.2. WHERE this spec, or any surface built on it, uses the word "capacity," it SHALL mean one of exactly
   two things, and SHALL say which:
   - **declared headroom** — the difference between a lane's declared concurrency cap (3.1) and the
     number of dispatches currently running against it. This is exact, because the core is the one
     scheduling those dispatches; it is a statement about how much of the self-imposed cap is in use, not
     a statement about the vendor's real limit.
   - **inferred availability** — whether the lane's most recent dispatches completed with observed effect
     (2.2) rather than the reported-success-produced-nothing outcome (2.3) or an explicit rate-limit
     error (3.3). This is the only signal this spec has for the thing a user actually means by "does this
     lane have room" — a lagging, behavioural signal, not a reading of the account itself.

7.3. Distribution of a new dispatch across candidate lanes SHALL be computed from 7.2's two signals only:
   prefer the eligible lane with the most declared headroom that is not currently in the cooldown state
   7.4 defines. Nothing else SHALL factor into the choice — not a lane's historical average, not a
   projection, not a number invented to fill the gap 7.1 leaves.

7.4. WHEN a dispatch against a lane produces the reported-success-produced-nothing outcome (2.3) or an
   explicit rate-limit error THEN that lane SHALL enter a cooldown state: the core SHALL NOT schedule new
   dispatches against it until cooldown clears. This is the "lane that started refusing work" signal —
   the only honest evidence this spec has that a lane is at or near its real limit, arrived at after the
   fact rather than predicted in advance.

7.5. Cooldown SHALL be cleared only by a subsequent observed-effect success on that lane (2.2), not by
   elapsed time alone. This project has no data connecting real-world wait time to any subscription's own
   reset window; inventing a fixed backoff duration would be exactly the fabricated precision Requirement
   1's evidence discipline, and 0018's "insufficient evidence" precedent, both refuse elsewhere in this
   project. WHERE a human wants time-based recovery in addition, that is a configuration choice layered on
   top of this signal, not a replacement for it.

7.6. A lane in cooldown remains a valid escalation target and a valid ordinary dispatch target once
   cooldown clears. Cooldown is a scheduling state, not a demotion recorded against the lane permanently.

7.7. This extends Requirement 3.1's reasoning rather than replacing it: the concurrency cap stays a
   declared, human-tuned number — 3.1's own open question about whether it is ever adjusted automatically
   remains unresolved by this Requirement — and 7.1 through 7.6 add the runtime signal that decides which
   of several lanes already under their caps receives the next dispatch.

## Requirement 8 — Declared task kind, and how a lane maps it to a model

**User story:** As a user whose dispatched work ranges from a mechanical rename to a real design
decision, I want the model doing the work to match what the work actually needs, without the core having
to know next month's model lineup to make that call.

8.1. A dispatch SHALL declare, alongside its ownership (4.2) and expected-file-change (2.7) declarations,
   what kind of work it is — a value from a small, fixed, capability-shaped set the core defines, for
   example mechanical transformation with a checkable outcome versus work requiring judgment the gates
   cannot fully verify. This declaration describes the work, not a model: the core SHALL NOT define this
   set in terms of any vendor's model names or a ranking between them.

8.2. Each lane SHALL declare which of the models it can invoke it offers for each declared task kind,
   and — separately — an ordering among the models it offers for a given kind, strongest to weakest, as
   that lane's own plugin author judges its vendor's lineup. The core SHALL NOT compute, store, or
   hard-code this ordering itself; owning it is the plugin's responsibility, because only the plugin's
   author tracks what its vendor currently ships.

8.3. The core SHALL treat a lane's declared ordering (8.2) as opaque. It SHALL NOT re-rank it, blend it
   with another lane's ordering, or compare "strongest on lane A" against "strongest on lane B" as though
   the two numbers meant the same thing — there is no cross-vendor quality scale this project defines,
   and inventing one is the same leaderboard failure 0018 Requirement 6 refuses for rule metrics, for the
   same reason: a number nobody can verify but everybody can be tempted to move.

8.4. WHERE a lane does not declare a model for a dispatch's declared task kind, that lane SHALL NOT be a
   candidate for that dispatch, and SHALL be treated identically to a lane over its concurrency cap or in
   cooldown for scheduling purposes (7.3): out of consideration for this unit of work, not blocked in
   general.

## Requirement 9 — Right-size the model, and escalate only on demonstrated failure

**User story:** As a user whose subscriptions meter me by usage window and token budget, I want small
work done by a small model, so the capacity I have is still there when work arrives that actually needs
it.

A flat-rate plan is not an unmetered one. Every subscription this project dispatches to bounds what it
will do inside a window, and the strongest model on a lane is the one that reaches that bound soonest.
Requesting it as a matter of course does not extract more value from a subscription; it spends the
scarce thing fastest, on the work least likely to need it, and the cost lands later as a lane that has
nothing left for a task that did. Requirement 8 already states the principle — the model should match
what the work actually needs — and this requirement is how that is honoured rather than contradicted.

9.1. The core SHALL request, for every dispatch, the weakest model the chosen lane declares eligible for
   that dispatch's declared task kind (8.1, 8.2): the last entry in that lane's declared ordering for the
   kind. There SHALL NOT be a setting, default or opt-in, that requests a lane's strongest model as a
   matter of course. "Strongest available" is not an objective this spec offers, because no user is
   served by exhausting a window on a mechanical rename.

9.2. Among the lanes eligible for a dispatch (7.3, 8.4), the core SHALL select the one with the most
   declared headroom. Spreading work toward unused capacity is the part of "use what you have paid for"
   that is real: it concerns which lane runs the work, never how strong a model that lane is asked for.

9.3. WHERE a dispatch's gates fail (2.6), the core MAY re-dispatch the same unit of work to the
   next-stronger model in that lane's declared ordering for the kind, up to a bounded number of attempts
   the user configures and which SHALL default to a finite value. Escalation SHALL be triggered only by
   an observed gate failure. The core SHALL NOT predict that a task will need a stronger model and skip
   ahead to one, because that prediction is exactly the guess this ordering exists to avoid making.

9.4. Each attempt under 9.3 SHALL be its own dispatch record (4.1), naming the model requested and the
   gate failure that caused the escalation. A unit of work that succeeded on the third model SHALL NOT be
   recorded as though it succeeded on the first: the record is what tells a user their task kinds are
   declared too optimistically, and collapsing the attempts hides it.

9.5. Requirements 1.3, 1.5 and 3.5 are not relaxed by anything here. Escalation SHALL NOT cross from a
   flat-rate lane to a metered one, and SHALL NOT reach a metered model within a lane. A metered lane or
   model remains reachable only through the explicit, opt-in, named configuration Requirement 1.3
   requires.

9.6. Every dispatch record SHALL name the lane and model requested. What the core reports about cost
   SHALL be limited to that, plus whether the lane's configuration is one the user has marked as
   permitting billed overage beyond its included capacity — a configuration fact the user supplied, not a
   live reading of their account. The core SHALL NOT report a dollar figure, a token count, or any other
   quantity purporting to be what a dispatch actually cost. No source available to this project supplies
   that number honestly: it is not observable through an authenticated CLI (7.1's reasoning applies
   identically here), and parsing it out of an executor's own stdout would be exactly the self-report
   Requirement 2.6 already refuses to trust for success.

9.7. A literal per-dispatch cost figure is therefore not a capability this spec delivers. WHERE it
   matters, it SHALL be read from the vendor's own billing surface, outside this project's scope. This
   spec's contribution is naming which lane and model a dispatch used, so that lookup is possible.
## Requirement 10 — The localhost view as part of the executor surface

**User story:** As a user with dispatches running unattended, I want to see, from a phone or another
machine, which lane is doing what, why, and what needs me — without that view becoming a second place
that can be wrong about what is actually happening.

10.1. Wherever this project's localhost dashboard (0006) or an executor-specific view built alongside it
   renders dispatch state, it SHALL read the dispatch records (Requirement 4) and lane state — cooldown
   (7.4), concurrency in use (7.2) — already written to disk. It SHALL NOT execute, poll, or re-derive
   that state by any other means: the same discipline 0006 Requirement 2.3 already applies to rendering
   rule manifests without running an analyzer applies here to rendering dispatch state without re-running
   or re-querying an executor.

10.2. The view SHALL show, per in-flight or recently completed dispatch: which lane is running it, which
   model was requested (Requirement 8) and under which objective (9.1), the declared task kind, and —
   WHERE an escalation occurred (3.4) — which lane it moved from, which it moved to, and why.

10.3. The view SHALL show a lane's cooldown state (7.4) as cooldown, distinctly from a lane that is
   merely at its concurrency cap (3.2). The two look similar from outside — no new dispatch is being
   scheduled either way — but mean different things, and 0018 Requirement 1 is this project's precedent
   for why collapsing two states that share a symptom but not a cause is a defect, not a simplification.

10.4. The view SHALL surface, without requiring the user to open a dispatch record individually, whatever
   needs a human: a dispatch blocked for lack of an escalation target (3.6), an out-of-scope write
   recorded as failed (2.5), a reported-success-produced-nothing outcome (2.3), and a scheduling refusal
   from overlapping ownership (4.3).

10.5. The view SHALL NEVER present a lane's status as observed when it is inferred. Both of 7.2's forms
   of "capacity" SHALL be labelled as what they are — declared headroom against a self-imposed cap, or a
   behavioural inference from a past outcome — and SHALL NOT be rendered as a live reading of the account
   itself. A percentage-full meter implying the account's real remaining quota is known is exactly the
   presentation this Requirement forbids: 7.1 establishes that number does not exist anywhere this
   project can read it.

10.6. Per Requirement 6.4, the view SHALL be able to render full dispatch state with the orchestrating
   session that created it absent, restarted, or unreachable — it reads from disk, not from that
   session's memory.

## Non-goals

Remote or cloud-hosted executors with no local authenticated CLI. Automatically merging or committing a
dispatch's output — something still reviews it, per the git backstop this project already relies on. A
cross-vendor quality or price scale, or any core-side ranking that compares one lane's declared model
ordering against another's (8.3) — each lane's ordering stays internal to that lane. A bidding or auction
mechanism between lanes for a dispatch — distribution is the fixed rule in 7.3, not a negotiation. An
interactive scheduler UI letting a user manually reassign a running or queued dispatch between lanes by
hand — Requirement 10 is read-only; changing what runs where is a configuration change (which lanes
exist, their caps, the active objective), not a control surface. A live reading of any vendor account's
actual remaining quota or billing balance — 7.1 and 9.5 establish this is not observable through an
authenticated CLI, and this spec does not propose building or waiting for one. Real-time cost accounting
in dollars — 9.5's limit stands; a dispatch's actual monetary cost is read from the vendor's own billing
surface, not this project. Detecting the orchestrator's own exhaustion from the outside — 6.3 states why
cyv has no vantage point to observe that; this spec provides durability of state instead, not detection.
An executor initiating work on its own; every dispatch in this spec is core-initiated. Cross-repo
dispatch. Resuming a dispatch that crashed mid-run — a crashed dispatch is reported and re-dispatched
from scratch, not checkpointed.

## Requirement 11 — A dispatch that never closes must not hold a lane forever

11.1. An `opened` entry with no matching `closed` entry holds its lane's
   concurrency slot indefinitely. There is no elapsed-time rule that reaps one
   (7.5 forbids cooldown by timer), and nothing else closes it, so a dispatch
   whose process was killed leaves the lane permanently at its cap.

   Observed: a dispatch interrupted mid-run left
   `work-20260831024409-a8c972-attempt-1` open on the devin lane, and every
   later dispatch naming that lane was refused with "running its declared cap
   of 1". The scheduler was correct; the log was wrong, and there was no way to
   correct it.

11.2. The core SHALL provide a way to close an abandoned dispatch, recording
   that it was closed without an observed outcome rather than inventing one.
   "The process is gone and nothing was recorded" is its own outcome and SHALL
   NOT be reported as a success or a failure of the work.

11.3. Closing SHALL be a deliberate act, not an elapsed-time rule. A long
   dispatch is not an abandoned one, and a timer cannot tell them apart.

## Requirement 12 — A gate that checked nothing did not pass

12.1. A gate reporting success SHALL state what it examined. A gate that
   examined nothing SHALL NOT report a pass.

   Observed: `cyv-check` reported "gate cyv-check passed — 0 error(s), 0
   warning(s) across 0 file(s) the dispatch changed" for a dispatch that had
   just changed two files. The outcome was classified `succeeded` on the
   strength of a gate that ran over an empty file list.

12.2. WHERE a gate's input is empty because the dispatch changed nothing, that
   is already the `produced-nothing` outcome (2.3) and the gate's verdict is not
   what decides it. WHERE the input is empty for any other reason, the gate has
   failed to run and SHALL be recorded as inconclusive.

## Open questions

- What exactly counts as a "gate" for a dispatch, and is that list executor-agnostic or does each
  executor's plugin get to add its own? This spec assumes gates are declared per dispatch (Requirement
  4.1) but does not define where that declaration is authored.
- A concurrency cap (3.1) is described as declared, not discovered — there is no way to learn an
  account's real rate limit except by hitting it. Is the declared number ever adjusted automatically
  after a dispatch is observed to be rate-limited, or is it a static number a human tunes after reading
  a report?
- Escalation (3.3) is described per unit of work. If several concurrent dispatches against one lane are
  rate-limited at once, does each escalate independently, or does the whole batch move together? The
  latter is probably cheaper and less noisy, but this spec does not resolve it.
- Where does a dispatch record (Requirement 4.1) live — folded into the same report format `cyv check`
  already produces, or a separate log this spec would need to define the shape of? Left to design.
- Is there a timeout after which a dispatch that has neither completed nor errored is itself treated as
  a distinct outcome (alongside 2.3's reported-success-produced-nothing), or does it simply run until
  the executor's own process exits?
- Requirement 8.2's ordering is capability-shaped: 9.1 reads it from the weak end to find the smallest
  model that still satisfies a task kind, and 9.3 walks up it on a gate failure. It is not a cost
  ordering, and this spec does not claim the two coincide. Where a vendor's smallest capable model for a
  kind is not also its cheapest, the ordering still selects correctly for capacity — which is what 9.1
  is protecting — but a user optimising for a billed overage would need something this spec does not
  define.
- Requirement 6.3 states cyv has no vantage point to detect the orchestrator's own exhaustion, because
  cyv is downstream of the orchestrator rather than upstream of it. Whether that failure mode is ever
  made visible from inside the orchestrator's own session — and if so, by what mechanism, given it is
  outside this project's process boundary — is not resolved here.
- Requirement 7.5 clears cooldown only on an observed success. Whether a lane stuck in cooldown because
  no further dispatch happens to be routed to it (rather than because it is still exhausted) needs a
  distinct probe-and-clear mechanism, or whether it is acceptable for cooldown to persist indefinitely
  until the next real dispatch lands there, is left open.
- Where the localhost view in Requirement 10 actually lives — a mode of the existing dashboard (0006), or
  a separate view sharing its foundation per 0006 Requirement 6.1's shared-foundation precedent — is left
  to whichever spec ends up owning the executor surface's UI implementation.
- Requirement 8.1 asserts the declared task-kind set must be small, fixed, and capability-shaped, without
  enumerating it. What that set actually contains, and who — this spec or a later one — gets to extend
  it, is not decided here.

## Why this ordering

Requirement 2 has to be settled before 3 or 4 can be tested meaningfully: escalation (3.3) triggers on
the reported-success-produced-nothing outcome that 2.3 defines, and the dispatch record's "observed
effect" field (4.1) is exactly what 2.2 and 2.6 compute. Requirement 4's ownership declaration has to
exist before Requirement 3's concurrency scheduling can refuse an overlapping pair — you cannot detect
a collision between two things that never declared what they own. Requirement 5 is the one piece that
does not depend on the others technically — it is a consent gate that could be built first — but it is
placed last because it is the requirement that decides whether any of the rest ever runs against a real
repository at all, and that is worth stating as the closing word, not the opening one.

Requirements 6 through 10 extend the same chain outward from execution into scheduling and observation,
and follow it in the same order. Requirement 7's capacity signal reuses Requirement 2's observed-effect
check and Requirement 3's rate-exhaustion outcome directly — it has nothing to compute from until those
exist. Requirement 6 (the orchestrating lane) is placed before 7 even though it does not depend on 7's
cooldown machinery, because it is a scope statement — which lane counts, including the one asking — and
scope precedes the mechanism that operates within it. Requirement 8 (task kind and model) and Requirement
9 (the objective setting) both extend Requirement 4's dispatch record, which is why neither could be
written before it: 9.4 records exactly the field 8.1 and 8.2 define, and 8 has to exist before 9 can
choose from opposite ends of the ordering 8.2 declares. Requirement 10 is placed last for the same reason
Requirement 5 was: it reads everything before it and adds nothing new to compute, only a place to see it —
with one addition unique to this half of the spec, that 6.4 requires it to keep working even when the
session that opened it cannot.
