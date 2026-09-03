# 0040 — Design

## Decision 1 — The page is about the run, and reference leaves the page

The owner's question is "is anything wrong, is anything moving, can I stop it".
A rule's `notFixes` graph is the same picture every time the page loads and
answers none of those. Everything static about the rule pack moves to `/rules`
and renders exactly as it does today, so nothing is lost and nothing competes
with the four regions.

**Not taken: keeping the reference panels below the fold.** 0037 tried that
ordering on 4180 and measured it: reference ran to 2,720 of 3,536 pixels. Below
the fold on a phone is off the page.

## Decision 2 — The disclaimers become evidence marks

Every honesty the old ledes argued for is kept, as a mark rather than a
paragraph: a number carries `measured`, `recorded` or `unknown` and its age; a
lane row says `1 of 1` against a declared cap and nothing about the account; a
cooling lane says what clears it. The reasoning lives in this file and in the
specs it cites. A reader who wants the argument can find it; a reader on a phone
gets the fact.

## Decision 3 — The stop control writes a close entry, not a new event kind

Stopping is `did-not-complete` with a detail, appended by the dashboard process
after it has killed the supervising cyv process (the `pid` an `opened` entry
carries since 0036 T36004) and, through it, the executor. The record folder,
the replay, cooldown and the lanes region all already understand
`did-not-complete`; a new event kind would need each taught again.

The dashboard kills by pid only when the entry's host is this host and the
process exists. On Windows `taskkill /T` takes the tree; elsewhere the pid is
signalled and the executor, which the supervising process spawned, receives the
same signal through its own handling. A pid whose start time postdates the
entry is judged abandoned rather than killed, because it is some other program
(0036 Decision 2).

**Not taken: a stop file the running cyv polls.** It would work on any host,
and it would require the running process to be healthy enough to poll, which
is the assumption 0036 R5.5 refuses.

## Decision 4 — Waves come from file scopes, not from a planner

`_Exec:` lines already declare `files=`. Two open tasks whose globs share no
path can run at once; the scheduler already refuses the second of an
overlapping pair (0011 R4.3). So "next up" groups unblocked tasks by greedy
disjoint-scope packing and shows the first group as the wave. Dependencies are
read from the task text — `Depends on T36004` — and a task whose named
dependency is open is shown blocked rather than next.

This is a reading of the spec, not a scheduler: it dispatches nothing, and it
is the same information the orchestrating agent is told to use when it plans
(spec 0041).

## Decision 5 — Tests are a gate a task may name, and nothing more

The 4180 headline carried `1037 tests pass`. That number belongs to this
repository, not to the product, and putting it on the page taught every reader
that cyv measures tests. It does not. The check indicator shows the last `cyv
check` and nothing else; a task that wants the suite names `run:pnpm test` as a
gate and the gate result appears on that dispatch.

## Decision 6 — One project per page, chosen at the top

0035 built an overview page and skipped it for one project. A dropdown does
both with less: one project shows a name, several show a selector, and the
selector's rows carry the same needs-you and in-flight counts the overview
carried, so the decision to switch is made without leaving the page.

## Decision 7 — The data layer is ported, then rewritten only where the port surfaced a fault

`tools/review/*.mjs` was never under the analyzer. Porting it to `.ts` puts
2,460 lines under the rules for the first time (0037 Decision 1). Where a rule
fires, the code is fixed; where the fix is larger than the port, it is recorded
in `tasks.md`. Nothing is suppressed to land it.

## Decision 8 — The view model is the seam

`dashboard/view-model.ts` declares every shape the page renders. Readers
produce it from disk and git; the renderer consumes it and reads nothing. A
region can then be tested against a fixture of the model, and the model can be
built without a browser. It is also what lets the port run as parallel tasks
with disjoint file scopes, which is the discipline AGENTS.md asks for.

## What this spec does not resolve

- **Authentication.** The server binds loopback unless `--host` is passed, as
  today. One dashboard serving several projects widens what a request reaches
  and that is its own spec.
- **Whether guarded editing ships enabled.** Carried across; default open.
