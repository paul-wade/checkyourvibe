# 0062 — Three tiers: an orchestrator, a middle, and the work

**Project:** orchestration  
**Status:** proposed
**Created:** 2026-09-08
**Constrained by:** 0011 Requirement 8.3 — a lane's model ordering belongs to the lane

## What this is

Today one session does everything: plans the specs, writes the briefs, dispatches
the work, reads every result, fixes what came back wrong, and merges. That
session is the most expensive model in the fleet, and most of what it spends its
time on is not planning or merging.

This splits the work three ways.

**The orchestrator** owns what only it can own: the specs, the plan, the
dashboard, and the merge. It decides what should happen and whether what came
back is right. It is the expensive model because those are the expensive
judgements.

**The middle** takes one spec and drives it to completion: writes the briefs for
its tasks, dispatches them, reads the outcomes, re-dispatches on a gate failure,
and hands back one result for the whole spec. It is a cheaper model, because
turning a spec into briefs and watching gates is not the same judgement as
deciding what the spec should say.

**The work** is what already exists: a dispatch on a lane, judged by gates and
an observed effect.

## Why this shape and not another

The evidence is this session. Sixty-odd dispatches, and the orchestrator's own
time went almost entirely to four things: writing briefs, watching for a
dispatch to close, reading an outcome record, and repairing a test the change
had invalidated. None of those need the model that decides whether a spec is
right.

The two that do need it — noticing that a benchmark was measuring its own
fixture prose, and noticing that the gate had never been registered — both came
from reading evidence across specs, which is the orchestrator's own view and not
a middle's.

## Requirement 1 — The middle owns one spec at a time

1.1. A middle SHALL be dispatched against exactly one spec and SHALL NOT read or
write outside that spec's declared paths. The ownership machinery that judges a
worker judges a middle.

1.2. A middle SHALL be given the spec and the task list, not a brief. Writing
the briefs for its tasks is the job.

1.3. A middle SHALL NOT dispatch another middle. Two tiers of fan-out is the
design; three is a way to lose track of what is running.

## Requirement 2 — What a middle hands back

2.1. A middle SHALL close with one record for the spec: which tasks it
dispatched, what each returned, what it re-dispatched and why, and what remains
unfinished.

2.2. A middle SHALL NOT report success for a spec whose tasks did not all pass
their gates. Partial completion is reported as partial.

2.3. The orchestrator SHALL judge a middle's result from the record and the
observed effect, exactly as it judges a worker's. A middle is not trusted more
for being a middle.

## Requirement 3 — The orchestrator keeps what only it can do

3.1. Spec planning, the dashboard, and the merge SHALL remain with the
orchestrator.

3.2. The orchestrator SHALL NOT write briefs for tasks inside a spec it has
handed to a middle. If it finds itself doing that, the middle was not given
enough.

3.3. A finding that spans specs — a metric measuring the wrong thing, a gate
that never fired — belongs to the orchestrator. A middle sees one spec and
cannot see across them.

## Requirement 4 — Cost is measured, not assumed

4.1. The reason for this split is that the expensive model spends its time on
cheap work. That claim SHALL be measured rather than asserted: tokens and cost
per spec completed, orchestrator-only against orchestrator-with-middles.

4.2. The benchmark already records tokens and dollars per trial from the
runtime. The same measurement applies here.

4.3. If the split does not reduce cost per spec completed, it SHALL be reported
as not having done so. A null result is publishable.

## Requirement 5 — Failure is visible

5.1. A middle that stops SHALL leave its spec's remaining tasks visible to the
orchestrator, not silently unfinished. The dashboard's To Do column is drawn
from specs with tasks left, so a stopped middle returns its spec to that column.

5.2. A middle SHALL be subject to the dispatch deadline (0058) like any other
executor. A middle that hangs is a dispatch that hangs.

## What this does not decide

Which model a middle runs. That belongs to the lane's own ordering (0011
Requirement 8.3), and this spec does not re-rank it.
