# 0066 — Tasks (spike)

- [x] **T6601** Scaffold daemon: 127.0.0.1:4301, token auth, GET /health
- [x] **T6602** Durable events: append+fsync events.ndjson, monotonic eventId, GET /events?after=, SSE as hint only; startup backfill from dispatches.ndjson
- [ ] **T6603** POST /dispatch async wrapper around existing dispatch entrypoint
- [ ] **T6604** MCP bridge stub: cyv_health, cyv_status, cyv_events_after (catch-up), cyv_wait
- [x] **T6605** Smoke: close a dispatch while "client offline", then catch up via after=cursor — must not lose the event
- [ ] **T6606** Manual notes; do not publish npm; do not push public repo unless Paul asks