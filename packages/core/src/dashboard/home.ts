/**
 * The home page: top bar and four regions, rendered from a `HomePage` and
 * nothing else (spec 0040 Requirements 1 to 6, Decision 8).
 *
 * Every fact is shown with the mark that says how it was obtained, and every
 * region has an empty state that names what would fill it. No region opens
 * with prose about what it does not show; the one disclaimer is the footer.
 */
import { esc } from './render.js';
import { projectQuery, shell, TAB_PATHS } from './shell.js';
import type {
  CheckIndicator,
  ExchangeEntry,
  ExchangeRegion,
  FinishedDispatch,
  HomePage,
  LaneRow,
  LanesRegion,
  Liveness,
  MotionRegion,
  NeedsYouItem,
  NextTask,
  ProjectOption,
  RunningDispatch,
  StallSignal,
  UncommittedWork,
} from './view-model.js';

/**
 * Coarse relative time against the moment the page was built. The reader
 * needs "is this stale", not a duration, so the unit steps up early.
 */
export function relativeTime(at: string | number, now: number): string {
  const then = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(then)) return 'at an unreadable time';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function evidenceClass(evidence: 'measured' | 'recorded' | 'unknown'): string {
  if (evidence === 'measured') return 'now';
  return evidence;
}

// ------------------------------------------------------------------ top bar

function projectControl(page: HomePage): string {
  if (page.projects.length <= 1) {
    const home = `${TAB_PATHS.home}${projectQuery(page.project.root)}`;
    return `<a href="${home}">${esc(page.project.name)}</a>`;
  }
  const options = page.projects.map((p: ProjectOption) => {
    const selected = p.root === page.project.root ? ' selected' : '';
    if (!p.reachable) {
      const why = p.unreachableReason ?? 'not reachable';
      return `<option value="${esc(p.root)}" disabled${selected}>${esc(p.name)} · ${esc(why)}</option>`;
    }
    const bits = [p.name];
    if (p.needsCount !== undefined && p.needsCount > 0) bits.push(`${p.needsCount} needs you`);
    if (p.inFlight !== undefined && p.inFlight > 0) bits.push(`${p.inFlight} in flight`);
    return `<option value="${esc(p.root)}"${selected}>${esc(bits.join(' · '))}</option>`;
  });
  return `<select class="project-select" aria-label="project">${options.join('')}</select>`;
}

export function checkIndicatorHtml(check: CheckIndicator, now: number): string {
  if (check.state === 'never') {
    return `<span class="check"><span class="ev unknown">no check yet</span></span>`;
  }
  if (check.state === 'running') {
    return `<span class="check"><span class="ev recorded">check running · ${esc(check.mode)}</span></span>`;
  }
  const count = check.findings === 0 ? 'clean' : plural(check.findings, 'finding');
  return `<span class="check"><span class="ev ${evidenceClass(check.evidence)}">${esc(check.evidence)}</span>` +
    `<span>${esc(count)}</span><span class="mut small">${esc(relativeTime(check.finishedAt, now))}</span></span>`;
}

// ------------------------------------------------------------- needs you

function needsYouActionHtml(action: NeedsYouItem['actions'][number]): string {
  if (action.kind === 'tell') {
    const task = action.task !== undefined ? ` data-task="${esc(action.task)}"` : '';
    return `<button class="act act-tell" data-prefill="${esc(action.prefill)}"${task}>${esc(action.label)}</button>`;
  }
  if (action.kind === 'dismiss') {
    return `<button class="act act-dismiss" data-item="${esc(action.itemId)}">${esc(action.label)}</button>`;
  }
  if (action.kind === 'close') {
    return `<button class="act act-close" data-dispatch="${esc(action.dispatchId)}">${esc(action.label)}</button>`;
  }
  if (action.kind === 'addressed') {
    return `<button class="act addressed-btn" data-id="${action.commentId}">${esc(action.label)}</button>`;
  }
  // open
  return `<a class="act" href="${esc(action.href)}">${esc(action.label)}</a>`;
}

function needsYouItemHtml(item: NeedsYouItem): string {
  const detail = item.detail !== undefined && item.detail.length > 0
    ? item.detail.map((line) => `<span class="detail mono small">${esc(line)}</span>`).join('')
    : '';
  const acts = item.actions.length > 0
    ? `<div class="acts">${item.actions.map(needsYouActionHtml).join('')}<span class="err"></span></div>`
    : '';
  return `<div class="need">
    <p class="q">${esc(item.question)}</p>
    <span class="what mut">${esc(item.title)}</span>
    ${detail}
    ${acts}
    <span class="loc small mut"><span class="id mono">${esc(item.id)}</span> · ${esc(item.where)}</span>
  </div>`;
}

function needsYouHtml(items: readonly NeedsYouItem[]): string {
  if (items.length === 0) {
    return `<section class="sect" id="needs-you">
      <header><span class="label">Needs you</span><span class="n">0</span></header>
      <p class="empty">Nothing is waiting on you.</p>
    </section>`;
  }
  // The only place the signal colour is allowed to lead: everything here is
  // waiting on a person.
  return `<section class="sect attention" id="needs-you">
    <header><span class="label">Needs you</span><span class="n">${items.length}</span></header>
    ${items.map(needsYouItemHtml).join('')}
  </section>`;
}

// ------------------------------------------------------------- in motion

function livenessMark(liveness: Liveness): string {
  const cls = liveness === 'live' ? 'now' : liveness === 'abandoned' ? 'signal' : 'unknown';
  return `<span class="ev ${cls}">${liveness}</span>`;
}

function runningHtml(running: readonly RunningDispatch[], project: string, now: number): string {
  if (running.length === 0) return '<p class="empty">Nothing is running.</p>';
  const q = projectQuery(project);
  return running
    .map((d) => {
      const id = d.taskId ?? d.dispatchId;
      const stop = d.canStop
        ? `<button class="stop" data-dispatch="${esc(d.dispatchId)}">stop</button><span class="err"></span>`
        : `<span class="mut small">${esc(d.stopRefusal ?? 'stop is not available for this dispatch')}</span>`;
      return `<div class="line" data-dispatch="${esc(d.dispatchId)}">
        <div class="t"><span class="mono">${esc(id)}</span> ${esc(d.task)}</div>
        <div class="meta"><span>${esc(d.laneId)} · ${esc(d.model)}</span>
          <span>started ${esc(relativeTime(d.openedAt, now))}</span>
          ${livenessMark(d.liveness)}<span class="small">${esc(d.livenessReason)}</span></div>
        <div class="actions"><a href="${TAB_PATHS.diff}?d=working&amp;${q.slice(1)}">diff</a>${stop}</div>
      </div>`;
    })
    .join('');
}

function nextTaskRow(task: NextTask): string {
  const landed = task.landed === true
    ? `<span class="small ok">landed — check it off in tasks.md</span>`
    : '';
  const blocked = task.blockedBy.length > 0
    ? `<span class="small">waiting on ${esc(task.blockedBy.join(', '))}</span>`
    : '';
  return `<div class="line">
    <div class="t"><span class="mono">${esc(task.id)}</span> ${esc(task.title)}</div>
    <div class="meta"><span>${esc(task.executor)}</span><span>${esc(task.kind)}</span>${blocked}${landed}</div>
    <span class="files mono" title="${esc(task.files.join(', '))}">${esc(task.files.join(', '))}</span>
  </div>`;
}

function nextUpHtml(next: readonly NextTask[]): string {
  if (next.length === 0) return '<p class="empty">No open task is unblocked.</p>';
  const waves = new Map<number, NextTask[]>();
  for (const task of next) {
    const wave = waves.get(task.wave);
    if (wave === undefined) waves.set(task.wave, [task]);
    else wave.push(task);
  }
  const numbered = [...waves.keys()].filter((w) => w > 0).sort((a, b) => a - b);
  const blocks = numbered.map((w) => {
    const tasks = waves.get(w) ?? [];
    const note = w === 1 ? 'can run at once' : `after wave ${w - 1}`;
    return `<div class="sub"><span class="label">wave ${w} · ${note}</span>${tasks.map(nextTaskRow).join('')}</div>`;
  });
  const blocked = waves.get(0) ?? [];
  if (blocked.length > 0) {
    blocks.push(`<div class="sub"><span class="label">blocked</span>${blocked.map(nextTaskRow).join('')}</div>`);
  }
  return blocks.join('');
}

function finishedHtml(finished: readonly FinishedDispatch[], now: number): string {
  if (finished.length === 0) return '<p class="empty">Nothing has finished yet.</p>';
  const newestFirst = [...finished].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  return newestFirst
    .map((d) => {
      const id = d.taskId ?? d.dispatchId;
      const cls = d.needsPerson ? 'bad' : d.outcome === 'succeeded' ? 'ok' : '';
      const gates = d.failedGates.length > 0
        ? `<span class="small">gates failed: ${esc(d.failedGates.join(', '))}</span>`
        : '';
      return `<div class="line">
        <div class="t"><span class="mono">${esc(id)}</span> ${esc(d.task)}</div>
        <div class="meta"><span>${esc(d.laneId)} · ${esc(d.model)}</span>
          <span class="${cls}">${esc(d.outcome)}</span>
          <span>${esc(relativeTime(d.closedAt, now))}</span>${gates}</div>
      </div>`;
    })
    .join('');
}

function stallHtml(stall: StallSignal, now: number): string {
  const since = stall.lastOpenedAt === undefined ? 'ever' : relativeTime(stall.lastOpenedAt, now);
  // What is and is not happening, and never why (0036 R4.2).
  return `<div class="sub"><span class="label">Stall</span>
    <p class="empty">Open work, ${plural(stall.idleLanes.length, 'lane')} free, and nothing dispatched for ${esc(since)} (interval ${stall.intervalMinutes}m): ${esc(stall.idleLanes.join(', '))}.</p>
  </div>`;
}

function uncommittedHtml(work: UncommittedWork, now: number): string {
  if (work.count === 0) return '<p class="empty">Working tree clean.</p>';
  const named = work.named.map((f) => {
    const when = f.touchedAt === undefined ? '' : ` <span class="mut">${esc(relativeTime(f.touchedAt, now))}</span>`;
    return `<div class="line small"><span class="mono">${esc(f.name)}</span>${when}</div>`;
  });
  const more = work.moreCount > 0 ? `<p class="empty">and ${plural(work.moreCount, 'more file')}</p>` : '';
  return `<p class="empty"><span class="mono">+${work.added} −${work.removed}</span> uncommitted across ${plural(work.count, 'file')}</p>
    ${named.join('')}${more}`;
}

function motionHtml(motion: MotionRegion, project: string, now: number): string {
  const spec = motion.spec;
  const header = spec === undefined
    ? `<header><span class="label">In motion</span></header>
       <p class="empty">No spec has open tasks. An unchecked task in <code>docs/specs/&lt;n&gt;/tasks.md</code> would appear here.</p>`
    : `<header><span class="label">In motion</span><span>${esc(spec.name)}</span>
       <span class="n">${spec.done}/${spec.total}</span></header>`;
  const unparseable = motion.unparseableLines > 0
    ? `<p class="empty">${plural(motion.unparseableLines, 'line')} of the dispatch log could not be read and are not counted.</p>`
    : '';
  const stall = motion.stall === undefined ? '' : stallHtml(motion.stall, now);
  return `<section class="sect" id="motion">
    ${header}
    <div class="sub"><span class="label">Running now</span>${runningHtml(motion.running, project, now)}</div>
    <div class="sub"><span class="label">Next up</span>${nextUpHtml(motion.next)}</div>
    <div class="sub"><span class="label">Just finished</span>${finishedHtml(motion.finished, now)}</div>
    ${stall}
    <div class="sub"><span class="label">Uncommitted</span>${uncommittedHtml(motion.uncommitted, now)}</div>
    ${unparseable}
  </section>`;
}

// ----------------------------------------------------------------- lanes

function laneStateMark(state: LaneRow['state']): string {
  const cls = state === 'free' ? 'now' : state === 'busy' ? 'ink' : state === 'cooling' ? 'stale' : 'muted';
  return `<span class="ev ${cls}">${state}</span>`;
}

function laneRowHtml(lane: LaneRow, now: number): string {
  const lines: string[] = [];
  if (lane.state === 'cooling' && lane.cooldown !== undefined) {
    const c = lane.cooldown;
    lines.push(
      `cooling since ${esc(relativeTime(c.since, now))} after ${esc(c.dispatchId)} closed ${esc(c.reason)}; ` +
        `clears on the next dispatch to this lane that changes its files — name it with <code>cyv dispatch --lane ${esc(lane.id)}</code>.`,
    );
  }
  if (lane.state === 'unavailable') {
    lines.push(`program not found: tried ${esc(lane.programTried.join(', '))}`);
  }
  if (lane.orchestrator) {
    const report = lane.selfReport;
    if (report === undefined) {
      lines.push('self-reported: unknown — no report recorded (<code>cyv orchestrator --state …</code>)');
    } else {
      const extra = [report.reason, report.model].filter((s): s is string => s !== undefined);
      const tail = extra.length > 0 ? ` · ${esc(extra.join(' · '))}` : '';
      lines.push(`self-reported ${esc(report.state)} ${esc(relativeTime(report.at, now))}${tail}`);
    }
  }
  const tag = lane.orchestrator ? '<span class="tag">orchestrator</span>' : '';
  return `<div class="lane">
    <div class="head"><span class="id mono">${esc(lane.id)}</span>${laneStateMark(lane.state)}
      <span>running ${lane.running} of ${lane.cap}</span>${tag}
      <span class="mut small">${esc(lane.billing)}</span></div>
    ${lines.map((l) => `<div class="more">${l}</div>`).join('')}
  </div>`;
}

function lanesHtml(lanes: LanesRegion, now: number): string {
  if (lanes.none) {
    return `<section class="sect" id="lanes">
      <header><span class="label">Lanes</span><span class="n">0</span></header>
      <p class="empty">No lane is declared. Add <code>executor.lanes</code> to checkyourvibe.json.</p>
    </section>`;
  }
  const unused = lanes.unused.map(
    (u) => `<div class="more">Installed and not declared as a lane: <span class="mono">${esc(u.agentId)}</span> (${esc(u.program)})</div>`,
  );
  return `<section class="sect" id="lanes">
    <header><span class="label">Lanes</span><span class="n">${lanes.lanes.length}</span></header>
    ${lanes.lanes.map((lane) => laneRowHtml(lane, now)).join('')}
    ${unused.join('')}
  </section>`;
}

// -------------------------------------------------------------- exchange

/** One recorded turn or note; shared with the docs viewer's section comments. */
/** A duration a person reads rather than a number they convert. */
function forHowLong(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function exchangeEntryHtml(entry: ExchangeEntry, project: string): string {
  const q = projectQuery(project);
  const refs: string[] = [];
  if (entry.task !== undefined) refs.push(`<span class="mono">${esc(entry.task)}</span>`);
  if (entry.file !== undefined) {
    refs.push(`<a href="/view?f=${encodeURIComponent(entry.file)}&amp;${q.slice(1)}">${esc(entry.file)}</a>`);
  }
  if (entry.anchor !== undefined) refs.push(`<span class="mut">${esc(entry.anchor)}</span>`);
  if (entry.replyTo !== undefined) refs.push(`<span class="mut">re #${entry.replyTo}</span>`);
  const classes = ['cm'];
  if (entry.isAgent) classes.push('agent');
  if (entry.status === 'addressed') classes.push('addressed');
  if (entry.readByAgent === false) classes.push('unread');

  // Whether the agent's cursor has passed this note, said on the note itself
  // (spec 0042 Requirement 3.1). Absent on the tool's own turns, where the
  // question does not arise.
  const readMark =
    entry.readByAgent === undefined
      ? ''
      : entry.readByAgent
        ? ' · <span class="mut">read by the agent</span>'
        : ` · <span class="warn">unread by the agent${
            entry.unreadForMs === undefined ? '' : ` for ${esc(forHowLong(entry.unreadForMs))}`
          }</span>`;
  const who = entry.isAgent ? `${esc(entry.author)} (agent)` : esc(entry.author);
  const when = new Date(entry.created).toLocaleString();
  // Only a person's open note can be marked addressed; an agent's turn is a
  // record, and records are not closed from the page (0034 R3.4).
  const mark = !entry.isAgent && entry.status === 'open'
    ? `<div class="row"><button class="addressed-btn" data-id="${entry.id}">mark addressed</button></div>`
    : '';
  return `<div class="${classes.join(' ')}" data-id="${entry.id}">
    <div class="meta">#${entry.id} · <span class="who">${who}</span> · ${esc(when)}${refs.map((r) => ` · ${r}`).join('')}${readMark}</div>
    <div class="body">${esc(entry.body)}</div>
    ${mark}
  </div>`;
}

function exchangeHtml(exchange: ExchangeRegion, project: string): string {
  const entries = exchange.entries.length === 0
    ? `<p class="empty">No turns recorded yet. The agent records one with <code>cyv comments --record</code>; you can write the first below.</p>`
    : exchange.entries.map((e) => exchangeEntryHtml(e, project)).join('');
  const older = exchange.omitted > 0 ? `<p class="empty">${exchange.omitted} older not shown</p>` : '';
  return `<section class="sect" id="exchange">
    <header><span class="label">Exchange</span><span class="n">${exchange.total}</span></header>
    ${entries}${older}
    <div class="compose">
      <textarea id="reply" rows="3" placeholder="Write back — a paragraph is fine. Name a task id or file if it's about one."></textarea>
      <input id="reply-task" class="task mono" placeholder="task id (optional)" aria-label="task id">
      <div class="row"><button class="post-btn primary" type="button">post</button><span class="err" id="post-err"></span></div>
    </div>
  </section>`;
}

// ------------------------------------------------------------------ page

export function renderHome(page: HomePage): string {
  const topBar = `${projectControl(page)}${checkIndicatorHtml(page.check, page.now)}`;
  const poll = `/api/state${projectQuery(page.project.root)}`;
  const body = `<main data-poll="${esc(poll)}">
    ${needsYouHtml(page.needsYou)}
    ${motionHtml(page.motion, page.project.root, page.now)}
    ${lanesHtml(page.lanes, page.now)}
    ${exchangeHtml(page.exchange, page.project.root)}
    <footer class="label">Reads .cyv-review/ and git. Runs nothing. <span id="poll-state"></span></footer>
  </main>`;
  return shell(page.project.name, body, {
    project: page.project.root,
    projectName: page.project.name,
    showProjects: page.projects.length > 1,
    topBarHtml: topBar,
    active: 'home',
  });
}

