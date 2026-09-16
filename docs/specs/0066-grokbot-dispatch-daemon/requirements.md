# 0066 â€” Requirements (spike slice)

**Status:** spike
**Created:** 2026-09-15

## R1 â€” Loopback daemon
R1.1 A long-lived process binds only to 127.0.0.1 and serves the HTTP surface in design.md.
R1.2 Unauthenticated requests are rejected (except optionally `/health` with no secrets).
R1.3 The process survives a single failed dispatch without exiting.

## R2 â€” Dispatch proxy
R2.1 POST /dispatch accepts cwd + task (+ lane/kind/own/gate) and schedules via existing executor path.
R2.2 Response returns workId without waiting for executor exit.
R2.3 GET /dispatches/:workId reflects opened/closed state from the on-disk store.

## R3 — Completion events (durability)
R3.1 Every closed dispatch emits a structured event with workId, laneId, outcome, cwd, summary, monotonic eventId, and dispatchId.
R3.2 Events are appended to a local events.ndjson and fsync'd before SSE/webhook fan-out.
R3.3 GET /events?after=<eventId> replays all later events so offline consumers catch up (overnight-safe).
R3.4 On daemon start, backfill any closed dispatches missing from events.ndjson (idempotent by dispatchId).
R3.5 Optional webhooks use a durable outbox with retries; webhook failure must not drop the log entry.
R3.6 SSE alone is not a durability mechanism.

## R4 â€” MCP bridge
R4.1 A separate MCP server exposes cyv_health, cyv_lanes, cyv_dispatch, cyv_status, cyv_wait.
R4.2 Existing analysis MCP tools remain unchanged.

## R5 â€” Non-regression
R5.1 `cyv dispatch` CLI behavior unchanged.
R5.2 Dashboard on 4300 unchanged by the spike.
