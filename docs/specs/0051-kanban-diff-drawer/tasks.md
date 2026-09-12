# 0051 — Kanban Board & Diff Drawer: Tasks

**Status:** active
**Created:** 2026-09-06

## T51001 — Design system stylesheet and board layout

Create `packages/core/src/dashboard/board.css` with the design tokens from the
Stitch project as CSS custom properties (surface colors, primary/secondary/
tertiary, error, fonts, spacing, radii). Create the board layout HTML
structure: a lane status strip, four columns (Backlog, In Motion, Needs
Review, Done), and a hidden bottom drawer. The layout is responsive: single
column on mobile, four columns on desktop.

_Exec: lane=devin-cli, gates=build,typecheck, files=`packages/core/src/dashboard/board.css`, `packages/core/src/dashboard/board-layout.ts`

## T51002 — Board data model and column mapping

Extend `packages/core/src/dashboard/view-model.ts` with a `BoardModel` that
maps dispatch records and open tasks to columns. A card is one of:
- Backlog: open task from `tasks.md` with no dispatch record
- In Motion: dispatch record with no outcome
- Needs Review: dispatch record whose outcome `needsHumanAttention`, or with
  open user comments
- Done: dispatch record with outcome `succeeded` and no open comments

Read from the dispatch log (`store.ts`), the comment store (`comments.ts`),
lane declarations, and spec task files. Do not modify the data sources; this
is a read-only projection.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/view-model.ts`, `packages/core/src/dashboard/board-model.ts`, `packages/core/test/dashboard/board-model.test.ts`

## T51003 — Board page renderer

Replace the current `render.ts` page generators with a `board-render.ts` that
renders the kanban board HTML using the `BoardModel`. Each card shows: task id,
one-line description, lane, outcome kind, timestamp, and an open-comment badge.
The lane status strip shows each lane's id, billing kind, and current state
(active, cooldown, idle). The drawer is rendered hidden, populated on card
selection via fetch.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/board-render.ts`, `packages/core/src/dashboard/render.ts`

## T51004 — Diff drawer content and targeted diff

Create `packages/core/src/dashboard/diff-drawer.ts` that, given a dispatch id,
reads the before/after snapshots from the executor store and renders a
line-by-line diff grouped into three sections: in-scope changes, out-of-scope
writes, and declared-but-unchanged files. Each file shows added/removed lines
with line numbers. If snapshots are unavailable, show the outcome and gates
with a note. The drawer also shows the dispatch's outcome classification and
gate results.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/diff-drawer.ts`, `packages/core/test/dashboard/diff-drawer.test.ts`

## T51005 — Inline comments in the diff drawer

Wire the diff drawer to the existing comment store. Each diff line that has a
comment shows it inline with author, timestamp, and an "addressed" toggle.
The user can add a comment on a line via a form that posts to the dashboard's
comment endpoint (the same one `cyv comments --record` uses). Comments by
`AGENT_AUTHOR` are visually distinguished. Marking a comment addressed calls
the existing `setCommentStatus`.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/diff-drawer.ts`, `packages/core/src/dashboard/shell.ts`

## T51006 — Drawer open/close interaction and card selection

Add the client-side JavaScript for: clicking a card opens the bottom drawer
and fetches the diff content for that dispatch; selecting a different card
replaces the drawer content; a close button hides the drawer. The drawer
slides up from the bottom covering ~60% of the viewport. On mobile, the
drawer covers the full screen.

_Exec: lane=devin-cli, gates=build,typecheck, files=`packages/core/src/dashboard/board-client.ts`, `packages/core/src/dashboard/board-layout.ts`

## T51007 — Needs-you cards and acknowledge action

Render needs-you items as cards in the Needs Review column with the outcome
kind as a label. Open user comments appear as a badge counting open notes on
the relevant card. Add an "Acknowledge" button on each needs-you card that
calls the existing acknowledge logic and refreshes the board.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/board-render.ts`, `packages/core/src/dashboard/board-client.ts`

## T51008 — Route replacement and dashboard CLI wiring

Replace the current dashboard routes (`/`, `/lanes`, `/dispatches`,
`/needs-you`, `/specs`) with the new board. The board is the single page; the
old page generators are removed. Update `cyv dashboard` to serve the board.
Update `shell.ts` to serve the board HTML, the diff drawer fetch endpoint,
and the comment post endpoint. Remove dead code from the old render path.

_Exec: lane=devin-cli, gates=build,typecheck,test, files=`packages/core/src/dashboard/shell.ts`, `packages/core/src/dashboard/pages.ts`, `packages/core/src/cli/dashboard.ts`, `packages/core/src/dashboard/render.ts`
