/**
 * Lanes declared in `checkyourvibe.json` reaching the two surfaces that take
 * `LaneDeclaration[]`: the scheduler and the localhost view.
 */
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, configuredLanes, loadConfig } from '../../src/config/index.js';
import { scheduleDispatch, laneRejections, type LaneRuntime } from '../../src/executor/schedule.js';
import { readExecutorView } from '../../src/dashboard/executor-view.js';
import { openDispatch } from '../../src/executor/store.js';
import type { LaneDeclaration } from '../../src/executor/lane.js';
import { declaration, running } from './fixtures.js';

const CONFIG = {
  executor: {
    lanes: [
      {
        id: 'claude-code',
        agentId: 'claude-code',
        concurrencyCap: 2,
        orchestrator: true,
        billing: { kind: 'subscription' },
        models: [
          { kind: 'mechanical-transformation', ordering: ['opus-4', 'sonnet-4', 'haiku-4'] },
          { kind: 'judgment-required', ordering: ['opus-4', 'sonnet-4'] },
        ],
      },
      {
        id: 'codex',
        agentId: 'codex',
        concurrencyCap: 1,
        billing: { kind: 'subscription' },
        models: [
          { kind: 'mechanical-transformation', ordering: ['gpt-5-codex', 'gpt-5-codex-mini'] },
        ],
      },
      {
        id: 'codex-api',
        agentId: 'codex',
        concurrencyCap: 4,
        billing: { kind: 'metered', permitsBilledOverage: true },
        models: [
          { kind: 'mechanical-transformation', ordering: ['gpt-5-pro', 'gpt-5'] },
          { kind: 'judgment-required', ordering: ['gpt-5-pro', 'gpt-5'] },
        ],
      },
    ],
    meteredLanesEnabled: ['codex-api'],
  },
};

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-config-lanes-'));
  await mkdir(join(dir, '.git'));
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schemaDir = join(dir, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), await readFile(schemaUrl, 'utf-8'));
  await writeFile(join(dir, CONFIG_FILENAME), JSON.stringify(CONFIG, null, 2));
  return dir;
}

async function declaredLanes(repoRoot: string): Promise<readonly LaneDeclaration[]> {
  return configuredLanes(await loadConfig(repoRoot));
}

function runtimesOf(
  lanes: readonly LaneDeclaration[],
  inFlightByLane: ReadonlyMap<string, number>,
): LaneRuntime[] {
  return lanes.map((lane) => ({
    lane,
    inFlight: Array.from({ length: inFlightByLane.get(lane.id) ?? 0 }, (_unused, index) =>
      running(`${lane.id}-${index}`, [`src/${lane.id}-${index}.ts`]),
    ),
  }));
}

describe('configured lanes reaching the scheduler', () => {
  it('schedules on the declared lane with the most headroom, asking for its weakest model', async () => {
    const repo = await makeRepo();
    try {
      const lanes = await declaredLanes(repo);
      const request = {
        dispatchId: 'd1',
        taskKind: 'mechanical-transformation',
        ownedPaths: declaration().ownedPaths,
      };
      const runtimes = runtimesOf(lanes, new Map());
      const decision = scheduleDispatch(request, runtimes);

      expect(decision).toEqual({
        decision: 'scheduled',
        laneId: 'codex',
        agentId: 'codex',
        model: 'gpt-5-codex-mini',
        declaredHeadroom: 1,
      });
      expect(laneRejections(request, runtimes)).toContainEqual({
        laneId: 'claude-code',
        reason: { reason: 'does-not-accept-dispatch', orchestrator: true },
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('never selects the declared metered lane on its own, even when it alone has room', async () => {
    const repo = await makeRepo();
    try {
      const lanes = await declaredLanes(repo);
      const decision = scheduleDispatch(
        {
          dispatchId: 'd2',
          taskKind: 'mechanical-transformation',
          ownedPaths: ['src/only.ts'],
        },
        runtimesOf(
          lanes,
          new Map([
            ['claude-code', 2],
            ['codex', 1],
          ]),
        ),
      );

      expect(decision.decision).toBe('refused');
      if (decision.decision !== 'refused' || decision.refusal.reason !== 'no-eligible-lane') {
        throw new Error('expected a no-eligible-lane refusal');
      }
      const reasons = decision.refusal.rejections.map((rejection) => [
        rejection.laneId,
        rejection.reason.reason,
      ]);
      expect(reasons).toEqual([
        ['claude-code', 'does-not-accept-dispatch'],
        ['codex', 'at-concurrency-cap'],
        ['codex-api', 'metered-not-named'],
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reaches the declared metered lane when the dispatch names it', async () => {
    const repo = await makeRepo();
    try {
      const lanes = await declaredLanes(repo);
      const decision = scheduleDispatch(
        {
          dispatchId: 'd3',
          taskKind: 'judgment-required',
          ownedPaths: ['src/only.ts'],
          laneId: 'codex-api',
        },
        runtimesOf(lanes, new Map()),
      );

      expect(decision).toEqual({
        decision: 'scheduled',
        laneId: 'codex-api',
        agentId: 'codex',
        model: 'gpt-5',
        declaredHeadroom: 4,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses a task kind the declared lane offers no ordering for', async () => {
    const repo = await makeRepo();
    try {
      const lanes = await declaredLanes(repo);
      const decision = scheduleDispatch(
        { dispatchId: 'd4', taskKind: 'judgment-required', ownedPaths: ['src/only.ts'] },
        runtimesOf(lanes, new Map([['claude-code', 2]])),
      );

      expect(decision.decision).toBe('refused');
      if (decision.decision !== 'refused' || decision.refusal.reason !== 'no-eligible-lane') {
        throw new Error('expected a no-eligible-lane refusal');
      }
      expect(
        decision.refusal.rejections.find((rejection) => rejection.laneId === 'codex')?.reason,
      ).toEqual({ reason: 'no-model-for-kind', taskKind: 'judgment-required' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('configured lanes reaching the localhost view', () => {
  it('reports a declared cap, and at-cap, for a lane no refusal in the log names', async () => {
    const repo = await makeRepo();
    try {
      const lanes = await declaredLanes(repo);
      await openDispatch(repo, {
        dispatchId: 'd1',
        workId: 'w1',
        attempt: 1,
        openedAt: '2026-08-29T10:00:00.000Z',
        declaration: declaration(),
        assignment: {
          laneId: 'codex',
          agentId: 'codex',
          model: 'gpt-5-codex-mini',
          billing: 'subscription',
          permitsBilledOverage: false,
          orchestrator: false,
          declaredHeadroomAtSchedule: 1,
        },
      });

      const view = await readExecutorView(repo, lanes);
      if (view.kind !== 'dispatches') {
        throw new Error('expected the view to hold dispatches');
      }

      const codex = view.lanes.find((lane) => lane.laneId === 'codex');
      expect(codex?.concurrency).toEqual({ running: 1, declaredCap: 1, source: 'declaration' });
      expect(codex?.atCap).toBe(true);
      expect(view.refusalCount).toBe(0);

      const metered = view.lanes.find((lane) => lane.laneId === 'codex-api');
      expect(metered?.label).toBe('codex-api (metered — billed per use, configured to permit billed overage)');
      expect(metered?.concurrency.declaredCap).toBe(4);
      expect(metered?.declared).toBe(true);

      const orchestrator = view.lanes.find((lane) => lane.laneId === 'claude-code');
      expect(orchestrator?.orchestrator).toBe(true);
      expect(orchestrator?.concurrency.declaredCap).toBe(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps the empty case when no lane is declared', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-config-lanes-none-'));
    try {
      const view = await readExecutorView(repo, []);
      expect(view).toEqual({ kind: 'no-dispatches', logPresent: false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
