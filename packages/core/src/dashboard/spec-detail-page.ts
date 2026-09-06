/**
 * The /spec detail page: one spec, three tabs, each file rendered as markdown.
 *
 * The page is read-only. Tabs are plain links that set `?tab=`, so the page
 * works with no script. A missing file is reported as missing, naming the path.
 * The freshness line tells the truth: this page is rendered on request and
 * does not stream or poll.
 */
import { esc } from './render.js';
import { topNavHtml } from './nav.js';
import { dashboardCss } from './styles.js';
import { renderSpecMarkdown } from './spec-page.js';
import { specDisplayName } from './review/specs.js';

export type SpecTab = 'requirements' | 'design' | 'tasks';

interface TabDef {
  id: SpecTab;
  label: string;
}

const TABS: readonly TabDef[] = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'design', label: 'Design' },
  { id: 'tasks', label: 'Tasks' },
];

export interface SpecDetailPageInput {
  /** The project root, carried as `?p=` on every link. */
  project: string;
  projectName: string;
  /** The spec id from `?spec=`, already validated by the caller. */
  specId: string;
  /** The selected tab from `?tab=`. */
  tab: SpecTab;
  /** File contents when present; a missing tab is absent. */
  files?: Readonly<Partial<Record<SpecTab, string>>>;
  /** When set, the page shows an error instead of tab content. */
  error?: string;
}

/** Recognise the three tab values; anything else falls back to Requirements. */
export function toSpecTab(value: string | null | undefined): SpecTab {
  if (value === 'design' || value === 'tasks') return value;
  return 'requirements';
}

/** A spec id must be a single directory name, not a path. */
export function isValidSpecId(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false;
  if (value.includes('\0')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return !value.split(/[\\/]/).includes('..');
}

function specFilePath(specId: string, tab: SpecTab): string {
  return `docs/specs/${specId}/${tab}.md`;
}

function tabHref(project: string, specId: string, tab: SpecTab): string {
  const params = new URLSearchParams({ p: project, spec: specId, tab });
  return `/spec?${params.toString()}`;
}

function specDetailCss(): string {
  return `
.sp-body { background: var(--cyv-surface); color: var(--cyv-on-surface); }
.sp-main { max-width: 52rem; margin: 0 auto; padding: 0 var(--cyv-gutter-mobile) var(--cyv-space-xxl); }
.sp-head { display: flex; align-items: baseline; gap: var(--cyv-space-sm); flex-wrap: wrap; margin: var(--cyv-space-md) 0; }
.sp-head h1 { font-size: 1.1rem; font-weight: 600; margin: 0; }
.sp-id { font-family: var(--cyv-font-mono); font-size: 0.8rem; color: var(--cyv-on-surface-variant); }
.sp-tabs { display: flex; gap: var(--cyv-space-xs); border-bottom: 1px solid var(--cyv-surface-highest); margin: var(--cyv-space-md) 0; }
.sp-tab { display: inline-flex; align-items: center; padding: var(--cyv-space-sm) var(--cyv-space-md); font-size: 0.85rem; color: var(--cyv-on-surface-variant); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.sp-tab:hover, .sp-tab.active { color: var(--cyv-on-surface); border-bottom-color: var(--cyv-primary); }
.sp-content { line-height: 1.55; }
.sp-content h1, .sp-content h2, .sp-content h3, .sp-content h4 { margin: var(--cyv-space-md) 0 var(--cyv-space-sm); }
.sp-content p { margin: var(--cyv-space-sm) 0; }
.sp-content ul, .sp-content ol { padding-left: 1.4rem; margin: var(--cyv-space-sm) 0; }
.sp-content li { margin: 2px 0; }
.sp-content pre { background: var(--cyv-surface-container); padding: var(--cyv-space-sm); border-radius: var(--cyv-radius); overflow-x: auto; font-size: 0.9rem; }
.sp-content code { font-family: var(--cyv-font-mono); font-size: 0.9em; }
.sp-missing { color: var(--cyv-on-surface-variant); padding: var(--cyv-space-md) 0; }
.sp-missing code { font-family: var(--cyv-font-mono); color: var(--cyv-tertiary); }
.sp-error { color: var(--cyv-error); padding: var(--cyv-space-md) 0; }
.sp-freshness { margin-top: var(--cyv-space-lg); font-size: 0.78rem; color: var(--cyv-on-surface-variant); font-family: var(--cyv-font-mono); }
`;
}

function tabsHtml(project: string, specId: string, current: SpecTab): string {
  const links = TABS.map((tab) => {
    const active = tab.id === current ? ' active' : '';
    return `<a class="sp-tab${active}" href="${esc(tabHref(project, specId, tab.id))}">${esc(tab.label)}</a>`;
  }).join('');
  return `<nav class="sp-tabs" aria-label="spec tabs">${links}</nav>`;
}

function contentHtml(input: SpecDetailPageInput): string {
  if (input.error !== undefined && input.error !== '') {
    return `<p class="sp-error">${esc(input.error)}</p>`;
  }
  const content = input.files?.[input.tab];
  if (content === undefined) {
    const path = specFilePath(input.specId, input.tab);
    const tab = TABS.find((t) => t.id === input.tab);
    return `<p class="sp-missing">This spec has no ${esc(tab?.label ?? input.tab)} file. The path would be <code>${esc(path)}</code>.</p>`;
  }
  return `<div class="sp-content">${renderSpecMarkdown(content)}</div>`;
}

export function renderSpecDetailPage(input: SpecDetailPageInput): string {
  const title = input.error !== undefined
    ? esc(input.projectName)
    : `${esc(input.projectName)} · ${esc(specDisplayName(input.specId))}`;
  const topNav = topNavHtml(input.projectName, input.project, '/specs');
  const tabs = input.error !== undefined ? '' : tabsHtml(input.project, input.specId, input.tab);
  const heading = input.error !== undefined
    ? `<h1>Spec</h1>`
    : `<h1>${esc(specDisplayName(input.specId))}</h1><span class="sp-id">${esc(input.specId)}</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${dashboardCss()}${specDetailCss()}</style>
</head>
<body class="sp-body" data-project="${esc(input.project)}">
${topNav}
<main class="sp-main">
  <header class="sp-head">
    ${heading}
  </header>
  ${tabs}
  ${contentHtml(input)}
  <p class="sp-freshness">rendered on request — not updated automatically</p>
</main>
</body>
</html>`;
}
