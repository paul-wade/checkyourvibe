# 0051 orchestration plan — preflight findings

Written by the orchestrating session before dispatching any task. Two
decisions block execution. Everything else is settled below.

## Blocking finding: the diff drawer has no content to diff

Requirement 2.3 says the diff is "rendered from the before/after filesystem
snapshots the executor already captures". Requirement 2.5 says it uses "the
same snippet data the executor already records".

Neither exists.

- `packages/core/src/executor/snapshot.ts:28-29` defines
  `Snapshot = ReadonlyMap<string, string>` and the comment says "A
  repo-relative path mapped to a **digest** of what was found there."
- `digest()` at `snapshot.ts:56` returns `` `${kind}:${sha256hex}` ``.
- `outcome.ts:103-118` compares two snapshots by digest equality. It can
  tell you *which* paths differ. It cannot tell you *what* differs.
- Grepping `snippet` across the executor and dispatch layers returns
  nothing. There is no recorded content anywhere.

So from existing data the drawer CAN show: the three-way scope split
(in-scope changed, out-of-scope written, declared-but-unchanged), the
outcome classification, and the gate results. It CANNOT show added and
removed lines, and therefore Requirement 3 (line comments) has nothing to
anchor a comment to.

T51004's fallback clause, "if snapshots are unavailable, show the outcome
and gates with a note", would be the permanent state rather than an edge
case. An implementer handed T51004 as written will either report blocked or
quietly ship the fallback and call it done.

### Decision 1 — where diff content comes from

- **A. difit for content, native for classification.** The drawer renders
  the three-way scope split natively and hands line-level content to difit,
  which already exists and is already run. Matches what the user described:
  "a difit drawer on the bottom". No new storage, Requirement 6.2 holds.
  Requirement 3 moves to difit's own comment surface or defers.
- **B. Read content from git.** Real content, no new storage, but a
  dispatch's changes must map to commit boundaries, and they may be
  uncommitted, amended, or interleaved with later work. Needs a spike
  before it can be planned.
- **C. Store content in the snapshot.** Gives every requirement as written,
  but adds a persistence layer that Requirement 6.2 forbids, and needs a
  size cap and a binary policy. Amends spec 0011.

Recommendation: A. It is the only option consistent with both the existing
data and the user's stated intent, and it keeps 0051 read-only.

## Blocking finding: uncommitted work in the files the tasks touch

`packages/core/src/dashboard/view-model.ts`, `shell.ts` and `home-model.ts`
carry uncommitted changes, and `styles.ts` is untracked. T51002 modifies
view-model.ts; T51005 and T51008 modify shell.ts. Review packages are built
from commit ranges, so an implementer's diff would be indistinguishable
from the pre-existing work in the same files.

### Decision 2 — the 0047 collision, which resolves this too

Spec 0047 (Stitch Dashboard Workbench) and spec 0051 both replace the
dashboard, differently. 0047 is a desktop workbench plus a mobile triage
deck built from the Stitch templates. 0051 is a kanban board plus a drawer.
The uncommitted work in the tree is 0047's, and it is already pushed to
`dashboard/stitch-workbench` for the Devin handoff, which has not started.

Either 0051 supersedes 0047, in which case that branch should be abandoned
and its work either folded in or reverted, or 0047 proceeds on Devin's
branch and 0051 waits. They cannot both land.

## Settled: T51001 duplicates work that already exists

`packages/core/src/dashboard/styles.ts` is untracked, 268 lines, and already
defines 59 CSS custom properties: the dark surfaces, violet primary, green
secondary and amber tertiary that Requirement 5.1 asks for. T51001 should
adopt and extend that file, not create `board.css` from scratch.

## Settled: the task graph is strictly sequential

File overlap, so no two tasks can run in parallel:

| Tasks | Shared file |
|---|---|
| T51001, T51006 | board-layout.ts |
| T51003, T51007 | board-render.ts |
| T51004, T51005 | diff-drawer.ts |
| T51006, T51007 | board-client.ts |
| T51005, T51008 | shell.ts |
| T51003, T51008 | render.ts |

T51003 modifies `render.ts` and T51008 removes the old render path. T51003
should not touch render.ts at all; route replacement belongs only to T51008.

## Execution order once unblocked

1. T51002 board data model, with the test. Independent of the drawer
   decision. Safe to start the moment the tree is clean.
2. T51001 design tokens and layout, adopting styles.ts.
3. T51003 board renderer, without touching render.ts.
4. T51006 drawer open/close and card selection.
5. T51007 needs-you cards and acknowledge.
6. T51008 route replacement and CLI wiring.
7. T51004 and T51005 last, shaped by Decision 1.

Every task: one implementer, one task review, fix rounds capped at five,
then one whole-branch review. Same discipline as spec 0050.
