/**
 * The /lanes page: every lane the configuration declares, the live state the
 * dispatch log gives it, and the agents found on this machine that no lane
 * names.
 *
 * The page reads four sources and keeps them distinct on the page. The
 * configuration says what a lane may run — its cap, its billing, its per-kind
 * model ordering. The dispatch log, replayed by `dashboard/lanes.ts`, says
 * what is running and whether the lane is cooling. `PATH` says whether the
 * program behind the lane's agent exists at all, which is the difference
 * between "idle" and "can never run": a lane whose binary is missing is
 * marked unavailable, not free. Quota is the fourth source and the only one
 * the dashboard's own state file owns: whether a lane's subscription is
 * recorded exhausted, and when it resets. Spec 0051 Requirement 6.1 makes an
 * exhausted lane a needs-you condition; the detail — which lane, until when —
 * lives here.
 *
 * The page is read-only: it renders records and configuration and starts
 * nothing. Dispatching already has a route; this page is where a lane's state
 * is explained.
 */
import { configuredLanes } from '../config/lanes.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import type { DispatchRecord } from '../executor/dispatch.js';
import type {
  LaneCooldown,
  LaneExecutionMode,
  LaneModelOffering,
  ResolvedLaneDeclaration,
} from '../executor/lane.js';
import type { DispatchOutcomeKind } from '../executor/outcome.js';
import { inFlightOn } from '../executor/replay.js';
import type { DispatchLog } from '../executor/store.js';
import { TASK_KINDS } from '../executor/task-kind.js';
import { relativeTime } from './home.js';
import { buildLanesRegion } from './lanes.js';
import { esc } from './render.js';
import { topNavHtml, freshnessHtml, FRESHNESS_CLIENT } from './nav.js';
import type { QuotaEntry } from './state-store.js';
import { dashboardCss, lanesPageCss } from './styles.js';
import type { LaneRow, OrchestratorSelfReport, UnusedAgent } from './view-model.js';

/**
 * How many closed dispatches one lane section lists under "recent". The full
 * history stays in the log; the page shows enough to answer "what has this
 * lane been doing".
 */
export const RECENT_DISPATCHES_SHOWN = 6;

/**
 * Whether the program behind a lane's agent exists on this machine. A
 * `subagent` lane is run by the orchestrating session itself, so no program
 * is looked up for it and "is the binary installed" is not a question it asks.
 */
export type LaneAvailability =
  | { kind: 'found'; program: string; programPath: string }
  | { kind: 'missing-program'; program: string }
  | { kind: 'unknown-agent' }
  | { kind: 'subagent' };

/**
 * The badge a lane wears on the page. `unavailable` and `exhausted` lead
 * because both mean the lane cannot take work; `reserved` is a declared
 * choice, `cooling` is observed behaviour, and the remaining three describe
 * how much of the lane's own cap is in use.
 */
export type LanePageStatus =
  | 'unavailable'
  | 'exhausted'
  | 'reserved'
  | 'cooling'
  | 'capped'
  | 'running'
  | 'free';

/** A dispatch still open on the lane. */
export interface LaneInFlightView {
  dispatchId: string;
  /** The first non-empty line of the task the record declares. */
  task: string;
  model: string;
  openedAt: string;
}

/** A dispatch that has closed, with the outcome the log recorded for it. */
export interface LaneClosedView {
  dispatchId: string;
  task: string;
  model: string;
  closedAt: string;
  outcome: DispatchOutcomeKind;
  summary: string;
}

export interface LaneStats {
  ran: number;
  succeeded: number;
  failedGates: number;
  abandoned: number;
  medianTimeMs: number;
}

export interface LanePageRow {
  id: string;
  agentId: string;
  availability: LaneAvailability;
  status: LanePageStatus;
  orchestrator: boolean;
  acceptsDispatch: boolean;
  running: number;
  cap: number;
  inFlight: readonly LaneInFlightView[];
  /** `laneBillingLabel` output: the billing kind and the billed-overage flag together. */
  billing: string;
  models: readonly LaneModelOffering[];
  cooldown?: LaneCooldown;
  quota: QuotaEntry;
  stats: LaneStats;
  recent: readonly LaneClosedView[];
  /** The orchestrating lane's own report of itself, where one is recorded. */
  selfReport?: OrchestratorSelfReport;
}

export interface LanesPage {
  project: string;
  projectName: string;
  lanes: readonly LanePageRow[];
  /** Agents found on PATH that no lane declares. */
  undeclared: readonly UnusedAgent[];
  /** True when the configuration declares no lane at all. */
  none: boolean;
  now: number;
}

/** Everything the page needs, already read by the caller. */
export interface LanesPageSource {
  project: string;
  projectName: string;
  config: CheckYourVibeConfig;
  log: DispatchLog;
  /** Quota entries keyed by lane id, from the dashboard's own state store. */
  quotas: Readonly<Record<string, QuotaEntry>>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now?: number;
}

function availabilityOf(row: LaneRow, executes: LaneExecutionMode): LaneAvailability {
  if (executes === 'subagent') return { kind: 'subagent' };
  const program = row.programTried[0];
  if (row.programPath !== undefined && program !== undefined) {
    return { kind: 'found', program, programPath: row.programPath };
  }
  // An agent this build has no command line for leaves nothing to look up:
  // `programTried` is empty exactly when `agentCommandFor` found no entry.
  if (program === undefined) return { kind: 'unknown-agent' };
  return { kind: 'missing-program', program };
}

function laneStatus(
  availability: LaneAvailability,
  row: LaneRow,
  quota: QuotaEntry,
): LanePageStatus {
  if (availability.kind === 'missing-program' || availability.kind === 'unknown-agent') {
    return 'unavailable';
  }
  if (quota.exhausted) return 'exhausted';
  if (!row.acceptsDispatch) return 'reserved';
  if (row.cooldown !== undefined) return 'cooling';
  if (row.running >= row.cap) return 'capped';
  return row.running > 0 ? 'running' : 'free';
}

function firstLine(task: string): string {
  const line = task.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return line === undefined ? task : line.trim();
}

function recentOn(
  records: readonly DispatchRecord[],
  laneId: string,
): LaneClosedView[] {
  const views: LaneClosedView[] = [];
  for (const record of [...records].reverse()) {
    if (views.length >= RECENT_DISPATCHES_SHOWN) break;
    if (record.assignment.laneId !== laneId) continue;
    const closed = record.closed;
    if (closed === undefined) continue;
    views.push({
      dispatchId: record.dispatchId,
      task: firstLine(record.declaration.task),
      model: record.assignment.model,
      closedAt: closed.closedAt,
      outcome: closed.outcome.kind,
      summary: closed.outcome.summary,
    });
  }
  return views;
}

function calculateStats(records: readonly DispatchRecord[], laneId: string): LaneStats {
  let ran = 0, succeeded = 0, failedGates = 0, abandoned = 0;
  const times: number[] = [];
  for (const record of records) {
    if (record.assignment.laneId !== laneId) continue;
    ran++;
    if (record.closed !== undefined) {
      const outcome = record.closed.outcome.kind;
      if (outcome === 'succeeded') succeeded++;
      else if (outcome === 'gates-failed') failedGates++;
      else if (outcome === 'did-not-complete') abandoned++;
      
      const opened = Date.parse(record.openedAt);
      const closed = Date.parse(record.closed.closedAt);
      if (!Number.isNaN(opened) && !Number.isNaN(closed)) {
        times.push(closed - opened);
      }
    }
  }
  times.sort((a, b) => a - b);
  let medianTimeMs = 0;
  if (times.length > 0) {
    const mid = Math.floor(times.length / 2);
    if (times.length % 2 === 0) {
      medianTimeMs = ((times[mid - 1] ?? 0) + (times[mid] ?? 0)) / 2;
    } else {
      medianTimeMs = times[mid] ?? 0;
    }
  }
  return { ran, succeeded, failedGates, abandoned, medianTimeMs };
}

function lanePageRow(
  row: LaneRow,
  declared: ResolvedLaneDeclaration | undefined,
  source: LanesPageSource,
  byDispatch: ReadonlyMap<string, DispatchRecord>,
): LanePageRow {
  const quota = source.quotas[row.id] ?? { exhausted: false };
  const availability = availabilityOf(row, declared?.executes ?? 'cli');
  const inFlight = inFlightOn(source.log.records, row.id)
    .map((open) => byDispatch.get(open.dispatchId))
    .filter((record): record is DispatchRecord => record !== undefined)
    .map((record) => ({
      dispatchId: record.dispatchId,
      task: firstLine(record.declaration.task),
      model: record.assignment.model,
      openedAt: record.openedAt,
    }));
  return {
    id: row.id,
    agentId: row.agentId,
    availability,
    status: laneStatus(availability, row, quota),
    orchestrator: row.orchestrator,
    acceptsDispatch: row.acceptsDispatch,
    running: row.running,
    cap: row.cap,
    inFlight,
    billing: row.billing,
    models: row.models,
    ...(row.cooldown === undefined ? {} : { cooldown: row.cooldown }),
    quota,
    stats: calculateStats(source.log.records, row.id),
    recent: recentOn(source.log.records, row.id),
    ...(row.selfReport === undefined ? {} : { selfReport: row.selfReport }),
  };
}

export async function buildLanesPage(source: LanesPageSource): Promise<LanesPage> {
  const region = await buildLanesRegion({
    config: source.config,
    log: source.log,
    env: source.env,
    cwd: source.cwd,
  });
  const resolved = new Map(
    configuredLanes(source.config).map((lane) => [lane.id, lane]),
  );
  const byDispatch = new Map(
    source.log.records.map((record) => [record.dispatchId, record]),
  );
  return {
    project: source.project,
    projectName: source.projectName,
    lanes: region.lanes.map((row) => lanePageRow(row, resolved.get(row.id), source, byDispatch)),
    undeclared: region.unused,
    none: region.none,
    now: source.now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<LanePageStatus, string> = {
  unavailable: 'unavailable',
  exhausted: 'exhausted',
  reserved: 'reserved',
  // Every other surface calls a lane in cooldown "out of quota"; this page
  // saying "cooling" gave one state two names, and a reader deciding whether
  // the lane can take work had to translate between them.
  cooling: 'out of quota',
  capped: 'at cap',
  running: 'running',
  free: 'free',
};

/** Coarse time-until, the counterpart of `relativeTime` for a reset that lies ahead. */
function untilTime(at: string, now: number): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return 'at an unreadable time';
  const seconds = Math.round((then - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function availabilityHtml(row: LanePageRow): string {
  const availability = row.availability;
  switch (availability.kind) {
    case 'found':
      return (
        `<p class="ln-line">agent <span class="ln-mono">${esc(row.agentId)}</span> — ` +
        `program <span class="ln-mono">${esc(availability.program)}</span> found at ` +
        `<span class="ln-mono">${esc(availability.programPath)}</span></p>`
      );
    case 'missing-program':
      return (
        `<p class="ln-line ln-bad">agent <span class="ln-mono">${esc(row.agentId)}</span> — ` +
        `program <span class="ln-mono">${esc(availability.program)}</span> is not on ` +
        'PATH, so this lane can never run. Install it and authenticate it, or remove the lane.</p>'
      );
    case 'unknown-agent':
      return (
        `<p class="ln-line ln-bad">agent <span class="ln-mono">${esc(row.agentId)}</span> is ` +
        'not one this build can invoke — no command line is known for it, so this lane ' +
        'can never run.</p>'
      );
    case 'subagent':
      return (
        `<p class="ln-line">agent <span class="ln-mono">${esc(row.agentId)}</span> — runs as ` +
        'a sub-agent of the orchestrating session; no program is looked up on PATH.</p>'
      );
  }
}

function runningHtml(row: LanePageRow, now: number): string {
  const atCap = row.running >= row.cap && row.cap > 0;
  const note = atCap
    ? '<p class="ln-note">At its declared cap — a self-imposed number, not a reading of the account.</p>'
    : '';
  const detail =
    row.inFlight.length === 0
      ? '<p class="ln-line ln-mut">nothing in flight</p>'
      : `<ul class="ln-dispatches">${row.inFlight
          .map(
            (d) => `<li class="ln-dispatch">
          <span class="ln-dtask"><span class="ln-mono">${esc(d.dispatchId)}</span> ${esc(d.task)}</span>
          <span class="ln-dmeta">model ${esc(d.model)} · elapsed ${esc(relativeTime(d.openedAt, now))}</span>
          <form method="post" action="/api/stop" data-action="stop" data-dispatch="${esc(d.dispatchId)}"><button type="submit">Stop</button></form>
        </li>`,
          )
          .join('')}</ul>`;
  return `<div class="ln-block"><h3>Running — ${row.running} of ${row.cap}</h3>${detail}${note}</div>`;
}

function modelsHtml(row: LanePageRow): string {
  const kinds = TASK_KINDS.map((kind) => {
    const offering = row.models.find((entry) => entry.kind === kind);
    if (offering === undefined || offering.ordering.length === 0) {
      return (
        `<div class="ln-kind"><span class="ln-kind-name">${esc(kind)}</span>` +
        `<p class="ln-line ln-mut">no model declared — a ${esc(kind)} dispatch is refused here</p></div>`
      );
    }
    const items = offering.ordering
      .map((model, index) => {
        const first = index === offering.ordering.length - 1;
        return `<span class="ln-mono${first ? ' ln-start' : ''}">${esc(model)}</span>` +
               `${first ? '<span class="ln-mut"> — starts here</span>' : ''}`;
      })
      .join('<span class="ln-mut"> → </span>');
    return `<div class="ln-kind"><span class="ln-kind-name">${esc(kind)}</span><p class="ln-line">${items}</p></div>`;
  });
  return (
    `<div class="ln-block"><h3>Model orderings</h3>${kinds.join('')}` +
    '<p class="ln-note">Each ordering runs strongest to weakest; a dispatch starts at the ' +
    'weakest — the last entry — and a gate failure escalates one step up.</p></div>'
  );
}

function cooldownHtml(row: LanePageRow, now: number): string {
  const cooldown = row.cooldown;
  if (cooldown === undefined) return '';
  return (
    `<div class="ln-block"><h3>Cooldown</h3>` +
    `<p class="ln-line">In cooldown since <time datetime="${esc(cooldown.since)}">` +
    `${esc(cooldown.since)}</time> (${esc(relativeTime(cooldown.since, now))}), after ` +
    `<span class="ln-mono">${esc(cooldown.dispatchId)}</span> closed ${esc(cooldown.reason)}.</p>` +
    '<p class="ln-note">Cooldown has no set end: it clears on the next observed-effect ' +
    'success on this lane, and a dispatch that names the lane is sent to it so that ' +
    'success can happen.</p></div>'
  );
}

function quotaHtml(row: LanePageRow, now: number): string {
  if (!row.quota.exhausted) {
    return '';
  }
  const reset =
    row.quota.resetsAt === undefined
      ? 'no reset time was recorded'
      : `resets <time datetime="${esc(row.quota.resetsAt)}">${esc(row.quota.resetsAt)}</time> ` +
        `(${esc(untilTime(row.quota.resetsAt, now))})`;
  return (
    `<div class="ln-block"><h3>Quota</h3>` +
    `<p class="ln-line ln-bad">Subscription exhausted — ${reset}. ` +
    'The lane takes no new work until it clears.</p></div>'
  );
}

function selfReportHtml(row: LanePageRow, now: number): string {
  if (!row.orchestrator) return '';
  const report = row.selfReport;
  let text: string;
  if (report === undefined) {
    text = 'self-reported: unknown — the session has written no report';
  } else {
    const extra = [report.reason, report.model].filter(
      (part): part is string => part !== undefined,
    );
    const tail = extra.length === 0 ? '' : ` · ${extra.join(' · ')}`;
    text = `self-reported ${report.state} ${relativeTime(report.at, now)}${tail}`;
  }
  return `<p class="ln-line ln-mut">${esc(text)}</p>`;
}

function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ''}`;
}

function statsHtml(row: LanePageRow): string {
  const s = row.stats;
  if (s.ran === 0) return '';
  const highFailure = s.failedGates > 0 && (s.failedGates / s.ran >= 0.5);
  return `<div class="ln-block"><h3>History</h3><p class="ln-line${highFailure ? ' ln-bad' : ''}">` +
         `Ran ${s.ran} — ${s.succeeded} succeeded, ${s.failedGates} failed gates, ${s.abandoned} abandoned. ` +
         `Median time: ${formatDuration(s.medianTimeMs)}.</p></div>`;
}

function recentHtml(row: LanePageRow, now: number): string {
  const body =
    row.recent.length === 0
      ? '<p class="ln-line ln-mut">No dispatch on this lane has closed yet.</p>'
      : `<ul class="ln-dispatches">${row.recent
          .map(
            (d) => `<li class="ln-dispatch">
          <span class="ln-dtask"><span class="ln-mono">${esc(d.dispatchId)}</span> ` +
              `<span class="ln-outcome ln-o-${esc(d.outcome)}">${esc(d.outcome)}</span> ${esc(d.task)}</span>
          <span class="ln-dmeta">model ${esc(d.model)} · closed ${esc(relativeTime(d.closedAt, now))} — ${esc(d.summary)}</span>
        </li>`,
          )
          .join('')}</ul>`;
  return `<div class="ln-block"><h3>Recent dispatches</h3>${body}</div>`;
}

function laneSectionHtml(row: LanePageRow, now: number): string {
  const tag = row.orchestrator ? '<span class="ln-tag">orchestrator</span>' : '';
  const reserved = row.acceptsDispatch
    ? ''
    : '<p class="ln-line ln-mut">does not accept dispatched work — this lane\'s capacity ' +
      'is held for orchestration, and nothing is scheduled to it</p>';
  return `<section class="ln-lane" data-status="${row.status}" data-lane="${esc(row.id)}">
  <header class="ln-head"><span class="ln-id">${esc(row.id)}</span><span class="ln-badge ln-st-${row.status}">${esc(STATUS_TEXT[row.status])}</span>${tag}</header>
  ${runningHtml(row, now)}
  ${availabilityHtml(row)}
  ${reserved}
  <p class="ln-line"><span class="ln-mut">billing</span> ${esc(row.billing)}</p>
  ${modelsHtml(row)}
  ${cooldownHtml(row, now)}
  ${quotaHtml(row, now)}
  ${selfReportHtml(row, now)}
  ${statsHtml(row)}
  ${recentHtml(row, now)}
</section>`;
}

function undeclaredHtml(page: LanesPage): string {
  if (page.undeclared.length === 0) return '';
  const items = page.undeclared
    .map(
      (agent) => `<li class="ln-dispatch">
      <span class="ln-dtask"><span class="ln-mono">${esc(agent.agentId)}</span> — program ` +
        `<span class="ln-mono">${esc(agent.program)}</span></span>
      <span class="ln-dmeta">found at <span class="ln-mono">${esc(agent.programPath)}</span></span>
    </li>`,
    )
    .join('');
  return `<section class="ln-lane ln-undeclared">
  <h2 class="ln-h2">Discovered in PATH</h2>
  <p class="ln-note">Agents found on this machine that no lane declares — installed, and nothing uses them.</p>
  <ul class="ln-dispatches">${items}</ul>
</section>`;
}

export function renderLanesPage(page: LanesPage): string {
  const href = (path: string): string =>
    `${path}?${new URLSearchParams({ p: page.project }).toString()}`;
  const topNav = topNavHtml(page.projectName, page.project, '/lanes');
  const lanes = page.none
    ? '<p class="ln-empty">No lane is declared. Add <code>executor.lanes</code> to ' +
      'checkyourvibe.json — a lane names an agent, a cap, a billing kind, and a model ' +
      'ordering per task kind.</p>'
    : page.lanes.map((row) => laneSectionHtml(row, page.now)).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(page.projectName)} · Lanes</title>
<style>${dashboardCss()}${lanesPageCss()}</style>
</head>
<body class="ln-body" data-project="${esc(page.project)}">
${topNav}
<main class="ln-main">
<p class="ln-lede">Every lane the configuration declares, what it is running against its own
cap, and the agents found on this machine that no lane names. Read from the configuration,
the dispatch log, the dashboard's quota state, and PATH — nothing here starts work.</p>
${lanes}
${undeclaredHtml(page)}
${freshnessHtml(page.now)}
<footer class="ln-foot">Reads checkyourvibe.json, .cyv-review/ and PATH. Starts nothing.</footer>
</main>
<script>${FRESHNESS_CLIENT}</script>
</body>
</html>`;
}
