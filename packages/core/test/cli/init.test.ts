import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import * as initModule from '../../src/cli/init.js';
import type { CommandContext } from '../../src/cli/types.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../../src/protocol/index.js';
import { loadAnalyzerManifest } from '../../src/registry/load.js';
import type { AgentPlugin } from '../../src/protocol/index.js';
import { makeGitOnlyPath } from './fixtures.js';

/**
 * Replace PATH with one holding only git, so agent detection is driven by the
 * files and directories these tests create rather than by whatever agent CLIs
 * the host has installed. See `makeGitOnlyPath`.
 */
const ORIGINAL_PATH = process.env.PATH ?? process.env.Path ?? '';
let SAFE_PATH = ORIGINAL_PATH;
const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-init-repo-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

  // `cyv init` in a source clone writes a repo-relative path to the
  // TypeScript analyzer. A bare temp repo has no such package, so link the
  // real analyzer under `packages/analyzer-typescript` so the generated config
  // resolves the same way a real clone does. The link is gitignored so the
  // post-init `cyv check` does not try to analyze the analyzer's own files.
  await writeFile(join(repo, '.gitignore'), 'packages/\n');
  const packagesDir = join(repo, 'packages');
  await mkdir(packagesDir, { recursive: true });
  const analyzerSource = resolve('packages/analyzer-typescript');
  const analyzerLink = join(packagesDir, 'analyzer-typescript');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(analyzerSource, analyzerLink, linkType);

  return repo;
}

async function makeRepoWithoutAnalyzer(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-init-repo-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

  // Vitest under pnpm sets NODE_PATH to the workspace packages, which would
  // let the bare package specifier resolve even though the repository has not
  // installed it. A broken package entry in this temp repo's node_modules
  // shadows the NODE_PATH entry and makes resolution fail, simulating a
  // package that is not installed or cannot be loaded.
  const brokenPackage = join(repo, 'node_modules', '@checkyourvibe', 'analyzer-typescript');
  await mkdir(brokenPackage, { recursive: true });
  await writeFile(join(brokenPackage, 'analyzer.manifest.json'), 'not valid json', 'utf-8');

  return repo;
}

/** Pre-seeds `.claude/settings.json` so claude-code detection is deterministic
 * (present-file detection) instead of depending on whether a `claude` binary
 * happens to be on this machine's PATH. */
async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'cyv-init-home-'));
  await mkdir(join(homeDir, '.claude'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');
  return homeDir;
}

function context(repo: string, argv: string[], homeDir: string): CommandContext {
  return {
    cwd: repo,
    argv,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  };
}

async function snapshot(dir: string): Promise<string[]> {
  const entries: string[] = [];
  await walk('');
  return entries.slice().sort();

  async function walk(rel: string): Promise<void> {
    const full = join(dir, rel);
    const items = await readdir(full, { withFileTypes: true });
    for (const item of items) {
      const itemRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        // Skip symlinks/junctions so the snapshot does not recurse into a
        // linked package tree (e.g. the `packages/analyzer-typescript` link
        // created by `makeRepo`), which can be large and is gitignored.
        continue;
      }
      entries.push(itemRel);
      if (item.isDirectory()) {
        await walk(itemRel);
      }
    }
  }
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

async function writeSourceFiles(repo: string, source: string): Promise<void> {
  const srcDir = join(repo, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(
    join(repo, 'tsconfig.json'),
    `${JSON.stringify(
      { compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true }, include: ['src/**/*.ts'] },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(srcDir, 'thing.ts'), source);
}

async function baselineExists(repo: string): Promise<boolean> {
  try {
    await stat(join(repo, 'checkyourvibe.baseline.json'));
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') {
      return false;
    }
  }
  return true;
}

interface ConfigShape {
  packs: string[];
  analyzers: { id: string; package: string }[];
  agents: string[];
  exclude: string[];
}

interface AnalyzerShape {
  id: string;
  package: string;
}

function isAnalyzerShape(value: unknown): value is AnalyzerShape {
  return isRecord(value) && typeof value.id === 'string' && typeof value.package === 'string';
}

function isConfigShape(value: unknown): value is ConfigShape {
  if (!isRecord(value)) {
    return false;
  }
  if (!isStringArray(value.packs) || !isStringArray(value.agents) || !isStringArray(value.exclude)) {
    return false;
  }
  const analyzers = value.analyzers;
  if (!Array.isArray(analyzers)) {
    return false;
  }
  for (let i = 0; i < analyzers.length; i++) {
    const entry: unknown = analyzers[i];
    if (!isAnalyzerShape(entry)) {
      return false;
    }
  }
  return true;
}

function parseConfig(raw: string): ConfigShape {
  const parsed: unknown = JSON.parse(raw);
  if (!isConfigShape(parsed)) {
    throw new Error(`checkyourvibe.json does not match the expected shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
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

async function seedMultiAgent(repo: string, homeDir: string): Promise<void> {
  await mkdir(join(homeDir, '.codex'), { recursive: true });
  await mkdir(join(repo, '.cursor'), { recursive: true });
  await mkdir(join(repo, '.gemini'), { recursive: true });
  await mkdir(join(repo, '.agents'), { recursive: true });
}

describe('cyv init', () => {
  beforeAll(async () => {
    SAFE_PATH = await makeGitOnlyPath();
    process.env.PATH = SAFE_PATH;
  });

  afterAll(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  it('--dry-run writes nothing and exits 0', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const beforeRepo = await snapshot(repo);
    const beforeHome = await snapshot(homeDir);
    const captured = captureConsole();

    try {
      const code = await initModule.command.run(context(repo, ['--dry-run'], homeDir));
      expect(code).toBe(0);

      const afterRepo = await snapshot(repo);
      const afterHome = await snapshot(homeDir);
      expect(afterRepo).toEqual(beforeRepo);
      expect(afterHome).toEqual(beforeHome);

      expect(captured.logs.join('\n')).toContain('file(s) would change.');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('plans the orchestration brief for the agent the orchestrating lane names', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      // A first `init` writes the config; the lanes are then declared by hand,
      // as they always are, and a second `init` should pick them up.
      await initModule.command.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
      captured.logs.length = 0;

      const configPath = join(repo, 'checkyourvibe.json');
      const raw: unknown = JSON.parse(await readFile(configPath, 'utf-8'));
      if (typeof raw !== 'object' || raw === null) throw new Error('config is not an object');
      await writeFile(
        configPath,
        JSON.stringify(
          {
            ...raw,
            executor: {
              lanes: [
                {
                  id: 'session',
                  agentId: 'claude-code',
                  concurrencyCap: 1,
                  orchestrator: true,
                  billing: { kind: 'subscription', permitsBilledOverage: false },
                  models: [{ kind: 'mechanical-transformation', ordering: ['only'] }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );

      const code = await initModule.command.run(context(repo, ['--dry-run'], homeDir));
      expect(code).toBe(0);

      // The regression this guards: `init` read the config through a lenient
      // parser that keeps only the fields it needs and drops `executor`, so the
      // brief was generated from no lanes and no block was ever planned.
      const output = captured.logs.join('\n');
      expect(output).toContain('checkyourvibe:start:claude-code-orchestration');
      expect(output).toContain('declares lane `session` as the orchestrator');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('--yes --allow-outside-repo writes the settings json-merge, the CLAUDE.md managed block, and the per-rule agent files', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const expectedCyvCommand = await initModule.resolveCyvCommand();
      const code = await initModule.command.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
      expect(code).toBe(0);

      const configRaw = await readFile(join(repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(configRaw);
      expect(config.packs).toEqual(['core-ts']);
      expect(config.analyzers).toHaveLength(1);
      expect(config.analyzers[0]?.id).toBe('typescript');
      // Assert the reference RESOLVES, not that it equals a particular string.
      // The previous assertion pinned `./packages/analyzer-typescript/...`, which
      // resolves against the repository being initialised — correct only when
      // that repository is this one. It passed while `cyv init` in any other
      // project wrote a config naming an analyzer that was not there, and
      // therefore checked nothing. A test that pins the spelling cannot catch
      // that; one that loads it can.
      const analyzerRef = config.analyzers[0]?.package ?? '';
      expect(analyzerRef).not.toBe('');
      await expect(loadAnalyzerManifest(analyzerRef, repo)).resolves.toMatchObject({ id: 'typescript' });
      expect(config.agents).toEqual(['claude-code']);
      expect(config.exclude.length).toBeGreaterThan(0);

      const settingsRaw = await readFile(join(homeDir, '.claude', 'settings.json'), 'utf-8');
      expect(settingsRaw).toContain('Edit|Write');

      const settings = parseSettings(settingsRaw);
      const hookCommand = settings.hooks.PostToolUse[0]?.hooks[0]?.command;
      expect(hookCommand).toBeDefined();
      expect(hookCommand ?? '').toContain(expectedCyvCommand);
      expect(hookCommand ?? '').toContain('hook claude-code');

      const claudeMd = await readFile(join(repo, 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain(MANAGED_BLOCK_START('claude-code-workflow'));
      expect(claudeMd).toContain(MANAGED_BLOCK_END('claude-code-workflow'));
      expect(claudeMd).toContain('checkyourvibe');

      const noAnyAgent = await readFile(join(homeDir, '.claude', 'agents', 'cyv-no-any.md'), 'utf-8');
      expect(noAnyAgent).toContain('name: cyv-no-any');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('run twice with --yes --allow-outside-repo is idempotent — the second run reports no changes', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const first = await initModule.command.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
      expect(first).toBe(0);
      captured.logs.length = 0;

      const second = await initModule.command.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
      expect(second).toBe(0);

      const planOutput = captured.logs.join('\n');
      expect(planOutput).toMatch(/^0 of \d+ file\(s\) would change\.$/m);

      const appliedLines = captured.logs.filter((line) => /^\s*\[(created|updated|unchanged)\]/.test(line));
      expect(appliedLines.length).toBeGreaterThan(0);
      expect(appliedLines.every((line) => line.includes('[unchanged]'))).toBe(true);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('refuses without --yes when stdin is not a TTY, and writes nothing', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const beforeRepo = await snapshot(repo);
    const captured = captureConsole();

    try {
      expect(process.stdin.isTTY).not.toBe(true);

      const code = await initModule.command.run(context(repo, [], homeDir));
      expect(code).toBe(1);
      expect(captured.errors.join('\n')).toMatch(/TTY|--yes/);

      const afterRepo = await snapshot(repo);
      expect(afterRepo).toEqual(beforeRepo);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('plans for every detected agent in one run and shows one combined diff', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    await seedMultiAgent(repo, homeDir);
    const beforeRepo = await snapshot(repo);
    const beforeHome = await snapshot(homeDir);
    const captured = captureConsole();

    try {
      const code = await initModule.command.run(context(repo, ['--dry-run'], homeDir));
      expect(code).toBe(0);

      const afterRepo = await snapshot(repo);
      const afterHome = await snapshot(homeDir);
      expect(afterRepo).toEqual(beforeRepo);
      expect(afterHome).toEqual(beforeHome);

      const output = captured.logs.join('\n');
      expect(output).toContain('cyv init plan:');
      expect(output).toContain('Claude Code:');
      expect(output).toContain('Cursor CLI:');
      expect(output).toContain('Gemini CLI:');
      expect(output).toContain('Antigravity CLI:');
      expect(output).toContain('Codex CLI:');
      expect(output).toMatch(/\d+ of \d+ file\(s\) would change\./);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports a plugin that throws and still applies the other agents', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    const failingPlugin: AgentPlugin = {
      id: 'failing',
      name: 'Failing Agent',
      surfaces: ['hook'],
      detect: vi.fn().mockRejectedValue(new Error('detector broke')),
      plan: vi.fn().mockResolvedValue([]),
      parseHookPayload: vi.fn().mockReturnValue({ files: [], event: 'test' }),
      formatResult: vi.fn().mockReturnValue({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const realPlugins = await initModule.loadAllPlugins();
    initModule.agentPluginsOverride.plugins = [failingPlugin, ...realPlugins];

    try {
      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('Failing Agent:');
      expect(output).toContain('detector broke');
      expect(output).toContain('Claude Code:');

      const configRaw = await readFile(join(repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(configRaw);
      expect(config.agents).not.toContain('failing');
      expect(config.agents).toContain('claude-code');
    } finally {
      initModule.agentPluginsOverride.plugins = undefined;
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  /**
   * A plugin that fails while planning produces no writes, so nothing about
   * it reaches the diff. Without its own report it would vanish from the plan
   * entirely while the header still claimed it was being configured.
   */
  it('reports a plugin whose plan throws and still applies the other agents', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    await mkdir(join(repo, '.cursor'), { recursive: true });
    const captured = captureConsole();

    const failingPlugin: AgentPlugin = {
      id: 'cursor',
      name: 'Cursor CLI',
      surfaces: ['hook'],
      detect: vi.fn().mockResolvedValue(true),
      plan: vi.fn().mockRejectedValue(new Error('planner broke')),
      parseHookPayload: vi.fn().mockReturnValue({ files: [], event: 'test' }),
      formatResult: vi.fn().mockReturnValue({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const realPlugins = await initModule.loadAllPlugins();
    initModule.agentPluginsOverride.plugins = [
      failingPlugin,
      ...realPlugins.filter((plugin) => plugin.id !== 'cursor'),
    ];

    try {
      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('Not in plan:');
      expect(output).toContain('could not be planned: planner broke');

      // The other agents still landed.
      expect(await fileExists(join(repo, 'CLAUDE.md'))).toBe(true);
      expect(await fileExists(join(repo, '.cursor', 'hooks.json'))).toBe(false);

      const config = parseConfig(await readFile(join(repo, 'checkyourvibe.json'), 'utf-8'));
      expect(config.agents).toContain('claude-code');
    } finally {
      initModule.agentPluginsOverride.plugins = undefined;
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('initialising two agents with --yes --allow-outside-repo leaves both managed blocks intact', async () => {
    const repo = await makeRepo();
    const homeDir = await mkdtemp(join(tmpdir(), 'cyv-init-home-'));
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await mkdir(join(repo, '.agents'), { recursive: true });
    const captured = captureConsole();

    try {
      const first = await initModule.command.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
      expect(first).toBe(0);

      const agentsMd = await readFile(join(repo, 'AGENTS.md'), 'utf-8');
      expect(agentsMd).toContain(MANAGED_BLOCK_START('codex-workflow'));
      expect(agentsMd).toContain(MANAGED_BLOCK_END('codex-workflow'));
      expect(agentsMd).toContain(MANAGED_BLOCK_START('antigravity-workflow'));
      expect(agentsMd).toContain(MANAGED_BLOCK_END('antigravity-workflow'));

      captured.logs.length = 0;
      const second = await initModule.command.run(context(repo, ['--yes', '--allow-outside-repo'], homeDir));
      expect(second).toBe(0);

      const planOutput = captured.logs.join('\n');
      expect(planOutput).toMatch(/^0 of \d+ file\(s\) would change\.$/m);

      const agentsMd2 = await readFile(join(repo, 'AGENTS.md'), 'utf-8');
      expect(agentsMd2).toContain(MANAGED_BLOCK_START('codex-workflow'));
      expect(agentsMd2).toContain(MANAGED_BLOCK_END('codex-workflow'));
      expect(agentsMd2).toContain(MANAGED_BLOCK_START('antigravity-workflow'));
      expect(agentsMd2).toContain(MANAGED_BLOCK_END('antigravity-workflow'));
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('offers a baseline when the repository has violations and does not write one without confirmation', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    await writeSourceFiles(repo, 'export const value: any = 1;\n');
    const captured = captureConsole();

    try {
      expect(process.stdin.isTTY).not.toBe(true);

      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('A baseline records existing violations as deferred debt, not a fix.');
      expect(output).toContain('docs/adoption.md');

      // The adoption guidance is static text and survives `--yes`. The count
      // does not: it is the one part of the offer that costs a type-aware scan
      // of the whole repository, which `--yes` would discard.
      expect(output).not.toContain('This run found');

      const hasBaseline = await baselineExists(repo);
      expect(hasBaseline).toBe(false);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  }, 15_000);

  /**
   * Every other test in this file runs with stdin detached, which is the one
   * condition under which the baseline prompt skips itself. That is why an
   * interactive `--yes` run could sit on a readline interface for a full minute
   * without a single test noticing. This one fakes the TTY so the prompt is
   * live, and fails on the clock if `--yes` ever reaches it again.
   */
  it('--yes does not reach the baseline prompt even when stdin is a TTY', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    await writeSourceFiles(repo, 'export const value: any = 1;\n');
    const captured = captureConsole();
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    try {
      expect(process.stdin.isTTY).toBe(true);

      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('No baseline written: --yes runs without prompting.');
      expect(output).not.toContain('Take a baseline now?');
      expect(await baselineExists(repo)).toBe(false);

      // The repository has a violation, so a whole-repository scan would have
      // had a count to report. Its absence is what says the scan never ran:
      // under `--yes` the count could only be printed and then discarded, and
      // paying for a type-aware pass over every file to print one line is what
      // exhausts the heap and kills `init` on a large repository.
      expect(output).not.toContain('This run found');
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      } else {
        Object.defineProperty(process.stdin, 'isTTY', descriptor);
      }
      captured.restore();
      await cleanup(repo, homeDir);
    }
  }, 20_000);

  it('does not offer a baseline when the repository is clean', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    await writeSourceFiles(repo, 'export const value = 1;\n');
    const captured = captureConsole();

    try {
      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).not.toContain('A baseline records these as deferred debt');

      const hasBaseline = await baselineExists(repo);
      expect(hasBaseline).toBe(false);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  }, 15_000);

  /**
   * The core ships no analyzer, so this is a supported first run rather than a
   * failure. It still has to be reported: a configuration resolving to no rules
   * must not read as a working setup.
   *
   * The message no longer leads with one analyzer's name, so these assert what
   * a reader needs — that none is installed, that they are separate modules,
   * and one command that gets you one.
   */
  it('writes no analyzer when none is installed, and says how to add one', async () => {
    const repo = await makeRepoWithoutAnalyzer();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const configRaw = await readFile(join(repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(configRaw);
      expect(config.packs).toEqual([]);
      expect(config.analyzers).toHaveLength(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('none is installed');
      expect(output).toContain('separate modules');
      expect(output).toContain('@checkyourvibe/analyzer-typescript');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('--yes on a repo with configured agents does not adopt a newly detected one, and lists skipped agents', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();

    // Pre-seed an existing config that has only claude-code.
    const existingConfig = {
      packs: ['core-ts'],
      analyzers: [{ id: 'typescript', package: './packages/analyzer-typescript/analyzer.manifest.json' }],
      agents: ['claude-code'],
      rules: {},
      strict: false,
      exclude: [],
    };
    await writeFile(join(repo, 'checkyourvibe.json'), `${JSON.stringify(existingConfig, null, 2)}\n`);

    // Detect Cursor CLI without adopting it.
    await mkdir(join(repo, '.cursor'), { recursive: true });
    const beforeHome = await readFile(join(homeDir, '.claude', 'settings.json'), 'utf-8');
    const captured = captureConsole();

    try {
      const code = await initModule.command.run(context(repo, ['--yes'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('Cursor CLI');
      expect(output).toContain('detected but not adopted');
      expect(output).toContain('Outside this repository');
      expect(output).not.toContain('--adopt claude-code');

      const configRaw = await readFile(join(repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(configRaw);
      expect(config.agents).toEqual(['claude-code']);

      const afterHome = await readFile(join(homeDir, '.claude', 'settings.json'), 'utf-8');
      expect(afterHome).toBe(beforeHome);

      const cursorHooks = await fileExists(join(repo, '.cursor', 'hooks.json'));
      expect(cursorHooks).toBe(false);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('--adopt adds a newly detected agent to an existing config', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();

    const existingConfig = {
      packs: ['core-ts'],
      analyzers: [{ id: 'typescript', package: './packages/analyzer-typescript/analyzer.manifest.json' }],
      agents: ['claude-code'],
      rules: {},
      strict: false,
      exclude: [],
    };
    await writeFile(join(repo, 'checkyourvibe.json'), `${JSON.stringify(existingConfig, null, 2)}\n`);

    await mkdir(join(repo, '.cursor'), { recursive: true });
    const captured = captureConsole();

    try {
      const code = await initModule.command.run(context(repo, ['--yes', '--adopt', 'cursor'], homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('Agents that will be configured: Claude Code (claude-code), Cursor CLI (cursor)');
      expect(output).not.toContain('detected but not adopted');

      const configRaw = await readFile(join(repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(configRaw);
      expect(config.agents).toEqual(['claude-code', 'cursor']);

      const cursorHooks = await fileExists(join(repo, '.cursor', 'hooks.json'));
      expect(cursorHooks).toBe(true);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('completes without --allow-outside-repo when run as a child process', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();
    try {
      const cyvCommand = await initModule.resolveCyvCommand();
      // `process.execPath`, not 'node': PATH is deliberately reduced to git
      // alone for these tests, so the child has to be told where node is. It
      // also guarantees the child runs the same runtime as the parent.
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [cyvCommand, 'init', '--dry-run'],
        {
          cwd: repo,
          env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: SAFE_PATH },
        },
      );
      const output = `${stderr}\n${stdout}`;
      expect(output).toContain('cyv init plan:');
      expect(output).toContain('would change');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });
});

/**
 * `unverifiedSurfaces` is read out of a plugin module and printed verbatim by
 * `cyv doctor`, and an adapter can come from anyone. These hold the guard that
 * keeps a malformed declaration from being loaded and reported as if it said
 * something.
 */
describe('agent plugin validation', () => {
  function validPlugin(): AgentPlugin {
    return {
      id: 'example',
      name: 'Example Agent',
      surfaces: ['hook'],
      detect: async () => true,
      plan: async () => [],
      parseHookPayload: () => ({ files: [], event: 'test' }),
      formatResult: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
  }

  it('accepts a plugin that declares no unverified surfaces', () => {
    expect(initModule.isAgentPlugin(validPlugin())).toBe(true);
  });

  it('accepts a well-formed unverifiedSurfaces declaration', () => {
    const plugin = {
      ...validPlugin(),
      unverifiedSurfaces: [{ surface: 'hook', reason: 'the path field is undocumented' }],
    };
    expect(initModule.isAgentPlugin(plugin)).toBe(true);
  });

  it('rejects an unverified surface naming a surface that is not in the protocol', () => {
    const plugin = {
      ...validPlugin(),
      unverifiedSurfaces: [{ surface: 'telepathy', reason: 'invented' }],
    };
    expect(initModule.isAgentPlugin(plugin)).toBe(false);
  });

  it('rejects an unverified surface with no reason, which would report nothing useful', () => {
    const plugin = { ...validPlugin(), unverifiedSurfaces: [{ surface: 'hook' }] };
    expect(initModule.isAgentPlugin(plugin)).toBe(false);
  });

  it('rejects an unverified surface with an empty reason', () => {
    const plugin = { ...validPlugin(), unverifiedSurfaces: [{ surface: 'hook', reason: '' }] };
    expect(initModule.isAgentPlugin(plugin)).toBe(false);
  });

  it('rejects unverifiedSurfaces that is not an array', () => {
    const plugin = { ...validPlugin(), unverifiedSurfaces: { surface: 'hook', reason: 'nope' } };
    expect(initModule.isAgentPlugin(plugin)).toBe(false);
  });
});
