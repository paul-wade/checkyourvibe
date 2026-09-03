# 0042 — Design

## Decision 1 — Deliver through the hook, not through a prompt

The orchestrator brief (0041) will tell the agent to read notes. That is worth
writing and it is not enough: the same project already proved to itself that an
instruction in prose does not hold under load. The analyzer's findings do not
depend on the agent remembering to run `cyv check`; a hook runs it. Notes take
the same route.

For Claude Code that is two hooks in `~/.claude/settings.json`, both already
managed by the adapter's `json-merge` write with its ownership marker:
`PostToolUse` (already installed for findings) gains a second command, and
`Stop` is added. The `Stop` hook is the one that matters: it fires when the
agent believes it is finished, which is exactly the moment an unread note
should stop it. Other adapters install whatever their contract offers; an
adapter with no equivalent to `Stop` gets the `PostToolUse` form only, and
`doctor` says so.

**Not taken: the dashboard pushing into the session.** There is no channel. The
orchestrator is the caller (0011 R6.3), and the hook runs inside it.

## Decision 2 — The cursor is the only evidence of "read"

R3 shows the owner whether a note was read. The cursor file records the last
id the agent's `cyv comments` returned; that is what "read" means here, and the
page says "unread by the agent" rather than "the agent has not seen this",
because the second claims more than the file knows. A note the hook delivered
is read; what the agent did with it is a different question the exchange
answers when the agent records a turn.

## Decision 3 — Printing at dispatch close does not advance the cursor

`cyv dispatch` prints unread notes as it closes (R2). It does not mark them
read, because the process printing them is about to exit and the orchestrator
may or may not be reading its output. The hook, which runs inside the session
that will act, is the writer of record. Showing a note twice costs a few lines;
losing one cost an hour.

## Decision 4 — The cursor moves out of the repository

The old watcher kept its cursor in the tool's own checkout. It is the agent's
memory, not the project's data, and one agent watches many projects, so it
lives in the home directory keyed by project root (already done in `cyv
comments`). The hook and `--watch` share it.
