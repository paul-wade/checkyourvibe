/**
 * The board page: a three-column kanban with a docked diff drawer (spec 0051 R2).
 *
 * Columns are left-to-right: To Do, In Progress, Done. The lane status is a
 * compact strip above the board, not a column, and items needing a person live
 * behind the bell. On narrow viewports the columns collapse to stacked sections
 * and the drawer becomes a full-screen sheet; To Do starts expanded because it
 * is the most actionable surface.
 *
 * Styling reuses the design tokens in `styles.ts`: `boardCss` is appended to
 * the same `<style>` element as `dashboardCss`, and every colour stays a
 * `var(--cyv-*)` custom property, so the tokens remain the single source
 * (Requirement 7.2). No literal colour appears in `boardCss`.
 */
import { basename } from 'node:path';
import { esc } from './render.js';
import { NAV_PAGES } from './nav.js';
import type { GateHealth } from './gate-health.js';
import type { BoardTodo } from './board-model.js';
import { relativeTime } from './home.js';
import { dashboardCss } from './styles.js';
import { laneBillingLabel, acceptsDispatch, type LaneDeclaration } from '../executor/lane.js';
import { normalizeOwnedPath, pathIsWithin } from '../executor/ownership.js';
import type { DispatchOutcomeKind, GateResult } from '../executor/outcome.js';
import { knownAgentIds } from '../executor/invocation.js';
import type { BoardCard, BoardLaneAlert, BoardModel, BoardNote, BoardStatus } from './board-model.js';
import type { ExchangeEntry } from './view-model.js';
import type { CommentDraft } from './review/comments.js';
import type { SessionView } from './session-manager.js';

/**
 * What the note exchange panel shows (spec 0051 Requirements 2.4, 5.2): the
 * recorded conversation — owner notes and the agent's turns — plus the batch
 * of drafts not yet sent. `model.notes` only carries open owner notes, so the
 * route passes the store's view itself; the model field is the fallback for a
 * caller that has no store.
 */
export interface BoardExchange {
  /** Every recorded note and turn, newest first. */
  entries: readonly ExchangeEntry[];
  /** How many recorded entries `entries` does not show. */
  omitted: number;
  /** Composed but unsent notes, in any order; the panel sorts them. */
  drafts: readonly CommentDraft[];
}

export interface BoardRenderInput {
  /** The projected board, from `buildBoardModel`. */
  model: BoardModel;
  /** Lane declarations, for the compact lane status strip and dispatch form. */
  lanes: readonly LaneDeclaration[];
  /**
   * Epoch milliseconds the page is rendered at; card timestamps are shown
   * relative to it. Defaults to the moment of the call.
   */
  now?: number;
  layout?: unknown;
  /** The repository root this board serves, passed to the client for same-origin requests. */
  projectRoot?: string;
  /** The conversation and unsent batch; absent falls back to `model.notes`. */
  exchange?: BoardExchange;
  /** Live session state, reconciled immediately before rendering. */
  sessions?: SessionView[];
  /** Whether the gate has been judging the edits it saw; see `gate-health.ts`. */
  gate?: GateHealth;
}

interface ScopeSplit {
  inScope: string[];
  outOfScope: string[];
  declaredUnchanged: string[];
}

/**
 * The badge on a finished dispatch says what the outcome means, not the kind's
 * name: `out-of-scope-write` is the record's vocabulary, and a reader deciding
 * what to do needs the sentence version. The kind itself stays on the element
 * as `data-outcome` so it remains referenceable without leading the card.
 */
function outcomeClass(kind: DispatchOutcomeKind): { color: string; label: string } {
  switch (kind) {
    case 'succeeded':
      return { color: 'secondary', label: 'succeeded' };
    case 'produced-nothing':
      return { color: 'tertiary', label: 'reported done, changed nothing' };
    case 'changed-files-unexpectedly':
      return { color: 'error', label: 'changed files it said it would not' };
    case 'out-of-scope-write':
      return { color: 'error', label: 'wrote files it did not declare' };
    case 'gates-failed':
      return { color: 'error', label: 'failed a required check' };
    case 'rate-limited':
      return { color: 'tertiary', label: 'stopped by a rate limit' };
    case 'did-not-complete':
      return { color: 'tertiary', label: 'ended without finishing' };
    case 'failed':
      return { color: 'error', label: 'reported failure' };
  }
}

function needsHumanAttention(kind: DispatchOutcomeKind): boolean {
  switch (kind) {
    case 'produced-nothing':
    case 'out-of-scope-write':
    case 'changed-files-unexpectedly':
    case 'did-not-complete':
    case 'failed':
    case 'gates-failed':
    case 'rate-limited':
      return true;
    default:
      return false;
  }
}

function scopeSplit(card: BoardCard): ScopeSplit {
  const changed = card.changedPaths ?? [];
  const out = new Set(card.outOfScopePaths ?? []);
  const inScope = changed.filter((path) => !out.has(path)).sort();
  const outOfScope = [...out].sort();

  const declared = [...new Set((card.ownedPaths ?? []).map(normalizeOwnedPath))]
    .filter((declared) => !changed.some((changedPath) => pathIsWithin(changedPath, declared)))
    .map((declared) => (declared === '' ? '.' : declared))
    .sort();

  return { inScope, outOfScope, declaredUnchanged: declared };
}

function cardId(card: BoardCard): string {
  return card.taskId ?? card.dispatchId;
}

function iconSvg(name: string): string {
  switch (name) {
    case 'logo':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5 5-5.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    case 'account_tree':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M3 15h6v-2H3v2zm0-8v2h6V7H3zm6 12v-2H9v2H3v-2h2v-2H3v-2h6v2H7v2h10v-2h-2v-2h6v2h-2v2h2v2h-6v-2h2v-2H9v2h2v2H9zm8-14h-2v2h2V5zm-2 4h-2v2h2V9zm-2 4h-2v2h2v-2zm-2-4H9v2h2V9zm0 4H9v2h2v-2z" fill="currentColor"/></svg>';
    case 'terminal':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M4 17h12v2H4v-2zm-2-9l3.5 3.5L2 15h2l3.5-3.5L4 8V8zM20 7h-8v2h8V7zm0 4h-8v2h8v-2z" fill="currentColor"/></svg>';
    case 'gavel':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M2 17l2 2 3.5-3.5-2-2L2 17zm7-9l-2 2 8.5 8.5 2-2L9 8zm-3 3l2 2L7 14l-2-2 1-1zm14-7l-4 4-2-2 4-4 2 2z" fill="currentColor"/></svg>';
    case 'forum':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M4 4h16v12H7l-5 4V4h2zm14 10V6H6v8h12z" fill="currentColor"/></svg>';
    case 'lock':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M18 10V7a4 4 0 0 0-8 0v3H7v10h10V10h-1zm-3 0h-4V7a2 2 0 0 1 4 0v3z" fill="currentColor"/></svg>';
    case 'play_arrow':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    case 'check':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>';
    case 'done_all':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L22.24 4.24 11.66 14.83 7.5 10.67 6.09 12.09l5.57 5.57L22.24 5.59zM2 12l4.59 4.59L8.17 15l-3.5-3.5L2 12z" fill="currentColor"/></svg>';
    case 'tune':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M3 17h6v-2H3v2zm-2-8v2h6V9H1zm18 8h-2v2h-2v2h6v-2h-2v-2zm-2-8V5h-2V3h6v2h-2v2h-2zM9 3H7v2H5v2h6V5H9V3zm-2 8h2v2H7v-2zm10 2v-2h2v2h-2z" fill="currentColor"/></svg>';
    case 'send':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2 .01 7z" fill="currentColor"/></svg>';
    case 'arrow_forward':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" fill="currentColor"/></svg>';
    case 'pause_circle':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" fill="currentColor"/></svg>';
    case 'bolt':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M11 21h-1l1-7H6.5c-.57 0-.66-.36-.38-.78l6.29-9.57c.23-.35.53-.35.76 0L19.64 13c.28.42.19.78-.38.78H14l1 7h-1l-1-7h-2l1 7z" fill="currentColor"/></svg>';
    case 'sync':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm-6.7 7.2L3.84 9.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8z" fill="currentColor"/></svg>';
    case 'play_circle':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 14.5v-9l6 4.5-6 4.5z" fill="currentColor"/></svg>';
    case 'source_environment':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="currentColor"/></svg>';
    case 'fork_right':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 2a3 3 0 0 1 3 3 3 3 0 0 1-2 2.83V11h2c1.1 0 2 .9 2 2v4.17a3 3 0 1 1-2 0V13h-2v4.17a3 3 0 1 1-2 0V13H9v4.17a3 3 0 1 1-2 0V13c0-1.1.9-2 2-2h2V7.83A3 3 0 0 1 9 5a3 3 0 0 1 3-3z" fill="currentColor"/></svg>';
    case 'unfold_more':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 5.83 15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z" fill="currentColor"/></svg>';
    case 'warning':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2V9h2v5z" fill="currentColor"/></svg>';
    case 'error':
      return '<svg viewBox="0 0 24 24" aria-hidden="true" class="board-icon"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/></svg>';
    default:
      return '';
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * What to call this dispatch in the corner of its card.
 *
 * It used to read `w44-attempt-1` whatever had happened, and the owner's
 * verdict was that the field was not helpful. The attempt number only carries
 * information when there has been more than one attempt: on a first attempt it
 * is four characters saying nothing. A task id, when the declaration names
 * one, is what a reader actually recognises, so it wins.
 */
function cardRefHtml(card: BoardCard): string {
  if (card.taskId !== undefined && card.taskId !== card.dispatchId) {
    return `<span class="board-card-ref font-mono-sm text-outline flex-shrink-0" title="${esc(
      card.dispatchId,
    )}">${esc(card.taskId)}</span>`;
  }
  const retried = /^(.*)-attempt-(\d+)$/.exec(card.dispatchId);
  const attempt = retried === null ? '' : (retried[2] ?? '');
  const label =
    retried === null || attempt === '1' ? (retried?.[1] ?? card.dispatchId) : `${retried[1] ?? ''} · attempt ${attempt}`;
  return `<span class="board-card-ref font-mono-sm text-outline flex-shrink-0" title="${esc(
    card.dispatchId,
  )}">${esc(label)}</span>`;
}

/**
 * A brief's first line is a markdown heading, and its hash is syntax rather
 * than content. On a card it is noise in the first column of the title.
 */
function cardTitle(card: BoardCard): string {
  return card.description.replace(/^#{1,6}\s+/, '');
}

function ownedPathsHtml(paths: readonly string[] | undefined): string {
  if (paths === undefined || paths.length === 0) return '';
  const shown = paths.slice(0, 2);
  const more = paths.length > 2 ? ` +${paths.length - 2}` : '';
  return `<p class="font-mono-sm text-outline truncate mt-space-2xs">${esc(shown.join(', '))}${esc(more)}</p>`;
}

/**
 * A list longer than the recent window collapses its tail behind a count.
 * Dispatches arrive sorted newest first, so the split is positional: every
 * item within the window stays open, and a floor keeps the list from ever
 * looking empty when it is not.
 */
const CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_VISIBLE_CURRENT = 3;

function splitCurrent<T>(items: readonly T[], at: (item: T) => string | undefined, now: number): { current: T[]; older: T[] } {
  let boundary = 0;
  for (const item of items) {
    const stamp = at(item);
    const then = stamp === undefined ? Number.NaN : Date.parse(stamp);
    if (Number.isNaN(then) || now - then <= CURRENT_WINDOW_MS) {
      boundary += 1;
    } else {
      break;
    }
  }
  const shown = Math.min(items.length, Math.max(MIN_VISIBLE_CURRENT, boundary));
  return { current: items.slice(0, shown), older: items.slice(shown) };
}

function olderItemsHtml(rendered: readonly string[], noun: string): string {
  if (rendered.length === 0) return '';
  const n = rendered.length;
  return `<details class="board-older"><summary class="board-older-toggle font-mono-sm">${n} older ${noun}${n === 1 ? '' : 's'}</summary><div class="board-older-body">${rendered.join('')}</div></details>`;
}

function topBarContent(projectRoot: string, model: BoardModel): string {
  // These were `href="#"`. The workbench is the page a person spends most time
  // on, and its two other tabs went nowhere.
  const tabs = NAV_PAGES.map((page) => {
    const active = page.path === '/board';
    const href = projectRoot === '' ? page.path : `${page.path}?${new URLSearchParams({ p: projectRoot }).toString()}`;
    return `<a class="board-nav-item${active ? ' active' : ''}" href="${esc(href)}"${
      active ? ' aria-current="page"' : ''
    }>${esc(page.label)}</a>`;
  }).join('\n    ');

  const projectOptions = model.projects.map((p) => 
    `<option value="${esc(p)}"${p === model.projectFilter ? ' selected' : ''}>${esc(p)}</option>`
  ).join('');
  const projectSelect = model.projects.length === 0 ? '' : `
    <select class="board-project-filter font-mono-sm" aria-label="Filter by project">
      <option value="">All projects</option>
      ${projectOptions}
    </select>
  `;

  return `<div class="board-brand">
    ${iconSvg('logo')}
    <span class="font-headline-sm text-on-surface tracking-tight">checkyourvibe</span>
  </div>
  <nav class="board-nav" aria-label="Section">
    ${tabs}
  </nav>
  <div class="board-topbar-right">
    ${projectSelect}
    <button class="cyv-btn cyv-btn-secondary board-bell" type="button" data-action="alerts" aria-pressed="false" aria-label="Things needing a person">
      ${iconSvg('gavel')}<span class="board-bell-count" id="board-bell-count">${model.needsYou.length}</span>
    </button>
    <button class="cyv-btn cyv-btn-secondary board-explorer-toggle" type="button" data-action="explorer" aria-pressed="false" title="Open the file tree on the right">Solution Explorer</button>
    <button class="cyv-btn cyv-btn-primary board-dispatch-btn" type="button" data-action="dispatch" title="Send a brief to a lane">
      <span class="font-label-md">Dispatch a wave</span>
    </button>
  </div>`;
}

function topBarHtml(projectRoot: string, model: BoardModel): string {
  return `<header class="board-topbar" id="board-topbar">${topBarContent(projectRoot, model)}</header>`;
}

/**
 * The connection indicator. What the server renders is deliberately pessimistic
 * — a page that never runs its script must not claim to be live. The client
 * rewrites both halves from the real EventSource state: `data-epoch` seeds the
 * "how old is this data" line so the age is honest even before the first event
 * arrives.
 */
function liveBadgeHtml(now: number): string {
  return `<span class="board-live-badge font-mono-sm text-on-surface-variant" id="board-live-badge" role="status" data-live="connecting">
      <span class="board-dot board-live-dot bg-outline"></span>
      <span class="board-live-label">not connected yet</span>
      <span class="board-live-age" data-epoch="${now}">showing the page as it loaded</span>
    </span>`;
}

/**
 * What the board is entitled to say about the orchestrator.
 *
 * It used to say "Orchestrator running", in green, whenever the stall detector
 * was quiet — including when no session existed at all. The claim behind it was
 * a self-report a session writes about itself, and one from 2026-09-01 was
 * still being rendered as a current state six days later.
 *
 * Hooks are run by the runtime and cannot be forgotten, so a session observed
 * through them is a measurement. Anything weaker says so.
 */
/** Whether the gate judged a write recently enough to call the session busy. */
function editingNow(gate: GateHealth | undefined, now: number): boolean {
  const at = gate?.lastWriteAt;
  if (at === undefined) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now - ms <= EDITING_WINDOW_MS;
}

/** How recently a write must have been judged for the session to count as working. */
const EDITING_WINDOW_MS = 10 * 60 * 1000;

function orchestratorBadgeHtml(
  status: BoardStatus,
  sessions: readonly SessionView[],
  now: number,
  gate?: GateHealth,
): string {
  const measured = sessions.filter((session) => session.alive && session.statusSource === 'hook');

  if (status.stalled) {
    // Three different situations, and only two of them are a problem. A
    // session that is editing the repository directly is working, not
    // stalled — its writes reach the gate, which timestamps every one.
    if (measured.length > 0 && editingNow(gate, now)) {
      return `<span class="board-ok-badge font-mono-sm text-mono-sm"><span class="board-dot bg-secondary"></span><span>a session is editing directly — nothing dispatched for ${esc(status.stalledFor ?? '')}</span></span>`;
    }
    const who = measured.length > 0 ? 'A SESSION IS LIVE BUT NOT DISPATCHING' : 'NO SESSION IS LIVE';
    return `<span class="board-stall-badge font-mono-sm text-mono-sm">${iconSvg('pause_circle')}<span>ORCHESTRATOR STALLED (${esc(status.stalledFor ?? '')}) — ${who}</span></span>`;
  }
  const newest = measured
    // When a hook last fired, not when the session started. The badge read
    // "a hook fired 13m ago" while one had fired a minute earlier, because it
    // was reporting the start time under the wrong words.
    .map((session) => Date.parse(session.lastEventAt ?? session.startedAt))
    .filter((parsed) => Number.isFinite(parsed))
    .sort((a, b) => b - a)
    .at(0);

  if (measured.length > 0) {
    const since =
      newest === undefined ? '' : ` — a hook fired ${esc(formatDuration(now - newest))} ago`;
    return `<span class="board-ok-badge font-mono-sm text-mono-sm"><span class="board-dot bg-secondary"></span><span>Orchestrator live${since}</span></span>`;
  }

  if (status.running > 0) {
    return `<span class="board-ok-badge font-mono-sm text-mono-sm"><span class="board-dot bg-tertiary"></span><span>${status.running} dispatch${status.running === 1 ? '' : 'es'} open, no session seen</span></span>`;
  }

  return `<span class="board-ok-badge font-mono-sm text-mono-sm"><span class="board-dot bg-outline"></span><span>No live session — nothing has fired a hook</span></span>`;
}

/**
 * Said out loud when the gate allowed an edit it could not judge. The gate
 * fails open by design and writes the reason down; a board that shows what is
 * live has to show that enforcement has stopped enforcing.
 */
function gateBadgeHtml(gate: GateHealth | undefined): string {
  if (gate === undefined || gate.unjudged === 0) return '';
  const n = gate.unjudged;
  return `<span class="board-stall-badge font-mono-sm text-mono-sm" data-gate="unjudged" title="${esc(gate.latestReason ?? '')}">${iconSvg('pause_circle')}<span>GATE COULD NOT CHECK ${n} EDIT${n === 1 ? '' : 'S'}</span></span>`;
}

function statusBarContent(
  status: BoardStatus | undefined,
  sessions: readonly SessionView[],
  now: number,
  gate?: GateHealth,
): string {
  const badge = liveBadgeHtml(now);
  if (status === undefined) {
    return `<div class="board-status-bar-left">${badge}<p class="font-mono-sm text-on-surface-variant">No status available.</p></div>`;
  }
  const stallBadge = orchestratorBadgeHtml(status, sessions, now, gate) + gateBadgeHtml(gate);
  return `<div class="board-status-bar-left">
    ${badge}
    ${stallBadge}
    <p class="font-mono-sm text-on-surface-variant truncate">
      <span class="text-secondary font-medium">${status.idle} of ${status.totalLanes} lane${
        status.totalLanes === 1 ? '' : 's'
      } free</span>, <span class="text-outline">${status.running} running</span>.
    </p>
  </div>`;
}

/**
 * Dispatches actually occupying this lane's capacity.
 *
 * In Progress holds two kinds of card: one still executing, and one that has
 * closed and is waiting for a person. Only the first holds a slot. Counting
 * both showed "3 of 1 running" beside a top bar that said "0 running" — two
 * contradictory numbers on one screen, and one of them impossible.
 */
function laneRunning(model: BoardModel, laneId: string): number {
  return model.inMotion.filter((card) => card.laneId === laneId && card.outcome === undefined).length;
}

/** Cards on this lane that have finished and are waiting to be reviewed. */
function laneAwaitingReview(model: BoardModel, laneId: string): number {
  return model.inMotion.filter((card) => card.laneId === laneId && card.outcome !== undefined).length;
}

function laneAlertFor(model: BoardModel, laneId: string): BoardLaneAlert | undefined {
  for (const item of model.needsYou) {
    if (item.kind === 'lane' && item.laneId === laneId) return item;
  }
  return undefined;
}

function laneModelName(lane: LaneDeclaration): string {
  const offering = lane.models[0];
  if (offering === undefined) return 'no model declared';
  return offering.ordering[0] ?? 'no model declared';
}

function laneCardHtml(lane: LaneDeclaration, model: BoardModel, now: number): string {
  const running = laneRunning(model, lane.id);
  const cap = lane.concurrencyCap;
  const alert = laneAlertFor(model, lane.id);
  const dispatchable = acceptsDispatch(lane);
  const modelName = laneModelName(lane);

  let badgeText = 'FREE';
  let badgeColor = 'bg-secondary-soft text-secondary';
  let dotColor = 'bg-secondary';
  const waiting = laneAwaitingReview(model, lane.id);
  const waitingNote = waiting === 0 ? '' : ` · ${waiting} waiting for review`;
  let stateLine = `${running} of ${cap} running${waitingNote}`;

  if (alert !== undefined) {
    badgeText = 'EXHAUSTED';
    badgeColor = 'bg-error-soft text-error';
    dotColor = 'bg-error';
    stateLine = 'out of quota';
  } else if (!dispatchable) {
    badgeText = 'RESERVED';
    badgeColor = 'bg-surface-container-highest text-on-surface-variant';
    dotColor = 'bg-outline';
  } else if (running >= cap) {
    badgeText = 'CAPPED';
    badgeColor = 'bg-tertiary-soft text-tertiary';
    dotColor = 'bg-tertiary';
  } else if (running > 0) {
    badgeText = 'RUNNING';
    badgeColor = 'bg-secondary-soft text-secondary';
    dotColor = 'bg-secondary';
  }

  const reset =
    alert === undefined || alert.resetAt === undefined
      ? ''
      : `<span class="font-mono-sm text-on-surface-variant">resets <time datetime="${esc(alert.resetAt)}">${esc(relativeTime(alert.resetAt, now))}</time></span>`;

  return `<div class="board-lane-card" data-lane="${esc(lane.id)}">
  <div class="board-lane-head">
    <div class="board-lane-idline min-w-0">
      <span class="board-dot ${dotColor}"></span>
      <span class="font-mono-md text-on-surface font-semibold truncate">${esc(lane.id)}</span>
    </div>
    <span class="board-lane-badge ${badgeColor} font-mono-sm text-mono-sm uppercase font-semibold">${esc(badgeText)}</span>
  </div>
  <div class="board-lane-meta">
    <span class="font-mono-sm text-outline">${esc(stateLine)}</span>
    <span class="font-mono-sm text-on-surface-variant">${esc(laneBillingLabel(lane.billing))}</span>
  </div>
  <div class="board-lane-foot">
    <span class="font-mono-sm text-outline truncate">${esc(modelName)}</span>
  </div>
  ${reset}
</div>`;
}

function lanesPanelContent(
  model: BoardModel,
  lanes: readonly LaneDeclaration[],
  now: number,
): string {
  const laneCards = lanes.map((lane) => laneCardHtml(lane, model, now)).join('');
  return lanes.length === 0
    ? '<p class="board-empty">No lane is declared. Add <code>executor.lanes</code> to the project configuration.</p>'
    : laneCards;
}

function laneStatusStripContent(
  model: BoardModel,
  lanes: readonly LaneDeclaration[],
  now: number,
): string {
  return `<div class="board-section-head">
    ${iconSvg('account_tree')}
    <h3 class="font-label-md text-on-surface uppercase tracking-wider">Lane Status</h3>
    <span class="font-mono-sm text-outline">${lanes.length} configured</span>
  </div>
  <div class="board-lane-list">${lanesPanelContent(model, lanes, now)}</div>`;
}

function sessionStatusColor(session: SessionView): string {
  if (session.alive) return 'secondary';
  if (session.state === 'stopped') return 'error';
  return 'tertiary';
}

function sessionStartFormHtml(): string {
  const options = knownAgentIds()
    .map((id) => `<option value="${esc(id)}">${esc(id)}</option>`)
    .join('');
  return `<form class="board-session-start" id="board-session-form" method="post" action="/api/session/start" aria-label="Start a new session">
    <label class="font-mono-sm text-on-surface" for="board-session-agent">Agent</label>
    <select class="board-filter board-session-select" id="board-session-agent" name="agentId" required>
      <option value="" disabled selected>Choose an agent</option>
      ${options}
    </select>
    <button class="cyv-btn cyv-btn-primary board-session-start-btn" type="submit">Start Session</button>
    <p class="board-session-error font-mono-sm" id="board-session-error" role="status" aria-live="polite" hidden></p>
  </form>`;
}

function sessionsListHtml(sessions: readonly SessionView[], now: number): string {
  return sessions.length === 0
    ? '<p class="board-empty" id="board-sessions-empty">No sessions are running.</p>'
    : `<div class="board-session-list" id="board-sessions">${sessions
        .map((session) => {
          const color = sessionStatusColor(session);
          const life = session.alive ? 'live' : session.state === 'stopped' ? 'dead' : 'unknown';
          const uptime = formatDuration(session.uptimeMs);
          // A session the dashboard did not start is known only through its
          // hooks: there is no pid to show and no handle to stop it with. The
          // row says where the status came from instead of offering a button
          // that cannot do what it says.
          const observed = session.observed === true;
          const handle = observed
            ? '<span class="font-mono-sm text-outline">observed via hooks</span>'
            : `<span class="font-mono-sm text-outline">pid ${session.pid}</span>`;
          const control = observed
            ? '<span class="font-mono-sm text-outline">started elsewhere — end it where it runs</span>'
            : `<button class="cyv-btn cyv-btn-secondary board-session-stop" type="button" data-action="stop-session" data-session="${esc(session.sessionId)}">Stop</button>`;
          return `<div class="board-session-row" data-session="${esc(session.sessionId)}">
  <div class="board-session-head">
    <span class="board-dot bg-${color}"></span>
    <span class="font-mono-sm text-on-surface font-semibold">${esc(session.agentId)}</span>
    ${handle}
  </div>
  <div class="board-session-meta">
    <span class="font-mono-sm text-outline">${esc(session.state)}</span>
    <span class="font-mono-sm text-on-surface-variant">${esc(uptime)}</span>
    <span class="font-mono-sm text-${color}">${esc(life)}</span>
  </div>
  ${control}
</div>`;
        })
        .join('')}</div>`;
}

/**
 * One line. Whether anything is alive is the only thing the board needs from
 * the sessions, and a card each turned that into eight rows of the same three
 * sentences. The detail belongs where a person goes looking for it, not across
 * the width of the working surface.
 */
function sessionsSummaryHtml(sessions: readonly SessionView[], now: number): string {
  if (sessions.length === 0) {
    return '<p class="board-sessions-line font-mono-sm text-outline" id="board-sessions-panel">No session is running.</p>';
  }

  // The counts this line used to spell out — how many are live, how long the
  // oldest has run, how many are quiet — are on the fold's own summary now, so
  // saying them again here was one line of chrome for no new fact.
  //
  // A session the dashboard started is one it can stop, and that control has to
  // stay reachable. There is normally nought or one of them, so it rides on the
  // same line rather than earning a card.
  const controls = sessions
    .filter((session) => session.observed !== true && session.alive)
    .map(
      (session) =>
        `<button class="cyv-btn cyv-btn-secondary board-session-stop" type="button" data-action="stop-session" data-session="${esc(
          session.sessionId,
        )}">Stop ${esc(session.agentId)} (pid ${session.pid})</button>`,
    )
    .join('');

  return `<p class="board-sessions-line font-mono-sm text-on-surface-variant" id="board-sessions-panel">${controls}</p>`;
}

function sessionsPanelContent(sessions: readonly SessionView[], now: number): string {
  return `<div class="board-section-head">
    <h3 class="font-label-md text-on-surface uppercase tracking-wider">Sessions</h3>
    <span class="font-mono-sm text-outline">${sessions.length}</span>
  </div>
  ${sessionsListHtml(sessions, now)}
  ${sessionStartFormHtml()}`;
}

function sessionsPanelHtml(sessions: readonly SessionView[], now: number): string {
  return `${sessionsSummaryHtml(sessions, now)}${sessionStartFormHtml()}`;
}

function statusBarHtml(
  status: BoardStatus | undefined,
  model: BoardModel,
  lanes: readonly LaneDeclaration[],
  sessions: readonly SessionView[],
  now: number,
  gate?: GateHealth,
): string {
  // These numbers come from `status`, the same place the line above renders
  // them from. Computing them a second time here put two different answers to
  // "how many lanes are free" four rows apart on the same screen, because
  // `effectiveStatus` returns the model's own status untouched when it has one.
  const total = status === undefined ? lanes.length : status.totalLanes;
  const free = status === undefined ? lanes.filter((lane) => laneRunning(model, lane.id) < lane.concurrencyCap).length : status.idle;
  const live = sessions.filter((session) => session.alive).length;
  // The status line above already says how many lanes are free and how many
  // sessions are live. Three lane cards, a sessions line and an agent picker
  // repeated it down a further two hundred pixels, and the board — the thing
  // the page is for — started below the fold. They fold away instead.
  const summary = `${total} lane${total === 1 ? '' : 's'}, ${free} free · ${live} live session${
    live === 1 ? '' : 's'
  }`;
  return `<section class="board-status" id="board-status" aria-label="Orchestrator status">
    <div class="board-status-bar">
      ${statusBarContent(status, sessions, now, gate)}
    </div>
    <details class="board-status-more" id="board-status-more">
      <summary class="board-status-summary font-mono-sm">Lanes and sessions <span class="text-outline">${esc(
        summary,
      )}</span></summary>
      <div class="board-lane-strip" id="board-lanes">
        ${laneStatusStripContent(model, lanes, now)}
      </div>
      ${sessionsPanelHtml(sessions, now)}
    </details>
  </section>`;
}

function effectiveStatus(model: BoardModel, lanes: readonly LaneDeclaration[]): BoardStatus | undefined {
  if (model.status !== undefined) return model.status;
  const idleLaneIds = lanes.filter((lane) => laneRunning(model, lane.id) < lane.concurrencyCap).map((lane) => lane.id);
  return {
    running: model.inMotion.filter(card => card.outcome === undefined).length,
    idle: idleLaneIds.length,
    idleLaneIds,
    totalLanes: lanes.length,
    needsYouCount: model.needsYou.length,
    stalled: false,
    stalledFor: '',
  };
}

/**
 * How much of a running dispatch's deadline is gone.
 *
 * Elapsed time alone says nothing: fifteen minutes into forty-five and fifteen
 * minutes into sixteen look identical and mean the opposite. A dispatch that
 * declared no deadline says so rather than implying an unbounded run is the
 * same as a generous one.
 */
function deadlineHtml(card: BoardCard, now: number): string {
  if (card.outcome !== undefined) return '';
  const deadlineMs = card.deadlineMs;
  if (deadlineMs === undefined || deadlineMs <= 0) {
    return '<span class="font-mono-sm text-outline">no deadline</span>';
  }
  const startedAt = Date.parse(card.timestamp);
  if (Number.isNaN(startedAt)) return '';
  const usedMs = Math.max(0, now - startedAt);
  const usedMinutes = Math.round(usedMs / 60_000);
  const totalMinutes = Math.round(deadlineMs / 60_000);
  const share = usedMs / deadlineMs;
  const tone = share >= 0.9 ? 'text-error' : share >= 0.7 ? 'text-tertiary' : 'text-outline';
  return `<span class="font-mono-sm ${tone}" title="of the deadline this dispatch was given">${usedMinutes} of ${totalMinutes} min</span>`;
}

function scopeSummaryHtml(card: BoardCard, now: number): string {
  const out = card.outOfScopePaths ?? [];
  const paths = card.changedPaths ?? card.ownedPaths ?? [];
  if (paths.length === 0 && out.length === 0) {
    return '<p class="font-mono-sm text-outline board-card-scope">No declared files.</p>';
  }
  const shown = paths.slice(0, 2).join(', ');
  const more = paths.length > 2 ? ` +${paths.length - 2}` : '';
  const prefix = card.changedPaths === undefined ? 'declared:' : 'changed:';
  const changedHtml = `<p class="font-mono-sm text-outline truncate board-card-scope">${esc(prefix)} <code>${esc(shown)}${esc(more)}</code></p>`;

  if (out.length === 0) {
    return changedHtml;
  }

  let noteText = '';
  if (card.writtenByOthers && card.writtenByOthers.length > 0) {
    const othersText = card.writtenByOthers.join(', ');
    noteText = ` <span class="board-scope-note font-mono-sm text-outline">(${esc(othersText)} written by another session)</span>`;
  } else if (card.sharedWindow) {
    noteText = ` <span class="board-scope-note font-mono-sm text-outline">(another session was active in this window)</span>`;
  }

  let outText = '';
  if (out.length === 1) {
    outText = `<span class="board-scope-out font-mono-sm text-error">${esc(out[0] ?? '')} out of scope</span>`;
  } else {
    outText = `<span class="board-scope-out font-mono-sm text-error">${esc(out[0] ?? '')} +${out.length - 1} out of scope</span>`;
  }

  return `<p class="font-mono-sm board-card-scope-out">${outText}${noteText}</p>${changedHtml}`;
}

function kanbanCardHtml(card: BoardCard, now: number, region: 'in-progress' | 'review' | 'done'): string {
  const isInProgress = region === 'in-progress';
  // A card that has finished and not been accepted stays here and says so. The
  // agent that produced it is still the one to talk to about it.
  const readyForReview = isInProgress && card.phase === 'ready-for-review';
  const status = isInProgress
    ? readyForReview
      ? { color: 'tertiary', label: 'ready for your review' }
      : {
          color: 'secondary',
          label: `running for ${formatDuration(now - Date.parse(card.timestamp))}`,
        }
    : outcomeClass(card.outcome ?? 'succeeded');
  const outcomeAttr = card.outcome === undefined ? '' : ` data-outcome="${esc(card.outcome)}"`;
  // Only a running dispatch can be stopped, and only a finished one can be
  // acknowledged into Done; a done card is terminal and gets no actions.
  const actions =
    readyForReview
      ? `<div class="board-kanban-actions">
    <button class="cyv-btn cyv-btn-primary board-action-ack" type="button" data-action="ack" data-item-id="${esc(card.dispatchId)}">Accept</button>
    <button class="cyv-btn cyv-btn-secondary board-action-note" type="button" data-action="note-dispatch" data-dispatch="${esc(card.dispatchId)}">Reply to the agent</button>
  </div>`
      : region === 'in-progress'
        ? `<div class="board-kanban-actions">
    <button class="cyv-btn cyv-btn-secondary board-action-stop" type="button" data-action="stop" data-dispatch="${esc(card.dispatchId)}">Stop</button>
    <button class="cyv-btn cyv-btn-secondary board-action-abandon" type="button" data-action="abandon" data-dispatch="${esc(card.dispatchId)}">Abandon</button>
  </div>`
        : '';
  const classes = ['board-card', 'board-kanban-card'];
  if (isInProgress && !readyForReview) classes.push('board-kanban-card--running');
  if (readyForReview) classes.push('board-kanban-card--review');
  const projectAttr = card.project ? ` data-project="${esc(card.project)}"` : '';
  return `<div class="${classes.join(' ')}" data-dispatch="${esc(card.dispatchId)}"${projectAttr}>
  <div class="board-kanban-main">
    <div class="board-kanban-titleline">
      <span class="font-mono-sm text-on-surface font-semibold board-kanban-title">${esc(cardTitle(card))}</span>
      ${cardRefHtml(card)}
    </div>
    <div class="board-kanban-meta">
      <span class="board-lane-tag font-mono-sm text-on-surface-variant">${esc(card.laneId)}</span>
      <span class="board-status-tag board-status-tag--plain bg-${status.color}-soft text-${status.color} font-mono-sm text-mono-sm font-semibold"${outcomeAttr}>${esc(status.label)}</span>
      <span class="font-mono-sm text-outline">${esc(relativeTime(card.timestamp, now))}</span>
      ${deadlineHtml(card, now)}
    </div>
    ${scopeSummaryHtml(card, now)}
  </div>
  ${actions}
</div>`;
}

function blockedHtml(cards: readonly BoardCard[], now: number): string {
  const rows = cards
    .map((card) => {
      return `<div class="board-blocked-row" data-dispatch="${esc(card.dispatchId)}">
  <div class="board-blocked-title min-w-0">
    ${iconSvg('lock')}
    <span class="font-mono-sm text-on-surface font-medium truncate">${esc(card.description)}</span>
    ${cardRefHtml(card)}
  </div>
  <span class="font-mono-sm text-outline flex-shrink-0">waits on ${esc(card.blockedBy ?? '')}</span>
</div>`;
    })
    .join('');
  return `<div class="board-blocked">
  <div class="board-section-head">
    <span class="font-label-xs text-on-surface uppercase tracking-wider">Blocked</span>
    <span class="font-mono-sm text-outline">${cards.length} waiting</span>
  </div>
  <div class="board-blocked-list">${rows}</div>
</div>`;
}

/**
 * One spec group card: the spec's identity at the top, then all its dispatches
 * listed inside. Each dispatch keeps its full kanban card markup — lane, phase,
 * age, deadline, scope line, and all action buttons — so nothing a person can
 * click today becomes unreachable after grouping.
 *
 * The caller is responsible for rendering `body` (e.g. with the current/older
 * split applied) so this wrapper stays free of rendering policy.
 */
function specGroupHtml(
  specId: string,
  specTitle: string,
  dispatchCount: number,
  project: string | undefined,
  body: string,
): string {
  const projectAttr = project ? ` data-project="${esc(project)}"` : '';
  const n = dispatchCount;
  return `<div class="board-card board-spec-group" data-spec="${esc(specId)}"${projectAttr}>
  <div class="board-spec-group-head">
    <div class="board-kanban-titleline">
      <span class="font-mono-sm text-on-surface font-semibold truncate">${esc(specTitle)}</span>
      <span class="board-lane-tag font-mono-sm text-on-surface-variant">${esc(specId)}</span>
    </div>
    <span class="font-mono-sm text-outline">${n} dispatch${n === 1 ? '' : 'es'}</span>
  </div>
  <div class="board-spec-group-body">
    ${body}
  </div>
</div>`;
}

/**
 * Split a flat list of cards into spec-grouped cards and loose (no-spec)
 * dispatches. Preserves the order specs and loose cards arrive in.
 */
function groupBySpec(cards: readonly BoardCard[]): {
  groups: Array<{ specId: string; specTitle: string; project: string | undefined; cards: BoardCard[] }>;
  loose: BoardCard[];
} {
  const groupMap = new Map<string, { specId: string; specTitle: string; project: string | undefined; cards: BoardCard[] }>();
  const groupOrder: string[] = [];
  const loose: BoardCard[] = [];

  for (const card of cards) {
    if (card.specId !== undefined && card.specTitle !== undefined) {
      const existing = groupMap.get(card.specId);
      if (existing !== undefined) {
        existing.cards.push(card);
      } else {
        groupMap.set(card.specId, { specId: card.specId, specTitle: card.specTitle, project: card.project, cards: [card] });
        groupOrder.push(card.specId);
      }
    } else {
      loose.push(card);
    }
  }

  const groups = groupOrder
    .map((id) => groupMap.get(id))
    .filter((g): g is { specId: string; specTitle: string; project: string | undefined; cards: BoardCard[] } => g !== undefined);
  return { groups, loose };
}

function inProgressColumnBodyHtml(model: BoardModel, now: number): string {
  const allCards = model.inMotion;
  const wave = allCards.filter((card) => card.blockedBy === undefined);
  const blocked = allCards.filter((card) => card.blockedBy !== undefined);

  if (wave.length === 0 && blocked.length === 0) {
    if (model.projectFilter) {
      return `<p class="board-quiet font-mono-sm">No dispatches match the project filter "${esc(model.projectFilter)}".</p>`;
    }
    return '<p class="board-quiet font-mono-sm">Nothing is running — a dispatch appears here from the moment it opens until it closes.</p>';
  }

  const { groups, loose } = groupBySpec(wave);

  const groupedBody = groups
    .map((g) => {
      const body = g.cards.map((card) => kanbanCardHtml(card, now, 'in-progress')).join('');
      return specGroupHtml(g.specId, g.specTitle, g.cards.length, g.project, body);
    })
    .join('');

  const looseBody = loose.map((card) => kanbanCardHtml(card, now, 'in-progress')).join('');

  const looseSection =
    loose.length === 0
      ? ''
      : groups.length === 0
        ? looseBody
        : `<div class="board-loose-section">
  <p class="board-loose-label font-mono-sm text-outline">Not scoped to a spec</p>
  ${looseBody}
</div>`;

  const blockedSection = blocked.length === 0 ? '' : blockedHtml(blocked, now);

  return `${groupedBody}${looseSection}${blockedSection}`;
}

function reviewColumnBodyHtml(model: BoardModel, now: number): string {
  const cards = model.review;
  if (cards.length === 0) {
    return '<p class="board-quiet font-mono-sm">Nothing is waiting for review. A closed dispatch whose gate results need a last look appears here.</p>';
  }
  const { current, older } = splitCurrent(cards, (card) => card.timestamp, now);
  return current.map((card) => kanbanCardHtml(card, now, 'review')).join('') + olderItemsHtml(older.map((card) => kanbanCardHtml(card, now, 'review')), 'card');
}

function doneColumnBodyHtml(model: BoardModel, now: number): string {
  const cards = model.done;
  if (cards.length === 0) {
    if (model.projectFilter) {
      return `<p class="board-quiet font-mono-sm">No done dispatches match the project filter "${esc(model.projectFilter)}".</p>`;
    }
    return '<p class="board-quiet font-mono-sm">No dispatch has finished and been acknowledged yet.</p>';
  }

  const { groups, loose } = groupBySpec(cards);

  // Within each spec group and in the loose section, apply the current/older
  // split so older dispatches collapse behind a count just as they did before.
  const groupedBody = groups
    .map((g) => {
      const { current, older } = splitCurrent(g.cards, (card) => card.timestamp, now);
      const currentHtml = current.map((card) => kanbanCardHtml(card, now, 'done')).join('');
      const olderHtml = olderItemsHtml(older.map((card) => kanbanCardHtml(card, now, 'done')), 'dispatch');
      const body = `${currentHtml}${olderHtml}`;
      return specGroupHtml(g.specId, g.specTitle, g.cards.length, g.project, body);
    })
    .join('');

  const { current: looseCurrent, older: looseOlder } = splitCurrent(loose, (card) => card.timestamp, now);
  const looseCurrentHtml = looseCurrent.map((card) => kanbanCardHtml(card, now, 'done')).join('');
  const looseOlderHtml = olderItemsHtml(looseOlder.map((card) => kanbanCardHtml(card, now, 'done')), 'dispatch');
  const looseBody = `${looseCurrentHtml}${looseOlderHtml}`;

  const looseSection =
    loose.length === 0
      ? ''
      : groups.length === 0
        ? looseBody
        : `<div class="board-loose-section">
  <p class="board-loose-label font-mono-sm text-outline">Not scoped to a spec</p>
  ${looseBody}
</div>`;

  return `${groupedBody}${looseSection}`;
}



function decisionCardHtml(item: BoardCard | BoardLaneAlert, now: number): string {
  if (item.kind === 'lane') {
    const reset =
      item.resetAt === undefined
        ? ''
        : `<span class="font-mono-sm text-on-surface-variant">resets <time datetime="${esc(item.resetAt)}">${esc(relativeTime(item.resetAt, now))}</time></span>`;
    return `<div class="board-decision-card" data-lane="${esc(item.laneId)}">
  <div class="board-decision-head">
    <span class="font-mono-md text-error font-bold">${esc(item.laneId)}</span>
    <span class="board-lane-tag font-mono-sm text-on-surface-variant">quota</span>
  </div>
  <p class="font-mono-sm text-on-surface-variant leading-relaxed">Lane ${esc(item.laneId)} is out of quota — its cards stop moving until it clears.</p>
  <div class="board-decision-actions">
    <button class="cyv-btn cyv-btn-primary" type="button" data-action="ack" data-item-id="${esc(item.laneId)}">Acknowledge</button>
    <button class="cyv-btn cyv-btn-secondary" type="button" data-action="inspect" data-lane="${esc(item.laneId)}">Inspect</button>
  </div>
  ${reset}
</div>`;
  }

  const problem = item.summary ?? item.description;
  const outcome = item.outcome;
  const outcomeStyle = outcome === undefined ? { color: 'tertiary', label: 'needs judgment' } : outcomeClass(outcome);
  const outcomeAttr = outcome === undefined ? '' : ` data-outcome="${esc(outcome)}"`;

  let primaryLabel = 'Acknowledge';
  let secondaryLabel = 'Inspect';
  if (outcome === undefined) {
    primaryLabel = 'Mark Addressed';
    secondaryLabel = 'Tell The Agent';
  } else if (outcome === 'succeeded') {
    primaryLabel = 'Acknowledge';
    secondaryLabel = 'Review';
  } else if (needsHumanAttention(outcome)) {
    primaryLabel = 'Acknowledge';
    secondaryLabel = 'Inspect';
  }
  const retryButton =
    outcome === 'gates-failed'
      ? `<button class="cyv-btn cyv-btn-secondary board-action-retry" type="button" data-action="retry" data-dispatch="${esc(item.dispatchId)}">Retry</button>`
      : '';

  return `<div class="board-decision-card board-card" data-dispatch="${esc(item.dispatchId)}">
  <div class="board-decision-head">
    <span class="font-mono-sm text-on-surface font-semibold truncate min-w-0">${esc(item.description)}</span>
    <span class="font-mono-sm text-outline flex-shrink-0">${esc(relativeTime(item.timestamp, now))}</span>
  </div>
  ${cardRefHtml(item)}
  <p class="font-mono-sm text-on-surface-variant leading-relaxed"><span class="text-tertiary font-semibold">The problem:</span> ${esc(problem)}</p>
  <div class="board-decision-actions">
    <button class="cyv-btn cyv-btn-primary" type="button" data-action="ack" data-item-id="${esc(cardId(item))}">${esc(primaryLabel)}</button>
    <button class="cyv-btn cyv-btn-secondary" type="button" data-action="inspect" data-dispatch="${esc(item.dispatchId)}">${esc(secondaryLabel)}</button>
    ${retryButton}
  </div>
  <span class="board-status-tag board-status-tag--plain bg-${outcomeStyle.color}-soft text-${outcomeStyle.color} font-mono-sm text-mono-sm font-semibold"${outcomeAttr}>${esc(outcomeStyle.label)}</span>
</div>`;
}

function decisionsPanelContent(model: BoardModel, now: number): string {
  const humanItems = model.needsYou;
  if (humanItems.length === 0) {
    return '<p class="board-empty">Nothing is waiting on you. A dispatch that failed, an unanswered note, or a lane out of quota would appear here.</p>';
  }
  const { current, older } = splitCurrent(
    humanItems,
    (item) => (item.kind === 'card' ? item.timestamp : item.resetAt),
    now,
  );
  return current.map((item) => decisionCardHtml(item, now)).join('') + olderItemsHtml(older.map((item) => decisionCardHtml(item, now)), 'item');
}

function needsYouColumnBodyHtml(model: BoardModel, now: number, exchange?: BoardExchange): string {
  return `<div class="board-panel board-decisions" id="board-decisions">
    ${decisionsPanelContent(model, now)}
  </div>
  ${exchangePanelHtml(model, exchange, now)}`;
}

function columnHtml(
  columnId: string,
  toggleId: string,
  bodyId: string,
  title: string,
  note: string,
  countText: string,
  checked: boolean,
  icon: string,
  body: string,
): string {
  const checkedAttr = checked ? ' checked' : '';
  return `<section class="board-column" data-column="${esc(columnId)}">
  <input type="checkbox" class="board-col-toggle" id="${esc(toggleId)}" aria-label="Toggle ${esc(title)}" tabindex="-1"${checkedAttr}>
  <label class="board-col-header" for="${esc(toggleId)}">
    <div class="board-col-heading min-w-0">
      <div class="board-section-head">
        ${iconSvg(icon)}
        <h2 class="font-label-md text-on-surface uppercase tracking-wider">${esc(title)}</h2>
      </div>
      <p class="board-region-note">${esc(note)}</p>
    </div>
    <span class="board-col-tail flex-shrink-0">
      <span class="font-mono-sm text-outline board-col-count">${esc(countText)}</span>
      <span class="board-col-chevron" aria-hidden="true">▸</span>
    </span>
  </label>
  <div class="board-col-body" id="${esc(bodyId)}">
    ${body}
  </div>
</section>`;
}


/** One spec with work left, as a card. */
function todoCardHtml(item: BoardTodo): string {
  const next =
    item.nextTask === undefined
      ? ''
      : `<p class="board-kanban-next font-mono-sm text-on-surface-variant">next: ${esc(item.nextTask.id)} ${esc(item.nextTask.title)}</p>`;
  const projectAttr = item.project ? ` data-project="${esc(item.project)}"` : '';
  return `<div class="board-card board-todo board-kanban-card" data-spec="${esc(item.specId)}"${projectAttr}>
  <div class="board-kanban-main">
    <div class="board-kanban-titleline">
      <span class="font-mono-sm text-on-surface font-semibold truncate">${esc(item.title)}</span>
      <span class="board-lane-tag font-mono-sm text-on-surface-variant">${esc(item.specId)}</span>
    </div>
    <div class="board-kanban-meta">
      <span class="font-mono-sm text-outline">${item.remaining} of ${item.total} task${item.total === 1 ? '' : 's'} left</span>
    </div>
    ${next}
  </div>
</div>`;
}

function todoColumnBodyHtml(model: BoardModel): string {
  if (model.todo.length === 0) {
    if (model.projectFilter) {
      return `<p class="board-quiet font-mono-sm">No tasks match the project filter "${esc(model.projectFilter)}".</p>`;
    }
    return '<p class="board-quiet font-mono-sm">No spec has work left that nothing is running against.</p>';
  }
  return model.todo.map(todoCardHtml).join('');
}

function todoColumnHtml(model: BoardModel): string {
  const note = 'Specs with tasks left that no agent is working on. A unit of work is a spec.';
  const n = model.todo.length;
  const countText = `${n} spec${n === 1 ? '' : 's'}`;
  return columnHtml('todo', 'board-todo-toggle', 'board-todo-body', 'To Do', note, countText, true, 'gavel', todoColumnBodyHtml(model));
}

function inProgressColumnHtml(model: BoardModel, now: number): string {
  const n = model.inMotion.length;
  const countText = `${n} dispatch${n === 1 ? '' : 'es'}`;
  const note =
    'What the AI is working on. A card enters when a dispatch opens, and a finished one '
    + 'stays here as ready for your review until you accept it.';
  const body = inProgressColumnBodyHtml(model, now);
  return columnHtml('in-progress', 'board-in-progress-toggle', 'board-in-progress-body', 'In Progress', note, countText, false, 'play_circle', body);
}



function doneColumnHtml(model: BoardModel, now: number): string {
  const n = model.done.length;
  const countText = `${n} dispatch${n === 1 ? '' : 'es'}`;
  const note = 'The last ten to finish, newest first.';
  const body = doneColumnBodyHtml(model, now);
  return columnHtml('done', 'board-done-toggle', 'board-done-body', 'Done', note, countText, false, 'done_all', body);
}

function kanbanBoardHtml(model: BoardModel, now: number, exchange?: BoardExchange): string {
  return `<div class="board-kanban">
  ${todoColumnHtml(model)}
  ${inProgressColumnHtml(model, now)}
  ${doneColumnHtml(model, now)}
</div>
${alertsPanelHtml(model, now, exchange)}`;
}

/**
 * The things wanting a person, behind the bell in the top bar rather than in a
 * column of their own. As a column it only accumulated — a thousand items deep,
 * with nothing that could leave it — which is a notification list wearing a
 * column's clothes.
 */
function alertsPanelHtml(model: BoardModel, now: number, exchange?: BoardExchange): string {
  return `<div class="board-alerts" id="board-alerts" role="region" aria-label="Attention" hidden>
  <div class="board-alerts-head">
    <span class="font-label-md text-on-surface">Needs a person</span>
    <span class="board-alerts-actions">
      <button class="cyv-btn cyv-btn-secondary board-alerts-clear" type="button" data-action="ack-all">Clear all</button>
      <button class="cyv-btn cyv-btn-secondary" type="button" data-action="close-alerts">Close</button>
    </span>
  </div>
  <div class="board-alerts-body" id="board-decisions">
    ${needsYouColumnBodyHtml(model, now, exchange)}
  </div>
</div>`;
}

/** A recorded note with the replies that thread under it. */
interface NoteThread {
  entry: ExchangeEntry;
  replies: NoteThread[];
}

/**
 * Group entries into threads: a reply whose parent is on the page hangs under
 * it; anything else is a root. Roots stay newest first, replies oldest first,
 * so a thread reads top to bottom in the order it happened.
 */
function threadNotes(entries: readonly ExchangeEntry[]): NoteThread[] {
  const shown = new Set(entries.map((entry) => entry.id));
  const byParent = new Map<number, ExchangeEntry[]>();
  const roots: ExchangeEntry[] = [];
  for (const entry of entries) {
    const parent = entry.replyTo;
    if (parent !== undefined && shown.has(parent)) {
      const siblings = byParent.get(parent) ?? [];
      siblings.push(entry);
      byParent.set(parent, siblings);
    } else {
      roots.push(entry);
    }
  }
  const build = (entry: ExchangeEntry): NoteThread => ({
    entry,
    replies: (byParent.get(entry.id) ?? [])
      .sort((a, b) => a.created - b.created || a.id - b.id)
      .map(build),
  });
  return roots
    .sort((a, b) => b.created - a.created || b.id - a.id)
    .map(build);
}

/** The state chip on a note: what a person scanning the list needs to know. */
function noteStatusChip(entry: ExchangeEntry): string {
  // A note addressed to the orchestrator is carried by a lifecycle hook, and
  // "stored" and "delivered" are different facts. Storing one says nothing
  // about whether the session it is for has seen it.
  if (entry.orchestrator === true && entry.status !== 'addressed') {
    return entry.deliveredAt === undefined
      ? '<span class="board-note-chip bg-tertiary-soft text-tertiary">waiting for the orchestrator</span>'
      : '<span class="board-note-chip bg-secondary-soft text-secondary">delivered to the orchestrator</span>';
  }
  if (entry.status === 'addressed') {
    return '<span class="board-note-chip bg-surface-container-highest text-on-surface-variant">addressed</span>';
  }
  if (entry.isAgent) {
    // An open note from the agent is one the owner has not answered yet —
    // marking it addressed is the read receipt, so open reads as unread.
    return '<span class="board-note-chip bg-tertiary-soft text-tertiary">unread</span>';
  }
  if (entry.readByAgent === false) {
    return '<span class="board-note-chip bg-tertiary-soft text-tertiary">unread by the agent</span>';
  }
  if (entry.readByAgent === true) {
    return '<span class="board-note-chip bg-secondary-soft text-secondary">read by the agent</span>';
  }
  return '<span class="board-note-chip bg-secondary-soft text-secondary">open</span>';
}

function exchangeNoteHtml(thread: NoteThread, now: number): string {
  const { entry } = thread;
  const created = new Date(entry.created).toISOString();
  const who = entry.isAgent ? 'agent' : entry.author;
  const classes = ['board-note'];
  if (entry.isAgent) classes.push('board-note--agent');
  if (entry.isAgent && entry.status === 'open') classes.push('board-note--unread');
  if (entry.status === 'addressed') classes.push('board-note--addressed');
  const refs = [
    ...(entry.task === undefined ? [] : [`re ${entry.task}`]),
    ...(entry.file === undefined || entry.file === '' ? [] : [entry.file]),
    ...(entry.orchestrator === true ? ['to the orchestrator'] : []),
    ...(entry.deliveredAt === undefined
      ? []
      : [`delivered ${relativeTime(new Date(entry.deliveredAt).toISOString(), now)}`]),
  ];
  const statusControl =
    entry.status === 'addressed'
      ? `<button class="cyv-btn cyv-btn-secondary" type="button" data-action="note-status" data-note="${entry.id}" data-status="open">Reopen</button>`
      : `<button class="cyv-btn cyv-btn-secondary" type="button" data-action="note-status" data-note="${entry.id}" data-status="addressed">Mark Addressed</button>`;
  const replies =
    thread.replies.length === 0
      ? ''
      : `<div class="board-note-replies">${thread.replies.map((reply) => exchangeNoteHtml(reply, now)).join('')}</div>`;
  return `<div class="${classes.join(' ')}" data-note="${entry.id}">
  <div class="board-note-head">
    <span class="font-mono-sm ${entry.isAgent ? 'text-secondary' : 'text-primary'} font-bold">${esc(who)} · Note #${entry.id}</span>
    ${noteStatusChip(entry)}
    <span class="font-mono-sm text-outline">${refs.length === 0 ? '' : `${esc(refs.join(' · '))} • `}<time datetime="${esc(created)}">${esc(relativeTime(created, now))}</time></span>
  </div>
  <p class="font-mono-sm text-on-surface board-note-body">${esc(entry.body)}</p>
  <div class="board-note-actions">
    ${statusControl}
    <button class="cyv-btn cyv-btn-secondary" type="button" data-action="note-reply" data-note="${entry.id}">Reply</button>
  </div>
  ${replies}
</div>`;
}

/** One unsent note: editable text with save and discard, no separate editor. */
function draftNoteHtml(draft: CommentDraft, now: number): string {
  const created = new Date(draft.created).toISOString();
  const replyTo = draft.refs?.replyTo;
  return `<div class="board-note board-note--draft" data-draft="${draft.id}">
  <div class="board-note-head">
    <span class="font-mono-sm text-tertiary font-bold">Draft #${draft.id}</span>
    <span class="board-note-chip bg-tertiary-soft text-tertiary">draft</span>
    <span class="font-mono-sm text-outline">${replyTo === undefined ? '' : `re #${replyTo} • `}<time datetime="${esc(created)}">${esc(relativeTime(created, now))}</time></span>
  </div>
  <textarea class="board-textarea board-draft-body" data-draft-body="${draft.id}" rows="2" aria-label="Draft note text">${esc(draft.body)}</textarea>
  <div class="board-note-actions">
    <button class="cyv-btn cyv-btn-secondary" type="button" data-action="draft-save" data-draft="${draft.id}">Save</button>
    <button class="cyv-btn cyv-btn-secondary" type="button" data-action="draft-discard" data-draft="${draft.id}">Discard</button>
  </div>
</div>`;
}

function notesToEntries(notes: readonly BoardNote[]): ExchangeEntry[] {
  return notes.map((note) => ({
    id: note.id,
    author: note.author,
    isAgent: note.isAgent,
    kind: 'note',
    body: note.body,
    created: note.created,
    status: note.status,
    ...(note.task === undefined ? {} : { task: note.task }),
    ...(note.orchestrator === undefined ? {} : { orchestrator: note.orchestrator }),
    ...(note.deliveredAt === undefined ? {} : { deliveredAt: note.deliveredAt }),
  }));
}

function exchangeFormHtml(): string {
  return `<form class="board-compose" id="board-note-form" aria-label="Compose a note for the agent">
    <p class="board-compose-reply font-mono-sm text-on-surface-variant" id="board-note-replying" hidden>
      Replying to <span class="text-primary font-bold" id="board-note-parent"></span>
      <button class="cyv-btn cyv-btn-secondary board-compose-cancel" type="button" data-action="note-reply-cancel">Cancel</button>
    </p>
    <textarea class="board-textarea board-compose-body" id="board-note-body" rows="3" placeholder="Write a note for the agent — it stays a draft until you send the review." aria-label="Note text"></textarea>
    <label class="board-field board-field--inline">
      <input type="checkbox" id="board-note-orchestrator" name="orchestrator" value="true">
      <span class="font-mono-sm text-on-surface-variant">Send to orchestrator instead of dispatched agent</span>
    </label>
    <div class="board-compose-actions">
      <p class="board-note-error font-mono-sm" id="board-note-error" role="status" aria-live="polite" hidden></p>
      <button class="cyv-btn cyv-btn-primary board-compose-submit" type="submit">Add To Review</button>
    </div>
  </form>`;
}

function exchangeDraftsContent(drafts: readonly CommentDraft[], now: number): string {
  const pending = [...drafts].sort((a, b) => a.created - b.created || a.id - b.id);
  const draftList =
    pending.length === 0
      ? '<p class="board-empty board-drafts-empty">Nothing is waiting to be sent.</p>'
      : pending.map((draft) => draftNoteHtml(draft, now)).join('');
  return `<div class="board-drafts-head">
      <span class="font-label-xs text-on-surface uppercase tracking-wider">Unsent review</span>
      <span class="font-mono-sm ${pending.length > 0 ? 'text-tertiary font-bold' : 'text-outline'}" id="board-draft-count">${pending.length} draft${pending.length === 1 ? '' : 's'}</span>
    </div>
    ${draftList}
    <button class="cyv-btn cyv-btn-primary board-send-review" id="board-send-review" type="button" data-action="send-review"${pending.length === 0 ? ' disabled' : ''}>Send Review (${pending.length})</button>`;
}

function exchangeConversationContent(exchange: BoardExchange | undefined, model: BoardModel, now: number): string {
  const entries = exchange?.entries ?? notesToEntries(model.notes ?? []);
  const threads = threadNotes(entries);
  const omitted = exchange?.omitted ?? 0;
  const earlier =
    omitted === 0
      ? ''
      : `<p class="board-note-more font-mono-sm text-outline">${omitted} earlier note${omitted === 1 ? '' : 's'} not shown.</p>`;
  return threads.length === 0
    ? '<p class="board-empty">No open notes are waiting for the agent.</p>'
    : `<div class="board-notes">${threads.map((thread) => exchangeNoteHtml(thread, now)).join('')}</div>${earlier}`;
}

/**
 * The two-way channel: compose a note (a draft until the batch goes out), the
 * unsent batch with its send control, then the conversation, newest thread
 * first.
 */
function exchangePanelHtml(model: BoardModel, exchange: BoardExchange | undefined, now: number): string {
  return `<div class="board-panel board-exchange" id="board-exchange">
  <div class="board-section-head">
    ${iconSvg('forum')}
    <h3 class="font-label-md text-on-surface uppercase tracking-wider">Agent Note Exchange</h3>
  </div>
  <p class="board-region-note">Notes to and from the agent — what you write stays a draft until you send the review.</p>
  ${exchangeFormHtml()}
  <div class="board-drafts" id="board-drafts">
    ${exchangeDraftsContent(exchange?.drafts ?? [], now)}
  </div>
  <div class="board-conversation" id="board-conversation">
    ${exchangeConversationContent(exchange, model, now)}
  </div>
</div>`;
}

const TASK_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: 'mechanical-transformation', label: 'mechanical transformation' },
  { value: 'judgment-required', label: 'judgment required' },
];

function laneOption(lane: LaneDeclaration, running: number): string {
  const atCap = running >= lane.concurrencyCap;
  const dispatchable = acceptsDispatch(lane);
  const suffix = atCap ? ' — at cap' : dispatchable ? '' : ' — reserved';
  const disabled = !dispatchable || atCap ? ' disabled' : '';
  return `<option value="${esc(lane.id)}"${disabled}>${esc(lane.id)} (${running}/${lane.concurrencyCap})${esc(suffix)}</option>`;
}

function dispatchFormHtml(lanes: readonly LaneDeclaration[], model: BoardModel, now: number): string {
  const laneOptions = lanes.map((lane) => laneOption(lane, laneRunning(model, lane.id))).join('');
  const kindOptions = TASK_KIND_OPTIONS.map(
    ({ value, label }) => `<option value="${esc(value)}">${esc(label)}</option>`,
  ).join('');

  return `<div class="board-form" id="board-form" hidden role="dialog" aria-modal="true" aria-label="Dispatch a new wave">
  <form class="board-form-panel" id="board-dispatch-form" method="post" action="/api/dispatch">
    <div class="board-form-head">
      <h2 class="font-label-md text-on-surface uppercase tracking-wider">Dispatch a wave</h2>
      <button class="board-form-close cyv-btn cyv-btn-secondary" type="button" data-action="close-dispatch-form" aria-label="Close dispatch form">Close</button>
    </div>
    <div class="board-form-body">
      <label class="board-field">
        <span class="board-field-label font-mono-sm text-on-surface-variant">Task text</span>
        <textarea class="board-textarea" name="task" rows="4" placeholder="What should the agent do?"></textarea>
      </label>
      <p class="board-form-or font-mono-sm text-outline">or</p>
      <label class="board-field">
        <span class="board-field-label font-mono-sm text-on-surface-variant">Task file under docs/specs/**</span>
        <input class="board-input" type="text" name="taskFile" placeholder="docs/specs/NNNN-name/tasks.md">
      </label>
      <div class="board-form-row">
        <label class="board-field">
          <span class="board-field-label font-mono-sm text-on-surface-variant">Lane</span>
          <select class="board-select" name="lane" aria-label="Lane" required>
            <option value="" disabled selected hidden>Choose a lane</option>
            ${laneOptions}
          </select>
        </label>
        <label class="board-field">
          <span class="board-field-label font-mono-sm text-on-surface-variant">Task kind</span>
          <select class="board-select" name="kind" aria-label="Task kind">
            ${kindOptions}
          </select>
        </label>
      </div>
      <label class="board-field">
        <span class="board-field-label font-mono-sm text-on-surface-variant">Owned paths (one per line, at least one)</span>
        <textarea class="board-textarea" name="ownedPaths" rows="3" placeholder="packages/core/src/cli/dashboard.ts"></textarea>
      </label>
      <label class="board-field">
        <span class="board-field-label font-mono-sm text-on-surface-variant">Gates (one per line, default cyv-check)</span>
        <textarea class="board-textarea" name="gates" rows="2">cyv-check</textarea>
      </label>
    </div>
    <div class="board-form-foot">
      <button class="cyv-btn cyv-btn-primary board-form-submit" type="submit">Dispatch</button>
      <div class="board-form-result" id="board-form-result" role="status" aria-live="polite"></div>
    </div>
  </form>
</div>`;
}

function gateHtml(gate: GateResult): string {
  const badge = gate.passed
    ? '<span class="board-gate-passed">passed</span>'
    : '<span class="board-gate-failed">failed</span>';
  const detail = gate.detail === undefined ? '' : `<span class="font-mono-sm text-on-surface-variant">${esc(gate.detail)}</span>`;
  // A failed gate used to be a count and nothing else, so a reader could see
  // that a dispatch was refused and never what for.
  const findings = gate.findings ?? [];
  const found =
    findings.length === 0
      ? ''
      : `<ul class="board-gate-findings">${findings
          .map(
            (finding) =>
              `<li class="font-mono-sm"><span class="board-gate-rule">${esc(finding.ruleId)}</span> ` +
              `<span class="text-on-surface-variant">${esc(finding.path)}:${finding.line}:${finding.column}</span> ` +
              `<span class="text-on-surface">${esc(finding.message)}</span></li>`,
          )
          .join('')}</ul>`;
  return `<li class="board-gate"><code class="font-mono-sm text-on-surface">${esc(gate.gate)}</code>${badge}${detail}${found}</li>`;
}

function diffPanelContent(card: BoardCard, now: number): string {
  const split = scopeSplit(card);
  const outcome = card.outcome;
  const outcomeStyle = outcome === undefined ? { color: 'outline', label: 'in motion' } : outcomeClass(outcome);
  const outcomeAttr = outcome === undefined ? '' : ` data-outcome="${esc(outcome)}"`;

  const section = (key: string, title: string, paths: readonly string[], empty: string) =>
    `<section class="board-diff-section" data-section="${key}">
      <header class="board-diff-section-head">
        <h4 class="font-label-xs text-on-surface uppercase tracking-wider">${esc(title)}</h4>
        <span class="font-mono-sm text-on-surface-variant">${paths.length}</span>
      </header>
      ${
        paths.length === 0
          ? `<p class="board-empty">${esc(empty)}</p>`
          : `<ul class="board-diff-paths">${paths
              .map(
                (p) =>
                  // The path is the file. Reading a review means opening what it
                  // names, and until now the only way there was to find it again
                  // by hand in the explorer.
                  `<li class="font-mono-sm text-on-surface-variant"><button class="board-diff-path" type="button" data-action="open-file" data-path="${esc(
                    p,
                  )}" title="Open ${esc(p)} in the editor"><code>${esc(p)}</code></button></li>`,
              )
              .join('')}</ul>`
      }
    </section>`;

  const gates =
    card.gateResults === undefined || card.gateResults.length === 0
      ? '<p class="board-empty">No gate results were recorded for this dispatch.</p>'
      : `<ul class="board-gates">${card.gateResults.map(gateHtml).join('')}</ul>`;

  return `<div class="board-panel board-diff" data-dispatch="${esc(card.dispatchId)}">
  <div class="board-diff-head">
    <div class="board-diff-titleline min-w-0">
      <span class="font-mono-sm text-on-surface font-semibold truncate">${esc(card.description)}</span>
      ${cardRefHtml(card)}
      <span class="font-mono-sm text-on-surface-variant">${esc(relativeTime(card.timestamp, now))}</span>
    </div>
  </div>
  <div class="board-diff-body">
    <div class="board-diff-outcome">
      <span class="board-status-tag board-status-tag--plain bg-${outcomeStyle.color}-soft text-${outcomeStyle.color} font-mono-sm text-mono-sm font-semibold"${outcomeAttr}>${esc(outcomeStyle.label)}</span>
      <span class="font-mono-sm text-on-surface-variant">${esc(card.summary ?? '')}</span>
    </div>
    ${card.changedPaths === undefined || card.changedPaths.length === 0 ? '<p class="board-empty">This dispatch changed no files, so there is no diff to review.</p>' : ''}
    ${section('in-scope', 'In scope', split.inScope, 'No changed file is covered by the declared ownership.')}
    ${section('out-of-scope', 'Out of scope', split.outOfScope, card.scopeUnchecked === true ? 'This dispatch declared the whole repository, so no write could be out of scope. Nothing was checked here.' : 'No write outside the declared ownership was observed.')}
    ${section('declared-unchanged', 'Declared but unchanged', split.declaredUnchanged, 'No path was declared, or every declared path changed.')}
    <section class="board-diff-section" data-section="gates">
      <header class="board-diff-section-head">
        <h4 class="font-label-xs text-on-surface uppercase tracking-wider">Gates</h4>
        <span class="font-mono-sm text-on-surface-variant">${card.gateResults?.length ?? 0}</span>
      </header>
      ${gates}
    </section>
  </div>
</div>`;
}

/**
 * The legacy inspect panel. The board drawer now fetches `/api/drawer`
 * directly, which uses `renderDiffDrawer`; this export is retained for the
 * `/api/inspect` route that some client actions still expect.
 */
export function diffPanelForCard(card: BoardCard, now: number): string {
  return diffPanelContent(card, now);
}

// A drawer owns its own handle. The layout manager's tabs could be closed with
// no control anywhere to bring the panel back, which is why the board is on
// drawers again: a `<details>` summary is always on screen, so a drawer that is
// shut can always be opened.
function drawerHtml(): string {
  return `<details class="board-drawer" id="board-drawer" role="region" aria-label="Dispatch detail">
  <summary class="board-drawer-head">
    <span class="font-label-md text-on-surface">Review</span>
    <span class="font-mono-sm text-outline board-drawer-subject" id="board-drawer-subject">nothing selected</span>
    <span class="board-drawer-actions">
      <button class="cyv-btn cyv-btn-secondary board-drawer-tab" type="button" data-action="drawer-tab" data-tab="info" aria-pressed="true">Info</button>
      <button class="cyv-btn cyv-btn-secondary board-drawer-tab" type="button" data-action="drawer-tab" data-tab="diff" aria-pressed="false">Diff</button>
      <button class="cyv-btn cyv-btn-secondary board-drawer-expand" type="button" data-action="drawer-full" aria-pressed="false">Full screen</button>
    </span>
  </summary>
  <div class="board-drawer-diff" id="board-drawer-diff" hidden></div>
  <div class="board-drawer-body" id="board-drawer-body">
    <div class="drawer">
      <p class="drawer-empty">Select a dispatch card to review its scope split, outcome, and line-level diff.</p>
    </div>
  </div>
</details>`;
}

function explorerHtml(): string {
  return `<details class="board-explorer" id="board-explorer" role="region" aria-label="Solution explorer">
  <summary class="board-explorer-head">
    <span class="board-explorer-rail" aria-hidden="true">‹</span>
    <span class="font-headline-sm text-on-surface board-explorer-label">Solution Explorer</span>
  </summary>
  <div class="board-explorer-body" id="board-explorer-body">
    <p class="board-empty">Loading file tree…</p>
  </div>
</details>`;
}

export function renderBoardFragment(input: BoardRenderInput, region: string): string | undefined {
  const now = input.now ?? Date.now();
  const status = effectiveStatus(input.model, input.lanes);
  switch (region) {
    case 'topbar':
      return topBarContent(input.projectRoot ?? '', input.model);
    case 'status':
      return statusBarContent(status, input.sessions ?? [], now, input.gate) + laneStatusStripContent(input.model, input.lanes, now) + sessionsPanelHtml(input.sessions ?? [], now);
    case 'lanes':
      return laneStatusStripContent(input.model, input.lanes, now);
    case 'sessions':
      return sessionsPanelHtml(input.sessions ?? [], now);
    case 'todo':
      return todoColumnBodyHtml(input.model);
    case 'in-progress':
      return inProgressColumnBodyHtml(input.model, now);
    case 'needs-you':
      return needsYouColumnBodyHtml(input.model, now, input.exchange);
    case 'decisions':
      return decisionsPanelContent(input.model, now);
    case 'conversation':
      return exchangeConversationContent(input.exchange, input.model, now);
    case 'drafts':
      return exchangeDraftsContent(input.exchange?.drafts ?? [], now);
    case 'done':
      return doneColumnBodyHtml(input.model, now);
    default:
      return undefined;
  }
}

export function renderBoard(input: BoardRenderInput): string {
  const now = input.now ?? Date.now();
  const status = effectiveStatus(input.model, input.lanes);
  const sessions = input.sessions ?? [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(basename(input.projectRoot ?? '') || 'checkyourvibe')} · Workbench</title>
<style>${dashboardCss()}${boardCss()}</style>
</head>
<body class="bg-surface text-on-surface font-body-md" data-project="${esc(input.projectRoot ?? '')}">
<!-- The chrome stays above the board and out of the drawers. The live badge,
     the gate badge, the orchestrator line and the project filter answer "is
     any of this current", and a drawer can be closed. -->
<header id="board-chrome" class="board-chrome">
  ${topBarHtml(input.projectRoot ?? '', input.model)}
  ${statusBarHtml(status, input.model, input.lanes, sessions, now, input.gate)}
</header>
<main class="board-main">
  ${kanbanBoardHtml(input.model, now, input.exchange)}
</main>
${drawerHtml()}
${explorerHtml()}
${dispatchFormHtml(input.lanes, input.model, now)}
</body>
</html>`;
}

/**
 * The board's own rules, token-referenced only. Kept as a separate export so
 * the route that serves this page can append them into the same stylesheet
 * `shell` already emits rather than adding a second one.
 */
export function boardCss(): string {
  return `
/* Board layout: three-column kanban with a docked diff drawer (spec 0051 R2). */
.board-main {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-md);
  background-color: var(--cyv-surface);
  color: var(--cyv-on-surface);
  padding: var(--cyv-space-md) var(--cyv-gutter-mobile);
  padding-bottom: 60vh;
}
@media (min-width: 1024px) {
  .board-main { padding: var(--cyv-space-md) var(--cyv-gutter-desktop); padding-bottom: 60vh; }
}
@media (max-width: 1023px) {
  .board-main { padding-bottom: var(--cyv-space-md); }
}

/* The chrome rides above the board and stays there while it scrolls. Folded,
   it is two lines: everything below the status line is behind a disclosure. */
.board-chrome {
  position: sticky;
  top: 0;
  z-index: 300;
  background-color: var(--cyv-surface);
  border-bottom: 1px solid var(--cyv-surface-container-high);
}

/* Top bar */
.board-topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-md);
  padding: var(--cyv-space-sm) 0;
}
.board-brand {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-sm);
  color: var(--cyv-primary);
}
.board-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
.board-nav {
  display: none;
  align-items: center;
  gap: var(--cyv-space-xs);
}
@media (min-width: 1024px) {
  .board-nav { display: flex; }
}
.board-nav-item {
  padding: var(--cyv-space-xs) var(--cyv-space-md);
  border-radius: var(--cyv-radius);
  font-family: var(--cyv-font-sans);
  font-size: 12px;
  line-height: 16px;
  letter-spacing: 0.04em;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--cyv-on-surface-variant);
  text-decoration: none;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.board-nav-item:hover, .board-nav-item.active {
  background-color: var(--cyv-surface-container-highest);
  color: var(--cyv-on-surface);
}
.board-topbar-right {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}

/* Status strip */
.board-status {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-status-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-md);
  padding: var(--cyv-space-sm) var(--cyv-space-md);
  background-color: var(--cyv-surface-container-low);
  border-radius: var(--cyv-radius-lg);
}
.board-status-bar-left {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cyv-space-sm);
  min-width: 0;
}
.board-live-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-xs) var(--cyv-space-sm);
  border-radius: var(--cyv-radius-full);
  background-color: var(--cyv-surface-container-lowest);
  font-family: var(--cyv-font-mono);
  font-size: 11px;
  line-height: 14px;
  flex-wrap: wrap;
}
.board-live-badge[data-live="disconnected"] {
  background-color: var(--cyv-error-soft);
  color: var(--cyv-error);
}
.board-live-badge[data-live="reconnecting"] {
  background-color: var(--cyv-tertiary-soft);
  color: var(--cyv-tertiary);
}
.board-live-badge[data-live="live"] {
  background-color: var(--cyv-secondary-soft);
  color: var(--cyv-secondary);
}
.board-live-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--cyv-radius-full);
}
.board-live-label {
  font-weight: 600;
}
.board-ok-badge, .board-stall-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-xs) var(--cyv-space-sm);
  border-radius: var(--cyv-radius);
}
.board-stall-badge {
  background-color: var(--cyv-tertiary-soft);
  color: var(--cyv-tertiary);
}
.board-ok-badge {
  background-color: var(--cyv-surface-container);
  color: var(--cyv-on-surface-variant);
}

/* Lanes and sessions fold away: the status line above carries the summary, and
   the board should start at the top of the viewport, not below it. */
.board-status-more { border-top: 1px solid var(--cyv-outline-variant); }
.board-status-summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  /* The status bar above is inset by its own padding; the summary lines its
     text up with it rather than running to the edge of the page. */
  padding: var(--cyv-space-xs) var(--cyv-space-md);
  color: var(--cyv-on-surface-variant);
  user-select: none;
}
.board-status-summary::-webkit-details-marker { display: none; }
.board-status-summary::before {
  content: '▸';
  flex: 0 0 auto;
  color: var(--cyv-outline);
  transition: transform 120ms ease;
}
.board-status-more[open] > .board-status-summary::before { transform: rotate(90deg); }
.board-status-summary:hover { color: var(--cyv-on-surface); }
.board-status-more > .board-lane-strip { margin-top: var(--cyv-space-sm); }

/* Lane status strip */
.board-lane-strip {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-md);
  background-color: var(--cyv-surface-container-low);
  border-radius: var(--cyv-radius-lg);
}
.board-lane-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--cyv-space-sm);
}
.board-lane-card {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius-lg);
  border: 1px solid var(--cyv-surface-container-high);
}
.board-lane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
}
.board-lane-idline {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  min-width: 0;
}
.board-lane-meta, .board-lane-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}
.board-lane-badge {
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  border-radius: var(--cyv-radius-full);
  font-family: var(--cyv-font-mono);
  font-size: 10px;
  line-height: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

/* Sessions */
.board-sessions {
  padding: var(--cyv-space-md);
  background-color: var(--cyv-surface-container-low);
  border-radius: var(--cyv-radius-lg);
}
.board-session-list {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-session-row {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius-lg);
}
.board-session-head {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  flex-wrap: wrap;
}
.board-session-meta {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}
.board-session-start {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cyv-space-sm);
  margin-top: var(--cyv-space-sm);
}

/* Kanban */
.board-bell { position: relative; }
.board-bell-count {
  margin-left: var(--cyv-space-xs);
  font-variant-numeric: tabular-nums;
}
.board-bell-count[data-empty="true"] { opacity: 0.5; }
.board-alerts {
  position: fixed;
  top: 3.5rem;
  right: var(--cyv-space-md);
  width: min(520px, 92vw);
  max-height: 70vh;
  overflow-y: auto;
  z-index: 250;
  background-color: var(--cyv-surface-container-low);
  border: 1px solid var(--cyv-surface-container-high);
  border-radius: var(--cyv-radius-lg);
  box-shadow: var(--cyv-shadow-md);
}
.board-alerts[hidden] { display: none; }
.board-alerts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--cyv-space-sm) var(--cyv-space-md);
  border-bottom: 1px solid var(--cyv-surface-container-high);
}
.board-alerts-body { padding: var(--cyv-space-sm) var(--cyv-space-md); }
.board-alerts-actions { display: flex; gap: var(--cyv-space-xs); }
.board-kanban-next { margin: var(--cyv-space-xs) 0 0; }
.board-sessions-line { margin: 0; padding: var(--cyv-space-xs) var(--cyv-space-md); }
.board-kanban {
  display: grid;
  /* One track per column, spanning the width. It said four while three were
     rendered, so the columns took three quarters of the grid and left the rest
     of the page empty. */
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--cyv-space-md);
  align-items: start;
  width: 100%;
}
@media (max-width: 1023px) {
  .board-kanban { display: flex; flex-direction: column; }
}

.board-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background-color: var(--cyv-surface-container-low);
  border-radius: var(--cyv-radius-lg);
  padding: var(--cyv-space-sm);
  gap: var(--cyv-space-sm);
}
@media (max-width: 1023px) {
  .board-column { border-radius: var(--cyv-radius); }
}

.board-col-toggle {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.board-col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  cursor: pointer;
  padding: var(--cyv-space-xs) var(--cyv-space-sm);
  border-radius: var(--cyv-radius);
  transition: background-color 0.15s ease;
}
.board-col-header:hover {
  background-color: var(--cyv-surface-container);
}
@media (min-width: 1024px) {
  .board-col-header { cursor: default; }
  .board-col-header:hover { background-color: transparent; }
  .board-col-toggle { display: none; }
  .board-col-chevron { display: none; }
}
.board-col-heading {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xxs);
  min-width: 0;
}
.board-col-tail {
  display: inline-flex;
  align-items: center;
  gap: var(--cyv-space-sm);
}
.board-col-count {
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius);
}
.board-col-chevron {
  color: var(--cyv-outline);
  transition: transform 0.15s ease;
}
.board-col-toggle:checked ~ .board-col-header .board-col-chevron {
  transform: rotate(90deg);
}

.board-col-body {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
  overflow-x: hidden;
}
@media (max-width: 1023px) {
  .board-col-body { display: none; }
  .board-col-toggle:checked ~ .board-col-body { display: flex; }
}

.board-section-head {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  flex-wrap: wrap;
}
.board-region-note {
  margin: 0;
  font-family: var(--cyv-font-mono);
  font-size: 11px;
  line-height: 14px;
  color: var(--cyv-on-surface-variant);
}

/* Cards */
.board-card {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius-lg);
  border: 1px solid var(--cyv-surface-container-high);
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.board-card:hover {
  background-color: var(--cyv-surface-container-high);
}
.board-kanban-main {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-kanban-titleline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
}
.board-kanban-meta {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  flex-wrap: wrap;
}
.board-card-ref {
  font-size: 11px;
}
.board-diff-path {
  /* A path is a control now, and it has to still read as a path: the button is
     the text, with the affordance only on hover and focus. */
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.board-diff-path:hover code,
.board-diff-path:focus-visible code {
  color: var(--cyv-primary);
  text-decoration: underline;
}
.board-kanban-title {
  /* The title is what the dispatch is doing, so it gets two lines rather than
     one truncated one. Past that it clips, so a card stays a card. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-width: 0;
}
.board-gate-findings {
  list-style: none;
  margin: var(--cyv-space-xs) 0 0;
  padding: 0 0 0 var(--cyv-space-md);
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-2xs);
}
.board-gate-findings li { overflow-wrap: anywhere; }
.board-gate-rule { color: var(--cyv-error); font-weight: 600; }
.board-card-scope-out {
  /* The accusation's evidence wraps rather than truncating: a path clipped off
     the right edge is the whole reason this line exists. Breaking anywhere
     splits a long path only once the line is genuinely full, so a path that
     fits stays whole. */
  margin: 0 0 var(--cyv-space-xs);
  white-space: normal;
  overflow-wrap: anywhere;
}
.board-card-scope {
  margin: 0;
}
.board-scope-out {
  font-weight: 600;
}
.board-kanban-actions {
  display: flex;
  gap: var(--cyv-space-xs);
}
.board-status-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--cyv-space-xxs);
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  border-radius: var(--cyv-radius);
  text-transform: none;
  letter-spacing: 0;
}
.board-status-tag--plain {
  background-color: var(--cyv-surface-container-highest);
  border: 1px solid var(--cyv-surface-highest);
}
.board-lane-tag {
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  background-color: var(--cyv-surface-container-lowest);
  border-radius: var(--cyv-radius);
}

/* Decision cards (Needs You) */
.board-decision-card {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius-lg);
  border: 1px solid var(--cyv-surface-container-high);
}
.board-decision-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
}
.board-decision-actions {
  display: flex;
  gap: var(--cyv-space-xs);
  flex-wrap: wrap;
}

/* Blocked row */
.board-blocked {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-sm);
  background-color: var(--cyv-tertiary-soft);
  border-radius: var(--cyv-radius-lg);
}
.board-blocked-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-xs) var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius);
}
.board-blocked-title {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  min-width: 0;
}

/* Note exchange */
.board-exchange {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-compose {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-compose-reply {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}
.board-compose-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}
.board-drafts {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-drafts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
}
.board-conversation {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-notes {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-note {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  border-radius: var(--cyv-radius);
  border: 1px solid var(--cyv-surface-container-high);
}
.board-note--agent {
  border-left: 3px solid var(--cyv-secondary);
}
.board-note--unread {
  border-left: 3px solid var(--cyv-tertiary);
}
.board-note-head {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
  flex-wrap: wrap;
}
.board-note-body {
  margin: 0;
  white-space: pre-wrap;
}
.board-note-actions {
  display: flex;
  gap: var(--cyv-space-xs);
}
.board-note-replies {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding-left: var(--cyv-space-md);
  border-left: 1px solid var(--cyv-surface-container-high);
}
.board-note-chip {
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  border-radius: var(--cyv-radius);
  font-family: var(--cyv-font-mono);
  font-size: 10px;
  line-height: 12px;
  font-weight: 600;
  text-transform: uppercase;
}
.board-note-more {
  margin: 0;
}

/* Drawer */
/* Docked at the bottom as a <details>. The summary is always visible and the
   body expands when a card is selected; the open attribute is managed by the
   browser, not by scripts or classes. */
.board-drawer {
  /* How tall the drawer may be, and how much of that its summary takes. The
     scrolling panes below size themselves from these rather than from flex:
     a <details> renders its content inside an anonymous box, so the panes are
     not flex items of this element and never shrank to it. A min-height of
     zero on them did nothing, and the overflow hung outside the drawer with no
     scrollbar — measured at 983px of content in a 460px drawer. */
  --cyv-drawer-max: 60vh;
  --cyv-drawer-head: 3.25rem;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 400;
  background-color: var(--cyv-surface-container-low);
  border-top: 1px solid var(--cyv-surface-container-high);
  display: flex;
  flex-direction: column;
  max-height: 60vh;
}
/* Reading a diff wants the screen, and 60vh of a docked panel is not enough
   for one. */
.board-drawer--full {
  --cyv-drawer-max: 100vh;
  top: 0;
  max-height: 100vh;
}
@media (min-width: 1024px) {
  /* The drawer is fixed to the viewport, so the page's own padding does not
     move it: it keeps its distance from the rail explicitly, in both of the
     rail's widths. A drawer running under the rail puts its own controls off
     the page. */
  .board-drawer { right: 2.25rem; }
  body.board-explorer-open .board-drawer { right: 320px; }
}
.board-drawer-head {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-sm) var(--cyv-space-md);
  border-bottom: 1px solid var(--cyv-surface-container-high);
  flex-shrink: 0;
  list-style: none;
  cursor: pointer;
}
.board-drawer-head::-webkit-details-marker { display: none; }
.board-drawer-subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-drawer-actions {
  display: flex;
  gap: var(--cyv-space-xs);
  margin-left: auto;
}
.board-drawer-tab[aria-pressed="true"] {
  background-color: var(--cyv-surface-container-high);
}
@media (max-width: 1023px) {
  .board-drawer[open] { --cyv-drawer-max: 100vh; inset: 0; max-height: 100vh; }
}
.board-drawer-diff {
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(var(--cyv-drawer-max) - var(--cyv-drawer-head));
  border: none;
  width: 100%;
}
.board-drawer-diff[hidden] { display: none; }
.board-difit-frame { width: 100%; height: calc(var(--cyv-drawer-max) - var(--cyv-drawer-head)); border: 0; display: block; }
.board-field--inline {
  flex-direction: row;
  align-items: center;
  gap: var(--cyv-space-sm);
  margin-top: var(--cyv-space-sm);
}
.board-drawer-diff {
  overflow: auto;
  padding: var(--cyv-space-sm) var(--cyv-space-md) var(--cyv-space-md);
}
.board-diff-basis {
  color: var(--cyv-on-surface-variant);
  margin: 0 0 var(--cyv-space-sm);
}
.board-difffile {
  border: 1px solid var(--cyv-surface-container-high);
  border-radius: var(--cyv-radius);
  margin-bottom: var(--cyv-space-sm);
  overflow: hidden;
}
.board-difffile-head {
  display: flex;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-xs) var(--cyv-space-sm);
  background-color: var(--cyv-surface-container);
  cursor: pointer;
}
.board-difffile-counts { color: var(--cyv-on-surface-variant); }
.board-difflines {
  font-family: var(--cyv-font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-x: auto;
}
.board-diffline {
  white-space: pre;
  padding: 0 var(--cyv-space-sm);
}
.board-diffline--added { background-color: color-mix(in srgb, var(--cyv-primary) 14%, transparent); }
.board-diffline--removed { background-color: color-mix(in srgb, var(--cyv-error) 14%, transparent); }
.board-diffline--meta { color: var(--cyv-on-surface-variant); }
.board-drawer-body {
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(var(--cyv-drawer-max) - var(--cyv-drawer-head));
}
/* Diff panel used by the /api/inspect route (legacy). */
.board-diff {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-md);
}
.board-diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
  padding-bottom: var(--cyv-space-sm);
  border-bottom: 1px solid var(--cyv-surface-container-high);
}
.board-diff-titleline {
  display: flex;
  align-items: baseline;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
  min-width: 0;
}
.board-diff-body {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-md);
}
.board-diff-outcome {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cyv-space-sm);
}
.board-diff-section {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-diff-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
}
.board-diff-paths {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-gates {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-gate {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}
.board-gate-passed {
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  background-color: var(--cyv-secondary-soft);
  color: var(--cyv-secondary);
  border-radius: var(--cyv-radius);
  font-family: var(--cyv-font-mono);
  font-size: 10px;
  line-height: 12px;
  font-weight: 600;
  text-transform: uppercase;
}
.board-gate-failed {
  padding: var(--cyv-space-xxs) var(--cyv-space-xs);
  background-color: var(--cyv-error-soft);
  color: var(--cyv-error);
  border-radius: var(--cyv-radius);
  font-family: var(--cyv-font-mono);
  font-size: 10px;
  line-height: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

/* Dispatch form */
.board-form {
  position: fixed;
  inset: 0;
  z-index: 300;
  background-color: var(--cyv-surface-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--cyv-space-md);
}
.board-form[hidden] {
  display: none;
}
.board-form-panel {
  width: 100%;
  max-width: 560px;
  max-height: 100%;
  overflow-y: auto;
  background-color: var(--cyv-surface-container);
  border: 1px solid var(--cyv-surface-container-high);
  border-radius: var(--cyv-radius-lg);
  padding: var(--cyv-space-md);
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-md);
}
.board-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
}
.board-form-body {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-sm);
}
.board-form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--cyv-space-sm);
}
.board-field {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-field-label {
  display: flex;
  align-items: center;
  gap: var(--cyv-space-xs);
}
.board-form-or {
  text-align: center;
  margin: 0;
}
.board-form-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  flex-wrap: wrap;
}

/* Utilities */
.board-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--cyv-radius-full);
  flex-shrink: 0;
}
.board-empty {
  margin: 0;
  padding: var(--cyv-space-sm);
  border: 1px dashed var(--cyv-surface-highest);
  border-radius: var(--cyv-radius);
  font-family: var(--cyv-font-mono);
  font-size: 12px;
  line-height: 16px;
  color: var(--cyv-on-surface-variant);
}
.board-quiet {
  margin: 0;
  color: var(--cyv-on-surface-variant);
  padding: var(--cyv-space-sm);
}
.board-older {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
}
.board-older-toggle {
  cursor: pointer;
  color: var(--cyv-on-surface-variant);
}
.board-older-body {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding-left: var(--cyv-space-sm);
}


/* Solution explorer docked on the right as a <details>. Closed, it collapses to
   the width of its own handle, so a panel that is not in use is not holding
   320px of the page. */
.board-explorer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 2.25rem;
  z-index: 400;
  background-color: var(--cyv-surface-container-low);
  border-left: 1px solid var(--cyv-surface-container-high);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.15s ease;
}
.board-explorer[open] { width: 320px; }
/* Closed, the rail is 36px wide: a two-word label inside it wraps and spills
   two clipped lines down the edge of the page. */
.board-explorer:not([open]) .board-explorer-label { display: none; }
.board-explorer:not([open]) .board-explorer-head { justify-content: center; padding: var(--cyv-space-sm) 0; }
.board-explorer[open] .board-explorer-rail { display: none; }
.board-explorer-rail { color: var(--cyv-on-surface-variant); }
/* The rail is fixed to the right edge, so nothing behind it moves out of its
   way on its own. The page reserves the width instead of the board alone: the
   header is in the page too, and it was running underneath the rail. */
body { padding-right: 2.25rem; }
@media (min-width: 1024px) {
  body.board-explorer-open { padding-right: 320px; }
}
@media (max-width: 1023px) {
  /* Open, the rail covers the viewport rather than sitting beside it, so
     there is nothing to reserve. */
  body.board-explorer-open { padding-right: 0; }
}
@media (max-width: 1023px) {
  .board-explorer[open] { width: 100vw; }
}
.board-explorer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-sm) var(--cyv-space-md);
  border-bottom: 1px solid var(--cyv-surface-container-high);
  flex-shrink: 0;
  list-style: none;
  cursor: pointer;
}
.board-explorer-head::-webkit-details-marker { display: none; }
.board-explorer-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.board-explorer-tree {
  flex: 0 1 45%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--cyv-space-sm);
  border-bottom: 1px solid var(--cyv-surface-container-high);
}
.board-explorer-dir {
  display: flex;
  flex-direction: column;
}
.board-explorer-dir-name {
  cursor: pointer;
  font-family: var(--cyv-font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--cyv-on-surface);
  padding: var(--cyv-space-xs) 0;
  list-style: none;
}
.board-explorer-children {
  display: flex;
  flex-direction: column;
  padding-left: var(--cyv-space-md);
}
.board-explorer-file {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: var(--cyv-space-xs) 0;
  font-family: var(--cyv-font-mono);
  font-size: 12px;
  color: var(--cyv-on-surface-variant);
  cursor: pointer;
}
.board-explorer-file:hover {
  color: var(--cyv-primary);
}
.board-explorer-file-selected {
  color: var(--cyv-primary);
  font-weight: 600;
}
/* The editor is a centred <dialog>. The browser provides the backdrop, focus
   trap, Escape to dismiss and inertness behind it; the CSS only styles the
   panel and the ::backdrop pseudo-element. */
.board-modal {
  position: fixed;
  inset: 0;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  max-width: none;
  max-height: none;
}
.board-modal[open] {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--cyv-space-lg);
  max-width: none;
  max-height: none;
}
.board-modal::backdrop {
  background-color: var(--cyv-surface-container-lowest);
}
.board-modal-panel {
  /* Writing code wants the screen. It was capped at 1100px on a 2560px display,
     which left most of the monitor as backdrop. */
  width: 96vw;
  height: 94vh;
  background-color: var(--cyv-surface-container-low);
  border: 1px solid var(--cyv-surface-container-high);
  border-radius: var(--cyv-radius-lg);
  box-shadow: var(--cyv-shadow-md);
  overflow: hidden;
}
.board-explorer-editor {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.board-monaco {
  flex: 1 1 auto;
  min-height: 0;
}
.board-monaco[hidden] { display: none; }
.board-explorer-preview {
  flex: 1 1 auto;
  /* Same trap as the drawer body: without this the markdown preview grows past
     the pane instead of scrolling inside it. */
  min-height: 0;
  overflow-y: auto;
  padding: var(--cyv-space-md) var(--cyv-space-lg);
  background-color: var(--cyv-surface);
  color: var(--cyv-on-surface);
}
.board-explorer-preview h1,
.board-explorer-preview h2,
.board-explorer-preview h3 {
  color: var(--cyv-on-surface);
  margin: var(--cyv-space-md) 0 var(--cyv-space-sm);
}
.board-explorer-preview pre {
  background-color: var(--cyv-surface-container);
  padding: var(--cyv-space-sm);
  overflow-x: auto;
}
@media (max-width: 1023px) {
  .board-modal[open] { padding: 0; }
  .board-modal-panel { width: 100vw; height: 100vh; border-radius: 0; border: none; }
}
.board-explorer-file-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cyv-space-sm);
  padding: var(--cyv-space-sm) var(--cyv-space-md);
  border-bottom: 1px solid var(--cyv-surface-container-high);
  background-color: var(--cyv-surface-container);
  flex-shrink: 0;
}
.board-explorer-file-path {
  color: var(--cyv-on-surface);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-explorer-file-actions {
  display: flex;
  gap: var(--cyv-space-xs);
}
.board-explorer-save:disabled {
  opacity: 0.5;
}
.board-explorer-editor-text {
  flex: 1 1 auto;
  width: 100%;
  min-height: 8rem;
  background-color: var(--cyv-surface);
  color: var(--cyv-on-surface);
  border: none;
  padding: var(--cyv-space-md);
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  outline: none;
}
.board-explorer-findings {
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: var(--cyv-space-sm) var(--cyv-space-md);
  border-top: 1px solid var(--cyv-surface-container-high);
  background-color: var(--cyv-surface-container);
  flex-shrink: 0;
}
.board-explorer-findings[hidden] {
  display: none;
}
.board-explorer-findings-head {
  color: var(--cyv-on-surface);
  text-transform: uppercase;
}
.board-explorer-findings-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--cyv-space-xs);
  padding: 0;
  margin: 0;
}
.board-explorer-finding {
  font-family: var(--cyv-font-mono);
  font-size: 11px;
  color: var(--cyv-on-surface-variant);
}
.board-explorer-finding-rule {
  color: var(--cyv-error);
  font-weight: 600;
}
.board-explorer-finding-message {
  color: var(--cyv-on-surface);
}
.board-explorer-finding-line {
  color: var(--cyv-outline);
}
.board-explorer-status {
  margin: 0;
  padding: var(--cyv-space-xs) var(--cyv-space-md);
  font-family: var(--cyv-font-mono);
  font-size: 11px;
  color: var(--cyv-on-surface-variant);
  flex-shrink: 0;
}
.board-explorer-status--ok {
  color: var(--cyv-secondary);
}
.board-explorer-status--error {
  color: var(--cyv-error);
}
`;
}
