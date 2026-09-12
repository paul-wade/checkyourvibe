# 0053 — Persistent Orchestrator

**Project:** orchestration  
**Status:** active
**Created:** 2026-09-06
**Depends on:** 0036, 0041, 0052

## Introduction

The orchestrator today is a live agent session: it runs as long as the
terminal is open, and when the user closes the laptop, work stops. The
dashboard and command bridge (spec 0052) let the user drive the
orchestrator from a web page, but the orchestrator itself is still a
foreground process that dies on disconnect.

This spec makes the orchestrator persistent. It runs as a background daemon
that survives terminal disconnects, keeps the command and comment watchers
alive, and can be reattached from any client — the web dashboard, a phone
browser, or a new terminal. The user closes their laptop, the orchestrator
keeps dispatching, and they come back to a board that has moved on.

The daemon is local-first: it runs on the user's machine, not in a cloud
sandbox. Cloud sessions are a future concern; this spec is about not losing
the orchestrator when the terminal closes.

## Requirement 1 — Orchestrator Daemon

1.1. `cyv orchestrator start` SHALL start a background daemon process that
runs the command watcher (`cyv commands --watch`) and the comment watcher
(`cyv comments --watch`) together, keeping both channels alive without a
foreground terminal.

1.2. The daemon SHALL survive the terminal that started it. Starting it
from a terminal and closing that terminal SHALL NOT kill the daemon.

1.3. The daemon SHALL write a PID file and a state file to
`.cyv-review/orchestrator.json` recording: the PID, the start time, the
last-seen-alive timestamp (updated on each poll cycle), and the
self-reported orchestrator state (healthy, degraded, exhausted).

1.4. `cyv orchestrator stop` SHALL stop the daemon by reading the PID file
and sending a termination signal.

1.5. `cyv orchestrator status` SHALL print whether the daemon is running,
how long it has been running, the last-seen-alive timestamp, and the
self-reported state. If the daemon is not running, it SHALL print "stopped"
and exit with a non-zero code so `cyv doctor` can detect it.

1.6. The daemon SHALL NOT run two instances simultaneously. A second `cyv
orchestrator start` SHALL detect the existing PID file and refuse to start,
printing the existing instance's details.

## Requirement 2 — Watcher Lifecycle Inside the Daemon

2.1. The daemon SHALL run the command watcher and comment watcher as
internal poll loops, not as spawned child processes. One process, two poll
loops on a shared interval.

2.2. If a poll cycle encounters an error (a file read fails, a dispatch
throws), the daemon SHALL record the error in the state file and continue
polling. A single error SHALL NOT crash the daemon.

2.3. The daemon SHALL update the last-seen-alive timestamp on every poll
cycle, regardless of whether any commands or comments were found. This lets
the dashboard detect a stalled daemon (timestamp is stale) versus a healthy
idle one (timestamp is recent, no work to do).

2.4. The daemon SHALL respect the `stallAfterMinutes` configuration value
from `checkyourvibe.json`. If no new dispatch has opened within that window
while open work exists and a lane is free, the daemon SHALL record a
stalled state in the state file.

## Requirement 3 — Dashboard Reattachment

3.1. The dashboard SHALL read `.cyv-review/orchestrator.json` on each poll
cycle and display the daemon's state: running, stopped, or stalled.

3.2. If the daemon is stopped, the dashboard SHALL show a banner prompting
the user to start it, with a button that posts to a `POST
/orchestrator/start` endpoint.

3.3. If the daemon is stalled (last-seen-alive is older than
`stallAfterMinutes`), the dashboard SHALL show a warning with the
last-seen-alive timestamp.

3.4. The dashboard SHALL provide `POST /orchestrator/start` and `POST
/orchestrator/stop` endpoints that start and stop the daemon, so the user
can control it from the web page without a terminal.

3.5. Closing the dashboard (the `cyv dashboard` process) SHALL NOT stop the
daemon. The daemon and the dashboard are independent processes. The user
can close the dashboard, reopen it later, and reattach to the same
orchestrator state.

## Requirement 4 — Self-Reported State Propagation

4.1. The orchestrating agent session SHALL continue to report its own
condition via the existing `cyv orchestrator --state` command (spec 0036
Requirement 3). The daemon reads the recorded state and includes it in the
state file.

4.2. The dashboard SHALL display the self-reported state alongside the
daemon's liveness state, clearly distinguishing "the daemon is alive" from
"the agent reports it is healthy." A daemon can be alive while the agent
reports exhausted, and the dashboard must show both.

4.3. When the agent reports `exhausted`, the daemon SHALL NOT dispatch new
work to that lane. It SHALL continue polling for commands and comments, but
dispatch commands targeting the exhausted lane SHALL be marked failed with
a reason naming the lane's state.

## Requirement 5 — Clean Shutdown

5.1. `cyv orchestrator stop` SHALL wait for in-flight poll cycles to
complete before exiting. It SHALL NOT kill the process mid-dispatch.

5.2. If a dispatch is in progress when `stop` is called, the daemon SHALL
let the dispatch finish (the dispatch runs in a separate lane process) and
then exit. The dispatch's outcome is recorded normally.

5.3. On unexpected termination (kill, crash), the PID file SHALL be
considered stale. The next `cyv orchestrator start` SHALL detect that the
PID is not running, remove the stale file, and start fresh. A stale PID
SHALL NOT block a new start.

## Requirement 6 — No Cloud Dependency

6.1. The daemon SHALL run entirely on the local machine. No cloud service,
no remote API, no external process manager is required.

6.2. The daemon SHALL NOT upload repository content, command queues, or
comment stores to any external service.

6.3. Cloud sessions — where the daemon runs in a managed sandbox and
survives the user's machine being off — are explicitly out of scope for this
spec. This spec is about local persistence only.
