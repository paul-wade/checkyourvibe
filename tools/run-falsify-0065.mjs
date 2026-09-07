/**
 * Spec 0065 falsification trials: does an ESLint-expressed local convention,
 * carried through cyv's analyzer bridge into the PreToolUse gate, recover the
 * fixture the way the hand-written oracle hook did?
 *
 * The repository under R:/cyv-falsify-0065/repo is the generated
 * "minority" service repo (8 of 30 tests in the superseded style) with the
 * convention stated as a stock `no-restricted-syntax` rule in
 * eslint.config.js and bridged into cyv by tools/cyv-analyzer-eslint.
 *
 * Each trial: the target test file is deleted, the agent is asked to write it
 * (the task never names the convention), the enforcing hook is installed, and
 * the outcome is scored the way `checkDi` scores it — wrote / followed /
 * bypassed — plus whether the gate denied.
 *
 * Usage: node tools/run-falsify-0065.mjs [--reps N] [--feature quota]
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO = 'R:/cyv-falsify-0065/repo';
const CYV_BIN = 'R:/checkyourvibe/packages/core/dist/cli/index.js';
const OUT_DIR = 'R:/checkyourvibe/.cyv-review/falsify-0065';
const CLAUDE_EXE = process.env.CLAUDE_PATH ?? 'C:/Users/paulw/.local/bin/claude.exe';
const MODEL = 'claude-haiku-4-5-20251001';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const REPS = Number(argValue('--reps', '5'));
const FEATURE = argValue('--feature', 'quota');
const ARM = argValue('--arm', 'enforcing');
const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TARGET_REL = `test/${FEATURE}.service.test.ts`;
const TARGET_ABS = join(REPO, TARGET_REL);

const PROMPT =
  `Add a unit test for the ${FEATURE} service covering the case where the id is not found.\n\n` +
  `Write the test to ${TARGET_REL}.`;

function settingsJson() {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|Bash|PowerShell|NotebookEdit',
          hooks: [{ type: 'command', command: `node ${CYV_BIN} hook claude-code` }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit',
          hooks: [{ type: 'command', command: `node ${CYV_BIN} hook claude-code` }],
        },
      ],
    },
  });
}

function sawHookEvents(transcript) {
  let denied = 0;
  let allowed = 0;
  let advisory = 0;
  for (const event of transcript) {
    if (event.type !== 'system' || event.subtype !== 'hook_response') continue;
    const eventName = event.hook_event ?? event.hookEvent ?? '';
    const out = typeof event.output === 'string' ? event.output : (event.stdout ?? '');
    if (eventName === 'PreToolUse') {
      if (/permissionDecision"\s*:\s*"deny"/.test(out)) denied += 1;
      else if (/permissionDecision"\s*:\s*"allow"/.test(out)) allowed += 1;
    }
    if (eventName === 'PostToolUse') advisory += 1;
  }
  return { denied, allowed, advisory };
}

/** The check-di three-way read of the file the agent wrote. */
function scoreFile() {
  if (!existsSync(TARGET_ABS)) return { wrote: false, followed: false, bypassed: false };
  const text = readFileSync(TARGET_ABS, 'utf-8');
  const bypassed = /new\s+\w+(Service|Repository)\s*\(/.test(text);
  const followed = /testContainer|register\w+\(/.test(text) && /\.resolve\(/.test(text);
  return { wrote: true, followed, bypassed };
}

async function runAgent(configDir) {
  const spawnArgs = [
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--model', MODEL,
    '--max-turns', '15',
    '-p',
  ];
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.CYV_DISPATCH_DECLARATION;
  delete env.CYV_DISPATCH_ID;
  delete env.CYV_DISPATCH_PARENTS;

  // The prompt travels on stdin — the same shape the pilot runner uses. `-p`
  // with no prompt argument reads the task from stdin.
  const stdout = await new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      CLAUDE_EXE,
      spawnArgs,
      {
        cwd: REPO,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
        windowsHide: true,
      },
      (error, out, err) => {
        if (error !== null && (out ?? '') === '') {
          rejectPromise(new Error(`claude exited: ${String(err ?? error).slice(0, 400)}`));
          return;
        }
        resolvePromise(out ?? '');
      },
    );
    child.stdin?.end(PROMPT);
  });

  const transcript = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      transcript.push(JSON.parse(line));
    } catch {
      // non-JSON line
    }
  }
  return transcript;
}

await mkdir(OUT_DIR, { recursive: true });
const { makeTrialConfigDir } = await import(
  '../packages/core/dist/benchmark/harness.js'
);
const records = [];

for (let rep = 1; rep <= REPS; rep++) {
  // Reset: the target test file is deleted so the agent must write it.
  if (existsSync(TARGET_ABS)) await unlink(TARGET_ABS);
  await execFileAsync('git', ['-C', REPO, 'status', '--porcelain']);

  // The arm is the environment: exactly these hooks, in this file.
  const settingsPath = join(REPO, '.claude', 'settings.json');
  if (ARM === 'none') {
    await rm(settingsPath, { force: true });
  } else {
    await mkdir(join(REPO, '.claude'), { recursive: true });
    await writeFile(settingsPath, settingsJson());
  }

  // A clean per-trial config dir with the operator's credentials copied in —
  // an empty one answers every prompt with "Not logged in".
  const configDir = await makeTrialConfigDir();

  const started = Date.now();
  let transcript = [];
  let error;
  try {
    transcript = await runAgent(configDir);
  } catch (err) {
    error = String(err).slice(0, 400);
  }
  const hooks = sawHookEvents(transcript);
  const outcome = scoreFile();

  const rec = {
    rep,
    feature: FEATURE,
    target: TARGET_REL,
    arm: `${ARM}-eslint-bridge`,
    model: MODEL,
    ...outcome,
    hookEvents: hooks,
    durationMs: Date.now() - started,
    ...(error !== undefined ? { error } : {}),
  };
  records.push(rec);
  await writeFile(
    join(OUT_DIR, `transcript-${ARM}-${FEATURE}-r${rep}.jsonl`),
    transcript.map((e) => JSON.stringify(e)).join('\n'),
  );
  console.log(
    `${ARM}/${FEATURE}/r${rep}: wrote=${outcome.wrote} followed=${outcome.followed} bypassed=${outcome.bypassed} ` +
      `${hooks.denied} denied/${hooks.allowed} allowed/${hooks.advisory} advisory ${Math.round(rec.durationMs / 1000)}s`,
  );

  // Reset the tree for the next rep.
  await execFileAsync('git', ['-C', REPO, 'checkout', '--', 'test/', '.claude/settings.json']).catch(() => {});
  await rm(configDir, { recursive: true, force: true });
}

await writeFile(
  join(OUT_DIR, 'trials.jsonl'),
  records.map((r) => JSON.stringify(r)).join('\n') + '\n',
);
const followed = records.filter((r) => r.followed).length;
const denied = records.filter((r) => r.hookEvents.denied > 0).length;
console.log(`\n${followed}/${records.length} followed the convention; ${denied}/${records.length} trials saw a denial.`);
