# 0041 — Design

## Decision 1 — The brief is generated, not written

The orchestration block is produced by `executor/brief.ts` from the loaded
configuration and the program resolution `doctor` already performs. Adapters
call it and wrap it in their own managed-block delimiters; none of them carries
prose of its own about orchestration. A hand-written brief would rot the first
time a lane was added, and six adapters would rot six ways.

The block is written only into the file of the agent whose lane is the
orchestrator. Writing it everywhere would tell every executor it is the
orchestrator, which is the confusion 0036 R1 spent a spec removing.

## Decision 2 — Self-execution is two commands with a persisted snapshot

A CLI lane is one `cyv dispatch`: snapshot, spawn, snapshot, judge. A
sub-agent lane cannot be, because the thing doing the work is the caller. So
the dispatch is split at the spawn: `cyv dispatch` opens the record and
persists the before snapshot under `.cyv-review/dispatch-snapshots/<id>.json`;
`cyv dispatch --close <id>` reads it back, snapshots again, runs the gates and
closes. Everything after the spawn is the same code path as the CLI lane, so
the outcome vocabulary and the cooldown rule are unchanged.

**Not taken: trusting the orchestrator's own account of what it changed.** That
is the exit-code mistake 0011 R2 was written against, in a new coat.

**Not taken: spawning the orchestrator's CLI as a child.** A Claude Code
session can spawn `claude -p`, and that would be the `cli` lane, spending the
same subscription from a second process. It works, and it loses the context the
orchestrator already has. `subagent` is for the case where the session wants
to hand the task to its own sub-agent and keep the review in the same context.

## Decision 3 — The global cap defaults to the sum of lane caps

A user with three subscriptions declared at one dispatch each gets three
parallel dispatches without setting anything. A user who wants fewer, because
their machine or their attention is the limit, sets
`executor.maxConcurrentDispatches`. The number is a cap on the core's own
scheduling, like a lane's cap, and says nothing about any account.

## Decision 4 — `cyv plan` reads the same waves the dashboard shows

One implementation, `dashboard/review/specs.ts`'s `planWaves`, feeds both the
"next up" region and the command. The orchestrator and the person reading the
phone see the same grouping, so a disagreement about what can run at once is
visible rather than hidden in two heuristics.

## Decision 5 — Defaults follow the count of lanes, and are resolved in one place

`acceptsDispatch` and `executes` are resolved by `configuredLanes`, which
already resolves the 0036 default. The rule is: with one lane declared, the
orchestrator executes; with more, it is reserved unless its author says
otherwise. `doctor` states the resolved value, so a user with one lane is told
their orchestrator will run tasks itself before the first dispatch does.
