/**
 * The Glance page — the dashboard's landing view, served at `/`.
 *
 * The board at `/board` is the working surface: three dense columns of detail.
 * This page exists because a landing page has a different job — someone
 * arriving on their phone needs to know, in seconds, whether anything wants
 * them, what is running, and whether the system itself is healthy. Each tile
 * answers one question in words and links to the page where the answer becomes
 * an action, following `glance-status-hub.html` (normative per spec 0051).
 *
 * Liveness is the board's own mechanism, not a second one: the page embeds
 * `boardClientScript()`, whose stream drives the same `#board-live-badge`
 * markup, and the small script below only mirrors the badge's rendered state
 * into each tile's stale line — it opens no connection and runs no timer.
 *
 * Everything is read from the dispatch log, the comment store, the lane
 * declarations, the spec files, dashboard state, and git. Facts the board
 * already derives come from `buildBoardModel`; nothing here keeps its own
 * copy of a number another module owns.
 */
import { basename } from 'node:path';

import { esc } from './render.js';
import { topNavHtml as sharedNavHtml } from './nav.js';
import { relativeTime } from './home.js';
import { buildBoardModel, type BoardModel, type BoardCard } from './board-model.js';
import { boardClientScript } from './board-client.js';
import { dashboardCss, glancePageCss } from './styles.js';
import { taskIdIn } from './motion.js';
import { specDisplayName, type SpecRollup } from './review/specs.js';
import type { CommentStore } from './review/comments.js';
import type { QuotaEntry } from './state-store.js';
import type { LatestRun } from './latest.js';
import type { DispatchLog } from '../executor/store.js';
import type { OrchestratorReported } from '../executor/dispatch.js';
import type { SessionView } from './session-manager.js';
import type { GateHealth } from './gate-health.js';
import { needsHumanAttention, type DispatchOutcomeKind } from '../executor/outcome.js';
import type { ResolvedLaneDeclaration } from '../executor/lane.js';
import type { UncommittedWork } from './view-model.js';

/** Everything the page needs, read by the caller so this module reads nothing. */
export interface GlancePageInput {
  /** The project root, carried as `?p=` on every link. */
  project: string;
  projectName: string;
  /** Every registered project root; the switcher is rendered only when there is a choice. */
  projects: readonly string[];
  log: DispatchLog;
  comments: CommentStore;
  /** The configured lanes, with `acceptsDispatch` resolved by `configuredLanes`. */
  lanes: readonly ResolvedLaneDeclaration[];
  /** Per-lane quota state from the dashboard store. */
  quotas: Readonly<Record<string, QuotaEntry>>;
  specs: SpecRollup;
  /** Uncommitted work read from git by `uncommittedWork`. */
  tree: UncommittedWork;
  /** The last recorded cyv check, or null when none is on record. */
  latest: LatestRun | null;
  /** Epoch milliseconds the page is built at; every age is computed against it. */
  now?: number;
  /** Sessions observed through the runtime's hooks; see `GlancePage.sessions`. */
  sessions?: readonly SessionView[];
  /** See `GlancePage.gate`. */
  gate?: GateHealth;
  /** A pre-built board model, to avoid building it twice in a test. */
  model?: BoardModel;
}

/** One item a person has to look at, named so the tile can say what it is. */
export interface GlanceNamedItem {
  label: string;
  detail: string;
}

export interface GlanceNeedsYou {
  count: number;
  /** The newest item, present only while something needs a person. */
  top?: GlanceNamedItem;
}

export interface GlanceRunning {
  count: number;
  /** The dispatches in flight, named by task rather than dispatch id. */
  items: readonly GlanceNamedItem[];
  /** How many in-flight dispatches the named items do not cover. */
  more: number;
  /**
   * Of `count`, how many are actually running. The rest have finished and are
   * waiting to be reviewed: they share the In Progress column, because the work
   * is not done until a person has looked at it, but "in flight" said they were
   * still executing.
   */
  executing: number;
}

export interface GlanceLaneExhausted {
  laneId: string;
  resetsAt?: string;
}

export interface GlanceLaneCooling {
  laneId: string;
  /** The board's reset-at record; absent when the alert carried none. */
  since?: string;
}

export interface GlanceLanes {
  total: number;
  /** Dispatchable, not in cooldown, below cap — the board's idle set. */
  free: number;
  /** Dispatchable lanes running their declared cap. */
  atCap: number;
  /** Dispatchable lanes in cooldown after a rate-exhaustion outcome. */
  cooling: readonly GlanceLaneCooling[];
  /** Declared lanes whose recorded subscription quota is exhausted. */
  exhausted: readonly GlanceLaneExhausted[];
}

export interface GlanceTree {
  clean: boolean;
  count: number;
  added: number;
  removed: number;
  /** Changed files git named, newest touched first. */
  named: readonly string[];
}

export interface GlanceSpecUndispatched {
  id: string;
  /** Open tasks in this spec no dispatch has ever named. */
  count: number;
}

export interface GlanceSpecs {
  /** Specs holding at least one open task that was never dispatched. */
  undispatched: readonly GlanceSpecUndispatched[];
  /** Whether any spec declares tasks at all, so the zero state names the right nothing. */
  anySpecs: boolean;
}

export interface GlanceJudgmentItem {
  id: string;
  outcome: DispatchOutcomeKind;
  summary: string;
}

export interface GlanceJudgment {
  count: number;
  items: readonly GlanceJudgmentItem[];
}

export interface GlancePage {
  project: string;
  projectName: string;
  projects: readonly { root: string; name: string }[];
  /** Epoch milliseconds the page was built at; the live badge counts from it. */
  now: number;
  /** Whether the board measured a stall: open work, a free lane, nothing opened. */
  stalled: boolean;
  /** How long the stall has run, in the board's own words, when it reported one. */
  stalledFor?: string;
  /** The orchestrator's most recent self-report, when the log holds one. */
  orchestrator?: OrchestratorReported;
  /**
   * Sessions the runtime's hooks have been observed firing for. A hook is run
   * by the runtime and cannot be forgotten, so this outranks the self-report
   * below it, which is only written when a model remembers to write it.
   */
  sessions?: readonly SessionView[];
  /** Whether the gate has been judging the edits it saw; see `gate-health.ts`. */
  gate?: GateHealth;
  latest: LatestRun | null;
  needsYou: GlanceNeedsYou;
  running: GlanceRunning;
  lanes: GlanceLanes;
  tree: GlanceTree;
  specs: GlanceSpecs;
  judgment: GlanceJudgment;
}

/** How many running dispatches the tile names before summarising the rest. */
const RUNNING_SHOWN = 3;
/** How many judgment items the tile names before summarising the rest. */
const JUDGMENT_SHOWN = 3;
/** How many specs the tile names before summarising the rest. */
const SPECS_SHOWN = 4;

/**
 * `needsHumanAttention` reads only the outcome's kind, so a kind from the
 * board's needs-you set is checked through it rather than a copy of its list.
 */
function needsDecision(kind: DispatchOutcomeKind): boolean {
  return needsHumanAttention({
    kind,
    summary: '',
    changedPaths: [],
    outOfScopePaths: [],
    failedGates: [],
  });
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function needsYouDetail(card: BoardCard, now: number): string {
  const parts = [card.summary ?? card.description];
  if (card.outcome !== undefined) parts.push(card.outcome);
  parts.push(relativeTime(card.timestamp, now));
  if (card.openNotes > 0) parts.push(plural(card.openNotes, 'open note'));
  return parts.join(' · ');
}

/**
 * The task ids any dispatch names. "Never dispatched" means the log has no
 * record naming the task at all — a failed dispatch was still dispatched.
 */
function dispatchedTaskIds(log: DispatchLog): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const record of log.records) {
    const id = taskIdIn(record.declaration.task);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

function undispatchedSpecs(specs: SpecRollup, dispatched: ReadonlySet<string>): GlanceSpecUndispatched[] {
  const found: GlanceSpecUndispatched[] = [];
  for (const spec of specs.specs) {
    // A spec without a tasks.md declares nothing this page can count.
    if (spec.tasksPath === null) continue;
    const never = spec.sections
      .flatMap((section) => section.tasks)
      .filter((task) => !task.done && !dispatched.has(task.id)).length;
    if (never > 0) found.push({ id: spec.id, count: never });
  }
  return found;
}

export function buildGlancePage(input: GlancePageInput): GlancePage {
  const now = input.now ?? Date.now();
  const model = input.model ?? buildBoardModel({
    log: input.log,
    comments: input.comments,
    lanes: input.lanes,
    now,
  });

  const first = model.needsYou.at(0);
  let top: GlanceNamedItem | undefined;
  if (first !== undefined) {
    top =
      first.kind === 'lane'
        ? {
            label: `lane ${first.laneId}`,
            detail:
              first.resetAt === undefined
                ? 'in cooldown'
                : `in cooldown since ${relativeTime(first.resetAt, now)}`,
          }
        : {
            label: first.taskId ?? first.dispatchId,
            detail: needsYouDetail(first, now),
          };
  }

  const inFlightByLane = new Map<string, number>();
  for (const card of model.inMotion) {
    if (card.outcome === undefined) {
      inFlightByLane.set(card.laneId, (inFlightByLane.get(card.laneId) ?? 0) + 1);
    }
  }
  const atCap = input.lanes.filter(
    (lane) => lane.acceptsDispatch && (inFlightByLane.get(lane.id) ?? 0) >= lane.concurrencyCap,
  ).length;

  const exhausted: GlanceLaneExhausted[] = [];
  for (const lane of input.lanes) {
    const quota = input.quotas[lane.id];
    if (quota === undefined || !quota.exhausted) continue;
    exhausted.push({
      laneId: lane.id,
      ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }),
    });
  }

  const cooling: GlanceLaneCooling[] = [];
  const judgmentItems: GlanceJudgmentItem[] = [];
  for (const item of model.needsYou) {
    if (item.kind === 'lane') {
      cooling.push({
        laneId: item.laneId,
        ...(item.resetAt === undefined ? {} : { since: item.resetAt }),
      });
      continue;
    }
    if (item.outcome === undefined || !needsDecision(item.outcome)) continue;
    judgmentItems.push({
      id: item.taskId ?? item.dispatchId,
      outcome: item.outcome,
      summary: item.summary ?? item.description,
    });
  }

  const undispatched = undispatchedSpecs(input.specs, dispatchedTaskIds(input.log));

  const status = model.status;
  const stalled = status?.stalled ?? false;
  return {
    project: input.project,
    projectName: input.projectName,
    projects: input.projects.map((root) => ({ root, name: basename(root) })),
    now,
    stalled,
    ...(status?.stalledFor === undefined ? {} : { stalledFor: status.stalledFor }),
    ...(model.orchestrator === undefined ? {} : { orchestrator: model.orchestrator }),
    ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
    ...(input.gate === undefined ? {} : { gate: input.gate }),
    latest: input.latest,
    needsYou: {
      count: model.needsYou.length,
      ...(top === undefined ? {} : { top }),
    },
    running: {
      count: model.inMotion.length,
      executing: model.inMotion.filter((card) => card.outcome === undefined).length,
      items: model.inMotion.slice(0, RUNNING_SHOWN).map((card) => ({
        label: card.taskId ?? card.description,
        detail: [card.taskId === undefined ? '' : card.description, card.laneId, relativeTime(card.timestamp, now)]
          .filter((part) => part !== '')
          .join(' · '),
      })),
      more: Math.max(0, model.inMotion.length - RUNNING_SHOWN),
    },
    lanes: {
      total: status?.totalLanes ?? input.lanes.length,
      free: status?.idle ?? 0,
      atCap,
      cooling,
      exhausted,
    },
    tree: {
      clean: input.tree.count === 0,
      count: input.tree.count,
      added: input.tree.added,
      removed: input.tree.removed,
      named: input.tree.named.map((file) => file.name),
    },
    specs: {
      undispatched,
      anySpecs: input.specs.total > 0,
    },
    judgment: {
      count: judgmentItems.length,
      items: judgmentItems.slice(0, JUDGMENT_SHOWN),
    },
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function pageHref(project: string, path: string, fragment = ''): string {
  return `${path}?${new URLSearchParams({ p: project }).toString()}${fragment}`;
}

/** A reset time is a point in the future; `relativeTime` would clamp it to "just now". */
function untilTime(at: string, now: number): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return 'at an unreadable time';
  const seconds = Math.max(0, Math.round((then - now) / 1000));
  if (seconds < 90) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * The connection indicator, byte-identical to the board's so the shared client
 * script drives it without a second mechanism. The rendered state is
 * deliberately pessimistic: a page that never runs its script must not claim
 * to be live.
 */
function liveBadgeHtml(now: number): string {
  return `<span class="board-live-badge gl-live font-mono-sm text-on-surface-variant" id="board-live-badge" role="status" data-live="connecting">
      <span class="board-dot board-live-dot bg-outline"></span>
      <span class="board-live-label">not connected yet</span>
      <span class="board-live-age" data-epoch="${now}">showing the page as it loaded</span>
    </span>`;
}

function checkChipHtml(page: GlancePage): string {
  const href = esc(pageHref(page.project, '/rules'));
  const latest = page.latest;
  if (latest === null) {
    return `<a class="gl-chip" href="${href}">no check recorded</a>`;
  }
  if (latest.status === 'running') {
    return `<a class="gl-chip" href="${href}">check running · started ${esc(
      relativeTime(latest.startedAt, page.now),
    )}</a>`;
  }
  const clean = latest.violationCount === 0;
  const verdict = clean ? 'clean' : plural(latest.violationCount, 'finding');
  return `<a class="gl-chip ${clean ? 'gl-chip-ok' : 'gl-chip-warn'}" href="${href}">${esc(
    verdict,
  )} · ${esc(relativeTime(latest.finishedAt, page.now))}</a>`;
}

/**
 * Said when the gate allowed an edit it could not judge. The gate fails open by
 * design and records the reason; the landing page is where a person looks first
 * to learn that enforcement has stopped enforcing.
 */
function gateHtml(page: GlancePage): string {
  const gate = page.gate;
  if (gate === undefined || gate.unjudged === 0) return '';
  const n = gate.unjudged;
  const reason = gate.latestReason === undefined ? '' : ` Last reason: ${gate.latestReason}`;
  return `<p class="gl-vibe gl-vibe-stalled">Gate could not check ${n} edit${
    n === 1 ? '' : 's'
  } and allowed ${n === 1 ? 'it' : 'them'}.${esc(reason)}</p>`;
}

function orchestratorHtml(page: GlancePage): string {
  // Measurement first. A session observed through its hooks is a fact the
  // runtime produced; everything below this is a claim someone wrote down.
  const measured = (page.sessions ?? []).filter(
    (session) => session.alive && session.statusSource === 'hook',
  );

  if (page.stalled) {
    const since =
      page.stalledFor === undefined || page.stalledFor === 'ever'
        ? 'nothing has ever been dispatched'
        : `nothing dispatched for ${page.stalledFor}`;
    // Stalled with a session live and stalled with nobody home are different
    // problems: one orchestrator is running and not dispatching, the other is
    // gone. The board draws the same distinction.
    const who =
      measured.length > 0
        ? `${measured.length} session${measured.length === 1 ? ' is' : 's are'} live but not dispatching`
        : 'no session is live';
    return `<p class="gl-vibe gl-vibe-stalled">Orchestrator stalled — ${esc(
      since,
    )} while open work and a free lane exist; ${esc(who)}.</p>`;
  }

  if (measured.length > 0) {
    const newest = measured
      .map((session) => session.startedAt)
      .sort()
      .at(-1);
    const since = newest === undefined ? '' : ` — the newest started ${relativeTime(newest, page.now)}`;
    const count = measured.length === 1 ? 'session' : 'sessions';
    return `<p class="gl-vibe">Orchestrator live: ${measured.length} ${count} seen firing hooks${esc(
      since,
    )}.</p>`;
  }

  // A self-report is written by a session about itself. Sessions run for hours,
  // not days, so beyond this a report describes something that no longer exists.
  const SELF_REPORT_EXPIRY_MS = 2 * 60 * 60 * 1000;
  const report = page.orchestrator;
  if (report !== undefined) {
    const reason = report.reason === undefined ? '' : ` — ${report.reason}`;
    const age = page.now - Date.parse(report.reportedAt);
    // A self-report describes the session that wrote it. Sessions do not last
    // days, so an old report is evidence about a session that is gone, not
    // about the orchestrator now. Spec 0036 already says a missing report means
    // unknown rather than healthy; an expired one means the same thing, and
    // rendering it as a current state is how a dashboard lies while being
    // technically accurate.
    if (Number.isFinite(age) && age > SELF_REPORT_EXPIRY_MS) {
      return `<p class="gl-vibe gl-vibe-mut">Orchestrator: unknown — the last self-report said ${esc(
        report.state,
      )} ${esc(relativeTime(report.reportedAt, page.now))}, too old to describe the session running now.</p>`;
    }
    return `<p class="gl-vibe">Orchestrator self-reported ${esc(report.state)} ${esc(
      relativeTime(report.reportedAt, page.now),
    )}${esc(reason)}.</p>`;
  }
  return '<p class="gl-vibe gl-vibe-mut">Orchestrator: no stall measured, no self-report recorded.</p>';
}

interface TileSpec {
  /** The id the tile carries, so a test or a link can name it. */
  id: string;
  name: string;
  /** The number the tile leads with. */
  num: string;
  /** The worded answer, already escaped where it names data. */
  say: string;
  /** Named items under the answer, already escaped; '' when there are none. */
  more: string;
  href: string;
  /** Where the link takes the reader, stated as the action they would take. */
  act: string;
  /** Whether the tile is reporting something that wants a person. */
  attention: boolean;
}

function tileHtml(tile: TileSpec): string {
  const more = tile.more === '' ? '' : `<span class="gl-more">${tile.more}</span>`;
  return `<a class="gl-tile${tile.attention ? ' gl-tile-attn' : ''}" id="${esc(tile.id)}" href="${esc(
    tile.href,
  )}">
  <span class="gl-tile-head"><span class="gl-name">${esc(tile.name)}</span><span class="gl-num">${esc(
    tile.num,
  )}</span></span>
  <span class="gl-say">${tile.say}</span>
  ${more}
  <span class="gl-stale">stale — showing the page as it loaded</span>
  <span class="gl-act">${esc(tile.act)} →</span>
</a>`;
}

function namedLines(items: readonly { label: string; detail: string }[]): string {
  return items
    .map((item) => `<span class="gl-item"><span class="mono">${esc(item.label)}</span> — ${esc(item.detail)}</span>`)
    .join('');
}

function needsYouTile(page: GlancePage): TileSpec {
  const { count, top } = page.needsYou;
  const say =
    count === 0
      ? 'Nothing needs you right now.'
      : esc(`${count === 1 ? '1 item wants' : `${count} items want`} a person — most recent:`);
  const more =
    top === undefined
      ? ''
      : `<span class="gl-item"><span class="mono">${esc(top.label)}</span> — ${esc(
          top.detail,
        )}</span>`;
  return {
    id: 'gl-needs',
    name: 'Needs you',
    num: String(count),
    say,
    more,
    href: pageHref(page.project, '/board', '#board-right-body'),
    act: 'Answer on the workbench',
    attention: count > 0,
  };
}

/**
 * What the count is made of. A dispatch that has finished and is waiting for a
 * person shares the In Progress column with one that is still executing, and
 * calling both "in flight" said the finished one was still running.
 */
function runningSay(count: number, executing: number): string {
  if (count === 0) return 'Nothing is in motion.';
  const waiting = count - executing;
  if (waiting <= 0) return `${plural(count, 'dispatch', 'dispatches')} in flight`;
  if (executing === 0) return `${plural(waiting, 'dispatch', 'dispatches')} waiting for your review`;
  return `${executing} in flight · ${waiting} waiting for your review`;
}

function runningTile(page: GlancePage): TileSpec {
  const { count, items, more } = page.running;
  const rest = more > 0 ? `<span class="gl-item">and ${more} more</span>` : '';
  return {
    id: 'gl-running',
    name: 'Running',
    num: String(count),
    say: esc(runningSay(count, page.running.executing)),
    more: namedLines(items) + rest,
    href: pageHref(page.project, '/board', '#board-center-body'),
    act: 'Watch it on the workbench',
    attention: false,
  };
}

function lanesTile(page: GlancePage): TileSpec {
  const { total, free, atCap, cooling, exhausted } = page.lanes;
  if (total === 0) {
    return {
      id: 'gl-lanes',
      name: 'Lanes',
      num: '0',
      say: 'No lane is declared in the configuration.',
      more: '',
      href: pageHref(page.project, '/lanes'),
      act: 'Open the lanes page',
      attention: false,
    };
  }
  const counts = [`${free} of ${total} free`];
  if (atCap > 0) counts.push(`${plural(atCap, 'lane')} at capacity`);
  const blocks: string[] = [];
  for (const lane of cooling) {
    const since =
      lane.since === undefined ? 'in cooldown' : `in cooldown since ${relativeTime(lane.since, page.now)}`;
    blocks.push(
      `<span class="gl-item"><span class="mono">${esc(lane.laneId)}</span> — ${esc(since)}</span>`,
    );
  }
  for (const lane of exhausted) {
    const reset =
      lane.resetsAt === undefined
        ? 'no reset time recorded'
        : `resets ${esc(untilTime(lane.resetsAt, page.now))} (${esc(lane.resetsAt)})`;
    blocks.push(
      `<span class="gl-item gl-item-bad"><span class="mono">${esc(
        lane.laneId,
      )}</span> — subscription exhausted, ${reset}. Work on this lane silently stops until then.</span>`,
    );
  }
  if (blocks.length === 0) {
    blocks.push('<span class="gl-item">No lanes are blocked.</span>');
  }
  return {
    id: 'gl-lanes',
    name: 'Lanes',
    num: `${free}/${total}`,
    say: esc(counts.join(' · ')),
    more: blocks.join(''),
    href: pageHref(page.project, '/lanes'),
    act: 'Open the lanes page',
    attention: exhausted.length > 0 || cooling.length > 0,
  };
}

function treeTile(page: GlancePage): TileSpec {
  const { clean, count, added, removed, named } = page.tree;
  let say = 'The working tree is clean — every change is committed.';
  if (!clean) {
    const diff = added + removed > 0 ? ` — +${added} −${removed}` : '';
    say = esc(`${plural(count, 'uncommitted file')}${diff}`);
  }
  const more = named
    .map((name) => `<span class="gl-item mono">${esc(name)}</span>`)
    .join('');
  return {
    id: 'gl-tree',
    name: 'Working tree',
    num: clean ? '0' : String(count),
    say,
    more,
    href: pageHref(page.project, '/diff'),
    act: 'Open the diff view',
    attention: !clean,
  };
}

function specsTile(page: GlancePage): TileSpec {
  const { undispatched, anySpecs } = page.specs;
  let say: string;
  if (undispatched.length === 0) {
    say = anySpecs
      ? 'No spec has open tasks that were never dispatched.'
      : 'No spec under docs/specs declares tasks yet.';
  } else {
    say = esc(`${plural(undispatched.length, 'spec')} with open tasks never dispatched`);
  }
  const named = undispatched.slice(0, SPECS_SHOWN);
  const rest = undispatched.length - named.length;
  const more =
    named
      .map(
        (spec) =>
          `<span class="gl-item">${esc(specDisplayName(spec.id))} — ${esc(
            plural(spec.count, 'task') + ' never sent',
          )}</span>`,
      )
      .join('') + (rest > 0 ? `<span class="gl-item">and ${esc(plural(rest, 'more spec'))}</span>` : '');
  return {
    id: 'gl-specs',
    name: 'Specs',
    num: String(undispatched.length),
    say,
    more,
    href: pageHref(page.project, '/tasks'),
    act: 'Open waves & tasks',
    attention: undispatched.length > 0,
  };
}

function judgmentTile(page: GlancePage): TileSpec {
  const { count, items } = page.judgment;
  const rest = count - items.length;
  const more =
    items
      .map(
        (item) =>
          `<span class="gl-item"><span class="mono">${esc(item.id)}</span> — ${esc(item.outcome)}: ${esc(
            item.summary,
          )}</span>`,
      )
      .join('') + (rest > 0 ? `<span class="gl-item">and ${rest} more</span>` : '');
  return {
    id: 'gl-judgment',
    name: 'Judgment required',
    num: String(count),
    say:
      count === 0
        ? 'No dispatch is waiting on a decision.'
        : esc(`${plural(count, 'dispatch needs', 'dispatches need')} a decision`),
    more,
    href: pageHref(page.project, '/board', '#board-decisions'),
    act: 'Decide on the workbench',
    attention: count > 0,
  };
}

function projectsNavHtml(page: GlancePage): string {
  if (page.projects.length <= 1) return '';
  const links = page.projects
    .map((project) => {
      const current = project.root === page.project;
      const cls = current ? 'gl-proj gl-proj-on' : 'gl-proj';
      return `<a class="${cls}" href="${esc(pageHref(project.root, '/'))}">${esc(project.name)}</a>`;
    })
    .join('');
  return `<nav class="gl-projects" aria-label="Projects">${links}</nav>`;
}

function topNavHtml(page: GlancePage): string {
  return sharedNavHtml(page.projectName, page.project, '/');
}

/**
 * The tiles' stale lines repeat whatever the live badge says, so a dead stream
 * marks every number stale rather than letting them read as current. The
 * observer mirrors the badge — it opens no connection and runs no timer,
 * because the badge is already the one account of liveness on the page.
 */
const GLANCE_CLIENT = String.raw`(function(){
var badge=document.getElementById('board-live-badge');
if(badge===null||typeof MutationObserver!=='function')return;
function sync(){
var state=badge.getAttribute('data-live');
var stale=state==='disconnected'||state==='reconnecting';
var label=badge.querySelector('.board-live-label');
var age=badge.querySelector('.board-live-age');
var text='stale — '+(label===null?'the connection is down':(label.textContent||'the connection is down'));
if(age!==null&&age.textContent!==null&&age.textContent!=='')text+=' · '+age.textContent;
var nodes=document.querySelectorAll('.gl-stale');
for(var i=0;i<nodes.length;i++){nodes[i].textContent=text;nodes[i].style.display=stale?'block':'none';}
}
new MutationObserver(sync).observe(badge,{attributes:true,subtree:true,childList:true,characterData:true});
sync();
})();`;

/**
 * The part of the glance page that goes out of date: the orchestrator line and
 * the six tiles. Served alone at `/api/glance` so the client can replace it
 * when the live channel reports a change; the page wraps it in `#gl-body`.
 */
export function renderGlanceBody(page: GlancePage): string {
  const tiles = [
    needsYouTile(page),
    runningTile(page),
    lanesTile(page),
    treeTile(page),
    specsTile(page),
    judgmentTile(page),
  ]
    .map(tileHtml)
    .join('\n  ');

  return `${orchestratorHtml(page)}
  ${gateHtml(page)}
  <div class="gl-tiles" id="gl-tiles">
  ${tiles}
  </div>`;
}

export function renderGlancePage(page: GlancePage): string {
  const tiles = [
    needsYouTile(page),
    runningTile(page),
    lanesTile(page),
    treeTile(page),
    specsTile(page),
    judgmentTile(page),
  ]
    .map(tileHtml)
    .join('\n  ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(page.projectName)} · Glance</title>
<style>${dashboardCss()}${glancePageCss()}</style>
</head>
<body class="gl-body" data-project="${esc(page.project)}">
${topNavHtml(page)}
<main class="gl-main">
  <section class="gl-status" aria-label="Connection and orchestrator">
    <div class="gl-status-row">
      ${liveBadgeHtml(page.now)}
      ${checkChipHtml(page)}
    </div>
  </section>
  <div id="gl-body">
  ${renderGlanceBody(page)}
  </div>
  ${projectsNavHtml(page)}
</main>
<script>${boardClientScript()}${GLANCE_CLIENT}</script>
</body>
</html>`;
}
