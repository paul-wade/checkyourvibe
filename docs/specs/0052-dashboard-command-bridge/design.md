# 0052 — Dashboard-to-Orchestrator Command Bridge: Design

**Status:** active
**Created:** 2026-09-06

## Architectural Decisions

### 1. File-based command queue, not a socket

The command queue is a JSON file on disk (`.cyv-review/commands.json`), polled
by both sides. The dashboard polls for status changes; the orchestrator polls
for pending commands.

**Why not a websocket:** A websocket requires a persistent connection from
both sides, which means the orchestrator session must stay attached and the
dashboard server must manage connection lifecycle. That is spec 0053's
territory (persistent orchestrator). This spec works with the existing poll
architecture, which is simpler and does not require a running process on
either side beyond what already runs.

**Why not an HTTP endpoint the orchestrator calls:** The orchestrator is an
agent session that runs `cyv` commands. It does not maintain an HTTP client.
It reads files. A file-based queue is the natural interface for a process
that communicates through the filesystem, which is exactly how the comment
store already works.

### 2. `cyv commands` as the orchestrator-side reader

A new CLI command, `cyv commands`, mirrors `cyv comments`. Where `cyv
comments` bridges review notes, `cyv commands` bridges operational commands.

`cyv commands --watch` is the long-running poll loop the orchestrator keeps
alive. It reads pending commands, executes them by calling the same logic
`cyv dispatch` and `cyv acknowledge` use, and marks them done or failed.

**Why not fold this into `cyv comments --watch`:** Comments and commands are
different channels with different semantics. Comments are review feedback
that the agent reads and responds to. Commands are operational instructions
that `cyv` itself executes. Mixing them would conflate "the agent should see
this" with "the harness should do this."

### 3. Batch review as the primary interaction

The `send-review` command is the key addition. Today, comments are delivered
one at a time via the watch/hook, which means the agent sees each comment as
a separate interruption. The user wants to finish a full review pass and then
send all comments at once.

`send-review` gathers every open comment for a dispatch, formats them as a
single batch message, and delivers that batch through the existing hook
contract. The agent receives one message containing all feedback, produces
one revision, and the cycle continues.

**Why not deliver comments as they are posted:** Because the user is still
reviewing. Sending the first comment before the user has finished reading the
diff means the agent starts working on incomplete feedback. The batch is the
unit of review.

### 4. Command store schema

```ts
interface CommandStore {
  version: 1;
  nextId: number;
  commands: Command[];
}

interface Command {
  id: number;
  kind: 'dispatch' | 'retry' | 'acknowledge' | 'comment' | 'send-review';
  target: string;        // task id or dispatch id
  status: 'pending' | 'done' | 'failed';
  createdAt: number;     // epoch ms
  resolvedAt?: number;   // epoch ms, when done or failed
  // Kind-specific payload
  laneId?: string;       // dispatch, retry
  file?: string;         // comment
  anchor?: string;       // comment
  body?: string;         // comment
  // Resolution
  dispatchId?: string;   // dispatch, retry — the new dispatch created
  outcome?: string;      // acknowledge — the outcome that was acknowledged
  reason?: string;       // failed — why
}
```

The store is additive: commands are appended, never removed. Status is
updated in place. This matches the comment store's pattern and avoids
concurrent-write issues.

### 5. Dashboard endpoints

The dashboard's HTTP server (`shell.ts`) gains five new POST endpoints that
write to the command store, and one GET endpoint that returns the current
command store for polling.

These are thin wrappers: parse the request body, call `addCommand`, return
the command id. No business logic in the endpoint — the orchestrator's `cyv
commands --watch` does the work.

### 6. File scope

New files:
- `packages/core/src/dashboard/commands.ts` — the command store (read, write,
  update status), mirroring `comments.ts`
- `packages/core/src/cli/commands.ts` — the `cyv commands` CLI command,
  mirroring `cyv comments`

Modified files:
- `packages/core/src/dashboard/shell.ts` — new POST/GET endpoints
- `packages/core/src/dashboard/board-client.ts` — command posting and status
  polling (from spec 0051)
- `packages/core/src/dashboard/board-render.ts` — pending-command indicators
  on cards (from spec 0051)
- `packages/core/src/cli/index.ts` — register the new `commands` command

## Decisions Deliberately Not Taken

- **No websocket.** File-based polling. Spec 0053 may add a persistent
  connection; this spec does not require one.

- **No new persistence.** The command store is a JSON file, same as the
  comment store. No database, no message queue, no external service.

- **No command cancellation.** A pending command that the user wants to
  cancel would need a `cancel` kind or a status transition. Not in scope:
  the orchestrator acts on commands quickly, and a dispatch that has already
  started cannot be safely stopped mid-run.

- **No command history UI.** The store is append-only, but the dashboard does
  not need to show past commands. The board shows current state; the dispatch
  log is the historical record.

- **No multi-repo command routing.** Commands target one repository. The
  dashboard already serves one repo at a time. Multi-repo is a future concern.
