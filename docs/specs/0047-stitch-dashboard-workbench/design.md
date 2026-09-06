# 0047 — Stitch Dashboard Workbench: Design

**Status:** active  
**Created:** 2026-09-05  

## Architectural Decisions

### 1. Zero-Hydration Server-Rendered CSS Grid & Flexbox

The new workbench uses CSS Grid for desktop screens ($\ge 1024\text{px}$) and a stacked Flexbox card column for mobile viewports ($< 1024\text{px}$). 

Rather than adopting a client-side JS framework (React/Svelte) or build step, templates are constructed using Node.js TypeScript string templates in `@checkyourvibe/core`. Styles are bundled into clean inline CSS modules derived from `.cyv-review/designs/stitch-17590787663427686906/desktop-workbench.html`.

### 2. View Model Extension

The existing home view model (`home-model.ts`, `view-model.ts`) is extended to supply:
- `lanes`: Active dispatches, capacity status (`FREE`, `RUNNING`, `COOLING_DOWN`), billing tier, and discovered `$PATH` binaries.
- `waves`: Active wave task items (`cyv plan` waves), status badges, and blocked dependency chains.
- `triage`: `Needs You` items requiring human approval or prompt editing.
- `history`: Recent execution records with duration and pass/fail/out-of-scope status badges.
- `diff`: Staged/unstaged diff stats and inline code previews.

### 3. Inline SVG Assets & Dark Mode Theme

System icons (such as `checkyourvibe-icon.svg`) and status indicators are embedded directly as inline SVG markup. The dark theme colors align with the Stitch palette (`#0d0e12` background, `#171821` panel surfaces, `#a78bfa` accent purple, `#22c55e` success green, `#ef4444` error red).

## Decisions Deliberately Not Taken

- **No Single Page Application (SPA) client framework:** We avoid adding Vite, React, or Tailwind build chains to `@checkyourvibe/core`. The core engine stays lightweight with zero runtime dependencies beyond Node.js.
- **No external icon font requests:** No Google Fonts or FontAwesome web fonts are fetched over the network; all fonts and SVGs are self-contained.
- **No complex node-graph canvas for local CLI:** The "Topology Map" widget from the Stitch mockup is omitted in favor of a clean, high-density Agent Lanes list.
