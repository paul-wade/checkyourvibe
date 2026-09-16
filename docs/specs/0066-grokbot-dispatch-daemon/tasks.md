# 0066 — Tasks (spike)

- [x] **T6601** Scaffold daemon: 127.0.0.1:4301, token auth, GET /health
- [x] **T6602** Durable events: append+fsync events.ndjson, monotonic eventId, GET /events?after=, SSE as hint only; startup backfill from dispatches.ndjson
- [x] **T6603** POST /dispatch async wrapper around existing dispatch entrypoint (spawns `node packages/core/dist/cli/index.js`; watcher tails dispatches.ndjson into events)
- [x] **T6604** MCP bridge: `cyv_health`, `cyv_status`, `cyv_events_after`, `cyv_dispatch`, `cyv_wait` via `cyv-daemon mcp` (stdio on the PC that runs the daemon)
- [x] **T6605** Smoke: close a dispatch while "client offline", then catch up via after=cursor — must not lose the event
- [x] **T6606** Manual notes in SMOKE.md; not published to npm; no public push unless Paul asks

## Dogfood (2026-09-15 ~7:20pm CT)
- Durability + watcher + real antigravity dispatch open/close → durable `dispatch.closed` (eventId 116)
- MCP stdio tools/list + `cyv_health` / `cyv_events_after` against live daemon on 4301
- Note: Grok Bot `AddMcpServer` stdio runs on Grok's machine, not desktop-paul — use PC-local MCP or HTTP from Shell+machineId
