# 0066 â€” Grok Bot dispatch daemon + MCP + completion events

**Status:** spike
**Created:** 2026-09-15
**Depends on:** 0011 (dispatch), existing `cyv mcp` (analysis-only), 0036 (orchestrator survival â€” related, not blocked)

## Problem

Grok Bot (and other out-of-process orchestrators) drive cyv today by shelling into the PC and scraping `.cyv-review/dispatches.ndjson`. That works, but:

1. Subagents often cannot target the Windows machine.
2. There is no structured "dispatch finished" wake â€” only polling / 2h routines.
3. Existing `cyv mcp` is **analysis-only** (`check_files`, `check_working_tree`, `list_rules`, `explain_rule`). It does not dispatch or watch executors.

## Shape (two processes, one host)

```
Grok Bot / Cursor  --MCP(stdio)-->  cyv-dispatch-mcp  --HTTP-->  cyv-daemon (127.0.0.1)
                                         |                         |
                                         |                         +-- wraps cyv dispatch / store
                                         |                         +-- tails dispatches.ndjson
                                         |                         +-- emits completion events
                                         v
                                   (optional) file sink / webhook
```

- **Daemon** â€” long-lived on the PC, loopback only. Owns dispatch lifecycle + events.
- **MCP adapter** â€” thin stdio bridge for Grok/Cursor tool calls. Does not run executors itself.
- **Existing `cyv mcp`** â€” unchanged (standards check). New tools live under a distinct server name: `checkyourvibe-dispatch`.

Do **not** fold dispatch into the analysis MCP in v1: different lifetime, different trust, different failure modes.

## Auth

- Bind `127.0.0.1` only (no LAN in spike).
- Shared token in `%LOCALAPPDATA%\checkyourvibe\daemon.token` (or `~/.local/share/checkyourvibe/daemon.token`).
- Every HTTP request: `Authorization: Bearer <token>`.
- MCP process reads the same token file; never prints it.

## HTTP surface (spike)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ ok, version, pid }` |
| GET | `/lanes?cwd=` | Declared lanes + headroom (from project `checkyourvibe.json`) |
| POST | `/dispatch` | Body mirrors `cyv dispatch` flags; returns `{ workId }` immediately (async) |
| GET | `/dispatches/:workId` | Latest open/closed state from store |
| GET | `/events` | SSE stream of completion (and optional open) events |
| POST | `/ack` | Thin wrap of `cyv acknowledge` (optional in spike) |

`POST /dispatch` must not block the HTTP handler for the full Devin run. Spawn/reuse the same path `cyv dispatch` uses; return `workId` once `opened` is recorded.

## Completion events

On every `closed` record in `dispatches.ndjson` (any configured project):

```json
{
  "type": "dispatch.closed",
  "at": "ISO-8601",
  "cwd": "R:\\storageflow-lease-recovery",
  "workId": "work-â€¦",
  "dispatchId": "â€¦-attempt-1",
  "laneId": "devin-cli",
  "outcome": "succeeded",
  "summary": "â€¦",
  "prUrl": null,
  "failedGates": []
}
```

Delivery (spike ships 1+2; 3 is stub):

1. **Append-only `events.ndjson`** (canonical; fsync before fan-out).
2. **SSE** on `/events?after=` (live hint + catch-up; never sole durability).
3. **Webhook** optional URL in daemon config (POST JSON). Off by default.

Also emit `dispatch.opened` so dashboards stay honest (0036 abandoned-open problem is adjacent).

## MCP tools (`checkyourvibe-dispatch`)

| Tool | Maps to |
|------|---------|
| `cyv_lanes` | GET `/lanes` |
| `cyv_dispatch` | POST `/dispatch` |
| `cyv_status` | GET `/dispatches/:workId` |
| `cyv_wait` | Subscribe SSE until matching `dispatch.closed` or timeout |
| `cyv_health` | GET `/health` |

Grok Bot installs this MCP pointing at the local bridge binary; the bridge talks to the daemon. No Shell scraping.

## Non-goals (spike)

- Cloud / multi-machine daemon
- Replacing the dashboard on :4300
- Solving full 0036 orchestrator survival (heartbeat/lease) â€” may share the event stream later
- Publishing to npm

## Spike acceptance

1. `cyv daemon start` (or `node â€¦`) listens on `127.0.0.1:4301` with token auth.
2. `curl` health + lanes against a known project cwd works.
3. One dry-run or tiny `--expects-no-file-changes` dispatch round-trips and produces a `dispatch.closed` on `/events` and in `events.ndjson`.
4. MCP stub can call `cyv_health` and `cyv_status` (dispatch tool may be wired second if timeboxed).
5. Docs: this folder + short pointer from `docs/ROADMAP.md` backlog (no number collision â€” folder **0066**).


## Durability (must not lose overnight)

**Rule:** live delivery (SSE / webhook) is a *hint*. The append-only event log is the *source of truth*. If Grok Bot or the MCP client is asleep when a dispatch closes, nothing is lost — on next wake they catch up.

### Canonical log
- Path: user-local `events.ndjson` (Windows: `%LOCALAPPDATA%\checkyourvibe\events.ndjson`).
- Each line is one event with a monotonic `eventId` (ulid or integer) plus `dispatchId` for idempotency.
- Write path: append line → `fsync` (or equivalent) → *then* fan out to SSE/webhook.
- Never delete or rewrite historical lines in v1 (rotate later with a floor eventId).

### Consumer cursor (catch-up)
- Clients persist `lastSeenEventId` (Grok routine state, MCP session file, or query param).
- `GET /events?after=<eventId>` returns all later events (batch), then optionally upgrades to SSE for live.
- `cyv_wait` / overnight babysit: on wake, **replay after cursor first**; only then wait for new live events.
- Advance cursor only after the consumer has successfully handled the event (at-least-once).

### Daemon restart / missed tail
- On startup, reconcile: scan watched projects' `dispatches.ndjson` for `closed` records whose `dispatchId` is not yet in `events.ndjson`; append missing events (idempotent).
- If the daemon was down while Devin finished, catch-up still reconstructs completions from the dispatch store.

### Webhooks (optional)
- Treat as an **outbox**: durable row/queue keyed by eventId; retry with backoff; mark delivered only on 2xx.
- Failure to POST must not drop the event from `events.ndjson`.
- Overnight: undelivered outbox entries remain until success or manual ack.

### What is explicitly insufficient alone
- SSE without a cursored log
- In-memory-only queues
- "Fire webhook and forget" without outbox + log
- Relying on Grok being online at close time

## Open questions for Paul

- Port **4301** vs reuse dashboard host with a `/api/dispatch/*` namespace?
- Should Grok wake prefer **file watch** (simple routines) or **webhook into Grok Bot** (needs a receiver)?
