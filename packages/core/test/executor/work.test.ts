import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchWork } from '../../src/executor/work.js';
import { openDispatch, readDispatchLog } from '../../src/executor/store.js';
import type { ChildCommand } from '../../src/executor/child.js';
import type { DispatchAssignment } from '../../src/executor/dispatch.js';
import { declaration, lane } from './fixtures.js';

function writesTo(relativePath: string, content: string): ChildCommand {
  const path = JSON.stringify(relativePath);
  return {
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').mkdirSync(require('node:path').dirname(${path}),{recursive:true});` +
        `require('node:fs').writeFileSync(${path},${JSON.stringify(content)});`,
    ],
  };
}

const inFlightAssignment: DispatchAssignment = {
  laneId: 'alpha',
  agentId: 'alpha-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 2,
};

describe('dispatchWork', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-work-')));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), 'before', 'utf-8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs on the weakest model of the lane with the most declared headroom', async () => {
    const result = await dispatchWork({
      repoRoot: repo,
      workId: 'w1',
      lanes: [lane({ id: 'alpha', concurrencyCap: 1 }), lane({ id: 'beta', concurrencyCap: 4 })],
      declaration: declaration(),
      commandFor: () => writesTo(join('src', 'a.ts'), 'after'),
      gateRunner: (gate) => ({ gate, passed: true }),
    });

    expect(result.scheduled).toBe(true);
    const { records } = await readDispatchLog(repo);
    expect(records[0]?.assignment).toMatchObject({
      laneId: 'beta',
      agentId: 'beta-agent',
      model: 'weak',
      billing: 'subscription',
      declaredHeadroomAtSchedule: 4,
    });
    expect(records[0]?.closed?.outcome.kind).toBe('succeeded');
  });

  it('refuses a dispatch overlapping one already in flight and records the refusal', async () => {
    await openDispatch(repo, {
      dispatchId: 'already-running',
      workId: 'w0',
      attempt: 1,
      openedAt: '2026-01-01T00:00:00.000Z',
      declaration: declaration({ ownedPaths: ['src'] }),
      assignment: inFlightAssignment,
    });

    const result = await dispatchWork({
      repoRoot: repo,
      workId: 'w1',
      lanes: [lane({ id: 'alpha' })],
      declaration: declaration({ ownedPaths: ['src/a.ts'] }),
      commandFor: () => writesTo(join('src', 'a.ts'), 'after'),
      gateRunner: (gate) => ({ gate, passed: true }),
      now: () => new Date('2026-01-01T00:01:00.000Z'),
    });

    expect(result.scheduled).toBe(false);
    const { records, refusals } = await readDispatchLog(repo);
    expect(records.map((r) => r.dispatchId)).toEqual(['already-running']);
    expect(refusals[0]?.dispatchId).toBe('w1-attempt-1');
    expect(refusals[0]?.refusal).toEqual({
      reason: 'overlapping-ownership',
      conflicts: [{ withDispatchId: 'already-running', laneId: 'alpha', paths: ['src/a.ts'] }],
    });
  });

  it('records why every lane was rejected when none can take the work', async () => {
    const result = await dispatchWork({
      repoRoot: repo,
      workId: 'w1',
      lanes: [lane({ id: 'alpha' }), lane({ id: 'paid', metered: true })],
      declaration: declaration({ taskKind: 'judgment-required' }),
      commandFor: () => writesTo(join('src', 'a.ts'), 'after'),
      gateRunner: (gate) => ({ gate, passed: true }),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.scheduled).toBe(false);
    const { refusals } = await readDispatchLog(repo);
    expect(refusals[0]?.refusal).toEqual({
      reason: 'no-eligible-lane',
      rejections: [
        { laneId: 'alpha', reason: { reason: 'no-model-for-kind', taskKind: 'judgment-required' } },
        { laneId: 'paid', reason: { reason: 'metered-not-named' } },
      ],
    });
  });

  it('leaves a metered lane out of a choice the core makes on its own', async () => {
    const result = await dispatchWork({
      repoRoot: repo,
      workId: 'w1',
      lanes: [lane({ id: 'paid', metered: true, concurrencyCap: 9 })],
      declaration: declaration(),
      commandFor: () => writesTo(join('src', 'a.ts'), 'after'),
      gateRunner: (gate) => ({ gate, passed: true }),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.scheduled).toBe(false);
    const { refusals } = await readDispatchLog(repo);
    expect(refusals[0]?.refusal).toMatchObject({
      rejections: [{ laneId: 'paid', reason: { reason: 'metered-not-named' } }],
    });
  });

  it('reads a lane into cooldown from the log a previous session wrote', async () => {
    const first = await dispatchWork({
      repoRoot: repo,
      workId: 'w1',
      lanes: [lane({ id: 'alpha' })],
      declaration: declaration(),
      commandFor: () => ({ command: process.execPath, args: ['-e', "process.exit(0);"] }),
      gateRunner: (gate) => ({ gate, passed: true }),
    });
    expect(first.scheduled).toBe(true);

    const second = await dispatchWork({
      repoRoot: repo,
      workId: 'w2',
      lanes: [lane({ id: 'alpha' })],
      declaration: declaration(),
      commandFor: () => writesTo(join('src', 'a.ts'), 'after'),
      gateRunner: (gate) => ({ gate, passed: true }),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(second.scheduled).toBe(false);
    const { refusals } = await readDispatchLog(repo);
    expect(refusals[0]?.refusal).toMatchObject({
      rejections: [{ laneId: 'alpha', reason: { reason: 'in-cooldown', cause: 'produced-nothing' } }],
    });
  });
});
