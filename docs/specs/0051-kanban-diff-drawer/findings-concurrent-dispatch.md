# Finding: concurrent dispatches falsely accuse each other

Found 2026-09-06 while dispatching the first two 0051 tasks in parallel to
two lanes, devin-cli and antigravity-cli, against one working tree.

## What happened

The devin dispatch (`t51002`, board model) closed with outcome
**out-of-scope-write**, naming `packages/core/src/dashboard/state-store.ts`.
It did not write that file. The antigravity dispatch (`t51-store`) did, and
was still running at the time. The file's contents match the store brief
exactly: session entries, card assignments, edit locks, quota entries, claim
success and failure types. None of that appears in the board-model brief.

## Cause

`--observe` defaults to the whole repository. That default is correct and
deliberate: `cyv dispatch --help` says it "is what makes a write outside the
declared ownership visible; narrowing it hides any write outside what is
named." But the observation is a before-and-after snapshot of the tree, so
any write by a concurrently running dispatch falls inside the observing
dispatch's window and is attributed to it.

So the two guarantees are in tension. Whole-repo observation is what makes
out-of-scope writes detectable, and it is also what makes concurrent
dispatches accuse each other.

## Why it matters more than a false positive

`out-of-scope-write` is one of the outcome kinds that exists specifically to
catch an agent doing something it did not declare. A false one is worse than
a missed finding, because the whole value of the classification is that a
human can trust it without checking. One false accusation and the reader
starts checking every one.

## Options

1. **One dispatch per working tree, enforced.** This is already Requirement
   5.2 of spec 0051: card-to-session assignment as mutual exclusion, with the
   server refusing to spawn against a tree that already has a dispatch open.
   The collision above is the requirement's own justification, discovered by
   violating it.
2. **A worktree per dispatch.** Real isolation, so concurrency is safe and
   whole-repo observation stays honest. Costs an install and a build per
   worktree, which on this monorepo is not cheap.
3. **Narrow `--observe`.** Rejected: the help text is right that this hides
   the thing the check exists to find.

Recommendation: option 1 now, option 2 later if per-project concurrency
turns out to matter. Until either lands, dispatches against one tree must be
serialized, and the orchestrator must not offer parallelism it cannot make
safe.

## Second, smaller finding

A repository-wide gate cannot be used by a dispatch that runs concurrently
with another. `run:pnpm typecheck` failed in the devin dispatch on an error
from the half-written `state-store.ts` it did not own. Gates should be scoped
to the dispatch's declared paths, or the dispatch must be the only one
running.

## Addendum: it is not agent-versus-agent, it is any writer

The store dispatch closed with the same outcome, symmetrically, naming
`board-model.ts`, its test, and `findings-concurrent-dispatch.md` — this
file, which the orchestrator wrote and committed itself while the dispatch
was open. So the observation window attributes every change in the tree to
the dispatch, whatever the source: another agent, the orchestrator, or a
developer editing a file in their editor.

That changes the recommendation. Option 1, one dispatch per working tree,
does not fix this, because you cannot ask a developer not to touch their own
repository for twenty minutes while a dispatch runs. Only isolation does.

Revised recommendation: **a worktree per dispatch** (option 2) is the real
answer, with one dispatch per tree (option 1) as the interim rule. The cost
is an install and a build per worktree, which this monorepo makes expensive,
so it is worth measuring whether a shared store and hardlinks bring that down
to something acceptable.

Both dispatches produced good work despite the false verdicts: typecheck
clean, 38 tests passing across the two new files. The classification was the
only thing wrong, which is precisely why it matters.
