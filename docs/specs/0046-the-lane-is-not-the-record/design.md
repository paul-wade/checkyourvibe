# 0046 — Design

Decisions that would be expensive to reverse, and the ones deliberately not
taken. A reader who disagrees should find the reasoning here rather than infer
it from the code.

## Why occupancy must be derived, not trusted

This is the spec's spine, and the project already has the argument in its own
words — just applied to the wrong noun. `executor/outcome.ts` and
`executor/child.ts` classify a dispatch's *outcome* from what changed on
disk, and say explicitly why the executor's own exit code does not decide it:
a process can exit 0 and have done nothing, or exit nonzero after doing
exactly the right thing and failing to report it cleanly. The exit code is
the process's own claim about itself, and this project already refuses to
believe a claim when it can check the filesystem instead.

An unclosed dispatch record is the same claim, one layer up. `opened` with no
`closed` is not evidence a dispatch is running — it is evidence that at some
point in the past, a process wrote a line saying it was starting, and has not
since written a line saying it finished. Whether it is still running is a
separate fact, and until this spec, nothing checked it. The incident's own
numbers make the gap concrete: three phantom claims, zero real processes,
found by asking the operating system directly (`Get-Process`), which is
exactly the kind of check `outcome.ts` already performs for the thing it
governs and `schedule.ts` never performed for this one.

The fix is not a new principle. It is applying the one this project already
holds — filesystem over self-report — to occupancy the same way it is already
applied to outcome.

## Why reconciliation-on-read, not a heartbeat, a lease, or a bare pid check

Four options, in the order the project would naturally reach for them:

**Bare pid check ("does a process with this pid exist").** Rejected already,
by 0036, for a real reason still true here: pids are reused. A process that
died an hour ago and whose pid the OS has since handed to an unrelated
program reads as "still running" under a bare check. `liveness.ts` already
carries the fix — `processStartedAt`, compared with a tolerance — and this
spec reuses it rather than reinventing a weaker version.

**Heartbeat (the claim-holder periodically touches a file to prove it is
alive).** Rejected for the reason 0036 Decision 2 states in its own words:
*"a heartbeat file whose last update is old tells you the same thing the
absence of new dispatches already told you, and it costs a writer that has to
survive the failure it is reporting."* A heartbeat is a mechanism that proves
liveness by asking the thing whose liveness is in question to keep asserting
it — which is self-report with extra steps, and fails at exactly the moment
(the process dies) that the mechanism exists to detect.

**Lease with expiry (a claim is valid for N minutes unless renewed).**
Partly self-reported — the requirement's own framing says so, and it is worth
being honest about exactly how. A lease still trusts the holder to renew
correctly under normal operation; it only recovers automatically once the
lease expires, which means it inherits the heartbeat's fatal case in slow
motion — a process that hangs rather than dies still holds its lease past the
point where it should have released it — and it invents a duration this
project has already refused to invent once (0011 R7.5, cooldown, "no
elapsed-time rule takes part"). A lease timer here would be the same
fabricated precision applied to a second resource.

**Reconciliation-on-read (judge liveness against the actual pid at the
moment a scheduling decision needs to know).** This is what 0036 Requirement
5 already built for the single-repository, single-host case, and what
Requirement 2 of this spec extends to run automatically wherever occupancy is
computed, not only when a person opens the dashboard and clicks stop. Its
cost is real and worth naming: a process-existence check plus, on a process
that exists, a platform-specific start-time read (`Get-Process` on Windows,
`/proc/<pid>/stat` on Linux, `ps` elsewhere — all three already implemented
in `liveness.ts`) — one such check per **open, unresolved** claim against the
`agentId` being scheduled, not per candidate lane and not per dispatch ever
made. Bounded by how many dispatches are currently unclosed, which in
practice is bounded by the sum of every declared `concurrencyCap` — a small
number by construction, because a lane in genuine, correctly-recorded use
never accumulates more open claims than its own cap allows.

Reconciliation-on-read wins because it needs nothing to keep running and
invents no clock: the same reasoning 0036 already applied once, applied again
here because the resource changed but the failure shape did not.

## Where the state lives, and why not in `.cyv-review/`

`~/.cyv/pool.ndjson`, beside `~/.cyv/projects.json` — the one file this
project already keeps outside any repository (`dashboard/projects.ts`).

A per-repository file cannot hold this state by construction, not merely by
inconvenience: `.cyv-review/dispatches.ndjson` lives inside one repository's
checkout, and a second repository's cyv process has no path to it unless it
already knows that repository exists and where it lives on this machine.
`~/.cyv/projects.json` is exactly that knowledge — every project a person has
registered on this machine, in one file, in the one place that is a fact
about the machine rather than about any project. The capacity this spec
tracks is the same kind of fact: which CLI, not which repository. Putting the
pool anywhere else would mean re-deriving "which other repositories exist on
this machine" from scratch, which the registry already answers.

This also keeps the two concerns apart cleanly: `.cyv-review/dispatches.ndjson`
stays the complete, single-repository audit trail 0011 and 0036 already
built and rely on (nothing about this spec touches its shape or its
guarantees — Requirement 2.3 is explicit that a repository's own record is
unaffected). `~/.cyv/pool.ndjson` is strictly additive: a second, smaller
entry written at the same two moments (claim, release) an existing dispatch
already writes its own `opened`/`closed` pair, carrying only what
cross-repository reconciliation needs (`agentId`, host, pid,
`processStartedAt`, the repository root, the dispatch id). One project's
crash does not corrupt another's history, because they were never the same
file.

## Whether a daemon is warranted

No, and this is worth arguing rather than asserting, because a daemon would
solve part of this spec's problem more easily. A single supervisory process
holding the pool in memory would not need a lock file at all — every read and
write would already be serialized by having one process do them.

It is rejected for two reasons, one structural and one specific to this
project. Structurally: a daemon has exactly the liveness problem this whole
spec exists to avoid trusting, one level up. Something would have to know
whether the daemon itself is still alive before believing anything it says,
and if that something is a bare pid check, the project has reintroduced the
weakest option in the list above through a side door; if it is
reconciliation-on-read against the daemon's own pid, the daemon added
supervision cost without adding a capability the reconciliation mechanism
did not already have on its own. Specific to this project: cyv has run since
spec 0011 with no daemon, no service, and no process that outlives the
command that started it, and that property is load-bearing to how this tool
is installed and used — a hook that fires after every edit, a dashboard
someone starts when they want one, nothing a person has to remember is
running. Requirement 6.1 keeps that property. The append-only file plus a
briefly-held, self-healing exclusive lock (Requirement 4) gets the correctness
this spec needs without spending it.

## Why the pool keys on `agentId`

Three candidates existed: `LaneDeclaration.id`, `LaneDeclaration.agentId`, and
"vendor account" (a login, finer-grained than either).

`id` is out because it is exactly the identity that produces the bug this
spec exists to fix: it is author-chosen, per repository, and two repositories
are free to name the same underlying CLI two different lane ids — the task
brief's own example. Pooling on `id` would let two repositories each declare
`concurrencyCap: 1` under different names and both believe they hold their
own, separate slot 1, reproducing the incident's oversubscription across
repositories instead of within one.

"Vendor account" is out for a plainer reason: it does not exist anywhere in
this project's model yet. `LaneBilling` records how a lane is paid for, not
which authenticated session a CLI is running under, and nothing in
`executor/invocation.ts` or the config schema distinguishes two accounts
behind one `agentId`. Inventing that distinction now, with no CLI in this
project's adapters that exposes multiple accounts, would be exactly the kind
of fabricated precision 0011 R7.1 and 0036 R9 already refuse elsewhere in
this codebase — a number the tool cannot actually check standing in for one
it can.

`agentId` is what is left, and it is already load-bearing for the same idea
elsewhere: `agentCommandFor(lane.agentId)` is how the executor resolves which
program to run, and 0011 R1.2 already describes a lane's billing as "a CLI
authenticated against a plan the user already holds" — a plan is a fact about
the `agentId`, not about the lane that happens to name it. Keying the pool on
`agentId` costs nothing new to compute and matches the identity this project
already treats as real everywhere except the one place — scheduling's own
concurrency check — that needed it most.

## Why the lock is an exclusive-create file, not a rename-based swap

`.cyv-review/` and `~/.cyv/` already have a working atomic-write idiom:
write to a temp file, then `rename()` onto the target
(`baseline/write.ts`, `cli/upgrade.ts`, `merge/apply.ts`). That idiom is
right for *replacing* a whole file's contents in one shot. It is the wrong
tool for Requirement 4's problem, which is not "replace the pool file" — the
pool is append-only and Requirement 4.1 never rewrites it — but "let exactly
one of two simultaneous readers proceed past the read-decide-append
sequence." A rename gives atomic replacement, not mutual exclusion between
two things that each want to decide before either writes.

`open(path, 'wx')` — `O_CREAT | O_EXCL` — gives exactly mutual exclusion: the
call fails if the file already exists, atomically, on both POSIX and NTFS.
That failure *is* the "someone else is in the critical section" signal, with
no separate lock protocol to get wrong.

The Windows-specific caveat the task brief asked to be named plainly: Windows
file-locking differs from POSIX in a way that would have broken the
rename-based idiom if it had been reused here. POSIX lets a process rename or
unlink a file that another process still has open — the old file's data
stays valid for whoever already opened it, and the name simply starts
pointing elsewhere. Windows, by default, does not: deleting or renaming a
file that another process has open without having requested share-delete
access fails outright, which is a real reason two-writer races have bitten
projects that assumed POSIX semantics on Windows. `O_CREAT|O_EXCL` sidesteps
this entirely, because it never needs to displace a file another process is
using — it only needs *creating* the lock file to be atomic, which
`CreateFile` with `CREATE_NEW` already guarantees on NTFS, independent of the
share-mode question that makes rename-over-open-file risky on this platform.
This is also why the lock is a distinct small file rather than an attempted
lock on the pool log itself: the pool log is being appended to by unrelated
processes throughout, and taking any kind of exclusive handle on it would
collide with 4.1's append guarantee for no benefit.

Recovering from a lock left behind by a dead holder (Requirement 4.4) reuses
Requirement 2's liveness judgement rather than a lock-expiry timer, for the
identical reason a lease was rejected above: a timer is a guess about how
long a legitimate holder might reasonably take, and this project has already
refused that guess once for cooldown (0011 R7.5) and once for stall
reporting (0036 Decision 4, "not a fault threshold"). A lock file that
records its holder's pid and start time can be judged by the same evidence
as everything else in this spec, so the mechanism gains a third use rather
than a new one.

## Why fairness is first-come, first-served

0011 R7.3 already states the project's policy on what may enter a scheduling
decision: "nothing else SHALL factor into the choice" beyond declared
headroom and cooldown. Round-robin, per-project quotas, and priority all
require a new fact this project does not currently keep anywhere — whose
turn it is, or how much of a shared cap a project has already used relative
to another — persisted across sessions that otherwise share nothing. Building
that bookkeeping to serve a want ("spread the load") that Requirement 4's
mechanism already satisfies passively — whichever session asks while a slot
is free gets it, and no session is ever denied in favor of one that asked
later — would be new state carrying no evidence of the need it would exist
to meet. If real contention patterns later show one project starving another,
that is a fact to design from; none exists yet.

## Whether 0045's managed-environment liveness and 0046's lane liveness are one mechanism or two

Two mechanisms, one discipline. 0045 probes an HTTP endpoint
(`unreal-mcp`) because the thing it supervises is a long-lived service with
no dispatch record and no pid this project ever wrote down — readiness there
means "the declared endpoint answers," checked live, every time. This spec
judges a recorded pid's continued existence and start time, because the thing
it supervises is a short-lived dispatch process this project already wrote a
pid down for at the moment it started. Sharing code between them would mean
building an abstraction over "is this thing alive" general enough to cover a
network probe and a pid check, which is not a real shared operation — it
would be two `if` branches wearing one interface. What they do share, and
should keep sharing, is the refusal both specs make in their own words: a
claim of health is not health, and cyv checks rather than believes. That
principle is the thing worth keeping consistent across the two specs; the
code that implements it does not need to be.

Also relevant: 0045 is scoped to one project (Requirement 6 there is "never
two editors on **one** project") and never needed cross-project state at all.
This spec's entire reason to exist is the cross-project case. That alone
would have kept them apart even if the liveness check itself were identical.

## Open

- **Whether the pool log should ever be compacted.** `.cyv-review/dispatches.ndjson`
  has the same question and has not answered it either; `~/.cyv/pool.ndjson`
  inherits it unresolved. An unbounded append-only file that is read in full
  on every scheduling decision is the kind of thing that is fine for a long
  time and then is not, and this design does not claim to know where that
  line is for this file.

- **Whether `cyv doctor`'s pool report (Requirement 3.1) needs to read every
  registered project's own dispatch log to attribute a claim to a task name,**
  or whether the pool entry's own fields (repository root, dispatch id) are
  enough for a first version. Leaning toward the latter, to avoid Requirement
  3 quietly growing a dependency on `~/.cyv/projects.json` being complete and
  current, which Requirement 6 already treats as a thing that can be missing
  or stale without breaking anything else.

- **Whether the exclusive-create lock's failure mode has actually been
  exercised on Windows under real concurrent load**, as opposed to reasoned
  about from documented `CreateFile`/NTFS semantics. The append-only pattern
  it sits beside has run on this exact incident machine without incident;
  the lock file has not yet been built or tested there.
