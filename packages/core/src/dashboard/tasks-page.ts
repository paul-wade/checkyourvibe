/**
 * The /tasks page: the work every spec declares, each task's state read off
 * the dispatch log, and the dispatch form a task's `_Exec:` line fills.
 *
 * The task list is `parseAllSpecs`'s reading of every tasks.md — this module
 * parses nothing. A task's state is derived from the dispatch log at render
 * time (never sent, in motion, succeeded, failed) and is never stored, so the
 * page cannot drift from the record. A task checked off in tasks.md is `done`
 * — the spec file's own declaration — whatever its dispatches say.
 *
 * Dispatching goes through the existing `/api/dispatch` route and nothing
 * else. A task that was never sent carries a Dispatch link to
 * `?for=<id>#dispatch`, which renders the form at the foot of the page filled
 * from that task's `_Exec:` line — lane, gates, owned paths — leaving one
 * confirmation. A task whose `_Exec:` line was not read fills nothing beyond
 * its own text: guessing an ownership set would let an executor write
 * somewhere nobody declared.
 *
 * The form posts `application/x-www-form-urlencoded` straight to the route,
 * so dispatching works with no script at all; the inline script auto-submits
 * the filter bar and keeps the freshness line's age honest. No framework, no
 * remote asset, nothing fetched.
 */
import { esc } from './render.js';
import { topNavHtml, freshnessHtml, FRESHNESS_CLIENT } from './nav.js';
import { relativeTime } from './home.js';
import { specDisplayName, type ParsedSpec, type SpecTask } from './review/specs.js';
import { taskIdIn } from './motion.js';
import { isTaskKind, TASK_KINDS, type TaskKind } from '../executor/task-kind.js';
import { acceptsDispatch, type LaneDeclaration } from '../executor/lane.js';
import type { DispatchRecord } from '../executor/dispatch.js';
import { dashboardCss, tasksPageCss } from './styles.js';

/** Where a task stands, derived at render time from the log and the checkbox. */
export type TaskState = 'never' | 'in-motion' | 'succeeded' | 'failed' | 'done';

const STATE_OPTIONS: readonly { value: TaskState; label: string }[] = [
  { value: 'never', label: 'never dispatched' },
  { value: 'in-motion', label: 'in motion' },
  { value: 'succeeded', label: 'succeeded' },
  { value: 'failed', label: 'failed' },
  { value: 'done', label: 'done' },
];

export interface TasksPageInput {
  /** The project root, carried as `?p=` on every link and form. */
  project: string;
  projectName: string;
  /** Specs exactly as `parseAllSpecs` read them; the page orders them newest first. */
  specs: readonly ParsedSpec[];
  /** Folded dispatch records from the log, oldest first. */
  records: readonly DispatchRecord[];
  /** Configured lanes, for the dispatch form's lane select. */
  lanes: readonly LaneDeclaration[];
  /** `?spec=` — show one spec only; '' shows all. */
  spec: string;
  /** `?state=` — show one state only; '' shows all. */
  state: string;
  /** `?for=` — the task id the dispatch form is armed for; '' keeps it closed. */
  forTask: string;
  /** Epoch milliseconds the page was built; ages are computed against it. */
  now?: number;
}

/** One rendered task: its derived state, its latest dispatch, and what blocks it. */
interface TaskView {
  task: SpecTask;
  state: TaskState;
  /** The newest record naming the task, where the log has one. */
  dispatch?: DispatchRecord;
  /** Dependencies the task names that are still open in the same spec. */
  blockedBy: readonly string[];
}

interface SectionView {
  title: string;
  tasks: readonly TaskView[];
}

const TASKS_SCRIPT = String.raw`(function(){
  var filter=document.getElementById('tk-filter');
  if(filter===null)return;
  filter.addEventListener('change',function(e){
    var t=e.target;
    if(t!==null&&t.tagName==='SELECT')filter.requestSubmit();
  });
})();`;

function isTaskState(value: string): value is TaskState {
  return STATE_OPTIONS.some((option) => option.value === value);
}

function stateLabel(state: TaskState): string {
  const option = STATE_OPTIONS.find((entry) => entry.value === state);
  return option === undefined ? state : option.label;
}

/**
 * The newest record naming each task id. A task may have several attempts —
 * retries share the task text — so only the latest decides the shown state,
 * the same fold `landedTaskIds` applies for the board.
 */
function latestByTask(records: readonly DispatchRecord[]): Map<string, DispatchRecord> {
  const latest = new Map<string, DispatchRecord>();
  for (const record of records) {
    const id = taskIdIn(record.declaration.task);
    if (id === undefined) continue;
    const current = latest.get(id);
    if (current === undefined || current.openedAt <= record.openedAt) {
      latest.set(id, record);
    }
  }
  return latest;
}

function stateOf(task: SpecTask, dispatch: DispatchRecord | undefined): TaskState {
  if (task.done) return 'done';
  if (dispatch === undefined) return 'never';
  if (dispatch.closed === undefined) return 'in-motion';
  return dispatch.closed.outcome.kind === 'succeeded' ? 'succeeded' : 'failed';
}

/**
 * A spec's sections with each task's derived state. `blockedBy` names only
 * dependencies still open in the same spec — a done dependency blocks nothing.
 */
function specSections(spec: ParsedSpec, latest: ReadonlyMap<string, DispatchRecord>): SectionView[] {
  const openIds = new Set<string>();
  for (const section of spec.sections) {
    for (const task of section.tasks) {
      if (!task.done) openIds.add(task.id);
    }
  }
  return spec.sections.map((section) => ({
    title: section.title,
    tasks: section.tasks.map((task) => {
      const dispatch = latest.get(task.id);
      return {
        task,
        state: stateOf(task, dispatch),
        ...(dispatch === undefined ? {} : { dispatch }),
        blockedBy: task.dependsOn.filter((id) => openIds.has(id)),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// The dispatch form's pre-fill
// ---------------------------------------------------------------------------

/**
 * `_Exec:` file lists are written comma-separated, sometimes backticked. The
 * parser keeps what it read; this strips the quote marks an author added so
 * the textarea holds one clean path per line.
 */
function cleanPath(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim();
}

/** Specs write `kind=mechanical`/`judgment` as shorthand for the two task kinds. */
const KIND_ALIAS: Record<string, TaskKind> = {
  mechanical: 'mechanical-transformation',
  judgment: 'judgment-required',
};

function declaredKind(task: SpecTask): TaskKind {
  if (isTaskKind(task.kind)) return task.kind;
  const alias = KIND_ALIAS[task.kind];
  if (alias !== undefined) return alias;
  // Some specs put the kind under `model=` (`model=judgment-required`).
  if (isTaskKind(task.model)) return task.model;
  return 'mechanical-transformation';
}

interface LaneChoice {
  /** The lane to preselect, '' when the declaration names none the config knows. */
  laneId: string;
  /** What the declaration said, when it did not translate to a lane directly. */
  note: string;
}

/**
 * What a task's declared executor means for the lane select. `executor=self`
 * is the orchestrating session itself, `executor=user` is a task a person kept
 * — neither is a lane, and an id the config does not declare is shown rather
 * than silently preselecting some other lane.
 */
function declaredLane(task: SpecTask, lanes: readonly LaneDeclaration[]): LaneChoice {
  const named = task.executor;
  if (lanes.some((lane) => lane.id === named)) return { laneId: named, note: '' };
  if (named === 'self') {
    const orchestrators = lanes.filter((lane) => lane.orchestrator);
    const only = orchestrators[0];
    if (orchestrators.length === 1 && only !== undefined) {
      return { laneId: only.id, note: 'executor=self — sent to the orchestrating lane' };
    }
    return { laneId: '', note: 'executor=self — choose the lane this session runs on' };
  }
  if (named === 'user') {
    return { laneId: '', note: 'this task is declared yours to decide (executor=user)' };
  }
  if (named !== 'unknown') {
    return { laneId: '', note: `the _Exec: line names "${named}", which is not a configured lane` };
  }
  return { laneId: '', note: '' };
}

interface DispatchPrefill {
  /** Whether any `_Exec:` field was read at all. */
  declared: boolean;
  lane: LaneChoice;
  /** Why the scope is empty, when it is — shown plainly instead of guessed. */
  scopeNote: string;
  kind: TaskKind;
  gates: readonly string[];
  ownedPaths: readonly string[];
  taskText: string;
}

function prefillFor(
  task: SpecTask,
  spec: ParsedSpec,
  lanes: readonly LaneDeclaration[],
): DispatchPrefill {
  const ownedPaths = task.files.map(cleanPath).filter((file) => file !== '');
  const declared =
    task.executor !== 'unknown' ||
    task.kind !== '' ||
    task.model !== '' ||
    task.gates !== '' ||
    ownedPaths.length > 0;
  let scopeNote = '';
  if (!declared) {
    scopeNote =
      'No _Exec: line was read for this task, so nothing is filled beyond the task text. ' +
      'Declare the paths it may write — the dispatch is refused without at least one.';
  } else if (ownedPaths.length === 0) {
    scopeNote =
      'The _Exec: line declares no files. Declare the paths it may write — ' +
      'the dispatch is refused without at least one.';
  }
  const tasksPath = spec.tasksPath ?? `docs/specs/${spec.id}/tasks.md`;
  return {
    declared,
    lane: declaredLane(task, lanes),
    scopeNote,
    kind: declaredKind(task),
    gates: task.gates
      .split(',')
      .map((gate) => gate.trim())
      .filter((gate) => gate !== ''),
    ownedPaths,
    taskText: `${task.id} — ${task.title}\n\nThe full task is declared in ${tasksPath}.`,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function pageHref(project: string, path: string): string {
  return `${path}?${new URLSearchParams({ p: project }).toString()}`;
}

function taskHref(input: TasksPageInput, taskId: string): string {
  const params = new URLSearchParams({ p: input.project });
  if (input.spec !== '') params.set('spec', input.spec);
  if (input.state !== '') params.set('state', input.state);
  params.set('for', taskId);
  return `/tasks?${params.toString()}#dispatch`;
}

function laneOptions(lanes: readonly LaneDeclaration[], selectedId: string): string {
  const options = lanes.map((lane) => {
    const accepts = acceptsDispatch(lane);
    const selected = lane.id === selectedId ? ' selected' : '';
    const disabled = accepts ? '' : ' disabled';
    const suffix = accepts ? '' : ' — reserved';
    return `<option value="${esc(lane.id)}"${selected}${disabled}>${esc(lane.id)}${esc(suffix)}</option>`;
  });
  return `<option value="">let the scheduler choose</option>${options.join('')}`;
}

/** What the row offers next: a Dispatch link, or the dispatch that has it. */
function taskActionHtml(view: TaskView, input: TasksPageInput, now: number): string {
  const board = esc(pageHref(input.project, '/board'));
  const dispatch = view.dispatch;
  switch (view.state) {
    case 'never': {
      const userNote =
        view.task.executor === 'user'
          ? '<span class="tk-note">declared yours to decide</span>'
          : '';
      return `<div class="tk-acts"><a class="tk-go" href="${esc(taskHref(input, view.task.id))}">Dispatch</a>${userNote}</div>`;
    }
    case 'in-motion': {
      if (dispatch === undefined) return '';
      return `<div class="tk-acts"><span class="tk-note">in motion on ${esc(dispatch.assignment.laneId)}, opened ${esc(
        relativeTime(dispatch.openedAt, now),
      )} · <span class="mono">${esc(dispatch.dispatchId)}</span></span><a class="tk-link" href="${board}">watch it on the board</a></div>`;
    }
    case 'succeeded': {
      if (dispatch === undefined || dispatch.closed === undefined) return '';
      return `<div class="tk-acts"><span class="tk-note">${esc(dispatch.closed.outcome.summary)} — tick it off in tasks.md · <span class="mono">${esc(
        dispatch.dispatchId,
      )}</span></span><a class="tk-link" href="${board}">see it on the board</a></div>`;
    }
    case 'failed': {
      if (dispatch === undefined || dispatch.closed === undefined) return '';
      return `<div class="tk-acts"><span class="tk-note">${esc(dispatch.closed.outcome.kind)} — ${esc(
        dispatch.closed.outcome.summary,
      )} · <span class="mono">${esc(dispatch.dispatchId)}</span></span><a class="tk-link" href="${board}">see it on the board</a></div>`;
    }
    case 'done':
      return '';
  }
}

function taskRowHtml(view: TaskView, input: TasksPageInput, now: number): string {
  const { task } = view;
  const meta = [task.executor, task.kind !== '' ? task.kind : task.model]
    .filter((part) => part !== '')
    .map(esc)
    .join(' · ');
  const blocked =
    view.blockedBy.length > 0
      ? `<span class="tk-note">waits on ${esc(view.blockedBy.join(', '))}</span>`
      : '';
  const files =
    task.files.length > 0
      ? `<span class="tk-files mono">${esc(task.files.join(', '))}</span>`
      : '';
  return `<div class="tk-task" data-state="${view.state}">
  <div class="tk-head"><span class="tk-id mono">${esc(task.id)}</span><span class="tk-title">${esc(
    task.title,
  )}</span><span class="tk-st tk-st-${view.state}">${esc(stateLabel(view.state))}</span></div>
  <div class="tk-meta">${meta}${blocked}</div>
  ${files}
  ${taskActionHtml(view, input, now)}
</div>`;
}

function specHref(project: string, specId: string): string {
  return `/spec?${new URLSearchParams({ p: project, spec: specId }).toString()}`;
}

function specBlockHtml(
  spec: ParsedSpec,
  sections: readonly SectionView[],
  input: TasksPageInput,
  now: number,
): string {
  const fileLink =
    spec.tasksPath === null
      ? ''
      : `<a class="tk-file mono" href="${esc(
          `/view?${new URLSearchParams({ p: input.project, f: spec.tasksPath }).toString()}`,
        )}">tasks.md</a>`;
  let body: string;
  if (spec.tasksPath === null) {
    body = '<p class="tk-empty">No tasks.md yet — a spec earns one when its tasks are written.</p>';
  } else if (sections.length === 0) {
    // Specs whose every section filtered out never reach this point: the page
    // drops the whole block and the filter bar says nothing matched. This is
    // a tasks.md that parsed to no tasks at all.
    body = '<p class="tk-empty">No tasks were read from this spec’s tasks.md.</p>';
  } else {
    body = sections
      .map(
        (section) => `<div class="tk-group"><h3>${esc(section.title)}</h3>${section.tasks
          .map((view) => taskRowHtml(view, input, now))
          .join('')}</div>`,
      )
      .join('');
  }
  return `<section class="tk-spec">
  <header class="tk-spec-head"><h2><a href="${esc(specHref(input.project, spec.id))}">${esc(
    specDisplayName(spec.id),
  )}</a></h2><span class="tk-count mono">${
    spec.done
  }/${spec.total}</span>${fileLink}</header>
  ${body}
</section>`;
}

function filterHtml(input: TasksPageInput, sorted: readonly ParsedSpec[]): string {
  const specOptions = sorted
    .map(
      (spec) =>
        `<option value="${esc(spec.id)}"${spec.id === input.spec ? ' selected' : ''}>${esc(
          specDisplayName(spec.id),
        )}</option>`,
    )
    .join('');
  const stateOptions = STATE_OPTIONS.map(
    (option) =>
      `<option value="${option.value}"${option.value === input.state ? ' selected' : ''}>${esc(
        option.label,
      )}</option>`,
  ).join('');
  return `<form class="tk-filter" id="tk-filter" method="get" action="/tasks">
  <input type="hidden" name="p" value="${esc(input.project)}">
  <select name="spec" aria-label="filter by spec"><option value="">all specs</option>${specOptions}</select>
  <select name="state" aria-label="filter by state"><option value="">any state</option>${stateOptions}</select>
  <button class="tk-filter-btn" type="submit">filter</button>
</form>`;
}

/**
 * The dispatch form, rendered at the foot of the page only while `?for=` names
 * a task that is still waiting to be sent. The submit is the one confirmation
 * and sits in a sticky bar so it stays under the thumb while the form is open.
 */
function dispatchPanelHtml(
  input: TasksPageInput,
  latest: ReadonlyMap<string, DispatchRecord>,
): string {
  if (input.forTask === '') return '';
  let spec: ParsedSpec | undefined;
  let task: SpecTask | undefined;
  for (const candidate of input.specs) {
    for (const section of candidate.sections) {
      const found = section.tasks.find((entry) => entry.id === input.forTask);
      if (found !== undefined) {
        spec = candidate;
        task = found;
      }
    }
  }
  if (spec === undefined || task === undefined) {
    return `<section class="tk-dispatch" id="dispatch"><h2>Dispatch</h2>
  <p class="tk-empty">No task named <span class="mono">${esc(
    input.forTask,
  )}</span> is declared in this project.</p></section>`;
  }
  const state = stateOf(task, latest.get(task.id));
  if (state !== 'never') {
    return `<section class="tk-dispatch" id="dispatch"><h2>Dispatch</h2>
  <p class="tk-empty"><span class="mono">${esc(task.id)}</span> is ${esc(
    stateLabel(state),
  )} — nothing to dispatch.</p></section>`;
  }
  const prefill = prefillFor(task, spec, input.lanes);
  const notes = [prefill.lane.note, prefill.scopeNote]
    .filter((note) => note !== '')
    .map((note) => `<p class="tk-note">${esc(note)}</p>`)
    .join('');
  const kindOptions = TASK_KINDS.map(
    (kind) => `<option value="${kind}"${kind === prefill.kind ? ' selected' : ''}>${kind}</option>`,
  ).join('');
  return `<section class="tk-dispatch" id="dispatch">
  <h2>Dispatch <span class="mono">${esc(task.id)}</span></h2>
  <p class="tk-lede">${esc(task.title)}</p>
  ${notes}
  <form class="tk-form" method="post" action="/api/dispatch?p=${esc(encodeURIComponent(input.project))}">
    <input type="hidden" name="spec" value="${esc(input.spec)}">
    <input type="hidden" name="state" value="${esc(input.state)}">
    <label class="tk-field"><span>Task</span>
      <textarea name="task" rows="3">${esc(prefill.taskText)}</textarea></label>
    <label class="tk-field"><span>Lane</span>
      <select name="lane">${laneOptions(input.lanes, prefill.lane.laneId)}</select></label>
    <label class="tk-field"><span>Kind</span>
      <select name="kind">${kindOptions}</select></label>
    <label class="tk-field"><span>Paths it may write — one per line</span>
      <textarea name="ownedPaths" rows="4" placeholder="packages/core/src/…">${esc(
        prefill.ownedPaths.join('\n'),
      )}</textarea></label>
    <label class="tk-field"><span>Gates — one per line; empty runs cyv-check</span>
      <textarea name="gates" rows="2">${esc(prefill.gates.join('\n'))}</textarea></label>
    <div class="tk-sendbar"><button class="tk-send" type="submit">Dispatch ${esc(task.id)}</button></div>
  </form>
</section>`;
}

export function renderTasksPage(input: TasksPageInput): string {
  const now = input.now ?? Date.now();
  const latest = latestByTask(input.records);
  const stateFilter = isTaskState(input.state) ? input.state : '';
  const sorted = [...input.specs].sort((a, b) => b.id.localeCompare(a.id));
  const shown = sorted.filter((spec) => input.spec === '' || spec.id === input.spec);

  const blocks = shown
    .map((spec) => {
      const sections = specSections(spec, latest)
        .map((section) => ({
          title: section.title,
          tasks: section.tasks.filter((view) => stateFilter === '' || view.state === stateFilter),
        }))
        .filter((section) => section.tasks.length > 0);
      return { spec, sections };
    })
    .filter((block) => stateFilter === '' || block.sections.length > 0)
    .map((block) => specBlockHtml(block.spec, block.sections, input, now))
    .join('');

  const empty =
    input.specs.length === 0
      ? '<p class="tk-empty">No spec folder under docs/specs yet.</p>'
      : blocks === ''
        ? '<p class="tk-empty">Nothing matches the filter.</p>'
        : '';

  const topNav = topNavHtml(input.projectName, input.project, '/tasks');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(input.projectName)} · Waves &amp; Tasks</title>
<style>${dashboardCss()}${tasksPageCss()}</style>
</head>
<body class="tk-body" data-project="${esc(input.project)}">
${topNav}
<main class="tk-main">
  ${filterHtml(input, sorted)}
  ${blocks}
  ${empty}
  ${dispatchPanelHtml(input, latest)}
  ${freshnessHtml(now)}
</main>
<script>${TASKS_SCRIPT}${FRESHNESS_CLIENT}</script>
</body>
</html>`;
}
