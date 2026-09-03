import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command as initCommand } from '../../src/cli/init.js';
import { command as doctorCommand } from '../../src/cli/doctor.js';
import type { CommandContext } from '../../src/cli/types.js';
import type { ExecutorConfig } from '../../src/config/types.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../../src/protocol/index.js';
import { makeGitOnlyPath } from './fixtures.js';

/**
 * Replace PATH with one holding only git, so agent detection is driven by the
 * files and directories these tests create rather than by whatever agent CLIs
 * the host has installed. See `makeGitOnlyPath`.
 */
const ORIGINAL_PATH = process.env.PATH ?? process.env.Path ?? '';
let SAFE_PATH = ORIGINAL_PATH;

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'cyv-doctor-repo-'));
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

/** Pre-seeds `.claude/settings.json` so claude-code detection is deterministic. */
async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'cyv-doctor-home-'));
  await mkdir(join(homeDir, '.claude'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');
  return homeDir;
}

/** `loadConfig` expects the config schema at `docs/protocol/config.schema.json`
 * relative to the checked repo's own root, so doctor's schema-validity check
 * has something to read. */
async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

function context(repo: string, argv: string[], homeDir: string): CommandContext {
  return {
    cwd: repo,
    argv,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  };
}

interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(line);
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
    errors.push(line);
  });
  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

async function initializedRepo(signals: { gemini?: boolean } = {}): Promise<{ repo: string; homeDir: string }> {
  const repo = await makeRepo();
  const homeDir = await makeHome();
  await copySchema(repo);

  if (signals.gemini) {
    await mkdir(join(repo, '.gemini'), { recursive: true });
  }

  const captured = captureConsole();
  try {
    const code = await initCommand.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
    if (code !== 0) {
      throw new Error(`cyv init fixture setup failed with exit code ${code}: ${captured.errors.join('\n')}`);
    }
  } finally {
    captured.restore();
  }

  return { repo, homeDir };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface HookEntry {
  command: string;
}

interface PostToolUseEntry {
  hooks: HookEntry[];
}

interface SettingsShape {
  hooks: { PostToolUse: PostToolUseEntry[] };
}

function isHookEntry(value: unknown): value is HookEntry {
  return isRecord(value) && typeof value.command === 'string';
}

function isPostToolUseEntry(value: unknown): value is PostToolUseEntry {
  if (!isRecord(value)) {
    return false;
  }
  const hooks = value.hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }
  for (let i = 0; i < hooks.length; i++) {
    const entry: unknown = hooks[i];
    if (!isHookEntry(entry)) {
      return false;
    }
  }
  return true;
}

function isSettingsShape(value: unknown): value is SettingsShape {
  if (!isRecord(value)) {
    return false;
  }
  const hooks = value.hooks;
  if (!isRecord(hooks)) {
    return false;
  }
  const postToolUse = hooks.PostToolUse;
  if (!Array.isArray(postToolUse)) {
    return false;
  }
  for (let i = 0; i < postToolUse.length; i++) {
    const entry: unknown = postToolUse[i];
    if (!isPostToolUseEntry(entry)) {
      return false;
    }
  }
  return true;
}

function parseSettings(raw: string): SettingsShape {
  const parsed: unknown = JSON.parse(raw);
  if (!isSettingsShape(parsed)) {
    throw new Error(`settings.json does not match the expected shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
}

const CONFIG_FILE = 'checkyourvibe.json';

/**
 * Add an `executor` key to the config `cyv init` wrote.
 *
 * `cyv init` writes none, by design, so a declaration can only ever arrive the
 * way this does: added by hand after the fact — which is the state doctor is
 * being asked to report on.
 */
async function declareLanes(repo: string, executor: ExecutorConfig): Promise<void> {
  const path = join(repo, CONFIG_FILE);
  const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
  if (!isRecord(parsed)) {
    throw new Error(`${CONFIG_FILE} is not an object`);
  }
  await writeFile(path, JSON.stringify({ ...parsed, executor }, null, 2));
}

/** Two flat-rate lanes and one metered one, all backed by `agentId`. */
function laneFixture(agentId: string): ExecutorConfig {
  return {
    lanes: [
      {
        id: 'claude-code-main',
        agentId: 'claude-code',
        concurrencyCap: 2,
        billing: { kind: 'subscription', permitsBilledOverage: false },
        models: [{ kind: 'judgment-required', ordering: ['opus-4', 'sonnet-4'] }],
        orchestrator: true,
      },
      {
        id: 'claude-code-batch',
        agentId: 'claude-code',
        concurrencyCap: 3,
        billing: { kind: 'subscription', permitsBilledOverage: false },
        models: [{ kind: 'mechanical-transformation', ordering: ['sonnet-4', 'haiku-4'] }],
        orchestrator: false,
      },
      {
        id: 'metered-lane',
        agentId,
        concurrencyCap: 4,
        billing: { kind: 'metered', permitsBilledOverage: true },
        models: [{ kind: 'mechanical-transformation', ordering: ['gpt-5-pro', 'gpt-5'] }],
        orchestrator: false,
      },
    ],
    meteredLanesEnabled: ['metered-lane'],
  };
}

describe('cyv doctor', () => {
  beforeAll(async () => {
    SAFE_PATH = await makeGitOnlyPath();
    process.env.PATH = SAFE_PATH;
  });

  afterAll(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  it('reports everything ok and exits 0 on a freshly initialised repo', async () => {
    const { repo, homeDir } = await initializedRepo();
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).not.toContain('[drift]');
      expect(output).not.toContain('[error]');
      expect(output).toContain('[ok]');
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports drift and exits 1 after the CLAUDE.md managed block is edited by hand', async () => {
    const { repo, homeDir } = await initializedRepo();
    const captured = captureConsole();

    try {
      const claudeMdPath = join(repo, 'CLAUDE.md');
      const original = await readFile(claudeMdPath, 'utf-8');
      const start = MANAGED_BLOCK_START('claude-code-workflow');
      const end = MANAGED_BLOCK_END('claude-code-workflow');
      const startIndex = original.indexOf(start) + start.length;
      const endIndex = original.indexOf(end);
      expect(startIndex).toBeGreaterThan(-1);
      expect(endIndex).toBeGreaterThan(-1);

      const edited = `${original.slice(0, startIndex)}\nhand-edited text that does not match the plan\n${original.slice(endIndex)}`;
      await writeFile(claudeMdPath, edited);

      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[drift]');
      expect(output).toMatch(/CLAUDE\.md/);
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports specifically when the embedded cyv entry point no longer exists', async () => {
    const { repo, homeDir } = await initializedRepo();
    const captured = captureConsole();

    try {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = parseSettings(raw);
      const bogusCommand = join(homeDir, 'nonexistent-checkout', 'dist', 'cli', 'index.js');
      const hookEntry = settings.hooks.PostToolUse[0]?.hooks[0];
      expect(hookEntry).toBeDefined();
      if (hookEntry !== undefined) {
        hookEntry.command = `${bogusCommand} hook claude-code`;
      }
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));

      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[drift]');
      expect(output).toContain(bogusCommand);
      expect(output).toContain('no longer exists');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('exits 2 with a configuration error when checkyourvibe.json is missing', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    await copySchema(repo);
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');
      expect(output).toContain('[error]');
      expect(code).toBe(2);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports an installed but not set up agent and exits 0', async () => {
    const { repo, homeDir } = await initializedRepo();
    await mkdir(join(repo, '.gemini'), { recursive: true });
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[setup]');
      expect(output).toContain('gemini');
      expect(output).toContain('installed but not set up');
      expect(output).toContain('[ok]');
      expect(output).not.toContain('[drift]');
      expect(output).not.toContain('[error]');
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports a configured agent that is no longer installed as dead weight and exits 1', async () => {
    const { repo, homeDir } = await initializedRepo({ gemini: true });
    await rm(join(repo, '.gemini'), { recursive: true, force: true });
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[drift]');
      expect(output).toContain('gemini');
      expect(output).toContain('dead weight');
      expect(output).toContain('[ok]');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports all four agent states in one run', async () => {
    const { repo, homeDir } = await initializedRepo({ gemini: true });
    const claudeMdPath = join(repo, 'CLAUDE.md');
    const original = await readFile(claudeMdPath, 'utf-8');
    const start = MANAGED_BLOCK_START('claude-code-workflow');
    const end = MANAGED_BLOCK_END('claude-code-workflow');
    const startIndex = original.indexOf(start) + start.length;
    const endIndex = original.indexOf(end);
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(-1);
    const edited = `${original.slice(0, startIndex)}\nhand-edited text\n${original.slice(endIndex)}`;
    await writeFile(claudeMdPath, edited);
    await rm(join(repo, '.gemini'), { recursive: true, force: true });
    await mkdir(join(repo, '.cursor'), { recursive: true });
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[ok]');
      expect(output).toContain('[drift]');
      expect(output).toContain('[setup]');
      expect(output).toContain('dead weight');
      expect(output).toContain('installed but not set up');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('collapses drift for one agent to a single [drift] line', async () => {
    const { repo, homeDir } = await initializedRepo();
    const claudeMdPath = join(repo, 'CLAUDE.md');
    const original = await readFile(claudeMdPath, 'utf-8');
    const start = MANAGED_BLOCK_START('claude-code-workflow');
    const end = MANAGED_BLOCK_END('claude-code-workflow');
    const startIndex = original.indexOf(start) + start.length;
    const endIndex = original.indexOf(end);
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(-1);
    const edited = `${original.slice(0, startIndex)}\nhand-edited text\n${original.slice(endIndex)}`;
    await writeFile(claudeMdPath, edited);

    const captured = captureConsole();
    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');
      const driftLines = output.split('\n').filter((line) => line.startsWith('[drift]'));

      expect(driftLines.length).toBe(1);
      expect(output).toContain('1 file(s) differ');
      expect(output).toContain('CLAUDE.md');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('restores the per-file detail when passed --verbose', async () => {
    const { repo, homeDir } = await initializedRepo();
    const claudeMdPath = join(repo, 'CLAUDE.md');
    const original = await readFile(claudeMdPath, 'utf-8');
    const start = MANAGED_BLOCK_START('claude-code-workflow');
    const end = MANAGED_BLOCK_END('claude-code-workflow');
    const startIndex = original.indexOf(start) + start.length;
    const endIndex = original.indexOf(end);
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(-1);
    const edited = `${original.slice(0, startIndex)}\nhand-edited text\n${original.slice(endIndex)}`;
    await writeFile(claudeMdPath, edited);
    // Remove the per-rule guidance files so the verbose listing has more than one entry.
    await rm(join(homeDir, '.claude', 'agents'), { recursive: true, force: true });

    const captured = captureConsole();
    try {
      const code = await doctorCommand.run(context(repo, ['--verbose'], homeDir));
      const output = captured.logs.join('\n');
      const perFileLines = output.split('\n').filter((line) => line.includes('has drifted from the applied configuration'));

      expect(perFileLines.length).toBeGreaterThan(1);
      expect(output).toContain('[drift] claude-code');
      expect(output).toContain('has drifted from the applied configuration');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports unverified surfaces and still exits 0 when there is no drift', async () => {
    const { repo, homeDir } = await initializedRepo({ gemini: true });
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[unverified]');
      expect(output).toContain('gemini');
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('produces no [unverified] line for an agent with no unverified surfaces', async () => {
    const { repo, homeDir } = await initializedRepo();
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).not.toContain('[unverified]');
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('names every declared executor lane, its cap and its billing, and exits 0', async () => {
    const { repo, homeDir } = await initializedRepo();
    await declareLanes(repo, laneFixture('claude-code'));
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('3 executor lane(s) declared in checkyourvibe.json');
      expect(output).toContain('executor lane claude-code-main (subscription, orchestrator)');
      expect(output).toContain('concurrency cap 2');
      expect(output).toContain('executor lane claude-code-batch (subscription)');
      expect(output).toContain('concurrency cap 3');
      expect(output).toContain(
        'executor lane metered-lane (metered — billed per use, configured to permit billed overage)',
      );
      expect(output).toContain('billed per use, and the core never selects it on its own');
      expect(output).not.toContain('[error]');

      // The lanes were declared after `cyv init` ran, so the orchestrating
      // lane's brief has never been written. That is drift, not an error, and
      // reporting it is spec 0041 Requirement 1.3 — the exit code changed from
      // 0 when the brief landed, which is the requirement working rather than a
      // regression.
      expect(output).toContain('[drift]');
      expect(output).toContain('Run `cyv init` to reapply.');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('writes no orchestration brief when no lane declares itself the orchestrator', async () => {
    const { repo, homeDir } = await initializedRepo();
    const fixture = laneFixture('claude-code');
    await declareLanes(repo, {
      ...fixture,
      lanes: fixture.lanes.map((lane) => ({ ...lane, orchestrator: false })),
    });
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      // An agent with no orchestrating lane gets no block, so there is nothing
      // for the file to be missing (spec 0041 Requirement 1.1).
      expect(output).not.toContain('[drift]');
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports a lane naming an agent this repository does not configure and exits 2', async () => {
    const { repo, homeDir } = await initializedRepo();
    await declareLanes(repo, laneFixture('codex'));
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[error] executor lane metered-lane');
      expect(output).toContain('names agent "codex", which this repository does not configure');
      expect(output).toContain('agents listed in checkyourvibe.json: claude-code');
      expect(output).toContain('has no configured agent to run it');
      // The lanes whose agent is configured are still reported as ordinary lanes,
      // carrying their agent and cap. Whether the line is [ok] or [notice] depends
      // on whether that agent's program is installed on the machine running the
      // test, which is not what this test is about — so it asserts the lane is
      // described, not which of the two markers it earned here.
      expect(output).toContain('executor lane claude-code-main');
      expect(output).toMatch(/executor lane claude-code-main.*concurrency cap 2/);
      expect(code).toBe(2);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('says nothing about lanes when the config declares no executor', async () => {
    const { repo, homeDir } = await initializedRepo();
    const captured = captureConsole();

    try {
      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).not.toContain('executor lane');
      expect(output).not.toContain('lane(s) declared');
      expect(output).not.toContain('metered');
      expect(code).toBe(0);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports drift when the embedded cyv command is a bare name that does not resolve', async () => {
    const { repo, homeDir } = await initializedRepo();
    const captured = captureConsole();

    try {
      const settingsPath = join(homeDir, '.claude', 'settings.json');
      const raw = await readFile(settingsPath, 'utf-8');
      const settings = parseSettings(raw);
      const hookEntry = settings.hooks.PostToolUse[0]?.hooks[0];
      expect(hookEntry).toBeDefined();
      if (hookEntry !== undefined) {
        hookEntry.command = 'cyv hook claude-code';
      }
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));

      const code = await doctorCommand.run(context(repo, [], homeDir));
      const output = captured.logs.join('\n');

      expect(output).toContain('[drift]');
      expect(output).toContain('cyv');
      expect(output).toContain('does not resolve');
      expect(code).toBe(1);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });
});
