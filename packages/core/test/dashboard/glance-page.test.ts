import { describe, expect, it } from 'vitest';

import { buildGlancePage, renderGlancePage, type GlancePageInput } from '../../src/dashboard/glance-page.js';
import type { DispatchRecord } from '../../src/executor/dispatch.js';
import type { DispatchOutcome } from '../../src/executor/outcome.js';
import type { ResolvedLaneDeclaration } from '../../src/executor/lane.js';
import type { DispatchLog } from '../../src/executor/store.js';
import type { CommentStore } from '../../src/dashboard/review/comments.js';
import type { ParsedSpec, SpecRollup, SpecTask } from '../../src/dashboard/review/specs.js';
import type { QuotaEntry } from '../../src/dashboard/state-store.js';
import type { LatestRun } from '../../src/dashboard/latest.js';
import type { UncommittedWork } from '../../src/dashboard/view-model.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

/**
 * The fixtures are built in memory: `buildGlancePage` reads nothing itself —
 * every input is the value the dashboard route would have read from disk.
 */
function record(
  dispatchId: string,
  laneId: string,
  task: string,
  openedAt: string,
): DispatchRecord {
  return {
    dispatchId,
    workId: `w-${dispatchId}`,
    attempt: 1,
    openedAt,
    declaration: {
      task,
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/thing.ts'],
      expectsFileChanges: true,
      gates: ['cyv-check'],
    },
    assignment: {
      laneId,
      agentId: 'agent-test',
      model: 'weak',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
}

function closed(
  dispatchId: string,
  laneId: string,
  task: string,
  kind: DispatchOutcome['kind'],
  closedAt = '2026-09-01T10:05:00.000Z',
): DispatchRecord {
  const open = record(dispatchId, laneId, task, '2026-09-01T10:00:00.000Z');
  open.closed = {
    closedAt,
    report: { status: 'success', exitCode: 0, rateLimited: false },
    gateResults: [],
    outcome: {
      kind,
      summary: `the dispatch ${kind}`,
      changedPaths: [],
      outOfScopePaths: [],
      failedGates: [],
    },
  };
  return open;
}

interface LaneOverrides {
  id?: string;
  concurrencyCap?: number;
  orchestrator?: boolean;
  acceptsDispatch?: boolean;
}

function lane(over: LaneOverrides = {}): ResolvedLaneDeclaration {
  return {
    id: over.id ?? 'lane-a',
    agentId: 'agent-test',
    concurrencyCap: over.concurrencyCap ?? 1,
    billing: { kind: 'subscription', permitsBilledOverage: false },
    models: [{ kind: 'mechanical-transformation', ordering: ['strong', 'weak'] }],
    orchestrator: over.orchestrator ?? false,
    acceptsDispatch: over.acceptsDispatch ?? !(over.orchestrator ?? false),
    executes: 'subagent',
  };
}

function log(records: readonly DispatchRecord[]): DispatchLog {
  return { records: [...records], refusals: [], acknowledged: [] };
}

function comments(): CommentStore {
  return { version: 1, nextId: 1, comments: [] };
}

function specTask(id: string, specId: string, done = false): SpecTask {
  return {
    id,
    title: `the task ${id}`,
    done,
    executor: 'unknown',
    model: '',
    kind: '',
    gates: '',
    files: [],
    dependsOn: [],
    specId,
    line: 1,
  };
}

function spec(id: string, tasks: readonly SpecTask[]): ParsedSpec {
  return {
    id,
    tasksPath: `docs/specs/${id}/tasks.md`,
    sections: tasks.length === 0 ? [] : [{ title: 'Open', tasks: [...tasks] }],
    done: tasks.filter((task) => task.done).length,
    total: tasks.length,
  };
}

function specs(rollup: readonly ParsedSpec[]): SpecRollup {
  return {
    specs: [...rollup],
    done: rollup.reduce((total, entry) => total + entry.done, 0),
    total: rollup.reduce((total, entry) => total + entry.total, 0),
  };
}

function cleanTree(): UncommittedWork {
  return { count: 0, added: 0, removed: 0, named: [], moreCount: 0 };
}

function dirtyTree(): UncommittedWork {
  return {
    count: 2,
    added: 33,
    removed: 30,
    named: [{ name: 'src/changed.ts' }, { name: 'src/other.ts' }],
    moreCount: 0,
  };
}

const CLEAN_RUN: LatestRun = {
  status: 'finished',
  startedAt: '2026-09-01T11:00:00.000Z',
  finishedAt: '2026-09-01T11:00:01.000Z',
  mode: 'fast',
  commit: 'abc1234',
  filesChecked: 10,
  violationCount: 0,
  violations: [],
};

interface InputOverrides {
  records?: readonly DispatchRecord[];
  lanes?: readonly ResolvedLaneDeclaration[];
  quotas?: Readonly<Record<string, QuotaEntry>>;
  specs?: SpecRollup;
  tree?: UncommittedWork;
  latest?: LatestRun | null;
}

function input(over: InputOverrides = {}): GlancePageInput {
  return {
    project: '/repo',
    projectName: 'repo',
    projects: ['/repo'],
    log: log(over.records ?? []),
    comments: comments(),
    lanes: over.lanes ?? [],
    quotas: over.quotas ?? {},
    specs: over.specs ?? specs([]),
    tree: over.tree ?? cleanTree(),
    latest: over.latest === undefined ? CLEAN_RUN : over.latest,
    now: NOW,
  };
}

/** The tiles the page always renders, in order. */
const TILE_IDS = ['gl-needs', 'gl-running', 'gl-lanes', 'gl-tree', 'gl-specs', 'gl-judgment'];

describe('renderGlancePage', () => {
  it('renders every tile with its number and the link to where the reader acts', () => {
    const html = renderGlancePage(
      buildGlancePage(
        input({
          records: [
            closed('d-needs', 'lane-a', 'T90001 wrote outside scope', 'out-of-scope-write'),
            record('d-moving', 'lane-b', 'T90004 Keep moving', '2026-09-01T10:06:00.000Z'),
          ],
          lanes: [lane({ id: 'lane-a' }), lane({ id: 'lane-b' })],
          specs: specs([spec('0099-fixture', [specTask('T99001', '0099-fixture')])]),
          tree: dirtyTree(),
        }),
      ),
    );

    for (const id of TILE_IDS) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain('class="gl-stale"');
    }

    // Needs you: one item, named, linked to the board's right column.
    expect(html).toContain('1 item wants a person');
    expect(html).toContain('T90001');
    expect(html).toContain('/board?p=');
    expect(html).toContain('#board-right-body');

    // Running: the in-flight dispatch named by task, not dispatch id.
    expect(html).toContain('1 dispatch in flight');
    expect(html).not.toContain('waiting for your review');
    expect(html).toContain('T90004');
    expect(html).not.toContain('d-moving');
    expect(html).toContain('#board-center-body');

    // Lanes: one free, the running dispatch fills the other's cap.
    expect(html).toContain('1 of 2 free');
    expect(html).toContain('at capacity');
    expect(html).toContain('No lanes are blocked.');
    expect(html).toContain('/lanes?p=');

    // Working tree: dirty, with the uncommitted count and a named file.
    expect(html).toContain('2 uncommitted files');
    expect(html).toContain('src/changed.ts');
    expect(html).toContain('/diff?p=');

    // Specs: one spec holds an open task no dispatch has ever named.
    expect(html).toContain('1 spec with open tasks never dispatched');
    expect(html).toContain('0099 · fixture');
    expect(html).toContain('/tasks?p=');

    // Judgment: the out-of-scope write needs a decision.
    expect(html).toContain('1 dispatch needs a decision');
    expect(html).toContain('out-of-scope-write');
    expect(html).toContain('#board-decisions');
  });

  it('renders a worded zero state on every tile, never an empty frame', () => {
    const html = renderGlancePage(
      buildGlancePage(input({ lanes: [lane({ id: 'lane-a' }), lane({ id: 'lane-b' })] })),
    );

    expect(html).toContain('Nothing needs you right now.');
    expect(html).toContain('Nothing is in motion.');
    expect(html).toContain('No lanes are blocked.');
    expect(html).toContain('The working tree is clean');
    expect(html).toContain('No spec under docs/specs declares tasks yet.');
    expect(html).toContain('No dispatch is waiting on a decision.');
  });

  it('counts judgment apart from failures that need none', () => {
    const page = buildGlancePage(
      input({
        records: [
          // A removed lane keeps the produced-nothing cooldown off the board's
          // declared lanes, so the needs-you count below is the two cards alone.
          closed('d-judge', 'lane-gone', 'T90001 produced nothing', 'produced-nothing'),
          closed('d-failed', 'lane-a', 'T90002 merely failed', 'gates-failed'),
        ],
        lanes: [lane({ id: 'lane-a' })],
      }),
    );

    // Both land in needs-you; only the produced-nothing outcome wants a decision.
    expect(page.needsYou.count).toBe(2);
    expect(page.judgment.count).toBe(1);
    const first = page.judgment.items.at(0);
    expect(first?.outcome).toBe('produced-nothing');
  });

  it('names an exhausted lane with its reset time', () => {
    const html = renderGlancePage(
      buildGlancePage(
        input({
          lanes: [lane({ id: 'lane-a' }), lane({ id: 'lane-b' })],
          quotas: { 'lane-b': { exhausted: true, resetsAt: '2030-01-01T00:00:00.000Z' } },
        }),
      ),
    );

    expect(html).toContain('lane-b');
    expect(html).toContain('subscription exhausted');
    expect(html).toContain('2030-01-01T00:00:00.000Z');
    expect(html).not.toContain('No lanes are blocked.');
  });

  it('marks every tile stale while the shared live badge reports the stream down', () => {
    const html = renderGlancePage(buildGlancePage(input()));

    // The badge the board's client script drives is present and seeded.
    expect(html).toContain('id="board-live-badge"');
    expect(html).toContain('data-live="connecting"');
    expect(html).toContain('data-epoch=');

    // Every tile carries a stale line the badge's state reveals.
    const tiles = TILE_IDS.length;
    const staleLines = html.split('class="gl-stale"').length - 1;
    expect(staleLines).toBe(tiles);

    // The reveal is wired to the badge's data-live state, and the page embeds
    // the board's own client script — no second stream, no polling timer.
    expect(html).toContain('data-live="disconnected"');
    expect(html).toContain('/api/live');
    expect(html).toContain('MutationObserver');
  });

  it('escapes markup in a dispatch record before rendering it', () => {
    // An in-flight task's text is what the running tile names the work by.
    const html = renderGlancePage(
      buildGlancePage(
        input({
          records: [
            record('d-evil', 'lane-a', '<script>alert(1)</script> change the thing', '2026-09-01T10:00:00.000Z'),
          ],
          lanes: [lane({ id: 'lane-a' })],
        }),
      ),
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('links every nav tab and marks Glance current', () => {
    const html = renderGlancePage(buildGlancePage(input()));

    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/?p=');
    expect(html).toContain('href="/board?p=');
    expect(html).toContain('href="/tasks?p=');
    expect(html).toContain('href="/lanes?p=');
    expect(html).toContain('href="/specs?p=');
  });

  it('reports the last check run beside the live badge', () => {
    const html = renderGlancePage(buildGlancePage(input()));

    expect(html).toContain('clean');
    expect(html).toContain('ago');
    expect(html).toContain('/rules?p=');
  });

  // A dispatch that finished and is waiting for a person shares the In Progress
  // column with one that is still executing. Calling both "in flight" said the
  // finished one was still running.
  it('separates what is executing from what is waiting for a review', () => {
    const finished = closed('d-done', 'lane-a', 'T90007 Finished, unreviewed', 'succeeded');
    const wasClosed = finished.closed;
    if (wasClosed !== undefined) {
      // A changed path is what keeps a succeeded dispatch awaiting review
      // rather than dropping straight into Done.
      finished.closed = { ...wasClosed, outcome: { ...wasClosed.outcome, changedPaths: ['src/thing.ts'] } };
    }
    const moving = record('d-moving', 'lane-b', 'T90004 Keep moving', '2026-09-01T10:02:00.000Z');

    const page = buildGlancePage(input({ records: [moving, finished] }));

    expect(page.running.count).toBe(2);
    expect(page.running.executing).toBe(1);

    const html = renderGlancePage(page);
    expect(html).toContain('1 in flight');
    expect(html).toContain('1 waiting for your review');
  });
});
