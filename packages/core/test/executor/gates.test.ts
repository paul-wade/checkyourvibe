import { describe, expect, it } from 'vitest';
import { basename, dirname } from 'node:path';

import { createGateRunner, parseGate, unknownGateDetail } from '../../src/executor/gates.js';
import type { GateContext } from '../../src/executor/run.js';
import { declaration } from './fixtures.js';

const nodeDirectory = dirname(process.execPath);
const nodeName = basename(process.execPath).replace(/\.exe$/i, '');
const env: NodeJS.ProcessEnv = { PATH: nodeDirectory, PATHEXT: '.EXE' };

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    repoRoot: process.cwd(),
    dispatchId: 'd1',
    declaration: declaration(),
    assignment: {
      laneId: 'alpha',
      agentId: 'alpha-agent',
      model: 'weak',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
    changedPaths: [],
    observation: { timedOut: false, stdout: '', stderr: '' },
    ...overrides,
  };
}

describe('parseGate', () => {
  it('reads the analyzer gate by name', () => {
    expect(parseGate('cyv-check')).toEqual({ kind: 'cyv-check' });
  });

  it('splits a run gate into a program and its arguments', () => {
    expect(parseGate('run:npx tsc -b')).toEqual({
      kind: 'command',
      program: 'npx',
      args: ['tsc', '-b'],
    });
  });

  it('ignores the whitespace around a run gate', () => {
    expect(parseGate('run:   node   -e   0 ')).toEqual({
      kind: 'command',
      program: 'node',
      args: ['-e', '0'],
    });
  });

  it('has no reading for a run gate that names no program', () => {
    expect(parseGate('run:')).toBeUndefined();
    expect(parseGate('run:   ')).toBeUndefined();
  });

  it('has no reading for a name in neither form', () => {
    expect(parseGate('tsc')).toBeUndefined();
  });
});

describe('the gate runner', () => {
  it('fails a gate it cannot read, naming both forms it accepts', async () => {
    const result = await createGateRunner(env)('tsc', context());
    expect(result.passed).toBe(false);
    expect(result.detail).toBe(unknownGateDetail('tsc'));
  });

  it('passes a run gate whose command exits zero', async () => {
    const result = await createGateRunner(env)(`run:${nodeName} -e 0`, context());
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('code 0');
  });

  it('fails a run gate whose command exits non-zero', async () => {
    const result = await createGateRunner(env)(
      `run:${nodeName} -e process.exit(3)`,
      context(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('code 3');
  });

  it('fails a run gate whose program is not on PATH rather than treating it as passed', async () => {
    const result = await createGateRunner(env)('run:a-program-no-machine-has', context());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('not found on PATH');
  });

  it('passes the analyzer gate without running an analyzer when nothing changed', async () => {
    const result = await createGateRunner(env)('cyv-check', context({ changedPaths: [] }));
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('nothing from this dispatch to check');
  });

  it('records the gate name it was given, so a record names what judged it', async () => {
    const result = await createGateRunner(env)(`run:${nodeName} -e 0`, context());
    expect(result.gate).toBe(`run:${nodeName} -e 0`);
  });
});
