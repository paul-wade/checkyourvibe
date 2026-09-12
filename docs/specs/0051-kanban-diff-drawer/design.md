# 0051 — Kanban Board & Diff Drawer: Design

**Status:** active
**Created:** 2026-09-06

## Architectural Decisions

### 1. Server-rendered HTML with progressive enhancement

The board is server-rendered HTML (as the current dashboard is), with vanilla
JavaScript for interactivity: drawer open/close, card selection, comment
posting via fetch, and comment status toggling. No React, no Vite, no build
step for the frontend.

**Why not a client-side app:** The current dashboard is server-rendered and
works. Introducing a client-side framework means a build pipeline, a second
server, and a new set of dependencies — all for a board that reads from files
on disk and posts comments to an endpoint. The Stitch designs show what the
UI should look like; they do not require a framework to render. The design
tokens (colors, fonts, spacing) become CSS custom properties, and the layout
is Tailwind-utility-equivalent CSS written by hand.

**Why not keep difit as a separate page:** difit runs on port 4381 and renders
a generic git diff. The drawer needs a *targeted* diff — grouped by declared
scope, not a flat `git diff` — and it needs inline comments wired to the
existing comment store. Embedding difit in an iframe would give neither.

### 2. Diff data comes from the executor's snapshots, not from git

The executor already snapshots the working tree before and after a dispatch
(spec 0011 Requirement 2.6) and stores the digests. The drawer reads the
before/after content for each changed path and renders a line-by-line diff
itself. This means:

- The diff is what the executor observed, not what `git diff` shows now (the
  working tree may have moved on since the dispatch finished).
- Out-of-scope writes are already classified by `outcome.ts` and do not need
  re-derivation.
- Declared-but-unchanged files are the set difference between the declared
  `files=` list and the changed-paths list, which the dashboard can compute
  from the dispatch record.

If the snapshots are not available (a dispatch record from before this spec,
or a task that has not been dispatched yet), the drawer shows the dispatch's
outcome and gate results without a diff, with a note explaining why.

### 3. Card state maps to dispatch outcome

| Column | Card state |
|---|---|
| Backlog | Open task in `tasks.md` with no dispatch record |
| In Motion | Dispatch record with no outcome yet (running) |
| Needs Review | Dispatch record whose outcome `needsHumanAttention`, or with open user comments |
| Done | Dispatch record with outcome `succeeded` and no open comments |

A task that failed (`gates-failed`, `failed`) goes to Needs Review, not Done,
because it needs a human decision: retry, revise, or abandon.

### 4. Comment posting via existing endpoint

The dashboard already serves comment-related routes. The drawer posts a
comment by calling the same endpoint `cyv comments --record` uses internally,
writing to the same `.cyv-review/comments.json` store. No new API surface.

The drawer reads comments by loading the store on page render and polling for
new ones via a lightweight fetch on an interval (the same pattern as the
current needs-you refresh).

### 5. Design tokens as CSS custom properties

A single `board.css` file defines the design system as CSS custom properties,
extracted from the Stitch project's `designMd`:

```css
:root {
  --surface: #121316;
  --surface-container: #1f1f23;
  --primary: #cabeff;
  --secondary: #4edea3;
  --tertiary: #ffb95f;
  --error: #ffb4ab;
  --font-headline: 'Geist', sans-serif;
  --font-body: 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  /* ... */
}
```

All board components use these tokens. No inline color values elsewhere.

### 6. File scope of the replacement

The current dashboard rendering lives in:
- `packages/core/src/dashboard/render.ts` — the page generators
- `packages/core/src/dashboard/home.ts` — the home page assembly
- `packages/core/src/dashboard/home-model.ts` — the data model
- `packages/core/src/dashboard/view-model.ts` — the view model
- `packages/core/src/dashboard/shell.ts` — the HTTP server
- `packages/core/src/dashboard/pages.ts` — page routing
- `packages/core/src/dashboard/lanes.ts` — lane status rendering
- `packages/core/src/dashboard/motion.ts` — dispatch motion rendering
- `packages/core/src/dashboard/executor-view.ts` — executor detail view
- `packages/core/src/dashboard/review/*.ts` — review components (difit, comments, needs-you, specs, documents)
- `packages/core/src/cli/dashboard.ts` — the CLI command

The new board replaces `render.ts`, `home.ts`, `pages.ts`, `lanes.ts`,
`motion.ts`, and `executor-view.ts`. It keeps `shell.ts` (the HTTP server),
`home-model.ts` and `view-model.ts` (the data model, extended), and the
review components (comments, needs-you) which are reused.

## Decisions Deliberately Not Taken

- **No client-side framework.** Vanilla JS with fetch. If the board grows
  complex enough to justify React, that is a future spec's decision, not this
  one's.

- **No websocket live updates.** The board polls on an interval, as the
  current dashboard does. Live push is spec 0052's territory (the command
  bridge needs a persistent connection, and the board can ride on that once
  it exists).

- **No new persistence.** The board reads existing files and posts to
  existing endpoints. Spec 0052 adds command writing; spec 0053 adds
  persistence across sessions.

- **No mobile app.** The board is responsive HTML that works on a phone
  browser. A native mobile app is not in scope.

- **No removal of difit.** difit stays as a CLI tool for terminal-based diff
  review. The drawer is the web surface; difit is the terminal surface. Both
  read from the same data.
