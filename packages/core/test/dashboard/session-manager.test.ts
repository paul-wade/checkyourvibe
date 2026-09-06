import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionManager, type SessionProcess, type SessionSpawn } from '../../src/dashboard/session-manager.js';
import { readState } from '../../src/dashboard/state-store.js';
import { recordOrchestratorState } from '../../src/executor/store.js';
import type { ProgramLauncher } from '../../src/executor/program.js';

interface FakeProcessRecord {
  startTime: string;
  killed: boolean;
}

interface Fakes {
  findProgram: (program: string, env: NodeJS.ProcessEnv, cwd: string) => Promise<ProgramLauncher | undefined>;
  spawn: SessionSpawn;
  processExists: (pid: number) => boolean;
  processStartedAt: (pid: number) => Promise<string | undefined>;
  terminate: (pid: number) => boolean;
  alive: Map<number, FakeProcessRecord>;
  terminated: number[];
}

function makeFakes(): Fakes {
  let nextPid = 1000;
  const alive = new Map<number, FakeProcessRecord>();
  const terminated: number[] = [];

  const findProgram: Fakes['findProgram'] = async () => ({
    command: 'test-agent',
    prefixArgs: [],
    path: 'test-agent',
  });

  const spawn: SessionSpawn = () => {
    nextPid += 1;
    const pid = nextPid;
    const startTime = new Date().toISOString();
    alive.set(pid, { startTime, killed: false });

    const child: SessionProcess = {
      pid,
      kill: (signal?: NodeJS.Signals | number) => {
        const record = alive.get(pid);
        if (record !== undefined && signal !== 0) {
          record.killed = true;
        }
        return true;
      },
      unref: () => {},
    };

    return child;
  };

  const processExists = (pid: number): boolean => {
    const record = alive.get(pid);
    return record !== undefined && !record.killed;
  };

  const processStartedAt = async (pid: number): Promise<string | undefined> => {
    return alive.get(pid)?.startTime;
  };

  const terminate = (pid: number): boolean => {
    terminated.push(pid);
    const record = alive.get(pid);
    if (record !== undefined) record.killed = true;
    return true;
  };

  return { findProgram, spawn, processExists, processStartedAt, terminate, alive, terminated };
}

describe('session manager', () => {
  let repo: string;
  let fakes: Fakes;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-session-'));
    fakes = makeFakes();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('starting registers a session and claims the tree', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'devin');

    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = await readState(repo);
    const entry = state.sessions[started.sessionId];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    expect(entry.projectRoot).toBe(repo);
    expect(entry.agentId).toBe('devin');
    expect(entry.state).toBe('running');
    expect(entry.lastResumedAt).not.toBe('');
    const treeHolder = state.workingTrees[repo];
    if (treeHolder === undefined) throw new Error('The working tree was not claimed.');
    expect(treeHolder).toBe(started.sessionId);
    expect(state.cardAssignments[`__session:${started.sessionId}`]?.sessionId).toBe(started.sessionId);
  });

  it('a second start against the same tree is refused and names the holder', async () => {
    const manager = createSessionManager(fakes);
    const first = await manager.startSession(repo, 'devin');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await manager.startSession(repo, 'devin');
    expect(second.ok).toBe(false);
    if (second.ok) return;

    expect(second.holder).toBe(first.sessionId);
    expect(second.error).toContain(first.sessionId);

    const state = await readState(repo);
    expect(Object.keys(state.sessions).length).toBe(1);
    const treeHolder = state.workingTrees[repo];
    if (treeHolder === undefined) throw new Error('The working tree was not claimed.');
    expect(treeHolder).toBe(first.sessionId);
  });

  it('stopping releases the claim', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const stopped = await manager.stopSession(repo, started.sessionId);
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
    expect(fakes.terminated).toContain(started.pid);

    const state = await readState(repo);
    expect(state.sessions[started.sessionId]?.state).toBe('stopped');
    const treeHolder = state.workingTrees[repo];
    if (treeHolder !== undefined) throw new Error(`Expected no tree holder, found ${treeHolder}`);
    expect(Object.keys(state.cardAssignments)).toHaveLength(0);
  });

  it('stopping an already-dead session succeeds and tidies up', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const record = fakes.alive.get(started.pid);
    if (record !== undefined) record.killed = true;
    fakes.terminated.length = 0;

    const stopped = await manager.stopSession(repo, started.sessionId);
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(true);
    expect(fakes.terminated).toHaveLength(0);

    const state = await readState(repo);
    expect(state.sessions[started.sessionId]?.state).toBe('stopped');
    const treeHolder = state.workingTrees[repo];
    if (treeHolder !== undefined) throw new Error(`Expected no tree holder, found ${treeHolder}`);
    expect(Object.keys(state.cardAssignments)).toHaveLength(0);
  });

  it('a registry entry whose pid is gone is reported dead and its claims released', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const record = fakes.alive.get(started.pid);
    if (record !== undefined) record.killed = true;

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.alive).toBe(false);
    expect(view.state).toBe('stopped');
    expect(view.reason).toContain('not running');

    const state = await readState(repo);
    expect(state.sessions[started.sessionId]?.state).toBe('stopped');
    const treeHolder = state.workingTrees[repo];
    if (treeHolder !== undefined) throw new Error(`Expected no tree holder, found ${treeHolder}`);
    expect(Object.keys(state.cardAssignments)).toHaveLength(0);
  });

  // Every other lifecycle test starts the session through the manager first,
  // so the session is already in `state.sessions` and the loop over that map
  // finds it. Most real sessions are not: they are started from a terminal,
  // and the dashboard learns of them only because their hooks fire. That is
  // the case these two cover, and it is the case the feature exists for.
  it('surfaces a session it never started, seen only through its hooks', async () => {
    const manager = createSessionManager(fakes);
    const at = new Date().toISOString();
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      [
        JSON.stringify({ at, event: 'SessionStart', sessionId: 'terminal-1', cwd: repo, source: 'startup', agentId: 'claude-code' }),
        JSON.stringify({ at, event: 'UserPromptSubmit', sessionId: 'terminal-1', cwd: repo, agentId: 'claude-code' }),
        '',
      ].join('\n'),
    );

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === 'terminal-1');
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.state).toBe('running');
    expect(view.statusSource).toBe('hook');
    expect(view.agentId).toBe('claude-code');
    expect(view.observed).toBe(true);
    // Observed, not managed: there is no handle, so the board must not offer
    // to stop it.
    expect(view.pid).toBe(0);
    expect(view.activeTurns).toBe(1);
  });

  // The board says how long ago a hook fired. It was given the session's start
  // time under those words, which read as thirteen minutes of silence while a
  // hook had fired a minute earlier.
  it('reports when the session last fired a hook, not when it started', async () => {
    const manager = createSessionManager(fakes);
    const started = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      [
        JSON.stringify({ at: started, event: 'SessionStart', sessionId: 'terminal-4', cwd: repo, agentId: 'claude-code' }),
        JSON.stringify({ at: recent, event: 'UserPromptSubmit', sessionId: 'terminal-4', cwd: repo, agentId: 'claude-code' }),
        '',
      ].join('\n'),
    );

    const view = (await manager.listSessions(repo)).find((s) => s.sessionId === 'terminal-4');
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.startedAt).toBe(started);
    expect(view.lastEventAt).toBe(recent);
  });

  it('leaves out an observed session whose hooks say it ended', async () => {
    const manager = createSessionManager(fakes);
    const at = new Date().toISOString();
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      [
        JSON.stringify({ at, event: 'SessionStart', sessionId: 'terminal-2', cwd: repo, agentId: 'claude-code' }),
        JSON.stringify({ at, event: 'SessionEnd', sessionId: 'terminal-2', cwd: repo, reason: 'user stopped' }),
        '',
      ].join('\n'),
    );

    const sessions = await manager.listSessions(repo);
    expect(sessions.find((s) => s.sessionId === 'terminal-2')).toBeUndefined();
  });

  it('refuses to claim it stopped a session it never started', async () => {
    const manager = createSessionManager(fakes);
    const at = new Date().toISOString();
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      `${JSON.stringify({ at, event: 'SessionStart', sessionId: 'terminal-3', cwd: repo, agentId: 'claude-code' })}` + '\n',
    );

    const result = await manager.stopSession(repo, 'terminal-3');

    // There is no pid to signal, so the session is still running. Reporting
    // success would tell the operator it is over when it is not.
    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.error).toContain('no process handle');
    expect(fakes.terminated).toEqual([]);
  });

  it('derives live from a SessionStart lifecycle event', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'claude-code');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = await readState(repo);
    const startedAt = state.sessions[started.sessionId]?.lastResumedAt;
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      `${JSON.stringify({
        at: startedAt,
        event: 'SessionStart',
        sessionId: started.sessionId,
        cwd: repo,
        source: 'startup',
      })}\n`,
    );

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.alive).toBe(true);
    expect(view.state).toBe('running');
    expect(view.statusSource).toBe('hook');
    expect(view.reason).toContain('SessionStart');
  });

  it('derives stale when the last hook is old', async () => {
    const startTime = new Date().toISOString();
    let fakeNow = Date.parse(startTime);
    const manager = createSessionManager({ ...fakes, now: () => fakeNow });
    const started = await manager.startSession(repo, 'claude-code');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = await readState(repo);
    const startedAt = state.sessions[started.sessionId]?.lastResumedAt;
    if (startedAt === undefined) {
      throw new Error('expected startedAt');
    }
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      `${JSON.stringify({
        at: startedAt,
        event: 'SessionStart',
        sessionId: started.sessionId,
        cwd: repo,
        source: 'startup',
      })}\n`,
    );

    fakeNow = Date.parse(startedAt) + 60 * 60 * 1000 + 1;

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.alive).toBe(false);
    expect(view.state).toBe('stale');
    expect(view.statusSource).toBe('hook');
    expect(view.reason).toContain('no lifecycle event since');
  });

  it('derives ended after SessionEnd', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'claude-code');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = await readState(repo);
    const startedAt = state.sessions[started.sessionId]?.lastResumedAt;
    if (startedAt === undefined) {
      throw new Error('expected startedAt');
    }
    const startEvent = {
      at: startedAt,
      event: 'SessionStart',
      sessionId: started.sessionId,
      cwd: repo,
      source: 'startup',
    };
    const endAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    const endEvent = {
      at: endAt,
      event: 'SessionEnd',
      sessionId: started.sessionId,
      reason: 'user stopped',
    };

    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      `${JSON.stringify(startEvent)}\n${JSON.stringify(endEvent)}\n`,
    );

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.alive).toBe(false);
    expect(view.state).toBe('stopped');
    expect(view.statusSource).toBe('hook');
    expect(view.reason).toContain('SessionEnd');

    const updated = await readState(repo);
    expect(updated.sessions[started.sessionId]?.state).toBe('stopped');
  });

  it('counts an in-flight turn', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'claude-code');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = await readState(repo);
    const startedAt = state.sessions[started.sessionId]?.lastResumedAt;
    if (startedAt === undefined) {
      throw new Error('expected startedAt');
    }
    const startEvent = {
      at: startedAt,
      event: 'SessionStart',
      sessionId: started.sessionId,
      cwd: repo,
      source: 'startup',
    };
    const submitAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    const submitEvent = {
      at: submitAt,
      event: 'UserPromptSubmit',
      sessionId: started.sessionId,
      cwd: repo,
    };

    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      `${JSON.stringify(startEvent)}\n${JSON.stringify(submitEvent)}\n`,
    );

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.activeTurns).toBe(1);
    expect(view.alive).toBe(true);
    expect(view.statusSource).toBe('hook');
  });

  it('surfaces a self-report that disagrees with hook-derived stale', async () => {
    const startTime = new Date().toISOString();
    let fakeNow = Date.parse(startTime);
    const manager = createSessionManager({ ...fakes, now: () => fakeNow });
    const started = await manager.startSession(repo, 'claude-code');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = await readState(repo);
    const startedAt = state.sessions[started.sessionId]?.lastResumedAt;
    if (startedAt === undefined) {
      throw new Error('expected startedAt');
    }
    await writeFile(
      join(repo, '.cyv-review', 'lifecycle.ndjson'),
      `${JSON.stringify({
        at: startedAt,
        event: 'SessionStart',
        sessionId: started.sessionId,
        cwd: repo,
        source: 'startup',
      })}\n`,
    );

    const reportAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    await recordOrchestratorState(repo, {
      reportedAt: reportAt,
      state: 'healthy',
      reason: 'all good',
    });

    fakeNow = Date.parse(startedAt) + 60 * 60 * 1000 + 1;

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.state).toBe('stale');
    expect(view.discrepancy).toContain('self-reported healthy');
    expect(view.discrepancy).toContain('hook-derived status is stale');
  });

  it('keeps dispatch as the status source when no hooks are present', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const sessions = await manager.listSessions(repo);
    const view = sessions.find((s) => s.sessionId === started.sessionId);
    expect(view).toBeDefined();
    if (view === undefined) return;

    expect(view.alive).toBe(true);
    expect(view.state).toBe('running');
    expect(view.statusSource).toBe('dispatch');
    expect(view.activeTurns).toBe(0);
  });

  it('listing reports liveness from the process, not the registry', async () => {
    const manager = createSessionManager(fakes);
    const started = await manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const running = await manager.listSessions(repo);
    const first = running.find((s) => s.sessionId === started.sessionId);
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.alive).toBe(true);
    expect(first.state).toBe('running');

    const record = fakes.alive.get(started.pid);
    if (record !== undefined) {
      record.startTime = new Date(Date.now() + 10000).toISOString();
    }

    const reused = await manager.listSessions(repo);
    const second = reused.find((s) => s.sessionId === started.sessionId);
    expect(second).toBeDefined();
    if (second === undefined) return;
    expect(second.alive).toBe(false);
    expect(second.state).toBe('stopped');
  });
});
