/**
 * `cyv init` run from an installed package, rather than from this checkout.
 *
 * Every other test here runs the CLI out of the workspace, where an absolute
 * path into the checkout resolves and a repo-relative analyzer reference works.
 * Neither is true for someone who installed the package: the checkout does not
 * exist on their machine, and an `npx` cache directory will not exist tomorrow.
 * Four defects were found by installing the tarballs by hand, and none of them
 * was reachable from a test that ran from the checkout.
 *
 * So this stages the layout an install produces — core as a real copy under
 * `node_modules`, its dependencies linked, `cyv` on PATH — and spawns the CLI
 * from there. What it asserts is the distribution contract: the generated
 * `checkyourvibe.json` names a package specifier rather than a path into this
 * machine, the generated hook invokes a bare `cyv` rather than a path that
 * an upgrade would invalidate, and an analyzer that is not installed is left
 * out of the configuration instead of being named and unresolvable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnknownArray } from '../../src/guards.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..');
const WORKSPACE_ROOT = join(CORE_ROOT, '..', '..');
const CORE_DIST = join(CORE_ROOT, 'dist');
const CORE_DEPS = join(CORE_ROOT, 'node_modules');
const ANALYZER_ROOT = join(WORKSPACE_ROOT, 'packages', 'analyzer-typescript');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

interface Staged {
  stage: string;
  repo: string;
  homeDir: string;
  cliEntry: string;
  binDir: string;
}

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the directory layout `npm install` would produce.
 *
 * Core has to be a real copy rather than a link: Node resolves a symlinked
 * entry point back to its target, so a linked core would report the checkout
 * as its own location and take the source-clone path through every decision
 * this test exists to exercise. Its dependencies are linked, because copying
 * a whole dependency tree adds nothing that this test reads.
 */
async function stageInstall(options: { withAnalyzer: boolean }): Promise<Staged> {
  const stage = await realpath(await mkdtemp(join(tmpdir(), 'cyv-installed-')));
  const repo = join(stage, 'project');
  const homeDir = join(stage, 'home');
  const binDir = join(stage, 'bin');

  await mkdir(repo, { recursive: true });
  await mkdir(join(homeDir, '.claude'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');
  await mkdir(binDir, { recursive: true });

  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'installed@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Installed Test'], { cwd: repo });

  const nodeModules = join(repo, 'node_modules');
  const scope = join(nodeModules, '@checkyourvibe');
  await mkdir(scope, { recursive: true });

  for (const entry of await readdir(CORE_DEPS)) {
    if (entry === '@checkyourvibe') {
      for (const sub of await readdir(join(CORE_DEPS, entry))) {
        await symlink(join(CORE_DEPS, entry, sub), join(scope, sub), LINK_TYPE);
      }
      continue;
    }
    await symlink(join(CORE_DEPS, entry), join(nodeModules, entry), LINK_TYPE);
  }

  await cp(join(CORE_ROOT, 'package.json'), join(scope, 'core', 'package.json'));
  await cp(CORE_DIST, join(scope, 'core', 'dist'), { recursive: true });

  if (options.withAnalyzer) {
    await symlink(ANALYZER_ROOT, join(scope, 'analyzer-typescript'), LINK_TYPE);
  }

  const cliEntry = join(scope, 'core', 'dist', 'cli', 'index.js');
  const node = process.execPath.replace(/\\/g, '/');
  const wrapper = join(binDir, 'cyv');
  await writeFile(wrapper, `#!/bin/sh\nexec "${node}" "${cliEntry.replace(/\\/g, '/')}" "$@"\n`);
  await chmod(wrapper, 0o755);
  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'cyv.cmd'), `@echo off\r\n"${process.execPath}" "${cliEntry}" %*\r\n`);
  }

  return { stage, repo, homeDir, cliEntry, binDir };
}

/**
 * The environment an installed CLI would actually see.
 *
 * `NODE_PATH` is dropped on purpose. Vitest under pnpm points it at the
 * workspace packages, which lets a bare package specifier resolve from a
 * project that never installed it — and whether the specifier resolves from
 * the project is the whole question here.
 */
function childEnv(staged: Staged): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_PATH') {
      continue;
    }
    env[key] = value;
  }
  env.HOME = staged.homeDir;
  env.USERPROFILE = staged.homeDir;
  env.PATH = `${staged.binDir}${delimiter}${process.env.PATH ?? ''}`;
  return env;
}

function runInstalledCli(staged: Staged, args: string[]): ProcResult {
  const result = spawnSync(process.execPath, [staged.cliEntry, ...args], {
    cwd: staged.repo,
    env: childEnv(staged),
    encoding: 'utf-8',
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

interface AnalyzerEntry {
  id: string;
  package: string;
}

function analyzerEntries(raw: string): AnalyzerEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`checkyourvibe.json is not an object: ${raw.slice(0, 200)}`);
  }
  const analyzers = parsed.analyzers;
  if (!isUnknownArray(analyzers)) {
    throw new Error(`checkyourvibe.json has no "analyzers" array: ${raw.slice(0, 200)}`);
  }
  const entries: AnalyzerEntry[] = [];
  for (let i = 0; i < analyzers.length; i++) {
    const entry: unknown = analyzers[i];
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.package !== 'string') {
      throw new Error(`checkyourvibe.json has a malformed analyzer entry: ${raw.slice(0, 200)}`);
    }
    entries.push({ id: entry.id, package: entry.package });
  }
  return entries;
}

/** Every `command` string under `hooks.PostToolUse`, however deeply nested. */
function hookCommands(raw: string): string[] {
  const commands: string[] = [];
  const parsed: unknown = JSON.parse(raw);
  collect(parsed);
  return commands;

  function collect(value: unknown): void {
    if (isUnknownArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item: unknown = value[i];
        collect(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.command === 'string') {
      commands.push(value.command);
    }
    for (const nested of Object.values(value)) {
      collect(nested);
    }
  }
}

describe('cyv init from an installed package', () => {
  beforeAll(async () => {
    const schema = join(CORE_DIST, 'schema', 'config.schema.json');
    if (!(await exists(schema))) {
      throw new Error(
        `${schema} is missing, so an installed package would have no schema to copy. Run \`pnpm build\` before this test.`,
      );
    }
  });

  describe('with the TypeScript analyzer installed', () => {
    let staged: Staged;
    let init: ProcResult;

    beforeAll(async () => {
      staged = await stageInstall({ withAnalyzer: true });
      init = runInstalledCli(staged, ['init', '--yes', '--allow-outside-repo']);
    }, 120_000);

    afterAll(async () => {
      await rm(staged.stage, { recursive: true, force: true });
    });

    it('exits 0', () => {
      expect(`${init.stdout}${init.stderr}`).not.toContain('Cannot find module');
      expect(init.code).toBe(0);
    });

    it('names the analyzer by package specifier, not by a path into this machine', async () => {
      const raw = await readFile(join(staged.repo, 'checkyourvibe.json'), 'utf-8');
      const analyzers = analyzerEntries(raw);

      expect(analyzers).toHaveLength(1);
      const entry = analyzers[0];
      expect(entry?.package).toBe('@checkyourvibe/analyzer-typescript');
      expect(isAbsolute(entry?.package ?? '')).toBe(false);
      expect(raw).not.toContain(WORKSPACE_ROOT.replace(/\\/g, '\\\\'));
      expect(raw).not.toContain(staged.stage.replace(/\\/g, '\\\\'));
    });

    it('embeds a bare cyv command in the generated hook, not a path that an upgrade invalidates', async () => {
      const raw = await readFile(join(staged.homeDir, '.claude', 'settings.json'), 'utf-8');
      const commands = hookCommands(raw).filter((command) => command.includes('hook claude-code'));

      expect(commands).toEqual([
        // The analyzer hook, the notes hook, the notes Stop hook, and the
        // analyzer's own Stop hook, which checks the working tree for files no
        // Edit or Write event ever reported. Every one of them bare: the point
        // of this test is that no absolute path to a staged checkout survives
        // into the user's settings.
        'cyv hook claude-code',
        'cyv comments --hook claude-code',
        'cyv comments --hook claude-code',
        'cyv hook claude-code',
      ]);
      expect(raw).not.toContain(staged.stage.replace(/\\/g, '\\\\'));
    });

    it('doctor confirms the embedded command still resolves', () => {
      const doctor = runInstalledCli(staged, ['doctor']);
      expect(doctor.stdout).toContain('The embedded cyv command resolves (cyv)');
      expect(doctor.stdout).not.toContain('[error]');
      expect(doctor.code).toBe(0);
    }, 60_000);
  });

  describe('with no analyzer installed', () => {
    let staged: Staged;
    let init: ProcResult;

    beforeAll(async () => {
      staged = await stageInstall({ withAnalyzer: false });
      init = runInstalledCli(staged, ['init', '--yes', '--allow-outside-repo']);
    }, 120_000);

    afterAll(async () => {
      await rm(staged.stage, { recursive: true, force: true });
    });

    it('writes no analyzer entry rather than one that cannot resolve', async () => {
      expect(init.code).toBe(0);
      const raw = await readFile(join(staged.repo, 'checkyourvibe.json'), 'utf-8');
      expect(analyzerEntries(raw)).toHaveLength(0);
    });

    it('says an analyzer has to be added, and how', () => {
      expect(init.stdout).toContain('none is installed');
      expect(init.stdout).toContain('separate modules');
      expect(init.stdout).toContain('@checkyourvibe/analyzer-typescript');
    });

    it('still embeds a bare cyv command in the generated hook', async () => {
      const raw = await readFile(join(staged.homeDir, '.claude', 'settings.json'), 'utf-8');
      const commands = hookCommands(raw).filter((command) => command.includes('hook claude-code'));
      expect(commands).toEqual([
        // The analyzer hook, the notes hook, the notes Stop hook, and the
        // analyzer's own Stop hook, which checks the working tree for files no
        // Edit or Write event ever reported. Every one of them bare: the point
        // of this test is that no absolute path to a staged checkout survives
        // into the user's settings.
        'cyv hook claude-code',
        'cyv comments --hook claude-code',
        'cyv comments --hook claude-code',
        'cyv hook claude-code',
      ]);
    });
  });
});
