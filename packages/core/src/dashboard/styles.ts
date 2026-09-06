/**
 * @file packages/core/src/dashboard/styles.ts
 * Self-contained CSS stylesheet for the checkyourvibe Stitch Workbench dashboard.
 */

export function dashboardCss(): string {
  return `
/* Reset & Dark Theme CSS Variables */
:root {
  --cyv-bg: #0d0e11;
  --cyv-surface: #121316;
  --cyv-surface-low: #1b1b1f;
  --cyv-surface-container: #1f1f23;
  --cyv-surface-high: #292a2d;
  --cyv-surface-highest: #343538;
  --cyv-on-surface: #e3e2e6;
  --cyv-on-surface-variant: #c9c4d8;
  --cyv-outline: #938ea1;
  --cyv-primary: #cabeff;
  --cyv-primary-container: #947dff;
  --cyv-on-primary: #1c0062;
  --cyv-secondary: #4edea3;
  --cyv-secondary-bg: rgba(78, 222, 163, 0.15);
  --cyv-tertiary: #ffb95f;
  --cyv-tertiary-bg: rgba(255, 185, 95, 0.15);
  --cyv-error: #ffb4ab;
  --cyv-error-bg: rgba(239, 68, 68, 0.15);
  --cyv-font-mono: 'JetBrains Mono', Consolas, Monaco, monospace;
  --cyv-font-sans: 'Inter', system-ui, -apple-system, sans-serif;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--cyv-bg);
  color: var(--cyv-on-surface);
  font-family: var(--cyv-font-sans);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
}

a {
  color: var(--cyv-primary);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}

/* Header Navbar */
.cyv-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background-color: rgba(18, 19, 22, 0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--cyv-surface-highest);
  padding: 0.75rem 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.cyv-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--cyv-font-mono);
  font-weight: 600;
  font-size: 15px;
}

.cyv-brand-logo {
  height: 24px;
  width: auto;
}

.cyv-nav-tabs {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cyv-tab {
  padding: 0.35rem 0.75rem;
  border-radius: 4px;
  font-size: 13px;
  color: var(--cyv-on-surface-variant);
  transition: all 0.15s ease;
}

.cyv-tab:hover, .cyv-tab.active {
  background-color: var(--cyv-surface-highest);
  color: var(--cyv-on-surface);
}

/* Status Banner */
.cyv-banner {
  background-color: var(--cyv-bg);
  border-bottom: 1px solid var(--cyv-surface-high);
  padding: 0.75rem 1.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.cyv-banner-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  font-family: var(--cyv-font-mono);
  font-size: 12px;
  font-weight: 700;
  background-color: var(--cyv-tertiary-bg);
  color: var(--cyv-tertiary);
}

.cyv-kpi-cluster {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--cyv-font-mono);
  font-size: 12px;
}

.cyv-kpi-pill {
  background-color: var(--cyv-surface-container);
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

/* Layout Grid: Desktop Workbench (>= 1024px) vs Mobile Deck (< 1024px) */
.cyv-container {
  padding: 1.25rem 1.5rem;
  width: 100%;
}

.cyv-workbench-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.25rem;
}

@media (min-width: 1024px) {
  .cyv-workbench-grid {
    grid-template-columns: 280px 1fr 340px;
  }
}

/* Panel Cards */
.cyv-card {
  background-color: var(--cyv-surface-low);
  border: 1px solid var(--cyv-surface-high);
  border-radius: 6px;
  padding: 1rem;
  display: flex;
  flex-col;
  gap: 0.75rem;
}

.cyv-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cyv-on-surface);
}

/* Status Badges */
.cyv-badge {
  display: inline-block;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  font-family: var(--cyv-font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.cyv-badge-free {
  background-color: var(--cyv-secondary-bg);
  color: var(--cyv-secondary);
}

.cyv-badge-running {
  background-color: var(--cyv-tertiary-bg);
  color: var(--cyv-tertiary);
}

.cyv-badge-failed {
  background-color: var(--cyv-error-bg);
  color: var(--cyv-error);
}

.cyv-badge-passed {
  background-color: var(--cyv-secondary-bg);
  color: var(--cyv-secondary);
}

/* Buttons */
.cyv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.4rem 0.8rem;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.cyv-btn-primary {
  background-color: var(--cyv-primary);
  color: var(--cyv-on-primary);
}
.cyv-btn-primary:hover {
  background-color: var(--cyv-primary-container);
}

.cyv-btn-secondary {
  background-color: var(--cyv-surface-container);
  color: var(--cyv-on-surface);
}
.cyv-btn-secondary:hover {
  background-color: var(--cyv-surface-highest);
}

/* Code & Diff Snippets */
pre, code {
  font-family: var(--cyv-font-mono);
}

.cyv-code-block {
  background-color: var(--cyv-bg);
  border: 1px solid var(--cyv-surface-highest);
  border-radius: 4px;
  padding: 0.75rem;
  font-size: 12px;
  overflow-x: auto;
}

.cyv-diff-add {
  color: var(--cyv-secondary);
}
.cyv-diff-remove {
  color: var(--cyv-error);
}
`;
}
