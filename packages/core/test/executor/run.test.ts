import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runDispatch, type GateContext, type GateRunner } from '../../src/executor/run.js';
import { readDispatchLog } from '../../src/executor/store.js';
import { reportFromObservation, runChild } from '../../src/executor/child.js';
import { isInFlight, type DispatchAssignment } from '../../src/executor/dispatch.js';
import { declaration } from './fixtures.js';

const assignment: DispatchAssignment = {
  laneId: 'alpha',
  agentId: 'alpha-agent',
  model: 'weak',
  billing: 'subscription',
  permitsBilledOverage: false,
  orchestrator: false,
  declaredHeadroomAtSchedule: 2,
};

/**
 * A `node -e` script. Every case in this file runs a real child process, so
 * what the runner observes comes from the file system a process actually
 * wrote to rather than from a stub.
 */
function nodeScript(source: string): { command: string; args: readonly string[] } {
  return { command: process.execPath, args: ['-e', source] };
}

function writes(relativePath: string, content: string): string {
  const path = JSON.stringify(relativePath);
  return (
    `require('node:fs').mkdirSync(require('node:path').dirname(${path}),{recursive:true});` +
    `require('node:fs').writeFileSync(${path},${JSON.stringify(content)});`
  );
}

const passes: GateRunner = (gate) => ({ gate, passed: true });
const fails: GateRunner = (gate) => ({ gate, passed: false, detail: 'the gate did not pass' });

async function seed(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
}

describe('runDispatch against a real child process', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-run-')));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('succeeds when the child changes a declared file and the gates pass', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after')),
      gateRunner: passes,
    });

    expect(result.observation.exitCode).toBe(0);
    expect(result.changedPaths).toEqual(['src/a.ts']);
    expect(result.closed.outcome.kind).toBe('succeeded');
  });

  it('classifies an exit-0 child that changed nothing as produced-nothing', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript("process.stdout.write('done, everything is fine');"),
      gateRunner: passes,
    });

    expect(result.observation.exitCode).toBe(0);
    expect(result.closed.report.status).toBe('success');
    expect(result.changedPaths).toEqual([]);
    expect(result.closed.outcome.kind).toBe('produced-nothing');
  });

  it('fails a child that wrote outside its declared ownership, exit code 0 included', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration({ ownedPaths: ['src/a.ts'] }),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after') + writes('src/elsewhere.ts', 'not mine')),
      gateRunner: passes,
    });

    expect(result.observation.exitCode).toBe(0);
    expect(result.closed.report.status).toBe('success');
    expect(result.closed.outcome.kind).toBe('out-of-scope-write');
    expect(result.closed.outcome.outOfScopePaths).toEqual(['src/elsewhere.ts']);
  });

  it('records a nonzero exit that changed nothing as failed', async () => {
    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript("process.stderr.write('could not do it');process.exit(3);"),
      gateRunner: passes,
    });

    expect(result.observation.exitCode).toBe(3);
    expect(result.observation.stderr).toContain('could not do it');
    expect(result.closed.outcome.kind).toBe('failed');
  });

  it('succeeds a nonzero exit whose declared file changed and whose gates passed', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(`${writes('src/a.ts', 'after')}process.exit(1);`),
      gateRunner: passes,
    });

    expect(result.closed.report.status).toBe('failure');
    expect(result.closed.report.exitCode).toBe(1);
    expect(result.closed.outcome.kind).toBe('succeeded');
  });

  it('records a child that could not be started as did-not-complete', async () => {
    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: { command: join(repo, 'no-such-executable'), args: [] },
      gateRunner: passes,
    });

    expect(result.observation.spawnError).toBeDefined();
    expect(result.closed.report.status).toBe('did-not-complete');
    expect(result.closed.outcome.kind).toBe('did-not-complete');
  });

  it('fails the dispatch when a declared gate fails against a real change', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after')),
      gateRunner: fails,
    });

    expect(result.closed.outcome.kind).toBe('gates-failed');
    expect(result.closed.outcome.failedGates).toEqual(['tsc']);
  });

  it('fails a declared gate that has no runner rather than assuming it passed', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after')),
    });

    expect(result.closed.outcome.kind).toBe('gates-failed');
    expect(result.closed.gateResults[0]?.detail).toContain('no runner');
  });

  it('records a gate runner that throws as a failed gate', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after')),
      gateRunner: () => {
        throw new Error('tsc could not start');
      },
    });

    expect(result.closed.outcome.kind).toBe('gates-failed');
    expect(result.closed.gateResults[0]?.detail).toContain('tsc could not start');
  });

  it('gives the gate the paths that were observed to change', async () => {
    await seed(repo, 'src/a.ts', 'before');
    const seen: GateContext[] = [];

    await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after')),
      gateRunner: (gate, context) => {
        seen.push(context);
        return { gate, passed: true };
      },
    });

    expect(seen[0]?.changedPaths).toEqual(['src/a.ts']);
    expect(seen[0]?.dispatchId).toBe('d1');
  });

  it('reports a dispatch that declared no file changes and made some', async () => {
    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration({ expectsFileChanges: false, ownedPaths: ['src'] }),
      assignment,
      command: nodeScript(writes('src/a.ts', 'written anyway')),
      gateRunner: passes,
    });

    expect(result.closed.outcome.kind).toBe('changed-files-unexpectedly');
  });

  it('succeeds a dispatch that declared no file changes and made none', async () => {
    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration({ expectsFileChanges: false }),
      assignment,
      command: nodeScript("process.stdout.write('looked, found nothing to change');"),
      gateRunner: passes,
    });

    expect(result.closed.outcome.kind).toBe('succeeded');
  });

  it('leaves the opened entry on disk while the child is still running (Requirement 6.4)', async () => {
    const logPath = JSON.stringify(join('.cyv-review', 'dispatches.ndjson'));
    const script =
      `const fs=require('node:fs');const p=require('node:path');` +
      `const seen=fs.readFileSync(${logPath},'utf-8').trim().split('\\n');` +
      `fs.mkdirSync('src',{recursive:true});` +
      `fs.writeFileSync(p.join('src','a.ts'), seen.join('\\n'));`;

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(script),
      gateRunner: passes,
    });

    expect(result.observation.stderr).toBe('');
    const readByTheChild = await readFile(join(repo, 'src', 'a.ts'), 'utf-8');
    const entries = readByTheChild.split('\n').map((line: string): unknown => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'opened', dispatchId: 'd1', workId: 'w1' });
    expect(result.closed.outcome.kind).toBe('succeeded');
  });

  it('writes both entries so the record folds into one closed dispatch', async () => {
    await seed(repo, 'src/a.ts', 'before');

    await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after')),
      gateRunner: passes,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const { records } = await readDispatchLog(repo);
    expect(records).toHaveLength(1);
    expect(records.some(isInFlight)).toBe(false);
    expect(records[0]?.assignment.model).toBe('weak');
    expect(records[0]?.closed?.outcome.changedPaths).toEqual(['src/a.ts']);
  });

  it('observes only the scope it is given', async () => {
    await seed(repo, 'src/a.ts', 'before');

    const result = await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(writes('src/a.ts', 'after') + writes('docs/notes.md', 'unwatched')),
      observedScope: ['src'],
      gateRunner: passes,
    });

    expect(result.changedPaths).toEqual(['src/a.ts']);
    expect(result.closed.outcome.kind).toBe('succeeded');
  });

  it('round-trips captured output through the dispatch log', async () => {
    await seed(repo, 'src/a.ts', 'before');

    await runDispatch({
      repoRoot: repo,
      dispatchId: 'd1',
      workId: 'w1',
      attempt: 1,
      declaration: declaration(),
      assignment,
      command: nodeScript(
        "process.stderr.write('error text');process.stdout.write('output text');",
      ),
      gateRunner: passes,
    });

    const { records } = await readDispatchLog(repo);
    const report = records[0]?.closed?.report;
    expect(report?.output).toEqual({ stderr: 'error text', stdout: 'output text' });
  });
});

describe('runChild', () => {
  it('records the signal when a child is killed on its timeout', async () => {
    const observation = await runChild({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000);'],
      timeoutMs: 200,
    });

    expect(observation.timedOut).toBe(true);
    expect(reportFromObservation(observation).status).toBe('did-not-complete');
  });

  it('captures both output streams', async () => {
    const observation = await runChild({
      command: process.execPath,
      args: ['-e', "process.stdout.write('out');process.stderr.write('err');"],
    });

    expect(observation.stdout).toBe('out');
    expect(observation.stderr).toBe('err');
    expect(observation.exitCode).toBe(0);
  });

  it('leaves rateLimited false unless a detector says otherwise', async () => {
    const observation = await runChild({
      command: process.execPath,
      args: ['-e', "process.stderr.write('429 rate limit reached');"],
    });

    expect(reportFromObservation(observation).rateLimited).toBe(false);
    expect(
      reportFromObservation(observation, (o) => o.stderr.includes('rate limit')).rateLimited,
    ).toBe(true);
  });
});
