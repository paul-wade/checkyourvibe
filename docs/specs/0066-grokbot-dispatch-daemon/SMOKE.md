# 0066 smoke — overnight catch-up + dogfood

Date: 2026-09-15 (America/Chicago)

## What we proved
1. Daemon binds `127.0.0.1:4301`; `GET /health` works without token.
2. Durable `events.ndjson` under `%LOCALAPPDATA%\checkyourvibe\` with append+fsync; `GET /events?after=` catch-up.
3. Kill/restart keeps events (smoke `smoke-overnight-20260915182245` → eventId 113 path).
4. Watcher: append closed line to `dispatches.ndjson` → durable event without POST.
5. `POST /dispatch` (token) accepts, spawns core CLI, status goes opened→closed; watcher emits `dispatch.opened` / `dispatch.closed` (dogfood work-20260916001949-3c8cb2 → eventId 116, outcome succeeded).
6. MCP stdio (`node packages/daemon/dist/cli.js mcp`): tools `cyv_health`, `cyv_events_after`, `cyv_status`, `cyv_dispatch`, `cyv_wait`; health + events_after against live daemon OK.

## Start
```
node packages/daemon/dist/cli.js start --port 4301 --project R:\checkyourvibe
# token: %LOCALAPPDATA%\checkyourvibe\daemon.token
# MCP (same PC): node packages/daemon/dist/cli.js mcp
```

## Gotchas
- Do not spawn `cyv.cmd` from the daemon on Windows (ENOENT); use `node` + `packages/core/dist/cli/index.js`.
- MCP for Grok Bot must run on desktop-paul (or any host where the daemon listens). Cursor `AddMcpServer` on the Grok box cannot reach `127.0.0.1:4301` on the PC.

Not published. Local branch `spike/0066-dispatch-daemon` only — do not push without Paul asking.
