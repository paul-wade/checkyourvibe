import { describe, expect, it } from 'vitest';

import {
  classifyOutcome,
  diffSnapshots,
  indicatesRateExhaustion,
  isObservedEffectSuccess,
  needsHumanAttention,
  observeEffect,
  type OutcomeInput,
} from '../../src/executor/outcome.js';
import { report } from './fixtures.js';

function input(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    expectsFileChanges: overrides.expectsFileChanges ?? true,
    ownedPaths: overrides.ownedPaths ?? ['src/a.ts'],
    changedPaths: overrides.changedPaths ?? ['src/a.ts'],
    gates: overrides.gates ?? [{ gate: 'tsc', passed: true }],
    report: overrides.report ?? report('success', { exitCode: 0 }),
  };
}

describe('reported success, produced nothing (Requirement 2.3)', () => {
  it('is its own outcome when the executor reported success and nothing changed', () => {
    const outcome = classifyOutcome(input({ changedPaths: [] }));

    expect(outcome.kind).toBe('produced-nothing');
    expect(outcome.summary).toContain('none of its declared files changed');
  });

  it('is not folded into success even when every gate passed', () => {
    const outcome = classifyOutcome(
      input({ changedPaths: [], gates: [{ gate: 'tsc', passed: true }] }),
    );

    expect(outcome.kind).toBe('produced-nothing');
  });

  it('is not folded into an ordinary failure', () => {
    const producedNothing = classifyOutcome(input({ changedPaths: [] }));
    const failed = classifyOutcome(
      input({ changedPaths: [], report: report('failure', { exitCode: 1 }) }),
    );

    expect(producedNothing.kind).toBe('produced-nothing');
    expect(failed.kind).toBe('failed');
  });

  it('ignores the exit code as evidence of work: exit 0 with no change is not a success', () => {
    const outcome = classifyOutcome(input({ changedPaths: [], report: report('success', { exitCode: 0 }) }));

    expect(outcome.kind).not.toBe('succeeded');
  });

  it('ignores the exit code the other way: a non-zero exit that changed files and passed gates succeeds', () => {
    const outcome = classifyOutcome(
      input({ changedPaths: ['src/a.ts'], report: report('failure', { exitCode: 3 }) }),
    );

    expect(outcome.kind).toBe('succeeded');
  });

  it('puts the lane into cooldown and asks for a human (Requirements 7.4, 10.4)', () => {
    const outcome = classifyOutcome(input({ changedPaths: [] }));

    expect(indicatesRateExhaustion(outcome)).toBe(true);
    expect(needsHumanAttention(outcome)).toBe(true);
    expect(isObservedEffectSuccess(outcome)).toBe(false);
  });
});

describe('out-of-scope writes (Requirement 2.5)', () => {
  it('fails the dispatch regardless of exit code or gate results', () => {
    const outcome = classifyOutcome(
      input({
        ownedPaths: ['src/a.ts'],
        changedPaths: ['src/a.ts', 'src/elsewhere.ts'],
        gates: [{ gate: 'tsc', passed: true }],
        report: report('success', { exitCode: 0 }),
      }),
    );

    expect(outcome.kind).toBe('out-of-scope-write');
    expect(outcome.outOfScopePaths).toEqual(['src/elsewhere.ts']);
    expect(needsHumanAttention(outcome)).toBe(true);
  });

  it('accepts a write beneath a declared directory as in scope', () => {
    const outcome = classifyOutcome(
      input({ ownedPaths: ['src/api'], changedPaths: ['src/api/handler.ts'] }),
    );

    expect(outcome.kind).toBe('succeeded');
    expect(outcome.outOfScopePaths).toEqual([]);
  });
});

describe('dispatches that expect no file changes (Requirement 2.7)', () => {
  it('succeeds on gates alone when nothing changed', () => {
    const outcome = classifyOutcome(
      input({ expectsFileChanges: false, changedPaths: [], gates: [{ gate: 'tsc', passed: true }] }),
    );

    expect(outcome.kind).toBe('succeeded');
  });

  it('fails on gates alone when nothing changed and a gate failed', () => {
    const outcome = classifyOutcome(
      input({
        expectsFileChanges: false,
        changedPaths: [],
        gates: [{ gate: 'tsc', passed: false }, { gate: 'tests', passed: true }],
      }),
    );

    expect(outcome.kind).toBe('gates-failed');
    expect(outcome.failedGates).toEqual(['tsc']);
  });

  it('reports a dispatch that changed files anyway', () => {
    const outcome = classifyOutcome(
      input({ expectsFileChanges: false, changedPaths: ['src/a.ts'] }),
    );

    expect(outcome.kind).toBe('changed-files-unexpectedly');
    expect(needsHumanAttention(outcome)).toBe(true);
  });

  it('does not report a no-change dispatch as produced-nothing', () => {
    const declared = classifyOutcome(input({ expectsFileChanges: false, changedPaths: [] }));
    const undeclared = classifyOutcome(input({ expectsFileChanges: true, changedPaths: [] }));

    expect(declared.kind).toBe('succeeded');
    expect(undeclared.kind).toBe('produced-nothing');
  });
});

describe('gates and other outcomes', () => {
  it('fails when files changed and a gate failed', () => {
    const outcome = classifyOutcome(
      input({ gates: [{ gate: 'tsc', passed: false, detail: 'TS2322' }] }),
    );

    expect(outcome.kind).toBe('gates-failed');
    expect(outcome.failedGates).toEqual(['tsc']);
    expect(isObservedEffectSuccess(outcome)).toBe(false);
  });

  it('records an explicit rate-limit error as its own outcome (Requirement 3.3)', () => {
    const outcome = classifyOutcome(
      input({ changedPaths: [], report: report('failure', { rateLimited: true }) }),
    );

    expect(outcome.kind).toBe('rate-limited');
    expect(indicatesRateExhaustion(outcome)).toBe(true);
  });

  it('records a dispatch that never completed', () => {
    const outcome = classifyOutcome(input({ changedPaths: [], report: report('did-not-complete') }));

    expect(outcome.kind).toBe('did-not-complete');
    expect(needsHumanAttention(outcome)).toBe(true);
    expect(indicatesRateExhaustion(outcome)).toBe(false);
  });

  it('counts a success with observed change as the only thing that clears cooldown', () => {
    const changed = classifyOutcome(input({ changedPaths: ['src/a.ts'] }));
    const gateOnly = classifyOutcome(input({ expectsFileChanges: false, changedPaths: [] }));

    expect(isObservedEffectSuccess(changed)).toBe(true);
    expect(isObservedEffectSuccess(gateOnly)).toBe(false);
  });
});

describe('observed effect from the file system (Requirement 2.6)', () => {
  it('reports added, removed and modified paths from two snapshots', () => {
    const before = new Map([
      ['src/a.ts', 'digest-a'],
      ['src/gone.ts', 'digest-g'],
      ['src/same.ts', 'digest-s'],
    ]);
    const after = new Map([
      ['src/a.ts', 'digest-a2'],
      ['src/new.ts', 'digest-n'],
      ['src/same.ts', 'digest-s'],
    ]);

    expect(diffSnapshots(before, after)).toEqual(['src/a.ts', 'src/gone.ts', 'src/new.ts']);
  });

  it('reports no change between identical snapshots', () => {
    const snapshot = new Map([['src/a.ts', 'digest-a']]);

    expect(diffSnapshots(snapshot, new Map(snapshot))).toEqual([]);
  });

  it('splits a changed set against the declared ownership', () => {
    const effect = observeEffect(['src/a.ts', 'docs/readme.md'], ['src/a.ts']);

    expect(effect.changedPaths).toEqual(['src/a.ts', 'docs/readme.md']);
    expect(effect.outOfScopePaths).toEqual(['docs/readme.md']);
  });
});
