# 0053 — Persistent Orchestrator: Design

**Status:** active
**Created:** 2026-09-06

## Architectural Decisions

### 1. Node daemon, not a system service

The daemon is a Node process spawned by `cyv orchestrator start` and
detached from the controlling terminal. It writes a PID file and a state
file to `.cyv-review/`, polls on an interval, and runs until `cyv
orchestrator stop` or an unexpected exit.

**Why not systemd/launchd:** Those are platform-specific, require elevated
privileges, and tie the orchestrator to a system service manager the user
may not control (especially on Windows). A detached Node process works
cross-platform, needs no privileges, and is started and stopped by the same
CLI the user already runs.

**Why not a worker thread:** A worker thread lives inside the parent
process. When the terminal closes, the parent dies, and the worker dies with
it. The point is survival across terminal disconnects, which requires a
separate process.

### 2. Detach via spawn with `detached: true`

On all platforms, `cyv orchestrator start` spawns the daemon via
`child_process.spawn` with `detached: true` and `stdio: 'ignore'`, then
calls `unref()` so the parent can exit without waiting for the child. The
daemon inherits no terminal.

On Windows, detached processes survive the parent terminal closing. On
Unix, the daemon is reparented to init (PID 1) when the parent exits. Both
platforms give the same result: the daemon outlives the terminal.

### 3. One process, two poll loops

The daemon runs a single event loop with two poll functions on a shared
interval: `pollCommands` (from spec 0052) and `pollComments` (from spec
0042). Each poll is wrapped in a try/catch so one failing does not stop the
other. The last-seen-alive timestamp is updated at the top of every cycle,
before either poll runs.

**Why not two processes:** Two processes means two PID files, two stop
commands, and two things that can drift apart (commands watcher alive,
comments watcher dead). One process with two loops is simpler to manage and
simpler to monitor.

### 4. State file as the communication channel

The daemon writes `.cyv-review/orchestrator.json` on every poll cycle:

```ts
interface OrchestratorDaemonState {
  pid: number;
  startedAt: number;       // epoch ms
  lastSeenAlive: number;   // epoch ms, updated each cycle
  pollIntervalSeconds: number;
  selfReportedState: 'healthy' | 'degraded' | 'exhausted' | 'unknown';
  selfReportedAt?: number; // epoch ms, when the agent last reported
  selfReportedReason?: string;
  selfReportedModel?: string;
  stalled: boolean;
  stalledReason?: string;
  lastError?: string;      // most recent poll error, if any
}
```

The dashboard reads this file to display orchestrator status. `cyv
orchestrator status` reads it for the CLI. `cyv doctor` reads it for the
health check. No IPC, no socket — just a file both sides read.

The daemon reads the self-reported state from the dispatch log (where `cyv
orchestrator --state` records it) and merges it into the state file. The
agent's self-report and the daemon's liveness are two different facts, and
the state file carries both.

### 5. Stale PID detection

On `start`, the daemon checks for an existing PID file. If one exists:

1. Read the PID.
2. Check if a process with that PID is running (via `process.kill(pid, 0)`
   on Unix, `tasklist` on Windows).
3. If the process is running, refuse to start and print its details.
4. If the process is not running, remove the stale PID file and start.

This handles the case where the daemon crashed without cleaning up. The
user does not need to manually delete the PID file.

### 6. Dashboard control endpoints

The dashboard gains two endpoints:
- `POST /orchestrator/start` — spawns the daemon (same logic as `cyv
  orchestrator start`)
- `POST /orchestrator/stop` — stops the daemon (same logic as `cyv
  orchestrator stop`)

These are thin wrappers around the same functions the CLI uses. The
dashboard already reads the state file for status display; the endpoints
add the ability to control the daemon from the web page.

### 7. File scope

New files:
- `packages/core/src/orchestrator/daemon.ts` — the daemon process logic
  (poll loops, state file, PID management)
- `packages/core/src/orchestrator/pid.ts` — PID file read/write and
  stale detection

Modified files:
- `packages/core/src/cli/orchestrator.ts` — add `start`, `stop`, `status`
  subcommands (the existing `--state` flag stays)
- `packages/core/src/dashboard/shell.ts` — `POST /orchestrator/start`,
  `POST /orchestrator/stop` endpoints
- `packages/core/src/dashboard/board-render.ts` — orchestrator status banner
  (from spec 0051)
- `packages/core/src/dashboard/board-client.ts` — orchestrator status polling
- `packages/core/src/cli/doctor.ts` — check daemon liveness

## Decisions Deliberately Not Taken

- **No cloud sessions.** The daemon runs locally. Cloud persistence is a
  future spec that would replace the local daemon with a remote one, but the
  state-file contract would stay the same.

- **No websocket.** The dashboard polls the state file. A websocket would
  give instant updates, but the poll interval (5 seconds by default) is fast
  enough for a review surface, and avoiding a websocket keeps the dashboard
  server simple.

- **No multi-orchestrator.** One daemon per repository. Running orchestrators
  for multiple repos simultaneously is a future concern tied to multi-repo
  dashboard support.

- **No automatic restart.** If the daemon crashes, it stays down. The
  dashboard shows a "stopped" banner and the user restarts it. An auto-restart
  supervisor is a system-service concern, not an application concern.

- **No log streaming.** The daemon writes errors to the state file's
  `lastError` field. A full log tail is not in scope; the dashboard shows the
  last error, and the dispatch log records dispatch-level history.
