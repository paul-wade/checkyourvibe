# 0058 — A dispatch must not be able to hang

**Status:** active
**Created:** 2026-09-06

## What happened

The `t51-visual` dispatch was launched at 12:55:20 with `--timeout 3000`,
fifty minutes. Its executor finished writing at 13:03:36, eight minutes in.
The dispatch then produced nothing further for four and a half hours, until it
was killed manually at 17:27. No output, no gate result, no outcome, no
timeout.

The work itself was fine and was salvaged intact. What failed was the
supervision.

## The gap

`cyv dispatch --help` describes `--timeout` as "Kill an executor that has not
finished by then." It does exactly that and no more. The executor had already
exited normally, so the deadline no longer applied to anything.

Everything after the executor exits is unbounded:

- taking the after-snapshot
- `splitGeneratedPaths`, which shells out to git
- every gate, each of which spawns a process that may itself hang
- writing the dispatch record

A gate is the obvious hazard. `run:pnpm test` spawns a process with no
deadline of its own, so a hung test run hangs the dispatch forever, and an
orchestrator waiting on it waits forever too.

## Requirement

1. A dispatch SHALL have a deadline covering its whole lifecycle, not only the
   executor. `--timeout` currently bounds one phase; the dispatch needs a bound
   on all of them.
2. Every gate SHALL run under its own deadline. A gate that exceeds it fails
   as a gate failure, naming the gate and the elapsed time, rather than
   stalling the dispatch.
3. A dispatch that exceeds its overall deadline SHALL close with an outcome
   saying so, and SHALL NOT be left open in the log. The record must reflect
   what happened rather than nothing at all.
4. A dispatch SHALL emit progress as it moves between phases — executor
   started, executor exited, snapshot taken, each gate started and finished —
   so a supervisor can tell a slow phase from a dead one. Today the output is
   written only at the end, so a hung dispatch and a working one look
   identical from outside.
5. Every child process a dispatch spawns SHALL be terminated when the dispatch
   ends for any reason, including timeout and interruption. An orphaned gate
   process outliving its dispatch is how a machine accumulates work nobody is
   waiting for.

## Why this matters beyond one bad night

The orchestrator's whole premise is that a developer can walk away. A dispatch
that can hang indefinitely, with no progress signal and no deadline, means
walking away can cost hours rather than minutes, and nothing in the system
says so. Spec 0051 Requirement 6.1 already treats a blocked lane as a Needs
You item; a stalled dispatch is the same class of fact and is currently
invisible.

## Related

- The dispatch log currently shows `t51-visual-attempt-1` and
  `t55b-attempt-1` as open, with no close entry, even though one was killed
  and the other completed and was committed. Whether records are being closed
  correctly is worth checking as part of Requirement 3.

## Requirement 6 — A budget nothing checks is not a budget

The plans this project writes carry per-task time budgets. Nothing reads them.
They are prose in a document, consulted only if a human remembers to look, and
during this stall nobody did for four and a half hours.

6.1. A declared budget SHALL be enforced by the system rather than observed by
a reader. The number that appears in a plan and the deadline the dispatch runs
under SHALL be the same number.

6.2. A recheck SHALL fire deterministically on wall-clock time, independent of
any event the dispatch might fail to produce. A supervisor that only wakes on
completion cannot notice a dispatch that never completes, which is precisely
the failure this spec exists to prevent.

6.3. Exceeding a budget SHALL produce a visible fact — a Needs You item under
spec 0051 Requirement 6.1 — not merely a longer wait.

The general form, which applies past this one bug: any interval a human or an
agent is expected to notice must have something mechanical noticing it
instead. Silence is not a signal, and a supervisor that reasons "no news
means it is working" will wait forever on a dead process.
