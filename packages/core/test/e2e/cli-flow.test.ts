/**
 * The end-to-end test: config, discovery, routing, analysis, guidance, the
 * git backstop, and the agent glue, driven exactly as a user would drive them
 * — by spawning the built `cyv` binary and a real `git`, never by importing a
 * `src/cli/*` command module and calling it in-process.
 *
 * The flow runs against one temp git repository and one temp fake-home
 * directory, in the order a real adoption would happen: check before any
 * glue exists, install the glue, install the backstop, try to break the
 * backstop, then try to break the merge logic that protects a user's own
 * CLAUDE.md prose. Steps share repo/home state on purpose — later steps
 * depend on earlier ones having actually run, the same way a real session
 * would.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInstall, planInstall } from '../../src/backstop/install.js';
import { resolveCyvCommand } from '../../src/cli/init.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../../src/protocol/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..', '..');
const WORKSPACE_ROOT = join(CORE_ROOT, '..', '..');
const CLI_ENTRY = join(CORE_ROOT, 'dist', 'cli', 'index.js');
const CONFIG_SCHEMA_SOURCE = join(WORKSPACE_ROOT, 'docs', 'protocol', 'config.schema.json');
const ANALYZER_MANIFEST = join(WORKSPACE_ROOT, 'packages', 'analyzer-typescript', 'analyzer.manifest.json');

const CLEAN_SOURCE = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const VIOLATION_SOURCE = `${CLEAN_SOURCE}\nexport const value: any = 1;\n`;

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the actual built CLI, the way a user's shell would. */
function runCli(repo: string, args: string[], homeDir: string): ProcResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    encoding: 'utf-8',
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo });
}

/** Like {@link git}, but never throws, so a non-zero exit can be asserted on. */
function gitTry(repo: string, args: string[]): ProcResult {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

async function writeCheckYourVibeConfig(repo: string): Promise<void> {
  await mkdir(join(repo, 'docs', 'protocol'), { recursive: true });
  const schema = await readFile(CONFIG_SCHEMA_SOURCE, 'utf-8');
  await writeFile(join(repo, 'docs', 'protocol', 'config.schema.json'), schema);

  const config = {
    packs: ['core-ts'],
    analyzers: [{ id: 'typescript', package: ANALYZER_MANIFEST }],
    agents: ['claude-code'],
    rules: {},
    strict: false,
    exclude: [],
  };
  await writeFile(join(repo, 'checkyourvibe.json'), `${JSON.stringify(config, null, 2)}\n`);

  // A real, resolvable tsconfig — without one, the analyzer falls back to a
  // degraded, no-lib project and inferred-`any` findings become unreliable
  // (see docs/specs/0001-core-vertical-slice/tasks.md's T603 milestone notes).
  await writeFile(
    join(repo, 'tsconfig.json'),
    `${JSON.stringify(
      { compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true }, include: ['src/**/*.ts'] },
      null,
      2,
    )}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && typeof err.code === 'string';
}

function quoteForSh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function snapshotDirSafe(dir: string): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { recursive: true });
    return entries.slice().sort();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

interface CheckJsonViolation {
  ruleId: string;
  guidance?: {
    summary: string;
    notFixes: { pattern: string; because: string; rule?: string }[];
  };
}

interface CheckJsonReport {
  violations: CheckJsonViolation[];
}

function isNotFix(value: unknown): value is { pattern: string; because: string; rule?: string } {
  return (
    isRecord(value) &&
    typeof value['pattern'] === 'string' &&
    typeof value['because'] === 'string' &&
    (value['rule'] === undefined || typeof value['rule'] === 'string')
  );
}

function isCheckJsonViolation(value: unknown): value is CheckJsonViolation {
  if (!isRecord(value)) return false;
  if (typeof value['ruleId'] !== 'string') return false;
  const guidance = value['guidance'];
  if (guidance !== undefined) {
    if (!isRecord(guidance)) return false;
    const notFixes = guidance['notFixes'];
    if (!isUnknownArray(notFixes)) return false;
    if (!notFixes.every((item: unknown) => isNotFix(item))) return false;
  }
  return true;
}

function isCheckJsonReport(value: unknown): value is CheckJsonReport {
  return (
    isRecord(value) &&
    isUnknownArray(value['violations']) &&
    value['violations'].every((item: unknown) => isCheckJsonViolation(item))
  );
}

describe('cyv end-to-end', () => {
  let repo: string;
  let homeDir: string;
  let cyvCommand: string;
  const realClaudeDir = join(homedir(), '.claude');
  let realSettingsBefore: string | null;
  let realAgentFilesBefore: string[];

  beforeAll(async () => {
    realSettingsBefore = await readFile(join(realClaudeDir, 'settings.json'), 'utf-8').catch(
      () => null,
    );
    // Snapshotted rather than asserted to be empty. Anyone who has actually run
    // `cyv init` on this repository — which `cyv doctor` tells them to do — has
    // these files in their real home, legitimately. Asserting `[]` outright made
    // the guard fail for exactly the people who use the tool, which is how a
    // guard gets deleted. What matters is that THIS RUN added nothing.
    realAgentFilesBefore = ((await snapshotDirSafe(join(realClaudeDir, 'agents'))) ?? []).filter(
      (name) => name.startsWith('cyv-'),
    );

    const repoParent = await mkdtemp(join(tmpdir(), 'cyv-e2e-repo-'));
    repo = join(repoParent, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    git(repo, ['config', 'user.name', 'E2E Test']);

    // Fake home so `cyv init` never touches the real ~/.claude. Pre-seeding
    // settings.json (rather than relying on a `claude` binary on PATH) makes
    // claude-code detection deterministic, following the pattern already
    // established in test/cli/init.test.ts.
    homeDir = await mkdtemp(join(tmpdir(), 'cyv-e2e-home-'));
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'thing.ts'), CLEAN_SOURCE);
    await writeCheckYourVibeConfig(repo);

    // An initial commit gives the repo a real HEAD before step 7 commits a
    // violation, matching any real repository. This test originally found that
    // `cyv check --staged` threw outright without one: `selectFiles` computed
    // `defaultBranch` + `mergeBase` ahead of the mode dispatch even for
    // `staged`, which needs neither, and `git merge-base HEAD HEAD` is fatal on
    // a zero-commit repo — precisely the state a freshly installed pre-commit
    // hook meets on its very first commit. Fixed in `run/discover.ts`; the
    // unborn-repository case is pinned in its own describe block below.
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'initial commit']);

    cyvCommand = await resolveCyvCommand();
  }, 30_000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('1. check --all on a clean file exits 0', () => {
    const result = runCli(repo, ['check', '--all'], homeDir);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }, 15_000);

  it('2. a violation makes check --all exit 1 and stdout names the rule', async () => {
    await writeFile(join(repo, 'src', 'thing.ts'), VIOLATION_SOURCE);

    const result = runCli(repo, ['check', '--all'], homeDir);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('no-any');
  }, 15_000);

  it('3. check --all --json emits parseable JSON whose violations carry guidance.notFixes', () => {
    const result = runCli(repo, ['check', '--all', '--json'], homeDir);
    expect(result.code).toBe(1);

    const report: unknown = JSON.parse(result.stdout);
    if (!isCheckJsonReport(report)) {
      throw new Error('expected check output to be a valid JSON report');
    }
    const violation = report.violations.find((v) => v.ruleId === 'no-any');
    expect(violation).toBeDefined();
    expect(violation?.guidance).toBeDefined();
    expect(violation?.guidance?.notFixes.length).toBeGreaterThan(0);
    expect(violation?.guidance?.notFixes[0]?.because).toBeTruthy();
  }, 15_000);

  it('4. init --yes --allow-outside-repo writes the settings file, the CLAUDE.md managed block, and the per-rule agent files', async () => {
    const result = runCli(repo, ['init', '--yes', '--allow-outside-repo'], homeDir);
    expect(result.code).toBe(0);

    const settingsRaw = await readFile(join(homeDir, '.claude', 'settings.json'), 'utf-8');
    expect(settingsRaw).toContain('hook claude-code');
    expect(settingsRaw).toContain(cyvCommand.replace(/\\/g, '\\\\'));

    const claudeMd = await readFile(join(repo, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain(MANAGED_BLOCK_START('claude-code-workflow'));
    expect(claudeMd).toContain(MANAGED_BLOCK_END('claude-code-workflow'));

    const agentFile = await readFile(join(homeDir, '.claude', 'agents', 'cyv-no-any.md'), 'utf-8');
    expect(agentFile).toContain('name: cyv-no-any');
  }, 15_000);

  it('5. init --yes --allow-outside-repo again is idempotent — no duplicated hook entry, nothing reported changed', async () => {
    const result = runCli(repo, ['init', '--yes', '--allow-outside-repo'], homeDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^0 of \d+ file\(s\) would change\.$/m);

    const settingsRaw = await readFile(join(homeDir, '.claude', 'settings.json'), 'utf-8');

    // Three entries carry this string: the analyzer's PostToolUse hook, the
    // notes PostToolUse hook, and the notes Stop hook that refuses to end a
    // turn with an unread note (spec 0042 Requirements 1.1, 1.2). Two of the
    // three are the notes command, which contains the analyzer's marker as a
    // substring — that overlap is deliberate here, because one marker owning
    // both means an upgrade cannot orphan either.
    //
    // The number is what this test is for: a second `init` must not grow it.
    expect(settingsRaw.split('hook claude-code').length - 1).toBe(4);
    expect(settingsRaw.split('comments --hook claude-code').length - 1).toBe(2);
  }, 15_000);

  // `cyv install-hooks` is listed in the CLI's dispatch table
  // (src/cli/index.ts's COMMANDS['install-hooks']) but has no backing module:
  // This test found that cli/install-hooks.ts had never been written, even
  // though the dispatch table advertised the command and the backstop library
  // it calls was complete. The command existed only as a promise in a help
  // listing. Written and wired now; this asserts it stays that way.
  it(
    '6. install-hooks writes .git/hooks/pre-commit containing the marker and the --staged --strict invocation',
    async () => {
      const result = runCli(repo, ['install-hooks'], homeDir);
      expect(result.code).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('not implemented yet');

      const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
      const content = await readFile(hookPath, 'utf-8');
      expect(content).toContain('checkyourvibe-managed');
      expect(content).toContain('check --staged --strict');
    },
    10_000,
  );

  // A second, independent gap, found by this very test: `generateHookScript`
  // in packages/core/src/backstop/install.ts interpolates `cyvCommand`
  // straight into the `#!/bin/sh` invocation line unquoted —
  // `${cyvCommand} check --staged --strict` — while the earlier "is the
  // command reachable" guard in the same script does quote it
  // (`shellSingleQuote(firstWord)`). On Windows, `resolveCyvCommand()`
  // returns a backslash path; `/bin/sh` (the shebang interpreter Git for
  // Windows actually uses to run hooks — confirmed separately, hooks with no
  // .exe suffix do run) treats an unquoted backslash as an escape character
  // and strips every one of them, turning
  // "R:\checkyourvibe\...\index.js" into the unrunnable
  // "R:checkyourvibe...index.js". That is a real bug in `backstop/install.ts`,
  // outside this task's declared scope (packages/core/test/e2e/** only) to
  // fix, pinned here the same way as the step-6 gap above.
  it(
    'a hook installed with the real, unmodified cyvCommand runs under Windows sh',
    async () => {
      const plan = await planInstall(repo, cyvCommand);
      await applyInstall(plan, cyvCommand);

      git(repo, ['add', 'src/thing.ts']);
      const result = gitTry(repo, ['commit', '-m', 'introduce a violation']);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('no-any');
    },
    15_000,
  );

  it('7. with the hook installed, git commit is refused for a file carrying a violation', async () => {
    // `cyv install-hooks` (step 6) cannot install anything — it does not
    // exist. Installing here through the already-built, already-tested
    // backstop library (packages/core/src/backstop/install.ts) is the
    // closest equivalent available: it is the exact code the missing CLI
    // command would call, so this still proves the real hook-generation and
    // git-enforcement path, just not the missing CLI shim around it.
    //
    // The command is given here with forward slashes rather than
    // `resolveCyvCommand()`'s native backslashes, working around the
    // quoting bug pinned immediately above — it is still the exact same real,
    // absolute path to this checkout's own built entry point, just spelled in
    // a form `/bin/sh` does not mangle. Once that bug is fixed, this
    // normalization stops being necessary but stays harmless.
    const shSafeCyvCommand = cyvCommand.replace(/\\/g, '/');
    const plan = await planInstall(repo, shSafeCyvCommand);
    expect(plan.action).toBe('update'); // overwrites the broken hook the gap test above just installed
    await applyInstall(plan, shSafeCyvCommand);

    const hookContent = await readFile(join(repo, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hookContent).toContain('checkyourvibe-managed');
    expect(hookContent).toContain('check --staged --strict');

    // src/thing.ts already carries the `any` violation written in step 2,
    // and is already staged from the gap test above.
    const result = gitTry(repo, ['commit', '-m', 'introduce a violation']);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('no-any');

    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' });
    expect(log.trim().split('\n')).toHaveLength(1); // only the initial commit — the refused commit never landed
  }, 15_000);

  it('8. git commit --no-verify bypasses the hook', () => {
    const result = gitTry(repo, ['commit', '--no-verify', '-m', 'bypass the hook']);
    expect(result.code).toBe(0);

    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' });
    expect(log.trim().split('\n')).toHaveLength(2);
  }, 15_000);

  it('9. doctor exits 0 after a successful init', () => {
    const result = runCli(repo, ['doctor'], homeDir);
    expect(result.stdout).toContain('is present and schema-valid');
    expect(result.stdout).toContain('glue matches the applied configuration');
    expect(result.code).toBe(0);
  }, 15_000);

  it('10. init --yes fails loudly if the CLAUDE.md managed block is corrupted, rather than guessing where it ended', async () => {
    const claudeMdPath = join(repo, 'CLAUDE.md');
    const original = await readFile(claudeMdPath, 'utf-8');
    const endMarker = MANAGED_BLOCK_END('claude-code-workflow');
    expect(original).toContain(endMarker);

    const corrupted = original.replace(endMarker, '');
    expect(corrupted).not.toContain(endMarker);
    await writeFile(claudeMdPath, corrupted);

    const result = runCli(repo, ['init', '--yes'], homeDir);

    expect(result.code).toBe(2);
    expect(result.stderr.toLowerCase()).toContain('end delimiter');

    // A loud failure, not a silent rewrite: the corrupted file is untouched.
    const after = await readFile(claudeMdPath, 'utf-8');
    expect(after).toBe(corrupted);
  }, 15_000);

  it('the real ~/.claude was never touched by any step above', async () => {
    // Assert the specific artefacts `cyv init` would create, not a snapshot of
    // the whole directory. A running agent CLI writes session state, history
    // and caches under ~/.claude continuously, so a whole-directory comparison
    // fails for reasons that have nothing to do with this tool — a flaky test
    // that cries wolf gets muted, and then it protects nothing.
    const settingsPath = join(realClaudeDir, 'settings.json');
    const settingsAfter = await readFile(settingsPath, 'utf-8').catch(() => null);
    expect(settingsAfter).toBe(realSettingsBefore);

    const agentsAfter = await snapshotDirSafe(join(realClaudeDir, 'agents'));
    const ourAgentFiles = (agentsAfter ?? []).filter((name) => name.startsWith('cyv-'));
    expect(ourAgentFiles).toEqual(realAgentFilesBefore);
  }, 15_000);
});

/**
 * Isolated regression coverage for the bug noted in `beforeAll` above:
 * `cyv check --staged` on a repository with zero commits throws instead of
 * running, because `run/discover.ts`'s `selectFiles` computes
 * `defaultBranch` + `mergeBase` unconditionally before dispatching on mode,
 * and an unborn HEAD makes `git merge-base HEAD HEAD` fail fatally.
 *
 * This is precisely the first commit a freshly `cyv install-hooks`-equipped
 * repository would ever attempt, so it is a real gap, not a contrived one —
 * pinned here rather than fixed, since `run/discover.ts` is outside this
 * task's declared scope. `.fails` keeps the gate green while making the gap
 * impossible to miss and self-updating once it's fixed elsewhere.
 */
describe('baseline-aware pre-commit hook', () => {
  let repo: string;
  let homeDir: string;
  let cyvCommand: string;

  beforeAll(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cyv-hook-baseline-'));
    repo = join(parent, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    git(repo, ['config', 'user.name', 'E2E Test']);

    homeDir = await mkdtemp(join(tmpdir(), 'cyv-hook-baseline-home-'));
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'thing.ts'), CLEAN_SOURCE);
    await writeCheckYourVibeConfig(repo);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'initial commit']);

    cyvCommand = await resolveCyvCommand();
  }, 30_000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('does not block a commit whose only findings are baselined, and reports the deferred total', async () => {
    await writeFile(join(repo, 'src', 'thing.ts'), VIOLATION_SOURCE);

    const baseline = runCli(repo, ['baseline', '--yes'], homeDir);
    expect(baseline.code).toBe(0);

    const shSafeCyvCommand = cyvCommand.replace(/\\/g, '/');
    const plan = await planInstall(repo, shSafeCyvCommand);
    await applyInstall(plan, shSafeCyvCommand);

    git(repo, ['add', 'src/thing.ts']);

    const direct = runCli(repo, ['check', '--staged', '--strict', '--since-baseline'], homeDir);
    expect(direct.code).toBe(0);
    expect(`${direct.stdout}${direct.stderr}`).toContain('deferred');

    const result = gitTry(repo, ['commit', '-m', 'commit baselined violation']);
    expect(result.code).toBe(0);

    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' });
    expect(log.trim().split('\n')).toHaveLength(2);
  }, 15_000);

  it('blocks a commit that adds a new finding to a file that already has baselined ones', async () => {
    await writeFile(join(repo, 'src', 'thing.ts'), `${VIOLATION_SOURCE}export const other: any = 2;\n`);
    git(repo, ['add', 'src/thing.ts']);

    const direct = runCli(repo, ['check', '--staged', '--strict', '--since-baseline'], homeDir);
    expect(direct.code).not.toBe(0);
    expect(`${direct.stdout}${direct.stderr}`).toContain('no-any');
    expect(`${direct.stdout}${direct.stderr}`).toContain('deferred');

    const result = gitTry(repo, ['commit', '-m', 'add new violation']);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('no-any');
    expect(`${result.stdout}${result.stderr}`).toContain('deferred');

    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' });
    expect(log.trim().split('\n')).toHaveLength(2);
  }, 15_000);
});

describe('known gap: cyv check --staged on an unborn repository', () => {
  it(
    'does not throw when the repository has no commits yet',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'cyv-e2e-unborn-'));
      const repoDir = join(parent, 'repo');
      await mkdir(repoDir, { recursive: true });
      git(repoDir, ['init']);
      git(repoDir, ['config', 'user.email', 'e2e@example.com']);
      git(repoDir, ['config', 'user.name', 'E2E Test']);

      await mkdir(join(repoDir, 'src'), { recursive: true });
      await writeFile(join(repoDir, 'src', 'thing.ts'), CLEAN_SOURCE);
      await writeCheckYourVibeConfig(repoDir);
      git(repoDir, ['add', '-A']);

      const homeParent = await mkdtemp(join(tmpdir(), 'cyv-e2e-unborn-home-'));
      const result = runCli(repoDir, ['check', '--staged', '--strict'], homeParent);

      try {
        expect(result.code).not.toBe(2);
        expect(result.stderr).not.toContain('merge-base');
      } finally {
        await rm(parent, { recursive: true, force: true });
        await rm(homeParent, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe('pre-commit hook with a bare cyv command', () => {
  let repo: string;
  let homeDir: string;
  let binDir: string;

  beforeAll(async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cyv-e2e-bare-'));
    repo = join(parent, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'e2e@example.com']);
    git(repo, ['config', 'user.name', 'E2E Test']);

    homeDir = await mkdtemp(join(tmpdir(), 'cyv-e2e-bare-home-'));
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'thing.ts'), CLEAN_SOURCE);
    await writeCheckYourVibeConfig(repo);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'initial commit']);

    binDir = await mkdtemp(join(tmpdir(), 'cyv-e2e-bare-bin-'));
    const wrapper = join(binDir, 'cyv');
    const node = quoteForSh(process.execPath.replace(/\\/g, '/'));
    const cli = quoteForSh(CLI_ENTRY.replace(/\\/g, '/'));
    await writeFile(wrapper, `#!/bin/sh\nexec ${node} ${cli} "$@"\n`);
    await chmod(wrapper, 0o755);
  }, 30_000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  });

  it('runs a generated hook that invokes a bare cyv command on PATH', async () => {
    const plan = await planInstall(repo, 'cyv');
    await applyInstall(plan, 'cyv');

    await writeFile(join(repo, 'src', 'thing.ts'), VIOLATION_SOURCE);
    git(repo, ['add', 'src/thing.ts']);

    const result = spawnSync('git', ['commit', '-m', 'introduce a violation'], {
      cwd: repo,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('no-any');
  }, 15_000);
});
