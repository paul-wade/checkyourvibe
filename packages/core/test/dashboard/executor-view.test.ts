import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildExecutorView,
  readExecutorView,
  type ExecutorDispatches,
  type ExecutorView,
} from '../../src/dashboard/executor-view.js';
import { renderExecutor } from '../../src/dashboard/render.js';
import { foldDispatchEntries } from '../../src/executor/store.js';
import type { DispatchEntry } from '../../src/executor/dispatch.js';
import type { LaneDeclaration } from '../../src/executor/lane.js';

/**
 * One dispatch log covering the four states Requirement 10 has to keep apart:
 * a dispatch in flight, one that succeeded with observed effect, one classified
 * `produced-nothing`, and the lane that outcome put into cooldown. A scheduling
 * refusal is included too, because Requirement 10.4 puts both refusal kinds on
 * the list a person has to read.
 */
function fixtureEntries(): DispatchEntry[] {
  return [
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-succeeded',
      workId: 'w-1',
      attempt: 1,
      openedAt: '2026-08-29T10:00:00.000Z',
      declaration: {
        task: 'Rename the parser entry point',
        taskKind: 'mechanical-transformation',
        ownedPaths: ['src/parse.ts'],
        expectsFileChanges: true,
        gates: ['typecheck'],
      },
      assignment: {
        laneId: 'lane-alpha',
        agentId: 'agent-alpha',
        model: 'alpha-small',
        billing: 'subscription',
        permitsBilledOverage: false,
        orchestrator: false,
        declaredHeadroomAtSchedule: 2,
      },
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-succeeded',
      closedAt: '2026-08-29T10:04:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [{ gate: 'typecheck', passed: true }],
      outcome: {
        kind: 'succeeded',
        summary: 'changed 1 declared file(s) and every gate passed',
        changedPaths: ['src/parse.ts'],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-nothing',
      workId: 'w-2',
      attempt: 1,
      openedAt: '2026-08-29T10:05:00.000Z',
      declaration: {
        task: 'Tighten the ownership check',
        taskKind: 'judgment-required',
        ownedPaths: ['src/ownership.ts'],
        expectsFileChanges: true,
        gates: ['typecheck'],
      },
      assignment: {
        laneId: 'lane-beta',
        agentId: 'agent-beta',
        model: 'beta-small',
        billing: 'subscription',
        permitsBilledOverage: true,
        orchestrator: false,
        declaredHeadroomAtSchedule: 1,
      },
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-nothing',
      closedAt: '2026-08-29T10:06:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [],
      outcome: {
        kind: 'produced-nothing',
        summary: 'the executor reported success and none of its declared files changed',
        changedPaths: [],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-running',
      workId: 'w-2',
      attempt: 2,
      openedAt: '2026-08-29T10:07:00.000Z',
      declaration: {
        task: 'Tighten the ownership check',
        taskKind: 'judgment-required',
        ownedPaths: ['src/ownership.ts'],
        expectsFileChanges: true,
        gates: ['typecheck'],
      },
      assignment: {
        laneId: 'lane-alpha',
        agentId: 'agent-alpha',
        model: 'alpha-small',
        billing: 'subscription',
        permitsBilledOverage: false,
        orchestrator: true,
        declaredHeadroomAtSchedule: 3,
      },
      escalation: {
        fromLaneId: 'lane-beta',
        fromModel: 'beta-small',
        reason: 'rate-exhaustion',
        detail: 'the executor reported success and none of its declared files changed',
        priorDispatchId: 'd-nothing',
      },
    },
    {
      event: 'refused',
      schemaVersion: 1,
      dispatchId: 'd-refused',
      workId: 'w-3',
      refusedAt: '2026-08-29T10:08:00.000Z',
      declaration: {
        task: 'Rewrite the ownership check a second time',
        taskKind: 'mechanical-transformation',
        ownedPaths: ['src/ownership.ts'],
        expectsFileChanges: true,
        gates: ['typecheck'],
      },
      refusal: {
        reason: 'overlapping-ownership',
        conflicts: [
          { withDispatchId: 'd-running', laneId: 'lane-alpha', paths: ['src/ownership.ts'] },
        ],
      },
    },
    {
      event: 'refused',
      schemaVersion: 1,
      dispatchId: 'd-blocked',
      workId: 'w-4',
      refusedAt: '2026-08-29T10:09:00.000Z',
      declaration: {
        task: 'Document the dispatch record',
        taskKind: 'judgment-required',
        ownedPaths: ['docs/dispatch.md'],
        expectsFileChanges: true,
        gates: ['typecheck'],
      },
      refusal: {
        reason: 'no-eligible-lane',
        rejections: [
          {
            laneId: 'lane-alpha',
            reason: { reason: 'at-concurrency-cap', concurrencyCap: 3, inFlight: 3 },
          },
          {
            laneId: 'lane-beta',
            reason: { reason: 'in-cooldown', since: '2026-08-29T10:06:00.000Z', cause: 'produced-nothing' },
          },
          { laneId: 'lane-metered', reason: { reason: 'metered-not-named' } },
        ],
      },
    },
  ];
}

function fixtureView(lanes: readonly LaneDeclaration[] = []): ExecutorView {
  return buildExecutorView({
    log: foldDispatchEntries(fixtureEntries()),
    lanes,
    logPresent: true,
  });
}

function populated(view: ExecutorView): ExecutorDispatches {
  if (view.kind !== 'dispatches') {
    throw new Error(`Expected a populated executor view, got ${view.kind}.`);
  }
  return view;
}

const NOW = Date.parse('2026-08-29T10:10:00.000Z');

/**
 * The rendered HTML is written across source lines, so a sentence a reader sees
 * as one run of text can carry a newline and indentation in the middle of it.
 * Collapsing runs of whitespace lets an assertion name the sentence rather than
 * the way it happens to be wrapped in the template literal.
 */
function flat(html: string): string {
  return html.replace(/\s+/g, ' ');
}

describe('buildExecutorView folds the dispatch log and derives nothing else', () => {
  it('separates in-flight from completed dispatches', () => {
    const view = populated(fixtureView());

    expect(view.inFlight.map((r) => r.dispatchId)).toEqual(['d-running']);
    expect(view.completed.map((r) => r.dispatchId)).toEqual(['d-nothing', 'd-succeeded']);
  });

  it('counts each lane running dispatches from the open records alone', () => {
    const view = populated(fixtureView());
    const alpha = view.lanes.find((lane) => lane.laneId === 'lane-alpha');
    const beta = view.lanes.find((lane) => lane.laneId === 'lane-beta');

    expect(alpha?.concurrency.running).toBe(1);
    expect(beta?.concurrency.running).toBe(0);
  });

  it('reads a lane cap the log recorded rather than reconstructing one', () => {
    const view = populated(fixtureView());
    const alpha = view.lanes.find((lane) => lane.laneId === 'lane-alpha');
    const beta = view.lanes.find((lane) => lane.laneId === 'lane-beta');

    expect(alpha?.concurrency.declaredCap).toBe(3);
    expect(alpha?.concurrency.source).toBe('recorded-refusal');
    // No refusal ever named lane-beta at its cap, so no denominator is invented.
    expect(beta?.concurrency.declaredCap).toBeUndefined();
    expect(beta?.concurrency.source).toBe('unrecorded');
  });

  it('prefers a supplied lane declaration for the cap and the label', () => {
    const declaration: LaneDeclaration = {
      id: 'lane-beta',
      agentId: 'agent-beta',
      concurrencyCap: 2,
      billing: { kind: 'metered', permitsBilledOverage: true },
      models: [{ kind: 'judgment-required', ordering: ['beta-large', 'beta-small'] }],
      orchestrator: false,
    };
    const view = populated(fixtureView([declaration]));
    const beta = view.lanes.find((lane) => lane.laneId === 'lane-beta');

    expect(beta?.declared).toBe(true);
    expect(beta?.concurrency.declaredCap).toBe(2);
    expect(beta?.concurrency.source).toBe('declaration');
    expect(beta?.label).toContain('metered — billed per use');
  });

  it('holds cooldown and at-cap apart as separate lane states', () => {
    const view = populated(fixtureView());
    const alpha = view.lanes.find((lane) => lane.laneId === 'lane-alpha');
    const beta = view.lanes.find((lane) => lane.laneId === 'lane-beta');

    // beta is in cooldown from its produced-nothing outcome, and nothing is
    // running on it; alpha is running work and is not in cooldown.
    expect(beta?.cooldown?.reason).toBe('produced-nothing');
    expect(beta?.atCap).toBe(false);
    expect(alpha?.cooldown).toBeUndefined();
  });

  it('surfaces every outcome and refusal that needs a person, newest first', () => {
    const view = populated(fixtureView());

    expect(view.attention.map((item) => item.dispatchId)).toEqual([
      'd-blocked',
      'd-refused',
      'd-nothing',
    ]);
  });

  it('reports no dispatches distinctly from dispatches that need nobody', () => {
    const absent = buildExecutorView({ log: { records: [], refusals: [] }, logPresent: false });
    const present = buildExecutorView({ log: { records: [], refusals: [] }, logPresent: true });

    expect(absent).toEqual({ kind: 'no-dispatches', logPresent: false });
    expect(present).toEqual({ kind: 'no-dispatches', logPresent: true });
  });
});

describe('renderExecutor states capacity without claiming to read an account', () => {
  it('shows a running count against a declared cap and never a percentage', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));

    expect(html).toContain('1 of 3, against a cap taken from');
    expect(html).not.toContain('%');
    expect(html).toContain('not a reading of');
  });

  it('reports no cost figure of any kind', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));

    expect(html).not.toContain('$');
    expect(html).toContain('subscription, configured to permit billed overage');
  });

  it('renders cooldown as cooldown, apart from being at the concurrency cap', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));

    expect(html).toContain('>cooldown<');
    expect(html).toContain('In cooldown since 2026-08-29T10:06:00.000Z');
    expect(html).toContain('at its declared concurrency cap: 3 of 3 running');
    expect(html).toContain('separate states with');
  });

  it('names the lane, the model, and the objective the model was requested under', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));

    expect(html).toContain('alpha-small');
    expect(html).toContain('the weakest model this lane declares for this task kind');
    expect(html).toContain('3 declared headroom at the moment it was scheduled');
    expect(html).toContain('judgment-required');
  });

  it('reports an escalation as a move between lanes with its reason', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));

    expect(html).toContain('Escalated to this lane');
    expect(html).toContain('lane-beta');
    expect(html).toContain('rate-exhaustion');
    expect(html).toContain('d-nothing');
  });

  it('labels a lane the log only ever passed over for being metered', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));
    // The lane cards, not the refusal above them that also names this lane.
    const lanes = html.slice(html.indexOf('<h3>Lanes</h3>'));
    const metered = lanes.slice(lanes.indexOf('<code>lane-metered</code>'));

    expect(metered).toContain('metered — billed per use');
    expect(metered).toContain('No dispatch in this log ran on this lane');
    // A lane the page knows nothing about beyond one refusal is not reported as
    // ready for work.
    expect(metered).not.toContain('accepting dispatches');
  });

  it('lists both refusal kinds without a record having to be opened', () => {
    const html = flat(renderExecutor(fixtureView(), NOW));

    expect(html).toContain('3 item(s) need a person');
    expect(html).toContain('Refused before it ran: overlapping file ownership');
    expect(html).toContain('Blocked: no lane was a candidate');
    expect(html).toContain('the core never selects a metered lane on its own');
  });

  it('says why it has nothing to say when no dispatch needs anybody', () => {
    const entries = fixtureEntries().filter((entry) => entry.dispatchId === 'd-succeeded');
    const html = flat(
      renderExecutor(buildExecutorView({ log: foldDispatchEntries(entries), logPresent: true }), NOW),
    );

    expect(html).toContain('Nothing needs a person');
    expect(html).toContain('1 dispatch(es) and 0 scheduling refusal(s) recorded');
  });

  it('says why it has nothing to say when no dispatch was ever recorded', () => {
    const html = flat(renderExecutor({ kind: 'no-dispatches', logPresent: false }, NOW));

    expect(html).toContain('No dispatches are recorded');
    expect(html).toContain('nothing has been dispatched from this repository');
  });

  it('distinguishes an unreadable log from an absent one', () => {
    const html = flat(renderExecutor({ kind: 'no-dispatches', logPresent: true }, NOW));

    expect(html).toContain('holds no readable entry');
    expect(html).not.toContain('nothing has been dispatched from this repository');
  });
});

describe('readExecutorView reads only what is on disk', () => {
  it('reports the absent log when no dispatch has ever run', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-executor-'));

    expect(await readExecutorView(repo)).toEqual({ kind: 'no-dispatches', logPresent: false });
  });

  it('folds an on-disk log and counts the lines it could not read', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-executor-'));
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    const lines = fixtureEntries().map((entry) => JSON.stringify(entry));
    await writeFile(
      join(repo, '.cyv-review', 'dispatches.ndjson'),
      `${lines.join('\n')}\n{ not json\n`,
      'utf-8',
    );

    const view = populated(await readExecutorView(repo));

    expect(view.recordCount).toBe(3);
    expect(view.refusalCount).toBe(2);
    expect(view.unparseableLines).toBe(1);
    expect(view.attention).toHaveLength(3);
  });
});

/**
 * A repository that declares lanes and has never dispatched. The lanes are the
 * two flat-rate shapes and the metered one a configuration can hold, so the
 * page's billing labelling is exercised on a lane no record mentions.
 */
function declaredOnlyLanes(): LaneDeclaration[] {
  return [
    {
      id: 'claude-code-main',
      agentId: 'claude-code',
      concurrencyCap: 2,
      billing: { kind: 'subscription', permitsBilledOverage: false },
      models: [{ kind: 'judgment-required', ordering: ['opus-4', 'sonnet-4'] }],
      orchestrator: true,
    },
    {
      id: 'codex',
      agentId: 'codex',
      concurrencyCap: 1,
      billing: { kind: 'subscription', permitsBilledOverage: false },
      models: [{ kind: 'mechanical-transformation', ordering: ['gpt-5-codex', 'gpt-5-codex-mini'] }],
      orchestrator: false,
    },
    {
      id: 'codex-api',
      agentId: 'codex',
      concurrencyCap: 4,
      billing: { kind: 'metered', permitsBilledOverage: true },
      models: [{ kind: 'mechanical-transformation', ordering: ['gpt-5-pro', 'gpt-5'] }],
      orchestrator: false,
    },
  ];
}

function emptyView(lanes: readonly LaneDeclaration[], logPresent = false): ExecutorView {
  return buildExecutorView({ log: { records: [], refusals: [] }, lanes, logPresent });
}

describe('a repository that declared lanes and has not dispatched', () => {
  it('carries the declarations through the empty state', () => {
    const view = emptyView(declaredOnlyLanes());

    expect(view.kind).toBe('no-dispatches');
    if (view.kind !== 'no-dispatches') return;
    expect(view.declaredLanes?.map((lane) => lane.id)).toEqual([
      'claude-code-main',
      'codex',
      'codex-api',
    ]);
  });

  it('carries no declarations when the repository declares none', () => {
    expect(emptyView([])).toEqual({ kind: 'no-dispatches', logPresent: false });
  });

  it('names each declared lane, its agent, its cap and its models', () => {
    const html = flat(renderExecutor(emptyView(declaredOnlyLanes()), NOW));

    expect(html).toContain('<code>claude-code-main</code>');
    expect(html).toContain('<code>codex-api</code>');
    expect(html).toContain('2 simultaneous dispatch(es)');
    expect(html).toContain('<code>gpt-5-codex</code> &rarr; <code>gpt-5-codex-mini</code>');
    expect(html).toContain('orchestrator');
  });

  it('labels the metered lane as billed per use where it is named', () => {
    const html = flat(renderExecutor(emptyView(declaredOnlyLanes()), NOW));

    expect(html).toContain('metered — billed per use, configured to permit billed overage');
    expect(html).toContain('never selects a metered lane on its own');
  });

  it('says the declarations are configuration and not something that ran', () => {
    const html = flat(renderExecutor(emptyView(declaredOnlyLanes()), NOW));

    expect(html).toContain('No dispatches are recorded');
    expect(html).toContain('nothing has been dispatched from this repository');
    expect(html).not.toContain('in cooldown');
    expect(html).not.toContain('Needs a person');
    expect(html).not.toContain('%');
  });

  it('keeps the absent log and the unreadable log apart while showing the same lanes', () => {
    const absent = flat(renderExecutor(emptyView(declaredOnlyLanes(), false), NOW));
    const unreadable = flat(renderExecutor(emptyView(declaredOnlyLanes(), true), NOW));

    expect(absent).toContain('nothing has been dispatched from this repository');
    expect(absent).not.toContain('holds no readable entry');
    expect(unreadable).toContain('holds no readable entry');
    expect(unreadable).not.toContain('nothing has been dispatched from this repository');
    expect(unreadable).toContain('<code>claude-code-main</code>');
  });

  it('reaches the same state through readExecutorView with no log on disk', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-executor-declared-'));
    const view = await readExecutorView(repo, declaredOnlyLanes());

    expect(view).toEqual({
      kind: 'no-dispatches',
      logPresent: false,
      declaredLanes: declaredOnlyLanes(),
    });
  });

  it('draws no lane section at all when no lane is declared', () => {
    const html = flat(renderExecutor(emptyView([]), NOW));

    expect(html).not.toContain('Declared lanes');
    expect(html).toContain('No dispatches are recorded');
  });
});
