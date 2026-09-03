# 0042 — The exchange reaches the agent

**Status:** active
**Created:** 2026-09-01
**Depends on:** 0040, 0041

## Introduction

The dashboard's exchange (0040 R5) is how the owner writes back to the
orchestrating agent from a phone. On 2026-09-01 the owner left three notes over
an hour and none was read, because the channel is pull-only: a note lands in
`.cyv-review/comments.json` and nothing carries it into the session. `cyv
comments` exists and was run when the orchestrator remembered to, which was
twice.

This is the project's own lesson, one layer up. `tools/spec-workflow.mjs`
exists because "the prose version was advisory and did not hold". An
instruction to the orchestrator to poll for notes is prose in the same sense.
The fix is the same shape as the analyzer's: a finding is not something the
agent goes looking for, it is put in front of the agent by a hook. A note from
the owner is a finding about the run.

## Requirement 1 — Notes arrive the way findings arrive

1.1. Each agent adapter that installs a hook SHALL, on the same events its
   analyzer hook uses, run `cyv comments` for the current repository and, when
   there are unread notes, deliver them into the session as context, in the
   form that adapter's hook contract supports (0003 recorded each adapter's
   payload and exit-code semantics; this reuses them).

1.2. WHERE the agent's hook contract supports refusing to end a turn (Claude
   Code's `Stop` event), the adapter SHALL install that hook so a turn does not
   end while an unread note exists, and the refusal SHALL carry the notes.

1.3. A note delivered by 1.1 or 1.2 SHALL advance the cursor only when the
   session has received it. A delivery that failed SHALL leave the note unread.

1.4. The hook SHALL be cheap: it reads one JSON file and one cursor file. It
   SHALL NOT run an analyzer, a dispatch, or anything that spawns an agent.

## Requirement 2 — A dispatch closing shows what arrived while it ran

2.1. WHEN `cyv dispatch` closes a dispatch THEN it SHALL print any notes unread
   at that moment, after the outcome and before returning. This is the point
   at which the orchestrator is already reading cyv's output and about to
   decide what to do next.

2.2. Printing under 2.1 SHALL NOT advance the cursor; the hook of Requirement 1
   or an explicit `cyv comments` does. A note shown twice is cheaper than a
   note shown to a process that was about to exit.

## Requirement 3 — The owner can see that the agent has not read a note

3.1. The exchange SHALL show, on each owner note, whether the agent has read it
   — the cursor is past it — and, when not, for how long it has been unread.

3.2. WHEN an owner note has been unread for longer than the stall interval
   (0036 R4.4) THEN it SHALL appear under needs you as its own item, worded as
   a description: the agent has not read this, not the agent is ignoring this.

3.3. Nothing here infers that the agent read a note from anything but the
   cursor. A note the hook delivered and the agent did not act on reads as read,
   because it was.

## Requirement 4 — A long-running form of the watcher

4.1. `cyv comments --watch` SHALL run until interrupted, printing each new note
   as it appears and advancing the cursor after printing, so a supervisor that
   consumes lines — a monitor, a terminal a person watches — gets one line per
   note without polling on its own schedule.

4.2. Its poll interval SHALL be configurable and default to a small number of
   seconds; it reads two small files and nothing else.

## Requirement 5 — Verified by leaving a note

5.1. Before this spec closes, a note left on the dashboard SHALL be seen to
   reach a Claude Code session through the hook without the session asking,
   and a dispatch closing SHALL be seen to print a note left while it ran.
   Record both in `docs/STATUS.md`.
