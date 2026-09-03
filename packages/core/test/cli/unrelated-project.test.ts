/**
 * The first run someone who is not developing checkyourvibe actually gets.
 *
 * They clone this repository, run `install.sh`, and then run `cyv` inside a
 * project of their own that has never heard of checkyourvibe. Every other test
 * that spawns the CLI runs it either inside this checkout — where the
 * repo-relative analyzer path resolves — or inside a staged install where the
 * analyzer was deliberately linked into the project. Neither is a stranger's
 * repository, and for a long time neither noticed that a stranger got
 * `"analyzers": []` and a `check` reporting `0 of 0 rules enabled`.
 *
 * So this stages the one layout that was never covered: the CLI running from
 * this clone, `cwd` in an unrelated git repository, `NODE_PATH` dropped so a
 * bare package specifier only resolves if something really resolves it. What it
 * asserts is that the run produces real findings and that the configuration it
 * wrote to get them contains no path into this machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnknownArray } from '../../src/guards.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..');
const WORKSPACE_ROOT = join(CORE_ROOT, '..', '..');
const CLI_ENTRY = join(CORE_ROOT, 'dist', 'cli', 'index.js');

/**
 * A second analyzer to name explicitly. It is deliberately one that `init`
 * would never choose by itself, declares no `core-*` pack, and needs no
 * toolchain beyond Node — so it also covers the pack fallback for an analyzer
 * whose packs are all opt-in.
 */
const NAMED_ANALYZER = '@checkyourvibe/analyzer-comments';

/**
 * One file with two violations a syntax rule can find without the type checker,
 * so the assertion does not depend on the stranger's project having a tsconfig
 * this analyzer can resolve.
 */
const SOURCE = [
  'export function widen(input: string): string {',
  '  const forced = input as unknown as string;',
  '  return forced;',
  '}',
  '',
  'export function ignore(value: string): number {',
  '  // @ts-expect-error deliberately wrong',
  '  return value;',
  '}',
  '',
].join('\n');

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Stranger {
  stage: string;
  repo: string;
  homeDir: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** A git repository with TypeScript in it and nothing else — no node_modules, no config. */
async function makeStrangerProject(): Promise<Stranger> {
  const stage = await mkdtemp(join(tmpdir(), 'cyv-stranger-'));
  const repo = join(stage, 'project');
  const homeDir = join(stage, 'home');

  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(homeDir, '.claude'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');

  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'stranger@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Stranger'], { cwd: repo });

  await writeFile(join(repo, 'src', 'widen.ts'), SOURCE, 'utf-8');

  return { stage, repo, homeDir };
}

/**
 * The environment a stranger's shell would give the CLI.
 *
 * `NODE_PATH` is dropped because vitest under pnpm points it at this
 * workspace's packages, which would let `@checkyourvibe/analyzer-typescript`
 * resolve from a project that has nothing to do with it — and whether the
 * specifier resolves without that help is the whole question.
 */
function strangerEnv(stranger: Stranger): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_PATH') {
      continue;
    }
    env[key] = value;
  }
  env.HOME = stranger.homeDir;
  env.USERPROFILE = stranger.homeDir;
  return env;
}

function runCli(stranger: Stranger, args: string[]): ProcResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: stranger.repo,
    env: strangerEnv(stranger),
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

interface ParsedConfig {
  analyzers: AnalyzerEntry[];
  packs: string[];
}

function parseConfig(raw: string): ParsedConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`checkyourvibe.json is not an object: ${raw.slice(0, 200)}`);
  }

  const analyzers: AnalyzerEntry[] = [];
  const rawAnalyzers = parsed.analyzers;
  if (!isUnknownArray(rawAnalyzers)) {
    throw new Error(`checkyourvibe.json has no "analyzers" array: ${raw.slice(0, 200)}`);
  }
  for (let i = 0; i < rawAnalyzers.length; i++) {
    const entry: unknown = rawAnalyzers[i];
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.package !== 'string') {
      throw new Error(`checkyourvibe.json has a malformed analyzer entry: ${raw.slice(0, 200)}`);
    }
    analyzers.push({ id: entry.id, package: entry.package });
  }

  const packs: string[] = [];
  const rawPacks = parsed.packs;
  if (isUnknownArray(rawPacks)) {
    for (let i = 0; i < rawPacks.length; i++) {
      const pack: unknown = rawPacks[i];
      if (typeof pack === 'string') {
        packs.push(pack);
      }
    }
  }

  return { analyzers, packs };
}

describe('a first run in a project unrelated to checkyourvibe', () => {
  beforeAll(async () => {
    if (!(await fileExists(CLI_ENTRY))) {
      throw new Error(`${CLI_ENTRY} is missing. Run \`pnpm build\` before this test.`);
    }
  });

  describe('cyv init with no arguments beyond --yes', () => {
    let stranger: Stranger;
    let init: ProcResult;

    beforeAll(async () => {
      stranger = await makeStrangerProject();
      init = runCli(stranger, ['init', '--yes']);
    }, 120_000);

    afterAll(async () => {
      await rm(stranger.stage, { recursive: true, force: true });
    });

    it('exits 0', () => {
      expect(init.stderr).not.toContain('Cannot find module');
      expect(init.code).toBe(0);
    });

    it('configures the TypeScript analyzer rather than leaving the project with none', async () => {
      const raw = await readFile(join(stranger.repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(raw);

      expect(config.analyzers).toEqual([
        { id: 'typescript', package: '@checkyourvibe/analyzer-typescript' },
      ]);
      expect(config.packs).toEqual(['core-ts']);
    });

    it('writes no absolute path into the configuration', async () => {
      const raw = await readFile(join(stranger.repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(raw);

      for (const entry of config.analyzers) {
        expect(isAbsolute(entry.package)).toBe(false);
      }
      expect(raw).not.toContain(WORKSPACE_ROOT.replace(/\\/g, '\\\\'));
      expect(raw).not.toContain(stranger.stage.replace(/\\/g, '\\\\'));
    });

    it('says the analyzer came from the checkyourvibe installation, not from this project', () => {
      expect(init.stdout).toContain('It is not installed in this repository');
      expect(init.stdout).toContain('resolved from the checkyourvibe installation running this command');
    });

    it('check --all then reports real findings instead of an empty rule set', () => {
      const check = runCli(stranger, ['check', '--all']);

      expect(check.stdout).not.toContain('0 of 0 rules enabled');
      expect(check.stdout).toContain('rules enabled');
      expect(check.stdout).toContain('no-as-cast');
      expect(check.stdout).toContain('no-ts-comment');
      expect(check.stdout).toContain('1 file checked');
      expect(check.code).toBe(1);
    }, 120_000);
  });

  describe('cyv init --analyzer', () => {
    let stranger: Stranger;

    beforeAll(async () => {
      stranger = await makeStrangerProject();
    }, 120_000);

    afterAll(async () => {
      await rm(stranger.stage, { recursive: true, force: true });
    });

    it('configures the named analyzer, taking its id and packs from its own manifest', async () => {
      const init = runCli(stranger, ['init', '--yes', '--analyzer', NAMED_ANALYZER]);
      expect(init.code).toBe(0);

      const raw = await readFile(join(stranger.repo, 'checkyourvibe.json'), 'utf-8');
      const config = parseConfig(raw);

      expect(config.analyzers).toEqual([{ id: 'comments', package: NAMED_ANALYZER }]);
      expect(config.packs).toEqual(['comment-quality']);
    }, 120_000);

    it('fails with the reason when the named analyzer does not resolve, rather than picking another', async () => {
      const other = await makeStrangerProject();
      try {
        const init = runCli(other, ['init', '--yes', '--analyzer', '@nobody/analyzer-nowhere']);

        expect(init.code).toBe(2);
        expect(init.stderr).toContain('@nobody/analyzer-nowhere');
        expect(await fileExists(join(other.repo, 'checkyourvibe.json'))).toBe(false);
      } finally {
        await rm(other.stage, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
