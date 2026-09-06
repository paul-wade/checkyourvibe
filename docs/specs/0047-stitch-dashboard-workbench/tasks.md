# 0047 — Stitch Dashboard Workbench: Tasks

**Status:** done  
**Spec:** 0047-stitch-dashboard-workbench  

## Tasks

- [x] **T47001 — Workbench CSS Stylesheet Module**
  Create `packages/core/src/dashboard/styles.ts` containing the full dark-theme Stitch workbench CSS grid, responsive breakpoint queries ($\ge 1024\text{px}$ workbench, $< 1024\text{px}$ mobile deck), status badge colors, and panel card styles derived from `.cyv-review/designs/stitch-17590787663427686906/desktop-workbench.html`.
  _Exec: lane=antigravity-cli model=mechanical-transformation gates=run:pnpm build,run:pnpm test files=packages/core/src/dashboard/styles.ts

- [x] **T47002 — View Model Extensions for Stitch Workbench**
  Extend `HomeViewModel` and related types in `packages/core/src/dashboard/view-model.ts` and `home-model.ts` to include wave task items, blocked dependency chains, discovered path binaries, execution log statuses, and diff metrics required by the Stitch workbench.
  _Exec: lane=antigravity-cli model=judgment-required gates=run:pnpm build,run:pnpm test files=packages/core/src/dashboard/view-model.ts packages/core/src/dashboard/home-model.ts

- [x] **T47003 — Lanes & Motion Region UI Components**
  Refactor `packages/core/src/dashboard/lanes.ts` and `motion.ts` to render the Stitch UI components for agent capacity lanes, discovered path binaries, `cyv plan` execution waves, and blocked task dependency chains. Depends on T47001 and T47002.
  _Exec: lane=antigravity-cli model=mechanical-transformation gates=run:pnpm build,run:pnpm test files=packages/core/src/dashboard/lanes.ts packages/core/src/dashboard/motion.ts

- [x] **T47004 — Workbench Home Page Layout & Shell Assembly**
  Update `packages/core/src/dashboard/home.ts` and `shell.ts` to assemble the 3-column desktop workbench grid and responsive mobile triage deck using `styles.ts`, linking top bar navigation, diff/history panels, and `Needs You` triage cards. Depends on T47001, T47002, T47003.
  _Exec: lane=antigravity-cli model=judgment-required gates=run:pnpm build,run:pnpm test files=packages/core/src/dashboard/home.ts packages/core/src/dashboard/shell.ts
