# 0057 — One writer per working tree

**Status:** active
**Created:** 2026-09-06

## Problem

Two dispatches sharing a working tree corrupt each other's observation, and so
does a human editing a file while one runs. Both were observed on 2026-09-06
(see `docs/specs/0051-kanban-diff-drawer/findings-concurrent-dispatch.md`).

Spec 0051 Requirement 5.2 already makes card-to-session assignment a mutual
exclusion, and the state store built for it has claim operations that fail
rather than overwrite. That is the interim answer. It does not solve the human
case, because a developer cannot be asked not to touch their own repository
for the twenty minutes a dispatch takes.

## Requirement

1. The orchestrator SHALL refuse to open a dispatch against a working tree
   that already has one open, naming the holder. This is enforced by the
   server, not requested of the agent.
2. A dispatch MAY be given its own git worktree, so concurrency is safe and
   whole-repository observation stays honest.
3. Where a worktree per dispatch is used, its setup cost SHALL be measured
   before it becomes the default. On a pnpm monorepo an install and a build
   per worktree is not obviously affordable, and a shared store with hardlinks
   may or may not bring it down to something acceptable.
4. The orchestrator SHALL NOT offer parallelism it cannot make safe. Until
   isolation exists, dispatches against one tree are serialized.

## Non-goals

- Narrowing `--observe` to the declared paths. That hides the thing the check
  exists to find, as the CLI's own help text warns.
