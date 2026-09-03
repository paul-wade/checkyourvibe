import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_ATTEMPTS,
  decideEscalation,
  runWorkWithEscalation,
} from '../../src/executor/escalate.js';
import { classifyOutcome, type DispatchOutcome } from '../../src/executor/outcome.js';
import { readDispatchLog } from '../../src/executor/store.js';
import type { DispatchAssignment } from '../../src/executor/dispatch.js';
import type { GateRunner } from '../../src/executor/run.js';
import { declaration, lane, report } from './fixtures.js';

const assignment: DispatchAssignment = {
  laneId: 'alpha',
  agentId: 'alpha-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 2,
};

function outcomeWith(gatePassed: boolean): DispatchOutcome {
  return classifyOutcome({
    expectsFileChanges: true,
    ownedPaths: ['src/a.ts'],
    changedPaths: ['src/a.ts'],
    gates: [{ gate: 'tsc', passed: gatePassed }],
    report: report('success', { exitCode: 0 }),
  });
}

describe('decideEscalation', () => {
  const gatesFailed = outcomeWith(false);

  it('moves one step up the lane ordering after an observed gate failure', () => {
    const decision = decideEscalation({
      lane: lane({ id: 'alpha' }),
      taskKind: 'mechanical-transformation',
      model: 'weak',
      dispatchId: 'd1',
      outcome: gatesFailed,
      attempt: 1,
    });

    expect(decision).toEqual({
      escalate: true,
      model: 'middle',
      escalation: {
        fromLaneId: 'alpha',
        fromModel: 'weak',
        reason: 'gate-failure',
        detail: 'gates failed: tsc',
        priorDispatchId: 'd1',
      },
    });
  });

  it('does not escalate an outcome that is not a gate failure', () => {
    for (const outcome of [outcomeWith(true), producedNothing()]) {
      const decision = decideEscalation({
        lane: lane({ id: 'alpha' }),
        taskKind: 'mechanical-transformation',
        model: 'weak',
        dispatchId: 'd1',
        outcome,
        attempt: 1,
      });

      expect(decision).toEqual({
        escalate: false,
        block: { reason: 'outcome-is-not-a-gate-failure', outcome: outcome.kind },
      });
    }
  });

  it('stops at the configured bound', () => {
    const decision = decideEscalation({
      lane: lane({ id: 'alpha' }),
      taskKind: 'mechanical-transformation',
      model: 'middle',
      dispatchId: 'd2',
      outcome: gatesFailed,
      attempt: 2,
      maxAttempts: 2,
    });

    expect(decision).toEqual({
      escalate: false,
      block: { reason: 'attempt-bound-reached', maxAttempts: 2 },
    });
  });

  it('defaults the bound to a finite number of attempts (Requirement 9.3)', () => {
    expect(Number.isFinite(DEFAULT_MAX_ATTEMPTS)).toBe(true);

    const decision = decideEscalation({
      lane: lane({ id: 'alpha' }),
      taskKind: 'mechanical-transformation',
      model: 'weak',
      dispatchId: 'd3',
      outcome: gatesFailed,
      attempt: DEFAULT_MAX_ATTEMPTS,
    });

    expect(decision).toEqual({
      escalate: false,
      block: { reason: 'attempt-bound-reached', maxAttempts: DEFAULT_MAX_ATTEMPTS },
    });
  });

  it('stops when the lane has nothing stronger for the kind', () => {
    const decision = decideEscalation({
      lane: lane({ id: 'alpha' }),
      taskKind: 'mechanical-transformation',
      model: 'strong',
      dispatchId: 'd3',
      outcome: gatesFailed,
      attempt: 2,
      maxAttempts: 9,
    });

    expect(decision).toEqual({
      escalate: false,
      block: { reason: 'no-stronger-model', model: 'strong' },
    });
  });

  it('stops when the lane declares no ordering for the kind', () => {
    const decision = decideEscalation({
      lane: lane({ id: 'alpha' }),
      taskKind: 'judgment-required',
      model: 'weak',
      dispatchId: 'd1',
      outcome: gatesFailed,
      attempt: 1,
    });

    expect(decision).toEqual({
      escalate: false,
      block: { reason: 'no-stronger-model', model: 'weak' },
    });
  });

  it('never re-dispatches on a metered lane (Requirements 1.5, 9.5)', () => {
    const decision = decideEscalation({
      lane: lane({ id: 'paid', metered: true }),
      taskKind: 'mechanical-transformation',
      model: 'weak',
      dispatchId: 'd1',
      outcome: gatesFailed,
      attempt: 1,
    });

    expect(decision).toEqual({
      escalate: false,
      block: { reason: 'metered-lane', laneId: 'paid' },
    });
  });
});

function producedNothing(): DispatchOutcome {
  return classifyOutcome({
    expectsFileChanges: true,
    ownedPaths: ['src/a.ts'],
    changedPaths: [],
    gates: [],
    report: report('success', { exitCode: 0 }),
  });
}

/**
 * A child that writes the model it was asked for into the declared file, and a
 * gate that accepts only what the strongest-named model wrote. The escalation
 * loop therefore has to reach that model for the work to pass.
 */
function writesItsModel(model: string): { command: string; args: readonly string[] } {
  const path = JSON.stringify(join('src', 'a.ts'));
  return {
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').mkdirSync('src',{recursive:true});` +
        `require('node:fs').writeFileSync(${path},${JSON.stringify(model)});`,
    ],
  };
}

function acceptsOnly(accepted: string, repo: string): GateRunner {
  return async (gate) => {
    const written = await readFile(join(repo, 'src', 'a.ts'), 'utf-8');
    return { gate, passed: written === accepted };
  };
}

describe('runWorkWithEscalation against real child processes', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-escalate-')));
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), 'untouched', 'utf-8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('retries one step up the ordering and records each attempt separately', async () => {
    const result = await runWorkWithEscalation({
      repoRoot: repo,
      workId: 'w1',
      lane: lane({ id: 'alpha' }),
      declaration: declaration(),
      assignment,
      commandFor: (context) => writesItsModel(context.model),
      gateRunner: acceptsOnly('middle', repo),
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.outcome.kind).toBe('succeeded');
    expect(result.stoppedBecause).toEqual({
      reason: 'outcome-is-not-a-gate-failure',
      outcome: 'succeeded',
    });

    const { records } = await readDispatchLog(repo);
    expect(records.map((r) => r.dispatchId)).toEqual(['w1-attempt-1', 'w1-attempt-2']);
    expect(records.map((r) => r.attempt)).toEqual([1, 2]);
    expect(records.map((r) => r.workId)).toEqual(['w1', 'w1']);
    expect(records.map((r) => r.assignment.model)).toEqual(['weak', 'middle']);
    expect(records[0]?.escalation).toBeUndefined();
    expect(records[1]?.escalation).toEqual({
      fromLaneId: 'alpha',
      fromModel: 'weak',
      reason: 'gate-failure',
      detail: 'gates failed: tsc',
      priorDispatchId: 'w1-attempt-1',
    });
    expect(records[0]?.closed?.outcome.kind).toBe('gates-failed');
    expect(records[1]?.closed?.outcome.kind).toBe('succeeded');
  });

  it('stops at the configured bound rather than retrying indefinitely', async () => {
    const result = await runWorkWithEscalation({
      repoRoot: repo,
      workId: 'w1',
      lane: lane({ id: 'alpha' }),
      declaration: declaration(),
      assignment,
      commandFor: (context) => writesItsModel(context.model),
      gateRunner: acceptsOnly('nothing this lane offers', repo),
      maxAttempts: 2,
    });

    expect(result.attempts).toHaveLength(2);
    expect(result.stoppedBecause).toEqual({ reason: 'attempt-bound-reached', maxAttempts: 2 });

    const { records } = await readDispatchLog(repo);
    expect(records.map((r) => r.assignment.model)).toEqual(['weak', 'middle']);
    expect(records.every((r) => r.closed?.outcome.kind === 'gates-failed')).toBe(true);
  });

  it('stops at the top of the ordering when the bound allows more attempts', async () => {
    const result = await runWorkWithEscalation({
      repoRoot: repo,
      workId: 'w1',
      lane: lane({ id: 'alpha' }),
      declaration: declaration(),
      assignment,
      commandFor: (context) => writesItsModel(context.model),
      gateRunner: acceptsOnly('nothing this lane offers', repo),
      maxAttempts: 9,
    });

    expect(result.attempts).toHaveLength(3);
    expect(result.stoppedBecause).toEqual({ reason: 'no-stronger-model', model: 'strong' });

    const { records } = await readDispatchLog(repo);
    expect(records.map((r) => r.assignment.model)).toEqual(['weak', 'middle', 'strong']);
    expect(records.map((r) => r.escalation?.fromModel)).toEqual([undefined, 'weak', 'middle']);
  });

  it('does not escalate an exit-0 child that produced nothing', async () => {
    const result = await runWorkWithEscalation({
      repoRoot: repo,
      workId: 'w1',
      lane: lane({ id: 'alpha' }),
      declaration: declaration(),
      assignment,
      commandFor: () => ({
        command: process.execPath,
        args: ['-e', "process.stdout.write('all good');"],
      }),
      gateRunner: (gate) => ({ gate, passed: true }),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.outcome.kind).toBe('produced-nothing');
    expect(result.stoppedBecause).toEqual({
      reason: 'outcome-is-not-a-gate-failure',
      outcome: 'produced-nothing',
    });
  });

  it('does not escalate an out-of-scope write', async () => {
    const outside = JSON.stringify(join('docs', 'notes.md'));
    const result = await runWorkWithEscalation({
      repoRoot: repo,
      workId: 'w1',
      lane: lane({ id: 'alpha' }),
      declaration: declaration(),
      assignment,
      commandFor: () => ({
        command: process.execPath,
        args: [
          '-e',
          `require('node:fs').mkdirSync('docs',{recursive:true});` +
            `require('node:fs').writeFileSync(${outside},'not mine');`,
        ],
      }),
      gateRunner: (gate) => ({ gate, passed: true }),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.outcome.kind).toBe('out-of-scope-write');
    expect(result.stoppedBecause).toEqual({
      reason: 'outcome-is-not-a-gate-failure',
      outcome: 'out-of-scope-write',
    });
  });

  it('names the model in the command it builds for each attempt', async () => {
    const asked: string[] = [];

    await runWorkWithEscalation({
      repoRoot: repo,
      workId: 'w1',
      lane: lane({ id: 'alpha' }),
      declaration: declaration(),
      assignment,
      commandFor: (context) => {
        asked.push(`${context.attempt}:${context.model}:${context.escalation?.reason ?? 'first'}`);
        return writesItsModel(context.model);
      },
      gateRunner: acceptsOnly('strong', repo),
    });

    expect(asked).toEqual(['1:weak:first', '2:middle:gate-failure', '3:strong:gate-failure']);
  });
});
