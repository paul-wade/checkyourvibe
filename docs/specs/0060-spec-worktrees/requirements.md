# 0060 — A worktree per spec, and the orchestrator owns the merge

**Status:** active
**Created:** 2026-09-07
**Implements:** 0057 Requirement 2
**Answers:** 0059 Requirement 4.3 (the subagent and foreign-CLI hole)

## Why this is the answer to three separate problems

Three findings, recorded over two days, have the same fix.

1. **Concurrent dispatches falsely accuse each other.** Two dispatches sharing
   a tree each snapshot the other's writes and attribute them to themselves.
   Any writer contaminates the window, including a human editing their own
   repository and including the orchestrator itself
   (`docs/specs/0051-kanban-diff-drawer/findings-concurrent-dispatch.md`).
2. **Foreign CLIs cannot be gated at all.** Devin, Antigravity, Codex and
   Gemini run with no Claude hooks. `SubagentStop` fires after the fact and
   cannot block. There is no in-process answer, and pretending otherwise
   overstates what the harness does.
3. **A repository-wide gate cannot be used under concurrency**, so gates get
   narrowed and lose their value.

Isolation answers all three. If a dispatch's work does not exist in the main
tree until the orchestrator accepts it, then it does not matter that the agent
cannot be blocked from stopping: **its stop does not put anything anywhere.**
The gate moves from inside a process cyv does not own to the boundary cyv does
own.

## Requirement 1 — A worktree per spec

1.1. Work SHALL run in a git worktree, not the main checkout.

1.2. The worktree granularity is the **spec**, not the dispatch. A spec's tasks
share files and context, and the setup cost is per worktree, so amortising it
across a spec's tasks is what makes this affordable. Requirement 4 governs
concurrency within one spec.

1.3. A worktree SHALL be named for its spec, so a person looking at a directory
listing knows what is in it: the spec's directory name, for example
`0051-kanban-diff-drawer`.

1.4. Worktrees SHALL live outside the main repository, under a configurable
root that defaults to a sibling directory. They SHALL NOT live inside the
repository even ignored: an ignored path inside the tree is invisible to the
snapshot and to `cyv check`, which is how work escapes observation entirely.

## Requirement 2 — The orchestrator merges, never the agent

2.1. A dispatch SHALL NOT write to the main tree. Its result reaches the main
tree only by a merge cyv performs.

2.2. cyv SHALL merge only when all of these hold, and SHALL name which one
failed otherwise:
  - `cyv check` is clean on the worktree's changes
  - every changed path is inside the dispatch's declared ownership
  - the dispatch's gates passed in the worktree

2.3. A refused merge SHALL leave the worktree intact so the work can be
inspected, retried or salvaged. Nothing is discarded on refusal.

2.4. This is the enforcement point for an executor that has no hooks. The
record SHALL distinguish `enforcement: edit-time` from
`enforcement: merge-time`, because two dispatches that read the same in the
record but were enforced differently is the same false-trust problem the
concurrency finding describes.

## Requirement 3 — Setup cost is measured before it is assumed

3.1. A worktree needs its dependencies and its build before gates can run. On
this monorepo that is not obviously affordable, and the cost SHALL be measured
and recorded before worktrees become the default.

3.2. Cheaper strategies SHALL be evaluated against that measurement: a shared
package store with hardlinks, copying `node_modules`, a warm template worktree
reused across specs, or skipping the build when a spec's gates do not need one.

3.3. If the measured cost is unaffordable, the fallback is 0057 Requirement 1 —
one dispatch per tree, enforced — and this spec SHALL say so rather than
shipping something too slow to use.

## Requirement 4 — One writer per worktree still holds

4.1. Two dispatches against one spec's worktree collide exactly as two
dispatches against the main tree do. The claim mechanism in
`packages/core/src/dashboard/state-store.ts` already fails rather than
overwrites; the worktree is the resource claimed.

4.2. A worktree whose dispatch died SHALL be reclaimable, the same way a dead
dispatch record is now (`cyv dispatch --abandon`). A dead holder must never
hold a resource forever; that defect cost hours on 2026-09-06.

## Requirement 5 — Lifecycle is explicit and observable

5.1. Create, prepare, dispatch, verify, merge, remove. Each transition SHALL be
recorded.

5.2. The dashboard SHALL show each worktree: its spec, its branch, whether a
dispatch holds it, whether its work is merged, refused or pending.

5.3. Removing a worktree with unmerged work SHALL require the work to be
abandoned explicitly. Silently deleting an agent's output is the worst failure
this feature can have.

## Non-goals

- Isolating the developer's own editing. This is about dispatched work.
- Replacing the snapshot. Inside a worktree the before-and-after comparison is
  still how effect is judged; isolation makes that comparison honest rather
  than replacing it.

## Measured, 2026-09-07

Requirement 3 is settled. On this monorepo, from the main checkout:

| Step | Time |
|---|---|
| `git worktree add` | 1s |
| `pnpm install` | 1s |
| `pnpm build` | 3s |
| **Total, to a tree that runs cyv and passes tests** | **5s** |

92 MB on disk. `cyv` runs inside it and 286 executor tests pass there.

The install is one second because pnpm hardlinks from a content-addressed
store the worktree shares, so the cost the concurrency finding worried about
does not exist here. Five seconds against a dispatch that runs for fifteen
minutes is not a tradeoff.

The fallback in Requirement 3.3 is therefore not needed, and none of the
cheaper strategies in 3.2 need evaluating. This measurement is repository- and
package-manager-specific: a repo whose install is slow should re-measure rather
than inherit this number.
