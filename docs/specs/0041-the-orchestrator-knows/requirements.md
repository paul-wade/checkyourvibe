# 0041 — The orchestrator knows it is the orchestrator

**Status:** active
**Created:** 2026-09-01
**Depends on:** 0011, 0036, 0040

## Introduction

`checkyourvibe.json` marks one lane `orchestrator: true`. Nothing tells the
session that starts in that folder. The Claude Code adapter writes a block into
`CLAUDE.md` about how its hook reports a violation and nothing else; the agent
that is supposed to plan the run, spread it across the other subscriptions, and
review what comes back learns none of that from the tool that knows it.

Three consequences, each observed in this repository:

- Work was dispatched one task at a time because nobody told the orchestrator
  the scheduler already refuses overlapping scopes and will happily run one
  dispatch per lane at once.
- Spec 0036 reserved the orchestrating lane, correctly, and left a user with
  one subscription nowhere to dispatch to: every dispatch is refused and the
  refusal names no alternative.
- The planning workflow in `AGENTS.md` says nothing about writing tasks so
  they can run in parallel, so file scopes overlap by accident and waves are
  one task wide.

This spec gives the orchestrating session a brief generated from the
configuration, a way to execute a task itself when it is the only executor,
and a cap and a planning aid for running several dispatches at once.

## Requirement 1 — The orchestrating session is briefed by the tool

1.1. `cyv init` and `cyv upgrade` SHALL write a managed block, id
   `orchestration`, into the instructions file of the agent whose lane
   declares `orchestrator: true`, and into no other agent's file. An agent with
   no orchestrating lane gets no block.

1.2. The block SHALL be generated from the configuration by one function in
   core, so every adapter says the same thing, and SHALL state: which lane the
   session is; the dispatchable lanes with their caps, task kinds and program
   availability; how many dispatches may run at once (Requirement 3); how a
   task is declared and dispatched; that the orchestrator does not edit the
   repository while a dispatch runs; how to read notes and record turns; how
   to self-report state; and how a relieving orchestrator resumes.

1.3. The block SHALL be regenerated when the lanes change, and `cyv doctor`
   SHALL report it as drift when the file's block no longer matches what the
   configuration would produce.

1.4. The block SHALL contain no vendor's model ranking and no claim about any
   account's remaining capacity (0011 R7.1, R8.3).

## Requirement 2 — One subscription is still an executor

2.1. A lane declaration SHALL support `executes: 'cli' | 'subagent'`. `cli`
   spawns the agent's program, as today. `subagent` means the orchestrating
   session runs the task itself, as a sub-agent of its own, and the core
   judges the result exactly as it judges a CLI's.

2.2. WHEN the orchestrating lane is the only declared lane THEN
   `acceptsDispatch` SHALL default to `true` and `executes` SHALL default to
   `subagent`. The 0036 R1.2 default stands whenever another lane exists.

2.3. `cyv dispatch` against a `subagent` lane SHALL open the record, take the
   before snapshot, write the prompt, print the dispatch id and the prompt
   path, and exit without running anything. `cyv dispatch --close <id>` SHALL
   take the after snapshot, run the gates, classify the outcome by observed
   effect (0011 R2), and close the record. A `--close` for a dispatch with no
   persisted snapshot SHALL refuse and say so.

2.4. A refusal for want of an eligible lane SHALL name self-execution as the
   remaining option when the orchestrating lane exists, rather than ending
   with a list of exclusions (0036 R1.5).

2.5. A dispatch opened for a sub-agent SHALL be judged for liveness like any
   other (0036 R5), so an orchestrator that died mid-task leaves an abandoned
   record and not an open one.

## Requirement 3 — Several at once, up to a cap

3.1. The configuration SHALL support `executor.maxConcurrentDispatches`. The
   default SHALL be the sum of the dispatchable lanes' concurrency caps, so
   more subscriptions mean more parallel work without a second number to
   maintain.

3.2. The scheduler SHALL refuse a dispatch that would exceed it, with an
   ineligibility reason distinct from a lane's own cap.

3.3. `cyv plan <spec>` SHALL print the spec's open tasks grouped into waves by
   disjoint file scope and satisfied dependencies (0040 Decision 4), with the
   lane each names, in a human form and `--json`. It dispatches nothing.

3.4. The planning guidance in `AGENTS.md` SHALL state how to write tasks that
   run at once: disjoint `files=` scopes, dependencies named in the text, a
   task per lane-sized unit, and gates each task can pass alone.

## Requirement 4 — Verified against this repository

4.1. `cyv init` on this repository SHALL produce the block in `CLAUDE.md`, and
   the block SHALL name the lanes `cyv doctor` reports as found.

4.2. A configuration with only the orchestrating lane SHALL dispatch a task by
   `subagent`, close it with `--close`, and record an observed-effect outcome.

4.3. `cyv plan 0040` SHALL show more than one task in its first wave.
