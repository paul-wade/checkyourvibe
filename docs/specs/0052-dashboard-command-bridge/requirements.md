# 0052 — Dashboard-to-Orchestrator Command Bridge

**Project:** dashboard  
**Status:** active
**Created:** 2026-09-06
**Depends on:** 0042, 0051

## Introduction

The dashboard today is read-only display plus comment posting. The user can
see what happened and leave notes, but they cannot tell the orchestrator to
act from the board. Dispatching, retrying, and acknowledging are CLI commands
typed by hand.

This spec adds the command bridge: the dashboard writes commands to a queue
the orchestrator reads, and the orchestrator's responses flow back to the
board as state changes. The user clicks "Dispatch" on a backlog card, the
orchestrator picks up the command, dispatches the task to a lane, and the
card moves to In Motion — all from the web page, no terminal.

The bridge is bidirectional but asynchronous. The dashboard does not hold a
connection open; it posts a command and polls for the result. The
orchestrator does not push; it reads the queue and writes outcomes to the
dispatch log, which the dashboard already reads. This keeps the architecture
simple and avoids requiring a persistent socket before spec 0053.

## Requirement 1 — Command Queue

1.1. The dashboard SHALL write commands to a JSON file at
`.cyv-review/commands.json` in the repository root, using the same additive
pattern as the comment store: each command is appended with a unique id, a
kind, a target (task id or dispatch id), a timestamp, and a status of
`pending`.

1.2. The command kinds are:
  - `dispatch` — dispatch a task to a lane. Target is a task id from
    `tasks.md`. Includes the lane id to dispatch to.
  - `retry` — re-dispatch a failed dispatch. Target is a dispatch id.
  - `acknowledge` — close a needs-you item. Target is a dispatch id.
  - `comment` — post a line comment on a diff. This reuses the existing
    comment store, but the command wrapper lets the dashboard post without
    a separate endpoint call.
  - `send-review` — deliver all open comments for a dispatch to the
    orchestrator as a batch, so the agent receives them in one pass rather
    than one at a time.

1.3. The command store SHALL be readable without executing any code, the
same constraint the analyzer manifest protocol imposes. It is a JSON file
with a `version`, `nextId`, and `commands` array.

1.4. The orchestrator SHALL read the command queue on its existing poll
interval (the same interval `cyv comments --watch` uses) and act on pending
commands in order.

1.5. A command that has been acted on SHALL be marked `status: "done"` with
the dispatch id or outcome recorded. A command that failed SHALL be marked
`status: "failed"` with a reason.

1.6. The dashboard SHALL poll the command store to detect status changes and
reflect them on the board without a full page reload.

## Requirement 2 — Orchestrator Command Reader

2.1. A new `cyv commands` command SHALL read the command queue and act on
pending commands. It is the orchestrator-side counterpart to `cyv comments
--hook`.

2.2. `cyv commands --watch` SHALL poll the command queue on an interval and
execute each pending command in order. This is the long-running process the
orchestrator session keeps alive to receive dashboard commands.

2.3. For a `dispatch` command, `cyv commands` SHALL invoke the same dispatch
logic `cyv dispatch` uses, with the task id and lane from the command. The
dispatch id is written back to the command record.

2.4. For a `retry` command, `cyv commands` SHALL re-dispatch the original
task with the same lane, producing a new dispatch id.

2.5. For an `acknowledge` command, `cyv commands` SHALL invoke the existing
`cyv acknowledge` logic.

2.6. For a `comment` command, `cyv commands` SHALL write to the existing
comment store via `addComment`.

2.7. For a `send-review` command, `cyv commands` SHALL gather all open
comments for the target dispatch, format them as a single batch, and deliver
them to the orchestrator via the same hook contract `cyv comments --hook`
uses (spec 0042). The comments are marked as delivered but remain open until
the agent addresses them.

## Requirement 3 — Dashboard Command Posting

3.1. The dashboard SHALL expose endpoints for posting commands:
  - `POST /commands/dispatch` with `{ taskId, laneId }` — writes a dispatch
    command.
  - `POST /commands/retry` with `{ dispatchId }` — writes a retry command.
  - `POST /commands/acknowledge` with `{ dispatchId }` — writes an
    acknowledge command.
  - `POST /commands/comment` with `{ dispatchId, file, anchor, body }` —
    writes a comment command.
  - `POST /commands/send-review` with `{ dispatchId }` — writes a
    send-review command.

3.2. Each endpoint SHALL write to the command store and return the command
id, so the dashboard can poll for its status.

3.3. The dashboard SHALL poll `GET /commands` on an interval to detect
status changes for pending commands and update the board accordingly.

3.4. A command that is `pending` SHALL show a visual indicator on the
relevant card (a spinner or "queued" label). A command that is `done` SHALL
cause the card to refresh its state. A command that is `failed` SHALL show
the failure reason on the card.

## Requirement 4 — Batch Review Mode

4.1. The `send-review` command SHALL be the primary review interaction. The
user reviews the diff, leaves line comments, and clicks "Send Review" when
done. This posts a `send-review` command that batches all open comments for
that dispatch.

4.2. The orchestrator SHALL receive the batch as a single message via the
hook contract, not as individual comments. This lets the agent respond to
all feedback in one revision rather than one comment at a time.

4.3. After sending a review, the card SHALL move to In Motion (the agent is
working on the feedback) and the open-comment badge SHALL clear, because the
comments have been delivered even though they are not yet addressed.

4.4. The agent's response — recorded via `cyv comments --record` as a `turn`
— SHALL appear on the card as a new comment, and the card moves to Needs
Review if the agent's revision produces a new diff.

## Requirement 5 — No Breaking Changes to Existing Contracts

5.1. The existing `cyv comments --hook`, `cyv comments --watch`, and `cyv
comments --record` contracts SHALL continue to work unchanged. The command
bridge is an additional channel, not a replacement for the comment channel.

5.2. The existing `cyv dispatch` and `cyv acknowledge` CLI commands SHALL
continue to work unchanged. `cyv commands` invokes their logic, it does not
replace them.

5.3. The dispatch log format SHALL not change. Commands reference dispatch
ids; they do not alter the log structure.

5.4. The comment store format SHALL not change. The `comment` command writes
to the same store `addComment` already uses.
