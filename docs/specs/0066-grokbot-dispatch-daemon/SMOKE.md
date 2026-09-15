# 0066 smoke — overnight catch-up

Date: 2026-09-15 (America/Chicago)

## What we proved
1. Daemon binds `127.0.0.1:4301`; `GET /health` works without token.
2. `POST /events/append` writes to `%LOCALAPPDATA%\checkyourvibe\events.ndjson` with fsync.
3. After killing the daemon process, the smoke event `smoke-overnight-20260915182245` was still on disk.
4. After restart, `GET /events?after=0` returned that event (cursor catch-up).

## Commands
```
node packages/daemon/dist/cli.js start --port 4301 --project <repo>
# token: %LOCALAPPDATA%\checkyourvibe\daemon.token
```

Not published. Local branch `spike/0066-dispatch-daemon` only — do not push without Paul asking.