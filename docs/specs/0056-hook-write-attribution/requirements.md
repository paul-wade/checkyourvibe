# 0056 — Attribute a write to the agent that made it

**Status:** active (probe answered 2026-09-06, see probe-result.md)
**Created:** 2026-09-06
**Blocked on:** whether hooks fire in non-interactive print mode (unverified;
probe fixture at `C:/Users/paulw/AppData/Local/Temp/hookprobe`)

## Problem

A dispatch is judged by comparing two snapshots of the working tree. That can
establish *that* a path changed. It can never establish *who* changed it,
because a filesystem does not record an author.

Observed 2026-09-06 (`docs/specs/0051-kanban-diff-drawer/findings-concurrent-dispatch.md`):
two dispatches run in parallel against one tree each closed as
`out-of-scope-write`, naming files the other had written, and one of them also
named a file the orchestrator itself committed mid-dispatch. Every verdict was
false. Both agents had done clean work.

`out-of-scope-write` exists to catch an agent doing something it never
declared. Its entire value is that a human can trust it without checking the
diff. One false accusation and the reader starts checking all of them.

## Requirement

1. A write SHALL be attributed to the agent that made it, using the
   post-tool-use hook, which fires inside that agent's own harness and carries
   the path it touched.
2. The hook SHALL report to the orchestrator rather than to the agent's own
   transcript, so the record is produced by the runtime and not self-reported.
3. The ownership judgement SHALL prefer attributed writes when available, and
   SHALL fall back to snapshot diffing when the hook stream is absent or
   incomplete, saying which it used.
4. A write the orchestrator or a human made SHALL NOT be attributed to any
   dispatch.
5. The hook configuration SHALL NOT be writable by the agent it constrains.
   Editing the enforcement config is itself one of the escapes this project
   exists to detect, so it is passed at spawn from outside the working tree
   where the CLI permits, and treated as a violation when modified during a
   turn where it does not.

## Non-goals

- Replacing snapshots. Snapshots stay as the fallback and as the source of the
  scope classification.
