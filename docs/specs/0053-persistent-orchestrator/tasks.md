# 0053 — Persistent Orchestrator: Tasks

**Status:** active
**Created:** 2026-09-06

## T53001 — PID file management and stale detection

Create `packages/core/src/orchestrator/pid.ts` implementing: `writePidFile`,
`readPidFile`, `isProcessRunning(pid)`, `removeStalePidFile`. PID file lives
at `.cyv-review/orchestrator.pid`. `isProcessRunning` uses
`process.kill(pid, 0)` on Unix and `tasklist /FI "PID eq <pid>"` on Windows.
A stale PID (process not running) is removed silently so a new start is not
blocked.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/orchestrator/pid.ts`, `packages/core/test/orchestrator/pid.test.ts`

## T53002 — Daemon state file

Create `packages/core/src/orchestrator/state.ts` implementing
`OrchestratorDaemonState`, `writeDaemonState`, `readDaemonState`. The state
file lives at `.cyv-review/orchestrator.json`. Writing updates the
`lastSeenAlive` timestamp. Reading a missing or unreadable file returns
`null` (daemon is not running). The state includes the self-reported agent
state read from the dispatch log via the existing `readDispatchLog`
function.

Depends on T53001 (the PID is part of the state).

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/orchestrator/state.ts`, `packages/core/test/orchestrator/state.test.ts`

## T53003 — Daemon poll loop

Create `packages/core/src/orchestrator/daemon.ts` implementing the daemon's
main loop: on each cycle, update `lastSeenAlive`, run `pollCommands` (from
spec 0052 T52002), run `pollComments` (from spec 0042), catch and record
errors, and check for stall conditions. The poll interval is configurable,
defaulting to 5 seconds. The daemon reads the self-reported agent state from
the dispatch log and merges it into the state file. If the agent reports
`exhausted`, dispatch commands targeting that lane are marked failed.

Depends on T53001, T53002, and spec 0052 T52002.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/orchestrator/daemon.ts`, `packages/core/test/orchestrator/daemon.test.ts`

## T53004 — `cyv orchestrator start/stop/status` CLI

Extend `packages/core/src/cli/orchestrator.ts` with three subcommands:
`start` spawns the daemon via `child_process.spawn` with `detached: true`
and `stdio: 'ignore'`, writes the PID file, and exits; `stop` reads the PID
file, sends a termination signal, and waits for the process to exit; `status`
reads the state file and prints the daemon's liveness and the agent's
self-reported state. The existing `--state` flag stays for recording
self-reports. A second `start` with an existing live PID refuses and prints
the existing instance's details.

Depends on T53001, T53002, T53003.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/cli/orchestrator.ts`, `packages/core/test/cli/orchestrator-daemon.test.ts`

## T53005 — Dashboard orchestrator status and control

Add to `shell.ts`: `POST /orchestrator/start` and `POST /orchestrator/stop`
endpoints that call the same logic as the CLI. Add to `board-render.ts`: an
orchestrator status banner that reads the state file and shows running,
stopped, or stalled. If stopped, the banner includes a "Start" button that
posts to the start endpoint. If stalled, the banner shows the last-seen-alive
timestamp as a warning. Add to `board-client.ts`: polling of the state file
on the existing poll interval to keep the banner current.

Depends on T53002, T53004, and spec 0051 T51003.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/shell.ts`, `packages/core/src/dashboard/board-render.ts`, `packages/core/src/dashboard/board-client.ts`

## T53006 — Doctor check for daemon liveness

Extend `cyv doctor` to check: the daemon PID file exists, the PID is running,
and `lastSeenAlive` is within `stallAfterMinutes` of now. Report each as
pass or fail with a short description. If the daemon is not running, suggest
`cyv orchestrator start`.

Depends on T53002, T53004.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/cli/doctor.ts`
