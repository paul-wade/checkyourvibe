/**
 * The diff drawer's content for one dispatch, rendered as server-side HTML
 * (spec 0051 Requirement 3).
 *
 * What the drawer can show is decided by what the dispatch record holds. The
 * executor's snapshots store a sha256 digest per path, not file content
 * (Decision 1; `executor/snapshot.ts`), and no snippet data exists anywhere —
 * so the three-way scope split is computed from path lists and there are no
 * added or removed lines to draw. Line-level content lives in the Diff tab,
 * which starts difit and frames it through the same-origin proxy; the Info tab
 * no longer links away.
 *
 * Requirement 3.5 is a correctness rule: a dispatch still in motion has a
 * working tree changing underneath the reader, so any classification rendered
 * for it could describe a state that no longer exists. `renderDiffDrawer`
 * refuses to present an open record as reviewable and says why, instead of
 * rendering an empty shell that looks like a verdict.
 *
 * Styling reuses the design tokens in `styles.ts`: `diffDrawerCss` is meant to
 * be appended to the same `<style>` element as `dashboardCss`, and every
 * colour stays a `var(--cyv-*)` custom property (Requirement 7.2). No literal
 * colour appears in it.
 */
import { esc } from './render.js';
import type { AttributedPath } from './attribution.js';
import { taskIdIn } from './motion.js';
import { normalizeOwnedPath, pathIsWithin } from '../executor/ownership.js';
import type { DispatchRecord } from '../executor/dispatch.js';
import type { DispatchOutcome, DispatchOutcomeKind, GateResult } from '../executor/outcome.js';

export interface DiffDrawerInput {
  /** The dispatch record the drawer is opened on. */
  record: DispatchRecord;
  /**
   * Kept for backwards compatibility with callers that used to pass a difit
   * surface URL. The drawer no longer links away; the Diff tab starts difit.
   */
  diffHref?: string;
  /**
   * Paths the decision log shows only a session outliving this dispatch wrote.
   * The before-and-after comparison the outcome rests on cannot tell writers
   * apart, so these are recorded as this dispatch's writes and are not.
   */
  writtenByOthers?: readonly AttributedPath[];
}



/** The first non-empty line of the task text, without a leading task id the header already shows. */
function firstLine(task: string): string {
  const line = task.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return (line ?? task).trim().replace(/^T\d{4,}\s*[:—-]?\s*/, '');
}

/**
 * The badge an outcome kind wears. `succeeded` is the only measured outcome,
 * so it is the only one allowed the secondary colour; the exhaustion-shaped
 * outcomes stay amber and every remaining kind is a failure. The same mapping
 * the board's cards use.
 */
function outcomeBadgeClass(kind: DispatchOutcomeKind): string {
  switch (kind) {
    case 'succeeded':
      return 'cyv-badge-passed';
    case 'produced-nothing':
    case 'rate-limited':
    case 'did-not-complete':
      return 'cyv-badge-running';
    default:
      return 'cyv-badge-failed';
  }
}

/** The three-way split Requirement 3.2 fixes, computed from the record's path lists. */
interface ScopeSplit {
  /** Changed, and covered by the declared ownership. */
  inScope: string[];
  /** Changed and not declared — the record's own `outOfScopePaths`. */
  outOfScope: string[];
  /** Declared and not changed: the claim of work that produced nothing there. */
  declaredUnchanged: string[];
}

function scopeSplit(record: DispatchRecord, outcome: DispatchOutcome): ScopeSplit {
  const out = new Set(outcome.outOfScopePaths);
  const changed = outcome.changedPaths;
  const declaredUnchanged = [...new Set(record.declaration.ownedPaths.map(normalizeOwnedPath))]
    .filter((declared) => !changed.some((changedPath) => pathIsWithin(changedPath, declared)))
    .map((declared) => (declared === '' ? '.' : declared))
    .sort();
  return {
    inScope: changed.filter((path) => !out.has(path)).sort(),
    outOfScope: [...outcome.outOfScopePaths].sort(),
    declaredUnchanged,
  };
}

/** One section of the scope split: a titled path list, or a designed empty line. */
function scopeSectionHtml(key: string, title: string, paths: readonly string[], empty: string): string {
  const body =
    paths.length === 0
      ? `<p class="drawer-empty">${esc(empty)}</p>`
      : `<ul class="drawer-paths">${paths
          .map((path) => `<li class="drawer-path"><code>${esc(path)}</code></li>`)
          .join('')}</ul>`;
  return `<section class="drawer-section" data-section="${key}">
    <header class="drawer-section-head"><h3 class="drawer-section-title">${title}</h3>
      <span class="drawer-count">${paths.length}</span></header>
    ${body}
  </section>`;
}

/** The scope split in the order Requirement 3.2 names it. */
function othersHtml(attributed: readonly AttributedPath[]): string {
  if (attributed.length === 0) return '';
  const rows = attributed
    .map(
      (entry) =>
        `<li class="drawer-path"><code>${esc(entry.path)}</code>` +
        `<span class="drawer-path-note">written by ${esc(entry.sessions.join(', '))}</span></li>`,
    )
    .join('');
  return `<section class="drawer-section" data-section="written-by-others">
    <header class="drawer-section-head"><h3 class="drawer-section-title">Changed here, but not by this dispatch</h3>
      <span class="drawer-count">${attributed.length}</span></header>
    <p class="drawer-note">The outcome compares the tree before this dispatch opened with the tree
      after it closed, so anything written in between is charged to it. The gate's decision log
      records these paths as written by a session that was already running before this dispatch
      opened, or was still running after it closed.</p>
    <ul class="drawer-paths">${rows}</ul>
  </section>`;
}

function scopeHtml(
  record: DispatchRecord,
  outcome: DispatchOutcome,
  attributed: readonly AttributedPath[] = [],
): string {
  const split = scopeSplit(record, outcome);
  const nothingChanged =
    outcome.changedPaths.length === 0
      ? '<p class="drawer-empty">This dispatch changed no files, so there is no diff to review.</p>'
      : '';
  return `${nothingChanged}${scopeSectionHtml(
    'in-scope',
    'In scope',
    split.inScope,
    'No changed file is covered by the declared ownership.',
  )}${scopeSectionHtml(
    'out-of-scope',
    'Out of scope',
    split.outOfScope,
    'No write outside the declared ownership was observed.',
  )}${scopeSectionHtml(
    'declared-unchanged',
    'Declared but unchanged',
    split.declaredUnchanged,
    'No path was declared, or every declared path changed.',
  )}${othersHtml(attributed)}`;
}

/** The outcome classification and each gate's verdict (Requirement 3.3). */
function outcomeHtml(closed: NonNullable<DispatchRecord['closed']>): string {
  const gates =
    closed.gateResults.length === 0
      ? '<p class="drawer-empty">No gate results were recorded for this dispatch.</p>'
      : `<ul class="drawer-gates">${closed.gateResults.map(gateHtml).join('')}</ul>`;
  return `<section class="drawer-section" data-section="outcome">
    <header class="drawer-section-head"><h3 class="drawer-section-title">Outcome</h3></header>
    <p class="drawer-outcome"><span class="cyv-badge ${outcomeBadgeClass(closed.outcome.kind)}">${esc(closed.outcome.kind)}</span>
      <span class="drawer-outcome-summary">${esc(closed.outcome.summary)}</span></p>
  </section>
  <section class="drawer-section" data-section="gates">
    <header class="drawer-section-head"><h3 class="drawer-section-title">Gates</h3>
      <span class="drawer-count">${closed.gateResults.length}</span></header>
    ${gates}
  </section>`;
}

function gateHtml(gate: GateResult): string {
  const badge = gate.passed
    ? '<span class="cyv-badge cyv-badge-passed">passed</span>'
    : '<span class="cyv-badge cyv-badge-failed">failed</span>';
  const detail =
    gate.detail === undefined ? '' : `<span class="drawer-gate-detail">${esc(gate.detail)}</span>`;
  // A failed gate was a count and nothing else, so a reader could see that a
  // dispatch had been refused and never what for. The count stays — it says
  // how much is not listed — and what it objected to is listed beneath it.
  const findings = gate.findings ?? [];
  const found =
    findings.length === 0
      ? ''
      : `<ul class="drawer-gate-findings">${findings
          .map(
            (finding) =>
              `<li><span class="drawer-gate-rule">${esc(finding.ruleId)}</span> ` +
              `<span class="drawer-gate-where">${esc(finding.path)}:${finding.line}:${finding.column}</span> ` +
              `<span class="drawer-gate-message">${esc(finding.message)}</span></li>`,
          )
          .join('')}</ul>`;
  return `<li class="drawer-gate"><code class="drawer-gate-name">${esc(gate.gate)}</code>${badge}${detail}${found}</li>`;
}

/**
 * The note under the scope split and outcome that tells a reader where the
 * line-level diff lives now. It no longer links away; the Diff tab starts
 * difit and frames it through the same-origin proxy.
 */
function diffNoteHtml(): string {
  return `<section class="drawer-section" data-section="diff">
    <header class="drawer-section-head"><h3 class="drawer-section-title">Line-level diff</h3></header>
    <p class="drawer-note">The Diff tab starts difit and shows the line-level diff here, framed
      through the same origin so the phone stylesheet and token stay in place. If difit is not
      available, the Diff tab falls back to the built-in file-by-file diff below.</p>
  </section>`;
}

/** The header a drawer shows in both states: what this dispatch is and when it ran. */
function headerHtml(record: DispatchRecord): string {
  const taskId = taskIdIn(record.declaration.task);
  const idLabel = taskId === undefined ? record.dispatchId : `${taskId} · ${record.dispatchId}`;
  const closed = record.closed;
  const times =
    closed === undefined
      ? `<span>opened <time datetime="${esc(record.openedAt)}">${esc(record.openedAt)}</time></span><span>still in motion</span>`
      : `<span>opened <time datetime="${esc(record.openedAt)}">${esc(record.openedAt)}</time></span>
         <span>closed <time datetime="${esc(closed.closedAt)}">${esc(closed.closedAt)}</time></span>`;
  return `<header class="drawer-head">
    <span class="drawer-id">${esc(idLabel)}</span>
    <span class="drawer-title">${esc(firstLine(record.declaration.task))}</span>
    <div class="drawer-meta"><span>lane ${esc(record.assignment.laneId)}</span>${times}</div>
  </header>`;
}

/**
 * Why an in-flight dispatch is not reviewable (Requirement 3.5): its working
 * tree is still moving, so a classification rendered now could describe a
 * state that no longer exists by the time it is read. The refusal says that
 * rather than showing empty sections that would read as "nothing happened".
 */
function refusalHtml(record: DispatchRecord): string {
  return `<div class="drawer-refused" role="status">
    <p><strong>Not reviewable yet.</strong> Dispatch ${esc(record.dispatchId)} is still in motion:
      it has no close entry, so the working tree it would be judged against is still changing and a
      diff offered now could anchor to lines that no longer exist. The scope split, outcome and
      line-level diff appear once the dispatch has closed and reached Review or Done.</p>
  </div>`;
}

/**
 * The drawer's inner content for one dispatch: the three-way scope split, the
 * outcome and the gates that produced it, and the difit hand-off — or, for a
 * dispatch that has not closed, a refusal naming why. Returns a fragment for
 * the `#board-drawer` container `renderBoard` leaves empty.
 */
/** One spec's whole change, which is what a pull request would carry. */
export interface SpecDrawerInput {
  specId: string;
  title: string;
  /** Every dispatch recorded against the spec, newest first. */
  dispatches: readonly {
    dispatchId: string;
    task: string;
    outcome: string;
    closedAt?: string;
    changedPaths: readonly string[];
  }[];
  /** Kept for backwards compatibility; the Diff tab starts difit itself. */
  diffHref?: string;
}

/**
 * The spec-level review surface. Reviewing one dispatch at a time asks a person
 * to sign off every individual change, which is an agent's job; what a person
 * wants to see before a pull request is everything the spec touched.
 */
export function renderSpecDrawer(input: SpecDrawerInput): string {
  const paths = new Set<string>();
  for (const dispatch of input.dispatches) {
    for (const path of dispatch.changedPaths) paths.add(path);
  }
  const files = [...paths].sort();

  const dispatchRows =
    input.dispatches.length === 0
      ? '<p class="drawer-empty">No dispatch has run against this spec yet, so it has changed nothing.</p>'
      : input.dispatches
          .map(
            (dispatch) => `<li class="board-diff-file font-mono-sm">
    <span class="truncate">${esc(dispatch.task)}</span>
    <span class="text-outline">${esc(dispatch.dispatchId)} · ${esc(dispatch.outcome)}</span>
  </li>`,
          )
          .join('');

  const fileRows =
    files.length === 0
      ? '<p class="drawer-empty">Nothing has changed on disk for this spec.</p>'
      : files.map((path) => `<li class="board-diff-file font-mono-sm">${esc(path)}</li>`).join('');

  return `<div class="drawer" data-spec="${esc(input.specId)}" data-reviewable="true">
  <div class="board-diff">
    <div class="board-diff-head">
      <div class="board-diff-titleline">
        <span class="font-label-md text-on-surface">${esc(input.title)}</span>
        <span class="font-mono-sm text-outline">${esc(input.specId)}</span>
      </div>
      <span class="font-mono-sm text-on-surface-variant">${input.dispatches.length} dispatch${
        input.dispatches.length === 1 ? '' : 'es'
      } · ${files.length} file${files.length === 1 ? '' : 's'} changed</span>
    </div>
    <div class="board-diff-body">
      <section class="board-diff-section" data-section="files">
        <header class="board-diff-section-head">
          <h4 class="font-label-xs text-on-surface uppercase tracking-wider">Files this spec changed</h4>
          <span class="font-mono-sm text-on-surface-variant">${files.length}</span>
        </header>
        <ul class="board-diff-files">${fileRows}</ul>
      </section>
      <section class="board-diff-section" data-section="dispatches">
        <header class="board-diff-section-head">
          <h4 class="font-label-xs text-on-surface uppercase tracking-wider">What ran</h4>
          <span class="font-mono-sm text-on-surface-variant">${input.dispatches.length}</span>
        </header>
        <ul class="board-diff-files">${dispatchRows}</ul>
      </section>
      ${diffNoteHtml()}
    </div>
  </div>
</div>`;
}

export function renderDiffDrawer(input: DiffDrawerInput): string {
  const record = input.record;
  const closed = record.closed;
  if (closed === undefined) {
    return `<div class="drawer" data-dispatch="${esc(record.dispatchId)}" data-reviewable="false">
  ${headerHtml(record)}${refusalHtml(record)}
</div>`;
  }

  return `<div class="drawer" data-dispatch="${esc(record.dispatchId)}" data-reviewable="true">
  ${headerHtml(record)}${scopeHtml(record, closed.outcome, input.writtenByOthers ?? [])}${outcomeHtml(closed)}${diffNoteHtml()}
</div>`;
}

/**
 * The drawer's own rules, token-referenced only. Kept as a separate export so
 * the route that serves drawer content can append them into the same
 * stylesheet `dashboardCss` emits rather than adding a second one
 * (Requirement 7.2).
 */
export function diffDrawerCss(): string {
  return `
/* Diff drawer content: scope split, outcome, gates, difit note (spec 0051 R3). */
.drawer{padding:1rem 1.25rem 1.5rem;display:flex;flex-direction:column;gap:1rem}
.drawer-head{display:flex;flex-direction:column;gap:.3rem;border-bottom:1px solid var(--cyv-surface-high);padding-bottom:.75rem}
.drawer-id{font-family:var(--cyv-font-mono);font-size:13px;font-weight:700;color:var(--cyv-primary)}
.drawer-title{font-size:14px;color:var(--cyv-on-surface)}
.drawer-meta{display:flex;flex-wrap:wrap;gap:.2rem .9rem;font-family:var(--cyv-font-mono);font-size:12px;color:var(--cyv-outline)}
.drawer-refused{border:1px solid var(--cyv-tertiary);border-radius:6px;background-color:var(--cyv-tertiary-bg);
  padding:.8rem 1rem;font-size:13px;color:var(--cyv-on-surface)}
.drawer-refused strong{color:var(--cyv-tertiary)}
.drawer-section{display:flex;flex-direction:column;gap:.45rem}
.drawer-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:.75rem}
.drawer-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--cyv-on-surface)}
.drawer-count{font-family:var(--cyv-font-mono);font-size:12px;color:var(--cyv-on-surface-variant)}
.drawer-paths{list-style:none;display:flex;flex-direction:column;gap:.25rem}
.drawer-path{font-family:var(--cyv-font-mono);font-size:12px;color:var(--cyv-on-surface-variant);
  background-color:var(--cyv-surface-low);border:1px solid var(--cyv-surface-high);border-radius:4px;
  padding:.3rem .55rem;overflow-wrap:anywhere}
.drawer-section[data-section=out-of-scope] .drawer-path{border-color:var(--cyv-error);color:var(--cyv-error)}
.drawer-empty{border:1px dashed var(--cyv-surface-highest);border-radius:4px;padding:.7rem .9rem;
  font-size:13px;color:var(--cyv-on-surface-variant)}
.drawer-outcome{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.drawer-outcome-summary{font-size:13px;color:var(--cyv-on-surface-variant)}
.drawer-gates{list-style:none;display:flex;flex-direction:column;gap:.35rem}
.drawer-gate{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-size:12px}
.drawer-gate-name{font-family:var(--cyv-font-mono);color:var(--cyv-on-surface)}
.drawer-gate-detail{color:var(--cyv-on-surface-variant)}
.drawer-gate-findings{list-style:none;margin:.35rem 0 0;padding:0 0 0 1rem;display:flex;flex-direction:column;gap:.2rem;font-size:.8rem}
.drawer-gate-findings li{overflow-wrap:anywhere}
.drawer-gate-rule{color:var(--cyv-error);font-weight:600}
.drawer-gate-where{color:var(--cyv-on-surface-variant)}
.drawer-note{font-size:13px;color:var(--cyv-on-surface-variant)}
.drawer-path-note{margin-left:.5rem;font-size:12px;color:var(--cyv-on-surface-variant)}
`;
}
