# 0052 — Dashboard-to-Orchestrator Command Bridge: Tasks

**Status:** active
**Created:** 2026-09-06

## T52001 — Command store

Create `packages/core/src/dashboard/commands.ts` implementing the command
queue: `CommandStore`, `Command`, `addCommand`, `loadCommands`,
`setCommandStatus`, and `pendingCommands`. The store is a JSON file at
`.cyv-review/commands.json`, additive, with the same lenient parsing pattern
as `comments.ts`. A missing or unreadable store is an empty one.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/commands.ts`, `packages/core/test/dashboard/commands.test.ts`

## T52002 — `cyv commands` CLI command

Create `packages/core/src/cli/commands.ts` implementing the `cyv commands`
command. Modes: `--watch [--interval <seconds>]` polls and executes pending
commands; `--peek` prints pending commands without executing; `--json` prints
as JSON. For each command kind, invoke the existing logic: `dispatch` calls
the dispatch module, `retry` re-dispatches, `acknowledge` calls the existing
acknowledge logic, `comment` calls `addComment`, `send-review` gathers open
comments for the dispatch and delivers them via the existing hook contract.
Mark each command done or failed in the store.

Depends on T52001.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/cli/commands.ts`, `packages/core/src/cli/index.ts`, `packages/core/test/cli/commands.test.ts`

## T52003 — Dashboard command endpoints

Add five POST endpoints and one GET endpoint to `shell.ts`:
`POST /commands/dispatch`, `POST /commands/retry`, `POST
/commands/acknowledge`, `POST /commands/comment`, `POST
/commands/send-review`, and `GET /commands`. Each POST parses the request
body, calls `addCommand`, and returns the command id. GET returns the full
command store for polling.

Depends on T52001.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/shell.ts`, `packages/core/test/dashboard/shell-commands.test.ts`

## T52004 — Board client command posting and status polling

Extend `board-client.ts` (from spec 0051) with: a `postCommand(kind, payload)`
function that fetches the appropriate endpoint; a `pollCommands()` function
that fetches `GET /commands` on an interval and updates card state for
resolved commands. A pending command shows a "queued" indicator on the card.
A done command triggers a card refresh. A failed command shows the reason.

Depends on T52001, T52003, and spec 0051 T51006.

_Exec: lane=devin-cli, gates=build,typecheck, files=`packages/core/src/dashboard/board-client.ts`

## T52005 — Dispatch and retry buttons on cards

Add "Dispatch" button to Backlog cards (posts a `dispatch` command with the
task id and a lane selector). Add "Retry" button to failed Needs Review cards
(posts a `retry` command). Add "Acknowledge" button to resolved Needs Review
cards (posts an `acknowledge` command). Each button calls `postCommand` from
T52004 and shows the queued indicator until the command resolves.

Depends on T52004.

_Exec: lane=devin-cli, gates=build,typecheck, files=`packages/core/src/dashboard/board-render.ts`, `packages/core/src/dashboard/board-client.ts`

## T52006 — Send Review button and batch delivery

Add a "Send Review" button to the diff drawer (from spec 0051) that posts a
`send-review` command for the current dispatch. The button is enabled only
when there are open comments for that dispatch. After posting, the open-
comment badge clears and the card moves to In Motion. The batch delivery
logic in `cyv commands` (T52002) gathers all open comments, formats them as
one message, and delivers via the hook contract.

Depends on T52002, T52004, and spec 0051 T51005.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/diff-drawer.ts`, `packages/core/src/dashboard/board-client.ts`, `packages/core/src/cli/commands.ts`

## T52007 — Orchestrator watch integration

Document and wire the orchestrator's startup sequence: the orchestrating
agent session runs `cyv commands --watch` alongside `cyv comments --watch` so
both channels are active. The watch interval is shared. Update `cyv doctor`
to check that both watchers are running and report if either is stale.

Depends on T52002.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/cli/doctor.ts`, `packages/core/src/cli/commands.ts`
