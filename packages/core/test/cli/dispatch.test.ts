import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command as dispatchCommand } from '../../src/cli/dispatch.js';
import { dispatchLogPath, readDispatchLog } from '../../src/executor/store.js';
import type { CommandContext } from '../../src/cli/types.js';
import type { ExecutorConfig } from '../../src/config/types.js';

interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

function capture(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(' '));
  });
  return {
    logs,
    errors,
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

/**
 * A lane per agent id, each offering a two-model ordering for mechanical
 * transformation so the weakest-first rule has a distinguishable last entry.
 */
function executorConfig(lanes: readonly { id: string; agentId: string; cap: number; orchestrator?: boolean; acceptsDispatch?: boolean }[]): ExecutorConfig {
  return {
    lanes: lanes.map((lane) => ({
      id: lane.id,
      agentId: lane.agentId,
      concurrencyCap: lane.cap,
      billing: { kind: 'subscription', permitsBilledOverage: false },
      orchestrator: lane.orchestrator ?? false,
      ...(lane.acceptsDispatch !== undefined ? { acceptsDispatch: lane.acceptsDispatch } : {}),
      models: [{ kind: 'mechanical-transformation', ordering: ['strong-model', 'weak-model'] }],
    })),
  };
}

async function writeConfig(repo: string, executor?: ExecutorConfig): Promise<void> {
  await writeFile(
    join(repo, 'checkyourvibe.json'),
    JSON.stringify({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      ...(executor === undefined ? {} : { executor }),
    }),
    'utf-8',
  );
}

describe('cyv dispatch', () => {
  let repo: string;
  let captured: Captured;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-dispatch-')));
    execFileSync('git', ['init'], { cwd: repo });
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    captured = capture();
  });

  afterEach(async () => {
    captured.restore();
    await rm(repo, { recursive: true, force: true });
  });

  function context(argv: string[]): CommandContext {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CYV_DISPATCH_DECLARATION;
    delete cleanEnv.CYV_DISPATCH_ID;
    delete cleanEnv.CYV_DISPATCH_PARENTS;
    return { cwd: repo, argv, env: cleanEnv };
  }

  it('lists the agents it can invoke and the command line each is driven by', async () => {
    expect(await dispatchCommand.run(context(['--agents']))).toBe(0);
    const output = captured.logs.join('\n');
    expect(output).toContain('codex');
    expect(output).toContain('claude-code');
    expect(output).toContain('--prompt-file');
  });

  it('refuses work that declares no ownership, saying why ownership is declared first', async () => {
    await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

    expect(await dispatchCommand.run(context(['--task', 'do the thing']))).toBe(2);
    expect(captured.errors.join('\n')).toContain('at least one --own');
  });

  it('refuses work that states no task', async () => {
    await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

    expect(await dispatchCommand.run(context(['--own', 'a.ts']))).toBe(2);
    expect(captured.errors.join('\n')).toContain('--task');
  });

  it('rejects a task kind outside the declared set', async () => {
    await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

    const code = await dispatchCommand.run(
      context(['--task', 't', '--own', 'a.ts', '--kind', 'whatever']),
    );
    expect(code).toBe(2);
    expect(captured.errors.join('\n')).toContain('mechanical-transformation');
  });

  it('says a repository that declares no lane has nothing to dispatch to', async () => {
    await writeConfig(repo);

    expect(await dispatchCommand.run(context(['--task', 't', '--own', 'a.ts']))).toBe(2);
    const message = captured.errors.join('\n');
    expect(message).toContain('No executor lane is declared');
    expect(message).toContain('cyv init` writes no lane');
  });

  it('refuses before scheduling when a lane names an agent it has no command line for', async () => {
    await writeConfig(repo, executorConfig([{ id: 'odd-lane', agentId: 'not-an-agent', cap: 1 }]));

    const code = await dispatchCommand.run(context(['--task', 't', '--own', 'a.ts']));
    expect(code).toBe(2);
    const message = captured.errors.join('\n');
    expect(message).toContain('odd-lane');
    expect(message).toContain('not-an-agent');
    await expect(access(dispatchLogPath(repo))).rejects.toThrow();
  });

  describe('--dry-run', () => {
    it('names the lane with the most declared headroom and that lane\'s weakest model', async () => {
      await writeConfig(
        repo,
        executorConfig([
          { id: 'lane-narrow', agentId: 'codex', cap: 1 },
          { id: 'lane-wide', agentId: 'claude-code', cap: 4 },
        ]),
      );

      const code = await dispatchCommand.run(
        context(['--task', 't', '--own', 'a.ts', '--dry-run']),
      );

      expect(code).toBe(0);
      const output = captured.logs.join('\n');
      expect(output).toContain('lane-wide');
      expect(output).toContain('weak-model');
      expect(output).toContain('declared headroom 4');
    });

    it('writes nothing, so no dispatch is recorded', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

      await dispatchCommand.run(context(['--task', 't', '--own', 'a.ts', '--dry-run']));

      await expect(access(dispatchLogPath(repo))).rejects.toThrow();
    });

    it('reports a refusal when the named lane is not declared', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

      const code = await dispatchCommand.run(
        context(['--task', 't', '--own', 'a.ts', '--lane', 'no-such-lane', '--dry-run']),
      );

      expect(code).toBe(1);
      const output = captured.logs.join('\n');
      expect(output).toContain('no declared lane was a candidate');
      expect(output).toContain('no lane with this id is declared');
    });
  });

  describe('--task-file', () => {
    it('reads an absolute path as given', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));
      const taskPath = join(repo, 'task.md');
      await writeFile(taskPath, 'do the absolute thing\n', 'utf-8');

      const code = await dispatchCommand.run(
        context(['--task-file', taskPath, '--own', 'a.ts', '--dry-run']),
      );

      expect(code).toBe(0);
      expect(captured.errors).toHaveLength(0);
    });

    it('resolves a relative path against the repository root', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));
      await writeFile(join(repo, 'task.md'), 'do the relative thing\n', 'utf-8');

      const code = await dispatchCommand.run(
        context(['--task-file', 'task.md', '--own', 'a.ts', '--dry-run']),
      );

      expect(code).toBe(0);
      expect(captured.errors).toHaveLength(0);
    });

    it('names the path the caller passed when the file does not exist', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

      await expect(
        dispatchCommand.run(context(['--task-file', 'no-such-task.md', '--own', 'a.ts', '--dry-run'])),
      ).rejects.toThrow(/--task-file "no-such-task\.md"/);
    });
  });

  describe('--abandon', () => {
    it('refuses to abandon an unknown dispatch id', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));
      const code = await dispatchCommand.run(context(['--abandon', 'unknown-id']));
      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('Unknown dispatch id "unknown-id"');
    });

    it('refuses to abandon an already closed dispatch', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1, orchestrator: true }]));
      // Self-dispatch and then close it
      await dispatchCommand.run(context(['--task', 't', '--own', 'a.ts', '--self', '--work-id', 'test-work']));
      await dispatchCommand.run(context(['--close', 'test-work-attempt-1']));
      
      const code = await dispatchCommand.run(context(['--abandon', 'test-work-attempt-1']));
      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('is already closed');
    });

    it('releases paths so a later dispatch claiming them is not refused', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1, orchestrator: true }]));
      // Open a dispatch and don't close it
      await dispatchCommand.run(context(['--task', 't', '--own', 'a.ts', '--self', '--work-id', 'hanging']));
      
      // Try to open a second dispatch claiming the same path
      const tryCode = await dispatchCommand.run(context(['--task', 't2', '--own', 'a.ts', '--work-id', 'blocked']));
      expect(tryCode).toBe(1);
      expect(captured.logs.join('\n')).toContain('refused: another dispatch already in flight declares paths this one also claims');

      // Abandon the first
      const abandonCode = await dispatchCommand.run(context(['--abandon', 'hanging-attempt-1', '--reason', 'hung']));
      expect(abandonCode).toBe(1); // abandoned is did-not-complete, so it exits 1

      // Second dispatch should now schedule (run will start executor, but since it's just dry-run here to check it schedules? 
      // wait, if I use --self it won't spawn anything)
      const successCode = await dispatchCommand.run(context(['--task', 't2', '--own', 'a.ts', '--work-id', 'freed', '--self']));
      expect(successCode).toBe(0);
    });
  });

  describe('nested dispatches', () => {
    it('refuses to widen ownership', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

      const code = await dispatchCommand.run({
        ...context(['--task', 't', '--own', 'a.ts', '--own', 'b.ts']),
        env: { ...context([]).env, CYV_DISPATCH_DECLARATION: JSON.stringify(['a.ts']) },
      });

      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('Nested dispatch may not widen ownership');
      expect(captured.errors.join('\n')).toContain('b.ts');
    });

    it('refuses to nest two deep', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1 }]));

      const code = await dispatchCommand.run({
        ...context(['--task', 't', '--own', 'a.ts']),
        env: { ...context([]).env, CYV_DISPATCH_PARENTS: 'parent1', CYV_DISPATCH_ID: 'parent2' },
      });

      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('a dispatch two levels deep');
      expect(captured.errors.join('\n')).toContain('parent1 → parent2');
    });

    it('refuses when the concurrency cap is reached by the parent', async () => {
      await writeConfig(repo, executorConfig([
        { id: 'codex-lane', agentId: 'codex', cap: 1, orchestrator: true, acceptsDispatch: true },
        { id: 'other-lane', agentId: 'codex', cap: 1 },
      ]));

      // Parent dispatch opens and occupies the 1 lane slot on codex-lane
      await dispatchCommand.run({
        ...context(['--task', 't', '--own', 'a.ts', '--self', '--work-id', 'parent-work', '--lane', 'codex-lane']),
        env: context([]).env,
      });

      // Child dispatch tries to schedule on the SAME lane but fails because the parent is taking the slot
      const code = await dispatchCommand.run({
        ...context(['--task', 't', '--own', 'a.ts', '--work-id', 'child-work', '--lane', 'codex-lane']),
        env: { ...context([]).env, CYV_DISPATCH_ID: 'parent-work-attempt-1', CYV_DISPATCH_DECLARATION: JSON.stringify(['a.ts']) },
      });

      expect(code).toBe(1);
      const output = captured.logs.join('\n');
      expect(output).toContain('running its declared cap of 1 (1 in flight)');
    });

    it('records the parent dispatch id', async () => {
      await writeConfig(repo, executorConfig([{ id: 'codex-lane', agentId: 'codex', cap: 1, orchestrator: true }]));

      const code = await dispatchCommand.run({
        ...context(['--task', 't', '--own', 'a.ts', '--self', '--work-id', 'child-work']),
        env: { ...context([]).env, CYV_DISPATCH_ID: 'parent-dispatch' },
      });
      expect(code).toBe(0);

      const log = await readDispatchLog(repo);
      const child = log.records.find(r => r.workId === 'child-work');
      expect(child).toBeDefined();
      if (!child) throw new Error('child is undefined');
      expect(child.parentDispatchId).toBe('parent-dispatch');
    });
  });
});
