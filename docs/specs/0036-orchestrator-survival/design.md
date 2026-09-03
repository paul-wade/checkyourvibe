# 0036 — Design

Decisions that would be expensive to reverse, and the ones deliberately not
taken. A reader who disagrees should find the reasoning here rather than infer
it from the code.

## The shape of the problem

Everything in 0011 detects failure by watching a subprocess. That mechanism
cannot reach the orchestrator, because the orchestrator is the caller. No amount
of cleverness inside cyv changes the direction of that arrow.

So this spec does not try to detect orchestrator exhaustion. It does three
different things instead, and the distinction between them is the whole design:

| | What it is | Evidence |
|---|---|---|
| **Prevent** (R1, R2) | Stop spending the orchestrator's quota on work another lane could do | Declared configuration |
| **Observe** (R4, R5) | Report what is and is not happening, without naming a cause | Measured from the log |
| **Accept a claim** (R3) | Record what the orchestrator says about itself | Self-reported, labelled |

Nothing crosses between rows. A self-report is never promoted to a measurement;
a stall is never reported as exhaustion. The project has been bitten twice by
exactly that promotion — 673 fabricated `no-any` findings from an analyzer that
did not know it was guessing, and a C# analyzer that did not know its type graph
was partial — and both fixes were the same fix: say which kind of thing you have.

## Decision 1 — `acceptsDispatch` defaults to false for the orchestrating lane

The alternative was to leave the orchestrating lane eligible and expect the
human to order the models so it is not chosen. That is precisely what this
repository's configuration does today, and it produced the defect: `opus` sits
first in `claude-code-cli`'s `judgment-required` ordering while the same lane
carries `orchestrator: true`, and nothing anywhere reports the collision.

Two fields, in different parts of one file, whose interaction is a footgun and
whose correct setting is invisible. The fix is to make the safe reading the one
you get by not thinking about it.

This follows a precedent already set in 0005: when `--all` and explicit-paths
runs were made to exit 2 on an empty match, the alarming modes were named
explicitly *"so a mode added later has to opt in and the safe behaviour is the
one you get by forgetting."* A lane added later that forgets `acceptsDispatch`
gets the safe reading. An orchestrating lane that genuinely wants dispatched work
says so, and R1.3 makes the run say it out loud.

**Cost, stated plainly:** the strongest model on the machine stops being
available for dispatched judgment work by default. That is intended. The
orchestrator's quota buys planning, review and integration, and this project's
own record is unambiguous about where its value came from — the ROADMAP's pacing
note says *"everything of value tonight came from reading a report carefully,
not from starting one more task."* Spending that capacity on a task a cheaper
lane could have done is the trade this decision refuses.

## Decision 2 — Liveness is written at open time, never maintained

R5.5 forbids a heartbeat, and the reasoning is worth stating rather than
citing: a mechanism that requires the orchestrator to keep writing fails exactly
when the orchestrator fails. A heartbeat file whose last update is old tells you
the same thing the absence of new dispatches already told you, and it costs a
writer that has to survive the failure it is reporting.

So the `opened` entry carries what a later reader needs, written once:

- `host` — the machine that opened it.
- `pid` — the cyv process that opened it. cyv is spawned by the orchestrator, so
  when the orchestrating session dies, this process dies with it, and the
  dispatch it was supervising dies too. That inheritance is what makes a pid
  informative here rather than incidental.
- `processStartedAt` — when that pid's process began. A bare pid is reusable:
  the operating system will eventually hand the number to something unrelated,
  and a reader that checked only the number would call a dead dispatch live
  because some other program inherited its pid.

The three states of R5.2 fall out of what those fields can and cannot settle:

- **live** — same host, a process with that pid exists, and its start time
  matches. The dispatch is still being supervised.
- **abandoned** — same host, no process with that pid exists. The supervisor is
  gone, so the dispatch cannot still be running.
- **undetermined** — a different host, or a pid that exists whose start time
  cannot be read. The reader has no basis to judge, and R5.4 requires it to say
  so rather than pick.

The undetermined state is not a gap to be closed later; it is the honest report
of a reader on a machine that cannot see the process in question. Collapsing it
into either neighbour would be the fabricated precision this project refuses.

**Not taken: a lock or lease file.** A lease would let a relieving orchestrator
claim abandoned work automatically. It also introduces a clock the project has
no basis to set — the same objection 0011 R7.5 raises against time-based
cooldown — and R5.3 already says abandoned work goes to a person rather than
being reclaimed. Adding a lease would be building the mechanism for a decision
the requirements deliberately do not automate.

## Decision 3 — One log, one reader

The self-report of R3 and the liveness fields of R5 go into the existing
append-only dispatch log rather than into new files beside it.

The log is already the thing 0011 R6.4 guarantees is complete and readable from
disk alone by a session that did not write it. Every property this spec needs —
survives its author, ordered, readable by a later process — is a property that
file already has and has been tested to have. A second file would need each of
them established again, and would introduce the question of what to believe when
the two disagree.

The cost is a wider entry union: `opened`, `closed`, `refused`, and now
`orchestrator`. A reader that folds entries into records must ignore event kinds
it does not recognise, which is the same forward-compatibility the record folder
already needs.

## Decision 4 — The stall interval defaults to 30 minutes, and it is a reporting choice

R4.4 requires the default be justified as reporting latency and not dressed up
as knowledge about a reset window. It is 30 minutes, and here is the whole
argument:

A stall is *"work is available, a lane is free, nothing has been dispatched."*
That description is also true of a run being paced deliberately. AGENTS.md and
the ROADMAP both call for at most a couple of delegated tasks at a time, and a
judgment task can legitimately run long while three other lanes sit idle by
choice. So the interval is not a fault threshold — it is the point at which
silence becomes worth mentioning to a human who has walked away.

Thirty minutes is long enough that ordinary pacing and a long-running judgment
dispatch do not trip it, and short enough that someone returning to the machine
learns the run stopped rather than discovering it an hour later. It is a choice
about how often a reader wants to be told something might be wrong. No
subscription's reset window informed it, because this project has no data
connecting the two, and R4.2's insistence that a stall names no cause is what
keeps a wrong interval cheap: the worst outcome is a report that says nothing is
happening during a stretch when nothing was supposed to happen.

**Not taken: making a stall re-dispatch automatically.** R4.5 stops at
reporting. Recovery requires knowing the cause, and the same observation supports
an exhausted orchestrator, a closed terminal, and a session waiting on a
question. Re-dispatching under the third of those starts a second agent against
files a human is mid-conversation about.

## Decision 5 — Availability is checked, and unused capacity is reported

R2 turns `cyv doctor` into the place where declared lanes meet the machine. Two
directions, both of which this repository is currently wrong in:

A declared lane whose program is absent is not an error — a shared configuration
naming five agents on a machine with three is normal and should stay usable. But
it must not be counted as capacity, because the moment it matters is the moment
another lane went into cooldown and the run needs somewhere to go.

The reverse direction is the one that motivated this whole spec. An adapter that
ships, whose CLI is installed and authenticated, that no lane names, is a
subscription the user is paying for and not using — while the orchestrator burns
its own quota. Reporting it is one line of output and it is the difference
between four lanes of capacity and two.

**Not taken: discovering lanes automatically from installed CLIs.** A lane is a
declaration about how the user wants their subscriptions spent, and 0011 R1.3 is
explicit that no lane is discovered, probed, or defaulted. Auto-declaring a lane
because a binary exists would start spending a subscription the user never
pointed at this project. Reporting the gap and letting them declare it keeps the
decision theirs.

## Decision 6 — Handoff reports, and does not act

R6.1's command is a reader over state that already exists. It introduces no new
record, and it changes nothing.

That is the correct shape because the decision it serves — which subscription to
spend next — is one the user owns, and because the relieving orchestrator may be
a different vendor entirely (R6.4). A command that printed the state and then
started dispatching would have to choose a lane, and choosing is what R6.5
reserves for the person paying.

The JSON form required by R6.3 exists because the consumer is usually an agent
rather than a person: a relieving session's first act is to read this, and prose
it has to parse is a schema nobody wrote down.

## Decision 7 — A gate's build output is not a write the executor made

Found by dispatching T36001 rather than by reasoning: devin edited exactly the
four files it declared, both gates passed, and the dispatch closed as
`out-of-scope-write`. The seven offending paths were a `dist/` tree and a
`.tsbuildinfo`, written by the `pnpm typecheck` gate. `git status` showed only
the four intended files.

Every dispatch whose gates compile anything fails that way, which makes the
ownership check useless exactly where it is needed — and `out-of-scope-write`
does not escalate, so the run stops with correct work marked failed.

Ownership is a claim about what the executor *authored*. The snapshot sees every
byte that changed and cannot tell authored from generated, because on disk they
are the same kind of thing. So the diff is split before it is judged, and the
question "is this path generated" is put to the repository's own answer:
`.gitignore`.

**Not taken: a list of generated directory names in the core.** `dist`,
`target`, `bin`, `obj`, `coverage` — the list would be this project's layout
imposed on every repository the tool runs in, and wrong for the first one that
puts its build somewhere else. It would also need editing every time a toolchain
changed, in a file no user of the tool can see.

**Not taken: dropping ignored paths silently.** They are reported as touched but
not judged. A dispatch writing into a build directory it never declared is worth
a reader seeing even when it is not a violation, and silence is the enemy.

When git cannot be asked, every path is reported as authored and the
indeterminacy is stated. Over-reporting produces a false violation a reader can
see and argue with; under-reporting hides a real one.

## What this spec does not resolve

- **Whether a vendor CLI can report its own limit to a hook.** If it can, R3.1's
  record could be written automatically at the moment it matters most, instead
  of depending on a session having enough capacity left to describe its own
  condition. Left as an open question because the answer differs per adapter and
  is a fact to be checked against each vendor, not reasoned about here.

- **Whether `concurrencyCap` should adapt to observed cooldown frequency.** 0011
  R3.1 left it open; this spec does not close it. Every mechanism here is
  declared or observed, never predicted, and an adaptive cap is a prediction.
