# 0046 — The lane is not the record: Requirements

**Status:** draft
**Created:** 2026-09-02
**Depends on:** 0011, 0035, 0036

## Introduction

> "i think cyv needs state too.. for example if I were to start cyv in another
> claude session and had it using the same lanes, we might... want to spread
> the load across projects/jobs/tasks... so a centralized cyv state needs to
> exist. but it needs to be kept in lock step with the agents some how not
> counting on them to hopefully update the status"

Two claims, both correct, both reproduced this session against
`R:\gamedev\catburgler`:

**(a) Lane capacity is machine-wide; cyv tracks it per repository.**
`checkyourvibe.json` in that project declares `claude-code-cli`
(orchestrator), `antigravity-cli`, `codex-cli`, `devin-cli`, each
`concurrencyCap: 1`, subscription billing. Every one of those caps is a
number about a CLI authenticated on this machine, not about the repository
that happens to declare it. A second orchestrating session in a second
project that names the same CLI is spending the same account, and cyv has no
way to know that, because — spec 0035 Requirement 3.1 — **"nothing is shared
between projects."** That line was correct when it was written: it is about
dashboard display, and two projects' review state genuinely should not leak
into each other. It is wrong for capacity, which is the one thing that is not
actually a fact about either project.

**(b) Occupancy is self-reported, not observed.** An orchestrating agent ran a
driver that dispatched 8 tasks in 3 dependency waves: wave 1 alone put 4
tasks against 3 lanes of cap 1 each, an oversubscription the driver did not
model, and a faulty wave barrier let waves 2 and 3 start before wave 1's work
had finished, compounding it. Several dispatches then died without closing
their records — `.cyv-review/dispatches.ndjson` holds `opened` entries for
`T0022`, `T0023`, `T0027` with no matching `closed` entry. Afterwards,
`cyv dispatch --dry-run` refused every candidate:

```
refused: no declared lane was a candidate for this work.
  claude-code-cli: declares no model for task kind "mechanical-transformation"
  antigravity-cli: running its declared cap of 1 (2 in flight). ...
  codex-cli: running its declared cap of 1 (1 in flight). ...
  devin-cli: running its declared cap of 1 (1 in flight). ...
```

`Get-Process` / `Get-CimInstance Win32_Process` on the same machine, at the
same time, found **zero** dispatch processes of any kind running. The
in-flight counts cyv reported were entirely phantom, and cyv had no command
the operator had been told about to clear them — it would refuse every future
dispatch in this repository, permanently, on the strength of records nothing
was left alive to close.

The pointed part: this project already holds the exact principle that would
have prevented (b), and does not apply it here. `executor/outcome.ts`
classifies a dispatch's outcome from the filesystem and explicitly discards
the executor's own exit code as evidence. `executor/child.ts`'s own comment
states it: *"Nothing here decides whether the dispatch succeeded... the exit
code [is] read... to separate a reported success... from a reported
failure."* An unclosed record is the occupancy equivalent of trusting the exit
code: it is the dispatch's own account of itself (it wrote `opened` and then
went silent), accepted because nothing checked further.

### What already exists, and what does not

Spec 0036 Requirement 5 built real liveness judgement: an `opened` entry
carries `host`, `pid`, and `processStartedAt`
(`executor/liveness.ts:judgeLiveness`), and a later reader on the same host
can judge **live**, **abandoned**, or **undetermined** by checking whether
that pid still exists and whether its start time still matches — exactly the
kind of observed evidence this spec also needs, and 0036 Decision 2
explicitly rejected a heartbeat or lease for the reason that matters here too:
*"a mechanism that requires the orchestrator to keep writing fails exactly
when the orchestrator fails."*

But that mechanism is wired to exactly two call sites:
`dashboard/stop.ts` (a person clicking "stop" on one dispatch from the
localhost dashboard) and `dashboard/motion.ts` (display). It is **not**
consulted by `executor/schedule.ts` or `executor/replay.ts`. Scheduling's
concurrency-cap check (`laneIneligibility`'s `at-concurrency-cap` branch,
`schedule.ts:137`) reads `runtime.inFlight.length`, which `replayLaneRuntimes`
(`replay.ts`) computes purely from `record.closed === undefined` — no liveness
judgement enters it. So even within one repository, on one host, a dead
dispatch occupies its lane forever unless a human happens to open the
dashboard and click stop on each of the three dead records by hand — which is
exactly the incident. 0036 R5.3 also deliberately keeps an abandoned record
from being auto-closed, "surfaced for a decision" instead: right for the
per-repo audit trail (a person may want to know *why* something died), wrong
as the only route back to usable capacity.

0036 is entirely scoped to one host reading its own dispatch log (`liveness.ts`
returns `undetermined` the instant `entry.host !== thisHost`) and to one
repository's log file. Neither of those is where cross-project pooling can
live. This spec:

- extends 0036's liveness judgement from "consulted by a person, per repository"
  to "consulted automatically at scheduling time, across every repository
  contending for the same underlying CLI" — the fix judgement already existed
  for, just not applied where the incident actually happened;
- adds the one piece of state that does not exist anywhere: a machine-wide
  record of which agent CLI a dispatch is holding, independent of which
  repository opened it.

Spec 0045 ("the editor nothing supervises") solves an adjacent but distinct
problem: whether one project's own managed Unreal Editor process is up,
probed at its HTTP endpoint. It never crosses a project boundary — Requirement
6 there is "never two editors on **one** project" — so it has nothing to say
about a resource two projects contend for. Both specs share a discipline
(observe, do not trust a claim), not a mechanism; Decision 6 in `design.md`
says why.

## Requirement 1 — Capacity is a fact about the agent, not the repository

**User story:** As a user running two projects against the same CLI, I want
cyv to know they are drawing on one account, so that declaring `concurrencyCap:
1` in each project does not silently permit two simultaneous dispatches
against a CLI that can only really run one.

1.1. The shared capacity pool SHALL key on `LaneDeclaration.agentId` — the
   `AgentPlugin.id` a lane names (`claude-code`, `codex`, `antigravity`,
   `devin`, ...) — not on `LaneDeclaration.id`. Two lanes in two repositories
   with different `id`s and the same `agentId` SHALL be treated as one pool.

1.2. `agentId` is already how this project identifies which CLI and
   subscription a lane spends (`executor/invocation.ts:agentCommandFor`,
   0011 R1.2's "a CLI authenticated against a plan the user already holds").
   This requirement introduces no new identity concept; it applies the one
   that already exists at the point it was missing.

1.3. WHERE two repositories declare different `concurrencyCap` values for the
   same `agentId`, the pool SHALL use the lower of the two as the effective
   cap for scheduling in both, and SHALL NOT silently pick one repository's
   number over the other's.

1.4. A `concurrencyCap` disagreement under 1.3 SHALL be reported by
   `cyv doctor`, naming both repositories, both numbers, and which one is
   currently governing. `cyv doctor` already reports each declared lane
   (spec 0036 R2.1); this is the same report extended to say when a lane's
   number does not agree with another repository's for the same agent.

1.5. This requirement SHALL NOT introduce an account identity finer than
   `agentId` (for example, "which of two logged-in accounts for the same
   CLI"). Nothing in this project's configuration currently distinguishes
   two accounts behind one `agentId`, and inventing that distinction without
   evidence of a CLI that supports it would be exactly the fabricated
   precision 0011 R7.1 and 0036 already refuse elsewhere.

## Requirement 2 — Occupancy is derived from evidence, not from an unclosed record

**User story:** As a user whose dispatch died — killed, crashed, machine
rebooted, orchestrator's own session ended — I want that dead dispatch to stop
holding a slot, without having to find and click something.

2.1. WHEN the scheduler computes whether a lane (by pooled `agentId`, per
   Requirement 1) has headroom for a new dispatch, it SHALL NOT count a
   claim whose supervising process is judged **abandoned** by the same
   liveness evidence spec 0036 R5 already defines (host, pid,
   `processStartedAt`, `executor/liveness.ts:judgeLiveness`).

2.2. This judgement SHALL be performed at the moment scheduling reads the
   pool — a reconciliation on read — not maintained by a running process. A
   mechanism that depends on the dispatch renewing its own claim is a
   mechanism that fails exactly when the dispatch fails, which is the
   precise case this requirement exists for (0036 Decision 2's reasoning,
   applied here without weakening it).

2.3. 2.1 changes what counts toward the pool's occupancy. It SHALL NOT
   change spec 0036 R5.3: the per-repository dispatch record for an abandoned
   dispatch SHALL still not be silently closed, reopened, or re-dispatched. A
   dead claim stops blocking new work; the audit trail of what happened to it
   is unaffected and still requires a person to close it in that repository's
   own log if they want to record why.

2.4. A claim judged **live** SHALL continue to count. A claim judged
   **undetermined** — a different host than the one reconciling, or a pid
   whose start time cannot be read — SHALL continue to count. Requirement 2 is
   only entitled to free a slot when it has positive evidence the slot is
   free; the same discipline 0036 R5.4 already states for the per-repository
   case ("waiting forever on nothing, or running two agents against the same
   files" are both real costs, and only one of them is repaired by guessing
   wrong in the other direction).

2.5. This requirement is explicitly scoped to one machine. It SHALL NOT
   attempt to judge liveness across hosts; a claim opened on a different host
   is undetermined by 2.4's rule (unchanged from 0036 R5.2's third state), and
   stays counted. Multi-machine pooling is out of scope; see Open questions.

## Requirement 3 — A phantom claim is discoverable and clears without guesswork

**User story:** As the operator in the incident above, I want a place to see
what the pool thinks is occupied and why, and — for the cases 2.1 cannot
resolve on its own — a documented way to clear it, because "cyv will refuse
forever with no way out" is not an acceptable state for a tool to leave a
person in.

3.1. `cyv doctor` SHALL report the pool's contents per `agentId`: every open
   claim, which repository and dispatch it belongs to, and its liveness
   judgement (live, abandoned, undetermined).

3.2. `cyv doctor`'s report under 3.1 SHALL state plainly, for any claim it
   shows as abandoned, that Requirement 2 already excludes it from scheduling
   — so the report reads as informational, not as a queue of things the
   operator must act on.

3.3. For a claim `cyv doctor` reports as **undetermined** that a person has
   independently confirmed is dead (for example: a different host that is
   known to be off, or a process the person can see is gone by other means),
   cyv SHALL provide a named command to clear it explicitly, and `doctor`'s
   report SHALL name that command inline next to the claim it applies to. This
   is the exact thing the incident's operator did not have.

3.4. Clearing a claim under 3.3 is a person overriding evidence cyv itself
   says is inconclusive. The command SHALL require the claim's dispatch id
   (not a blanket "clear everything") and SHALL record who/when it was
   cleared in the pool log, so a later reader sees an override, not a
   judgement.

## Requirement 4 — Concurrent writers do not corrupt the pool or double-book a slot

**User story:** As a user running two orchestrating sessions against the same
CLI at once, I want them to never both believe they got the last slot.

4.1. The pool SHALL be a single append-only file, written the same way
   `executor/store.ts` already writes `.cyv-review/dispatches.ndjson`: one
   JSON object per line, appended with one `appendFile` call per entry. This
   is a proven mechanism on the incident's own platform — the very log that
   recorded the incident was written this way on Windows 11 without
   corruption — not a new one.

4.2. Appending a claim or a release SHALL NOT by itself require exclusive
   access; concurrent appends are safe by 4.1's existing guarantee.

4.3. Deciding *whether to append a claim* — reading current occupancy,
   applying Requirement 2's reconciliation, and checking it against the
   pooled cap — is a read-then-write sequence, and two sessions running it at
   the same instant against a lane with one free slot SHALL NOT both conclude
   they got it. This decision SHALL be serialized by a lock file, acquired
   with an exclusive create (`O_CREAT|O_EXCL` / Node's `'wx'` flag), held only
   for the read-decide-append sequence, and removed immediately after.

4.4. A session that finds the lock already held SHALL read the pid the
   holder wrote into it and judge its liveness by the same mechanism as
   Requirement 2. A lock held by a process judged abandoned SHALL be treated
   as stale and removed by the waiting session before it retries — this
   requirement introduces no lock-expiry timer; staleness is decided by the
   same evidence, not a guessed duration, for the same reason Requirement 2.2
   gives.

4.5. A session that cannot acquire the lock within a bounded number of
   attempts (not a duration guess, a small fixed retry count) SHALL report
   the pool as contended and refuse the dispatch, rather than block
   indefinitely. A bounded, reported refusal is consistent with how every
   other scheduling refusal in this project already behaves (0011 R4.3).

4.6. `O_CREAT|O_EXCL` create is atomic on both POSIX and NTFS; this is the
   mechanism, not a rename. `design.md` states why a rename-based
   compare-and-swap was not chosen, and the Windows-specific caveat that
   ruled it out.

## Requirement 5 — Contention across projects is resolved first-come, first-served

**User story:** As a user who asked to "spread the load across
projects/jobs/tasks," I want to know what happens when two projects want the
same lane at once, stated plainly rather than left to chance.

5.1. WHEN a slot is free and more than one session is contending for it, the
   session whose claim is appended first (i.e., the one that wins Requirement
   4's lock and finds headroom) SHALL receive it. No project, job, or task
   SHALL be given priority over another.

5.2. cyv SHALL NOT implement round-robin fairness, per-project quotas within
   a shared cap, or a priority field. Each would require new persistent
   bookkeeping this project has no evidence it needs yet (a "whose turn is
   it" record per `agentId`, maintained across sessions that do not otherwise
   coordinate) and 0011 R7.3 already states the project's standing policy:
   "nothing else SHALL factor into the choice" beyond the two signals capacity
   already has.

5.3. A session refused under Requirement 4.5 or for lack of headroom SHALL be
   told which repositories currently hold the pool's claims for that
   `agentId`, so a person deciding whether to wait, retry, or intervene is not
   guessing.

## Requirement 6 — The pool degrades to per-repository behavior, and introduces no daemon

**User story:** As a user on a machine where the shared pool file is missing,
unreadable, or corrupt, I want cyv to keep working the way it always has,
rather than invent a new way for the whole tool to stop.

6.1. This feature SHALL NOT introduce a background process, service, or
   daemon of any kind. Every mechanism in this spec runs inside the same
   `cyv` invocation that already reads and writes `.cyv-review/` today.

6.2. WHEN the pool file at `~/.cyv/pool.ndjson` cannot be read or parsed, cyv
   SHALL fall back to per-repository enforcement exactly as it behaves today
   (spec 0011, unmodified) rather than refusing to schedule anything.
   Refusing all work because a cross-project convenience file is broken would
   be a new, harsher failure than existed before this feature; falling back
   to the tool's prior, already-shipped behavior is not.

6.3. A fallback under 6.2 SHALL be reported — by `cyv doctor` and by the
   scheduling decision itself, when queried with `--dry-run` or equivalent —
   so a user is told that cross-project capacity limits are not currently
   being enforced, rather than left to assume they are.

6.4. The lock file described in Requirement 4 is scoped to the brief
   read-decide-append sequence only. It SHALL NOT be required to hold, read,
   or run any dispatch; its absence or corruption is covered by the same 6.2
   fallback, treating an unusable lock exactly like an unusable pool file.

## Open questions

- **Multi-machine pooling.** The motivating quote — "another claude session"
  — does not say same machine. This spec assumes one machine because
  liveness (Requirements 2, 4) can only be judged by a process that can see
  the pid in question, and 0036 already established that a different host is
  `undetermined` by construction. A true multi-machine pool needs either a
  network service (a daemon, which Requirement 6 argues against) or trusting
  a remote session's self-report of its own liveness (the exact thing this
  spec exists to stop doing locally). Left open; no design here assumes it
  will be solved the same way.

- **`concurrencyCap` disagreement, minimum-wins.** Requirement 1.3 picks the
  lower of two declared caps as the safe default. Whether that is the right
  call long-term, versus refusing to schedule at all until a person
  reconciles the numbers, is not fully settled — minimum-wins never
  oversubscribes, but a repository whose author genuinely wants a higher cap
  for good reason has no way to express "I mean it" the way spec 0036 R10.1
  lets a person name a cooling lane and mean it.

- **The bounded retry count in Requirement 4.5.** Some small fixed number is
  needed; what a reasonable one is has not been measured against real
  cross-project contention, the same honesty spec 0036 Decision 4 already
  applied to the 30-minute stall interval.

- **Whether FIFO-by-attempt (Requirement 5) starves a project whose sessions
  poll less aggressively than another's.** No evidence of this happening
  exists yet; round-robin remains rejected until there is.
