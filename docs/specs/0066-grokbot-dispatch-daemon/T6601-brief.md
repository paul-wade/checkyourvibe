# T6601+T6602 — Daemon scaffold + durable overnight-safe events

You are on `R:\checkyourvibe`. Create/use branch `spike/0066-dispatch-daemon` from current HEAD.

## Why the last attempt failed
A prior dispatch reported success but **produced-nothing** (no files changed). This run must actually write code.

## Read
- `docs/specs/0066-grokbot-dispatch-daemon/design.md` (especially **Durability**)
- `docs/specs/0066-grokbot-dispatch-daemon/requirements.md` R1–R3
- `packages/core/src/executor/` dispatch store / ndjson writers
- Do not break `packages/core/src/mcp/` analysis tools

## Implement
1. New package or module for the daemon (smallest fit: `packages/daemon` or under core).
2. Listen `127.0.0.1:4301` only; bearer token file; `GET /health`.
3. **Durable log first:** on each `closed` dispatch, append to `%LOCALAPPDATA%\checkyourvibe\events.ndjson` with monotonic `eventId` + `dispatchId`, fsync, then SSE.
4. `GET /events?after=<eventId>` returns catch-up batch (JSON array or NDJSON). SSE optional for live.
5. On daemon start: backfill closed dispatches not yet in the events log (idempotent by dispatchId).
6. Mark T6601, T6602 done in tasks.md; add a one-file smoke note under the spec folder.
7. Commit on `spike/0066-dispatch-daemon`. **Do not push.**

## Ownership (must write)
- `packages/daemon/**` (or the path you create for the daemon)
- `docs/specs/0066-grokbot-dispatch-daemon/tasks.md`
- `docs/specs/0066-grokbot-dispatch-daemon/SMOKE.md` (short)
- `package.json` / `pnpm-workspace.yaml` only if adding a package

## Done when
Daemon starts; health works; simulating or observing a closed dispatch leaves a durable events.ndjson line that is still readable after process restart; `after=` catch-up returns it.
