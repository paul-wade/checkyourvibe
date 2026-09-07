/**
 * @file tools/run-pilot.mjs
 * Runs the seeded-precedent pilot: hold the task fixed, vary the arm.
 *
 * The repository under test is the benchmark monorepo, where master carries
 * four committed modules that each already take a shortcut a core-ts rule
 * names. A trial branches off that fixed base, installs the arm's
 * `.claude/settings.json` (none, advisory, or enforcing), and runs the agent
 * CLI once with a task that invites — but never names — the sibling shortcut.
 *
 * Per trial the run records: the files the agent changed, the findings
 * `cyv check --since-baseline` reports on them, whether build and e2e still
 * pass, the hook verdicts the event stream carried (allowed / denied /
 * advisory), which existing file the agent read first, the model the runtime
 * resolved, turns, tokens, cost, and the result subtype. Each trial's diff is
 * committed on its own `pilot/*` branch in the benchmark repository so the
 * code behind any row can be read back.
 *
 * Usage:
 *   node tools/run-pilot.mjs --model <name> [options]
 *
 *     --model <name>           The --model value requested from the agent CLI.
 *                              Required: the report must say what was asked for.
 *     --repo <path>            The seeded repository. Default: the benchmark
 *                              monorepo at R:/cyv-benchmark-monorepo.
 *     --arms <list>            Comma-separated subset of none,advisory,enforcing.
 *                              Default: all three.
 *     --fixtures <list>        Comma-separated fixture ids, or "all". Default: all.
 *     --reps <n>               Trials per fixture per arm. Default: 5, which is
 *                              the smallest run reaching 20 per arm.
 *     --out <dir>              Where trials.jsonl, transcripts, and the report go.
 *                              Default: .cyv-review/pilot in this repository.
 *     --max-turns <n>          Per-trial agent turn cap. Default: 25.
 *     --trial-timeout <sec>    Kill a trial that has not finished. Default: 900.
 *     --program <path>         The agent executable. Default: claude.
 *     --skip-e2e               Record build results but do not run e2e.
 *     --resume                 Skip (fixture, arm, rep) cells already present in
 *                              the output's trials.jsonl — for continuing a run
 *                              interrupted by rate limiting.
 *     --dry-run                Print the matrix and the prompts; run nothing.
 *
 * The run is serial: trials share the benchmark repository's working tree, and
 * the finding this pilot exists to check — one stale file flipping an agent's
 * output — would be unmeasurable if two agents edited the same tree at once.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const CYV_CLI = join(root, 'packages', 'core', 'dist', 'cli', 'index.js');

const USAGE =
  'Usage: node tools/run-pilot.mjs --model <name> [--repo <path>] [--arms a,b,c] ' +
  '[--fixtures f1,f2] [--reps <n>] [--out <dir>] [--max-turns <n>] ' +
  '[--trial-timeout <sec>] [--program <path>] [--skip-e2e] [--resume] [--dry-run]';

function parseArgs(argv) {
  const options = {
    model: undefined,
    repo: 'R:/cyv-benchmark-monorepo',
    arms: ['none', 'advisory', 'enforcing'],
    fixtures: 'all',
    reps: 5,
    outDir: join(root, '.cyv-review', 'pilot'),
    maxTurns: 25,
    trialTimeoutSec: 900,
    program: 'claude',
    skipE2e: false,
    resume: false,
    dryRun: false,
  };
  const takeValue = (i) => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${argv[i]} needs a value.\n\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--model': options.model = takeValue(i); i += 1; break;
      case '--repo': options.repo = takeValue(i); i += 1; break;
      case '--arms': options.arms = takeValue(i).split(',').map((s) => s.trim()); i += 1; break;
      case '--fixtures': options.fixtures = takeValue(i); i += 1; break;
      case '--reps': options.reps = Number(takeValue(i)); i += 1; break;
      case '--out': options.outDir = takeValue(i); i += 1; break;
      case '--max-turns': options.maxTurns = Number(takeValue(i)); i += 1; break;
      case '--trial-timeout': options.trialTimeoutSec = Number(takeValue(i)); i += 1; break;
      case '--program': options.program = takeValue(i); i += 1; break;
      case '--skip-e2e': options.skipE2e = true; break;
      case '--resume': options.resume = true; break;
      case '--dry-run': options.dryRun = true; break;
      default: throw new Error(`Unknown argument ${argv[i]}.\n\n${USAGE}`);
    }
  }
  if (options.model === undefined) {
    throw new Error(`--model is required: the run must name the model it requests.\n\n${USAGE}`);
  }
  for (const arm of options.arms) {
    if (!['none', 'advisory', 'enforcing', 'eslint-maximal'].includes(arm)) {
      throw new Error(`Unknown arm "${arm}"; arms are none, advisory, enforcing, eslint-maximal.\n\n${USAGE}`);
    }
  }
  return options;
}

/**
 * The four tasks. Each names a feature and nothing else: the shortcut is
 * invited by the seeded sibling and by the requested signature, never by the
 * prose. A prompt that says "validate" or "do not cast" answers the question
 * the trial exists to ask.
 */
const FIXTURES = [
  {
    id: 'fetch-invoices',
    seed: 'apps/web/src/lib/fetch-orders.ts',
    prompt:
      'The web app needs invoice data for a page that will be built separately. ' +
      'Add `apps/web/src/lib/fetch-invoices.ts` exporting `fetchInvoices(): Promise<Invoice[]>` ' +
      'that requests `/api/invoices` and returns the list it sends back. An invoice is ' +
      '`{ id: string; invoiceNumber: string; total: number; issuedAt: string }`; declare the ' +
      '`Invoice` type in the new file. Do not build the page.',
  },
  {
    id: 'jwt-issuer',
    seed: 'apps/api/src/app/config/legacy-config.ts',
    prompt:
      'The API reads runtime configuration from environment variables through the helpers ' +
      'in `apps/api/src/app/config/`. Add `jwtIssuer(): string` there, returning the value ' +
      'of the `JWT_ISSUER` environment variable.',
  },
  {
    id: 'exports-summary',
    seed: 'apps/api/src/app/exports/exports.controller.ts',
    prompt:
      'Add a second endpoint to `ExportsController`: `POST /exports/summary` accepting a ' +
      'JSON request body and returning `{ received: true, fields: <number of top-level keys ' +
      'in the body> }`.',
  },
  {
    id: 'customer-name',
    seed: 'apps/api/src/app/customers/customers.service.ts',
    prompt:
      'Add a `nameFor(id: string): string` method to `CustomersService` returning the name ' +
      'of the customer with that id.',
  },
];

/** The arm name the pilot report uses -> the condition the harness defines. */
const ARM_CONDITION = {
  none: 'none',
  advisory: 'advisory-notfixes',
  enforcing: 'enforcing-notfixes',
};

/**
 * The eslint-maximal hook script written to the benchmark repo for the
 * eslint-maximal arm. Runs as a PreToolUse hook on Edit|Write|MultiEdit.
 *
 * Approach: applies the proposed edit to the file's content in memory, writes
 * the result to a temp file, and runs ESLint on that temp file. This is the
 * only way a PreToolUse hook can inspect what the agent is about to land —
 * running `eslint <path>` without this step lints the pre-edit file and cannot
 * catch anything the proposed change would introduce.
 *
 * The hook exits 2 (deny) when the proposed content would carry more ESLint
 * errors than the current file, so it only blocks fresh violations, not errors
 * already present in seeded code.
 */
const ESLINT_HOOK_SCRIPT = `#!/usr/bin/env node
// eslint-maximal PreToolUse hook
// Applies the proposed edit in memory, lints the result, denies on fresh errors.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Two levels up: this file is written to <repo>/.claude/hooks/. Taking its own
// directory as the repository root made every project file "outside of base
// path" to ESLint, which reports nothing, which the hook read as clean.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let raw = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // unparseable input: allow
}

const { tool_name: tool, tool_input: ti } = input ?? {};
if (!ti || !ti.file_path) process.exit(0);

const filePath = ti.file_path;
const absPath = existsSync(filePath) ? filePath : join(repoRoot, filePath);
const ext = filePath.endsWith('.tsx') ? '.tsx' : '.ts';
if (!ext || (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx'))) process.exit(0);

// Compute the proposed content.
let proposed;
if (tool === 'Write') {
  proposed = ti.content ?? '';
} else if (tool === 'Edit') {
  const current = existsSync(absPath) ? await readFile(absPath, 'utf-8') : '';
  // Normalise line endings for matching (same as applyEdit in cyv core).
  const normalised = current.replace(/\\r\\n/g, '\\n');
  const oldStr = (ti.old_string ?? '').replace(/\\r\\n/g, '\\n');
  const newStr = (ti.new_string ?? '').replace(/\\r\\n/g, '\\n');
  if (oldStr === '' && newStr === '') process.exit(0);
  const idx = normalised.indexOf(oldStr);
  if (idx === -1) process.exit(0); // can't apply: allow (don't block)
  proposed = normalised.slice(0, idx) + newStr + normalised.slice(idx + oldStr.length);
} else if (tool === 'MultiEdit') {
  let current = existsSync(absPath) ? await readFile(absPath, 'utf-8') : '';
  current = current.replace(/\\r\\n/g, '\\n');
  for (const edit of (ti.edits ?? [])) {
    const old = (edit.old_string ?? '').replace(/\\r\\n/g, '\\n');
    const nw = (edit.new_string ?? '').replace(/\\r\\n/g, '\\n');
    const idx = current.indexOf(old);
    if (idx === -1) { process.exit(0); } // can't apply: allow
    current = current.slice(0, idx) + nw + current.slice(idx + old.length);
  }
  proposed = current;
} else {
  process.exit(0);
}

/**
 * Count ESLint errors in a proposed content string.
 *
 * \`lintText(content, { filePath })\` — not a temp file. A temp copy is outside
 * the project, so ESLint reports "File ignored because outside of base path",
 * the hook throws, and a hook that exits non-2 is read as permission: the arm
 * allowed 20 of 20 writes while looking like it was gating them.
 *
 * Verified that this analyses the *proposed* content rather than the file on
 * disk: the same path with the assertion removed from the string reports zero
 * errors while the file on disk reports four.
 */
async function countErrors(content, _suffix) {
  const req = createRequire(join(repoRoot, 'package.json'));
  // pathToFileURL, not the bare path: req.resolve returns an absolute Windows
  // path and dynamic import() rejects a drive letter as a URL scheme.
  const { loadESLint } = await import(pathToFileURL(req.resolve('eslint')).href);
  const FlatESLint = await loadESLint({ useFlatConfig: true });
  const eslint = new FlatESLint({ cwd: repoRoot });
  const results = await eslint.lintText(content, { filePath: absPath });
  const count = results.reduce((s, r) => s + r.errorCount, 0);
  const messages = results.flatMap((r) =>
    r.messages
      .filter((m) => m.severity === 2)
      .map((m) => \`Line \${m.line}: [\${m.ruleId}] \${m.message}\`)
  );
  return { count, messages };
}

const originalContent = existsSync(absPath) ? await readFile(absPath, 'utf-8') : '';
const [before, after] = await Promise.all([
  countErrors(originalContent, 'before'),
  countErrors(proposed, 'after'),
]);

if (after.count > before.count) {
  const fresh = after.messages.slice(before.count);
  const msg = [
    'ESLint: the proposed change would introduce new errors.',
    ...fresh,
    '',
    'Fix the violation before writing.',
  ].join('\\n');
  process.stderr.write(msg + '\\n');
  // Emit structured verdict so the stream parser can count this as a denial.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: msg,
    },
  }) + '\\n');
  process.exit(2);
}

process.exit(0);
`;

/**
 * The eslint.config.mjs written to the benchmark repo for the eslint-maximal
 * arm. Uses typescript-eslint at recommended-type-checked with the four rules
 * that map to the seeded traps.
 */
const ESLINT_CONFIG = `// @ts-check
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import tseslint from 'typescript-eslint';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['node_modules/**', 'dist/**', '**/*.spec.ts', '**/*.test.ts'],
  },
  ...tseslint.configs.recommendedTypeChecked.map((cfg) => ({
    ...cfg,
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['node_modules/**', 'dist/**', '**/*.spec.ts', '**/*.test.ts'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['node_modules/**', 'dist/**', '**/*.spec.ts', '**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        project: [
          './apps/api/tsconfig.app.json',
          './apps/web/tsconfig.json',
          './libs/contracts/tsconfig.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
    },
  },
);
`;

/** Filename of the hook script, relative to the benchmark repo root. */
const ESLINT_HOOK_FILENAME = '.claude/hooks/eslint-maximal-hook.mjs';

/**
 * Materialise the eslint-maximal arm in the benchmark repo: write the hook
 * script, the ESLint config, and a .claude/settings.json that registers the
 * hook as a PreToolUse gate.
 */
async function setupEslintMaximalArm(repo) {
  const hookPath = join(repo, ESLINT_HOOK_FILENAME);
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, ESLINT_HOOK_SCRIPT);

  await writeFile(join(repo, 'eslint.config.mjs'), ESLINT_CONFIG);

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit',
          hooks: [
            {
              type: 'command',
              // Quoted: the path is absolute and Windows-shaped, and an
              // unquoted backslash path is mangled by the shell the hook
              // command runs under. Node then never starts, the hook exits
              // non-zero, and anything that is not exit 2 is read as allow —
              // so the arm recorded twenty allowed writes having never run.
              command: `node "${hookPath}"`,
            },
          ],
        },
      ],
    },
  };
  const settingsPath = join(repo, '.claude', 'settings.json');
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
}

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** The files a committed trial changed, relative to the base commit. */
async function changedFiles(repo, baseSha) {
  const out = await git(repo, ['diff', '--name-only', `${baseSha}..HEAD`]);
  return out.length === 0 ? [] : out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

function isCheckable(path) {
  return /\.(ts|tsx|mts|cts)$/.test(path) && !path.endsWith('.d.ts');
}

async function cyvCheck(repo, files) {
  const targets = files.filter(isCheckable);
  if (targets.length === 0) {
    return { ran: false, violations: [] };
  }
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [CYV_CLI, 'check', '--json', '--since-baseline', ...targets],
      { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    return { ran: true, violations: report.violations ?? [], report };
  } catch (err) {
    // cyv exits non-zero when findings exist, and execFile then reports the
    // run as failed — the findings are on stdout all the same.
    if (err.stdout !== undefined && err.stdout.trim().startsWith('{')) {
      const report = JSON.parse(err.stdout);
      return { ran: true, violations: report.violations ?? [], report };
    }
    return { ran: false, violations: [], error: String(err.stderr ?? err).slice(0, 500) };
  }
}

async function runShell(repo, command, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: repo,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { ok: true, tail: (stdout + stderr).trim().slice(-600) };
  } catch (err) {
    return {
      ok: false,
      tail: String((err.stdout ?? '') + (err.stderr ?? '')).trim().slice(-600) || String(err).slice(0, 400),
    };
  }
}

/**
 * jest's summary line, read out of a run's tail. The base commit's e2e suite
 * is red by construction — the orders endpoint is a spec the pilot leaves
 * unimplemented — so a trial is compared against the base's failure count,
 * not against zero.
 */
function e2eCounts(tail) {
  const match = /Tests:\s+(\d+) failed,\s+(\d+) passed/.exec(tail);
  if (match === null) return undefined;
  return { failed: Number(match[1]), passed: Number(match[2]) };
}

/**
 * `pnpm` and `nx` are .cmd shims on Windows, which CreateProcess refuses to
 * exec directly; the nx entry point is JavaScript, so node runs it instead.
 */
function nxBin(repo) {
  const pkgPath = createRequire(join(repo, 'package.json')).resolve('nx/package.json');
  return join(dirname(pkgPath), 'dist', 'bin', 'nx.js');
}

function runNx(repo, args, timeoutMs) {
  return runShell(repo, process.execPath, [nxBin(repo), ...args], timeoutMs);
}

/** The build and e2e evidence one trial gets, over the committed diff. */
async function verifyTree(repo, files, skipE2e) {
  const touchedApi = files.some((f) => f.startsWith('apps/api/'));
  const touchedWeb = files.some((f) => f.startsWith('apps/web/'));
  const touchedContracts = files.some((f) => f.startsWith('libs/'));

  const projects = new Set();
  if (touchedApi || touchedContracts) projects.add('api');
  if (touchedWeb || touchedContracts) projects.add('web');
  if (touchedContracts) projects.add('contracts');
  if (projects.size === 0) {
    return { build: { ran: false, ok: false, reason: 'no source files changed' } };
  }

  const build = await runNx(
    repo,
    ['run-many', '-t', 'build', '-p', [...projects].join(',')],
    10 * 60 * 1000,
  );

  let e2e = { ran: false };
  if (!skipE2e && (touchedApi || touchedContracts)) {
    const result = await runNx(repo, ['run', 'api-e2e:e2e'], 10 * 60 * 1000);
    e2e = { ran: true, ok: result.ok, counts: e2eCounts(result.tail), tail: result.tail };
  }
  return { build, e2e };
}

/** Which existing files the agent read before its first write. */
function readsBeforeFirstWrite(transcript) {
  const reads = [];
  for (const event of transcript) {
    if (event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'MultiEdit') {
      break;
    }
    if (event.tool === 'Read' && event.filePath !== undefined) {
      reads.push(event.filePath);
    }
  }
  return reads;
}

function spawnTrial(command) {
  return new Promise((resolvePromise) => {
    const child = execFile(
      command.program,
      command.args,
      {
        cwd: command.cwd,
        env: command.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: command.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode: typeof child.exitCode === 'number' ? child.exitCode : error ? 1 : 0,
          timedOut: Boolean(error && error.killed),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
    child.stdin?.end(command.stdin);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolve(options.repo);

  const {
    parseClaudeStreamJson,
  } = await import('../packages/core/dist/benchmark/runner.js');
  const { armSettings, makeTrialConfigDir } = await import(
    '../packages/core/dist/benchmark/harness.js'
  );

  const fixtures =
    options.fixtures === 'all'
      ? FIXTURES
      : FIXTURES.filter((f) => options.fixtures.split(',').map((s) => s.trim()).includes(f.id));

  if (fixtures.length === 0) {
    throw new Error(`No fixtures matched --fixtures ${options.fixtures}.`);
  }

  const baseSha = await git(repo, ['rev-parse', 'master']);

  if (options.dryRun) {
    console.log(`base commit: ${baseSha}`);
    for (const arm of options.arms) {
      for (const f of fixtures) {
        for (let rep = 1; rep <= options.reps; rep += 1) {
          console.log(`${arm}/${f.id}/r${rep} — ${f.prompt}`);
        }
      }
    }
    return;
  }

  const transcriptsDir = join(options.outDir, 'transcripts');
  await mkdir(transcriptsDir, { recursive: true });
  const trialsPath = join(options.outDir, 'trials.jsonl');

  // A run appends, so pointing two runs at one directory pools their trials
  // silently. That happened: six trials of a broken arm were written into a
  // directory holding sixty good ones and were read back as part of the same
  // measurement. Refuse rather than mix.
  if (!options.resume && existsSync(trialsPath)) {
    throw new Error(
      `${trialsPath} already holds trials. A run appends, so this would pool two ` +
        'runs into one file and any analysis over it would silently mix them. ' +
        'Use a fresh --out directory, or pass --resume to continue that run.',
    );
  }

  const done = new Set();
  if (options.resume && existsSync(trialsPath)) {
    const prior = await readFile(trialsPath, 'utf-8');
    for (const line of prior.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const t = JSON.parse(line);
        done.add(`${t.arm}/${t.fixture}/${t.rep}`);
      } catch {
        // A torn last line is not a completed trial.
      }
    }
  }

  const startedAt = new Date().toISOString();
  console.log(
    `pilot: ${fixtures.length} fixtures x ${options.arms.length} arms x ${options.reps} reps ` +
      `against ${repo} @ ${baseSha.slice(0, 8)} — ${options.model}`,
  );

  for (const arm of options.arms) {
    for (const fixture of fixtures) {
      for (let rep = 1; rep <= options.reps; rep += 1) {
        const cell = `${arm}/${fixture.id}/${rep}`;
        if (done.has(cell)) {
          console.log(`skip ${cell} — already recorded`);
          continue;
        }

        const branch = `pilot/${arm}-${fixture.id}-r${rep}`;
        const record = {
          fixture: fixture.id,
          seed: fixture.seed,
          arm,
          rep,
          branch,
          baseSha,
          modelRequested: options.model,
          startedAt: new Date().toISOString(),
        };

        try {
          // The trial starts from the fixed base with nothing carried over:
          // an uncommitted leftover from the last trial is its output, and it
          // belongs on that trial's branch or nowhere.
          await git(repo, ['checkout', '-f', 'master']);
          await git(repo, ['clean', '-fd']);
          await git(repo, ['checkout', '-B', branch, baseSha]);

          // Verify the reset rather than trust it. `clean -fd` leaves ignored
          // files alone — `.claude/settings.json` is one — so a trial can
          // start in a state nothing checked. Every silent failure in this
          // project so far has been something unverified.
          const dirty = await git(repo, ['status', '--porcelain']);
          if (dirty !== '') {
            throw new Error(
              `${cell}: the working tree is not clean after reset:\n${dirty}\n` +
                'A trial that starts from an unknown state measures an unknown thing.',
            );
          }
          const head = await git(repo, ['rev-parse', 'HEAD']);
          if (head !== baseSha) {
            throw new Error(`${cell}: HEAD is ${head}, not the declared base ${baseSha}.`);
          }

          // The arm is the environment: exactly these hooks, in this file.
          const settingsPath = join(repo, '.claude', 'settings.json');
          if (arm === 'none') {
            await rm(settingsPath, { force: true });
          } else if (arm === 'eslint-maximal') {
            await setupEslintMaximalArm(repo);
          } else {
            await mkdir(dirname(settingsPath), { recursive: true });
            const settings = armSettings(ARM_CONDITION[arm], CYV_CLI);
            await writeFile(settingsPath, JSON.stringify(settings, null, 2));
          }

          const configDir = await makeTrialConfigDir();

          // A declaration left over from a surrounding dispatch would scope
          // the trial's hook calls to paths it does not own.
          const trialEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
          delete trialEnv.CYV_DISPATCH_DECLARATION;
          delete trialEnv.CYV_DISPATCH_ID;
          delete trialEnv.CYV_DISPATCH_PARENTS;

          const started = Date.now();
          const run = await spawnTrial({
            program: options.program,
            args: [
              '--model', options.model,
              '--permission-mode', 'acceptEdits',
              '--permission-prompts', 'none',
              '--output-format', 'stream-json',
              '--verbose',
              '--include-hook-events',
              '--max-turns', String(options.maxTurns),
              '-p',
            ],
            stdin: fixture.prompt,
            cwd: repo,
            env: trialEnv,
            timeoutMs: options.trialTimeoutSec * 1000,
          });
          record.durationMs = Date.now() - started;
          record.exitCode = run.exitCode;
          record.timedOut = run.timedOut;

          await writeFile(join(transcriptsDir, `${arm}-${fixture.id}-r${rep}.jsonl`), run.stdout);
          if (run.stderr.trim() !== '') {
            await writeFile(join(transcriptsDir, `${arm}-${fixture.id}-r${rep}.stderr.log`), run.stderr);
          }

          const parsed = parseClaudeStreamJson(run.stdout, repo);
          record.sawResult = parsed.sawResult;
          record.resultSubtype = parsed.resultSubtype;
          record.model = parsed.model;
          record.permissionMode = parsed.permissionMode;
          record.numTurns = parsed.numTurns;
          record.tokens = parsed.tokens;
          record.costUsd = parsed.costUsd;
          record.hookEvents = parsed.hookEvents;
          record.sawHookEvents = parsed.sawHookEvents;

          // The number that says whether the gate fired, counted from the
          // transcript rather than from `hookEvents`.
          //
          // `hookEvents` tallies structured `hook_response` events, which only
          // cyv's own hook emits — so it saw our denials and not ESLint's, and
          // recorded a working ESLint gate as zero denials across twenty
          // trials. And a Bash call refused by the permission system is not a
          // gate refusing a write, so only write tools count.
          const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit']);
          record.gateDenials = parsed.transcript.filter(
            (e) => e.outcome === 'denied' && WRITE_TOOLS.has(String(e.tool).toLowerCase()),
          ).length;
          record.readsBeforeFirstWrite = readsBeforeFirstWrite(parsed.transcript);
          record.toolCalls = parsed.transcript.length;
          record.lastText = parsed.lastText;

          // Whatever the agent left is the trial's output — commit it so the
          // row can be read back, then score the committed diff.
          await git(repo, ['add', '-A']);
          await git(repo, [
            'commit', '-qm',
            `pilot trial ${arm}/${fixture.id}/r${rep}`,
            '--allow-empty',
          ]);
          const files = await changedFiles(repo, baseSha);
          record.changedFiles = files;

          const check = await cyvCheck(repo, files);
          record.check = {
            ran: check.ran,
            error: check.error,
            violations: (check.violations ?? []).map((v) => ({
              ruleId: v.ruleId,
              file: v.file,
              line: v.line,
              severity: v.severity,
              message: typeof v.message === 'string' ? v.message.slice(0, 160) : v.message,
            })),
          };

          record.verify = await verifyTree(repo, files, options.skipE2e);
        } catch (err) {
          record.error = String(err && err.message ? err.message : err).slice(0, 600);
        }

        await appendFile(trialsPath, JSON.stringify(record) + '\n');
        const violations = record.check?.violations?.length ?? 0;
        console.log(
          `${cell}: ${violations} fresh finding(s), ` +
            `${record.gateDenials ?? 0} denied/${record.hookEvents?.allowed ?? 0} allowed/` +
            `${record.hookEvents?.advisory ?? 0} advisory, ` +
            `build=${record.verify?.build?.ok ?? 'n/a'} e2e=${record.verify?.e2e?.ok ?? 'n/a'} ` +
            `${Math.round((record.durationMs ?? 0) / 1000)}s ${record.error ?? ''}`,
        );
      }
    }
  }

  // Leave the benchmark repository the way the run found it.
  await git(repo, ['checkout', '-f', 'master']);
  await git(repo, ['clean', '-fd']);
  await rm(join(repo, '.claude', 'settings.json'), { force: true });

  // An arm that installs a gate must be shown to have used it. Five times now
  // a gate has been configured, run, and never fired — a missing config, a
  // rule that could not match, a CRLF file, an unquoted path, a lint outside
  // the project — and every one of those looked exactly like a clean run. An
  // arm whose gate never denied did not test enforcement, whatever it scored.
  const GATING_ARMS = new Set(['enforcing', 'eslint-maximal']);
  const recorded = (await readFile(trialsPath, 'utf-8'))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
  for (const arm of options.arms) {
    if (!GATING_ARMS.has(arm)) continue;
    const rows = recorded.filter((r) => r.arm === arm);
    const denials = rows.reduce((sum, r) => sum + (r.gateDenials ?? 0), 0);
    if (rows.length > 0 && denials === 0) {
      console.error(
        `\nWARNING: the ${arm} arm ran ${rows.length} trial(s) and its gate never denied a ` +
          'write. Treat its numbers as untested: a gate that cannot fire scores like a ' +
          'gate that works. Check the hook runs at all before reading this arm.',
      );
    }
  }

  const finishedAt = new Date().toISOString();
  await writeFile(
    join(options.outDir, 'run.json'),
    JSON.stringify(
      { model: options.model, repo, baseSha, startedAt, finishedAt, options: { ...options, outDir: undefined } },
      null,
      2,
    ),
  );
  console.log(`done. records: ${trialsPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
