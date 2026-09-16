---
name: checkyourvibe cyv
description: >-
  Use this when dispatching or babysitting coding-agent work with checkyourvibe
  (cyv), the dispatch daemon, or cyv MCP ? including choosing user-PC vs
  assistant-box host setup.
---
# checkyourvibe (cyv)

Orchestrate coding-agent work through the `cyv` CLI and optional dispatch daemon. Prefer cyv over ad-hoc lane CLIs when the repo uses checkyourvibe.

## Host models (pick one)

### A ? User computer (local heavy setup)
Repos, lane CLIs, and the daemon live on the **user's registered machine**. The assistant wakes work with remote Shell/exec on that machine (HTTP to the loopback daemon). A stdio MCP registration that starts on the **assistant's** computer cannot reach the user's `127.0.0.1`.

### B ? Assistant computer (all-on-box)
Checkout, lane CLIs, daemon, and MCP all live on the **assistant's computer**. Loopback MCP (`cyv-daemon mcp` / local stdio) works because client and daemon share one host.

Never assume which model: check where the repo and `cyv` binary actually are before dispatching.

## Locate tools
1. Find the repo checkout and confirm `cyv` (or `node packages/core/dist/cli/index.js` in a monorepo build) is available on that host.
2. If using the daemon: health-check `GET http://127.0.0.1:4301/health` on the **same** host. Token for mutating routes lives under the host's checkyourvibe appdata (`daemon.token`).
3. MCP tools (when local to the daemon host): `cyv_health`, `cyv_events_after`, `cyv_status`, `cyv_dispatch`, `cyv_wait`.

## Dispatch
1. Prefer the project's documented lane (`--lane ?`) and ownership/gate flags from its cyv config or task brief.
2. Via CLI: `cyv ?` with the task text, lane, own/gate, and expects-no-file-changes when appropriate.
3. Via daemon: `POST /dispatch` (or `cyv_dispatch`) with `cwd`, `task`, optional `lane` / `kind` / `own` / `timeoutSeconds`. On Windows, the daemon must spawn `node` + core CLI ? not a `.cmd` shim (ENOENT).
4. Record `workId` / `dispatchId` from the accept response.

## Wait for completion (no lost events)
1. Canonical store is durable `events.ndjson` (append + fsync). SSE/webhook are hints only.
2. Catch up with `GET /events?after=<cursor>` or `cyv_events_after` / `cyv_wait` ? works after daemon restart and when the client was offline.
3. Do not treat an open PR as a stop signal unless the user said so; keep mining the backlog when that is the standing rule for the project.

## Safety defaults
- Do not push, force-push, or open PRs against **public** remotes unless the user explicitly asked in this conversation.
- Respect any user-stated time gates on pushes/commits (e.g. after a local evening cutoff).
- Prefer lane CLIs the host already has; do not invent paid API spend without asking.

## After a run
Report: workId, lane, outcome, PR URL if any, next recommended task id, and which host model (A or B) you used.
