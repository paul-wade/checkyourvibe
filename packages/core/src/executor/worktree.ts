/**
 * Git worktree isolation for dispatched work (spec 0060).
 *
 * A spec's tasks share one worktree outside the main repository. The worktree is
 * created once, prepared, claimed per dispatch, verified, and merged by cyv.
 * Refused merges and unmerged work are never silently discarded.
 *
 * Every git invocation uses an argument array, never a shell string, so a spec
 * name from a directory listing cannot reach the shell.
 */
import { execFile } from 'node:child_process';
import { mkdir, appendFile, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import { claimCard, releaseCard, readState } from '../dashboard/state-store.js';
import { runCheck } from '../run/check.js';
import { isUnknownArray } from '../guards.js';
import { judgeLiveness, type LivenessProbe, type LivenessJudgement } from './liveness.js';
import { ownsPath } from './ownership.js';
import { createGateRunner } from './gates.js';
import { findProgram, launchArguments } from './program.js';
import { runChild } from './child.js';
import { readDispatchLog } from './store.js';
import type { GateContext, GateRunner } from './run.js';
import type { GateResult } from './outcome.js';
import type { DispatchDeclaration, DispatchAssignment } from './dispatch.js';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorktreeState =
  | 'created'
  | 'prepared'
  | 'dispatched'
  | 'reclaimed'
  | 'verifying'
  | 'merged'
  | 'refused'
  | 'removing'
  | 'removed'
  | 'remove-refused'
  | 'abandoned';

export interface WorktreeTransition {
  event: 'worktree';
  spec: string;
  branch: string;
  worktreePath: string;
  state: WorktreeState;
  at: string;
  dispatchId?: string;
  detail?: string;
  enforcement?: 'edit-time' | 'merge-time';
  previousHolder?: string;
}

export interface PrepareStep {
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface EnsureWorktreeRequest {
  repoRoot: string;
  specName: string;
  worktreeRoot?: string;
  branchName?: string;
  prepareSteps?: readonly PrepareStep[];
  now?: () => Date;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  created: boolean;
  prepared: boolean;
}

export interface ClaimWorktreeRequest {
  repoRoot: string;
  specName: string;
  holder: string;
  worktreeRoot?: string;
  branchName?: string;
  now?: () => Date;
}

export type ClaimWorktreeResult =
  | { claimed: true; worktreePath: string }
  | { claimed: false; holder: string };

export interface ReclaimWorktreeRequest {
  repoRoot: string;
  specName: string;
  holder: string;
  worktreeRoot?: string;
  branchName?: string;
  livenessProbe?: LivenessProbe;
  now?: () => Date;
}

export type ReclaimWorktreeResult =
  | { reclaimed: true; worktreePath: string }
  | { reclaimed: false; holder: string; liveness: 'live' | 'undetermined'; detail?: string };

export interface MergeWorktreeRequest {
  repoRoot: string;
  specName: string;
  holder: string;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  worktreeRoot?: string;
  branchName?: string;
  /** Custom cyv-check runner; the default runs `cyv check` in the worktree. */
  runCyvCheck?: (context: GateContext) => Promise<GateResult>;
  /** Custom gate runner; the default uses `createGateRunner(process.env)`. */
  gateRunner?: GateRunner;
  /** Commit message for the worktree commit. */
  message?: string;
  now?: () => Date;
}

export interface MergeWorktreeResult {
  merged: boolean;
  reason?:
    | 'out-of-scope'
    | 'cyv-check-failed'
    | 'gate-failed'
    | 'not-claimed'
    | 'not-found'
    | 'merge-conflict';
  detail?: string;
  worktreePath?: string;
  changedPaths?: readonly string[];
  gateResults?: readonly GateResult[];
}

export interface RemoveWorktreeRequest {
  repoRoot: string;
  specName: string;
  holder: string;
  worktreeRoot?: string;
  branchName?: string;
  /** Explicitly abandon unmerged work before removing. */
  abandon?: boolean;
  now?: () => Date;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  reason?: 'unmerged-work' | 'not-holder' | 'merge-failed';
  detail?: string;
  holder?: string;
  worktreePath?: string;
}

interface WorktreeListEntry {
  path: string;
  branch?: string;
}

interface ChangedPathSet {
  all: string[];
  uncommitted: string[];
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

interface ExecFailure extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

function isExecFailure(value: unknown): value is ExecFailure {
  return (
    value instanceof Error &&
    ('code' in value || 'killed' in value || 'signal' in value)
  );
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

function gitFailureMessage(args: readonly string[], err: ExecFailure): string {
  const stderr = err.stderr ?? '';
  const code = err.code;
  const codeText = code === null ? 'a signal' : `code ${String(code)}`;
  const detail = stderr.trim().length > 0 ? stderr.trim() : `git exited with ${codeText}`;
  return `\`git ${args.join(' ')}\` failed: ${detail}`;
}

async function gitCommand(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
    return stdout;
  } catch (err) {
    if (!isExecFailure(err)) throw err;
    throw new Error(gitFailureMessage(args, err));
  }
}

async function gitExitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
    return true;
  } catch (err) {
    if (!isExecFailure(err)) throw err;
    if (err.code === 1) return false;
    throw new Error(gitFailureMessage(args, err));
  }
}

// ---------------------------------------------------------------------------
// Paths and naming
// ---------------------------------------------------------------------------

function defaultWorktreeRoot(repoRoot: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
}

function specWorktreePath(worktreeRoot: string, specName: string): string {
  return resolve(worktreeRoot, specName);
}

function branchNameFor(specName: string, branchName?: string): string {
  return branchName ?? `specs/${specName}`;
}

function safeSpecName(specName: string): string {
  return specName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function worktreeLogPath(repoRoot: string, specName: string): string {
  return join(repoRoot, '.cyv-review', 'worktrees', `${safeSpecName(specName)}.ndjson`);
}

async function resolveWorktreePath(
  repoRoot: string,
  specName: string,
  worktreeRoot?: string,
): Promise<string> {
  const root = resolve(worktreeRoot ?? defaultWorktreeRoot(repoRoot));
  return resolve(root, specName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const WORKTREE_STATES: readonly WorktreeState[] = [
  'created',
  'prepared',
  'dispatched',
  'reclaimed',
  'verifying',
  'merged',
  'refused',
  'removing',
  'removed',
  'remove-refused',
  'abandoned',
];

function asWorktreeState(value: unknown): WorktreeState | undefined {
  if (typeof value !== 'string') return undefined;
  return WORKTREE_STATES.find((state) => state === value);
}

function asEnforcement(value: unknown): 'edit-time' | 'merge-time' | undefined {
  if (value === 'edit-time' || value === 'merge-time') return value;
  return undefined;
}

export function parseWorktreeTransition(value: unknown): WorktreeTransition | undefined {
  if (!isRecord(value)) return undefined;
  if (value.event !== 'worktree') return undefined;
  const spec = asString(value.spec);
  const branch = asString(value.branch);
  const worktreePath = asString(value.worktreePath);
  const state = asWorktreeState(value.state);
  const at = asString(value.at);
  if (
    spec === undefined ||
    branch === undefined ||
    worktreePath === undefined ||
    state === undefined ||
    at === undefined
  ) {
    return undefined;
  }
  const dispatchId = asString(value.dispatchId);
  const detail = asString(value.detail);
  const enforcement = asEnforcement(value.enforcement);
  const previousHolder = asString(value.previousHolder);
  return {
    event: 'worktree',
    spec,
    branch,
    worktreePath,
    state,
    at,
    ...(dispatchId === undefined ? {} : { dispatchId }),
    ...(detail === undefined ? {} : { detail }),
    ...(enforcement === undefined ? {} : { enforcement }),
    ...(previousHolder === undefined ? {} : { previousHolder }),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle log
// ---------------------------------------------------------------------------

interface RecordTransitionInput {
  state: WorktreeState;
  worktreePath: string;
  branch: string;
  dispatchId?: string;
  detail?: string;
  enforcement?: 'edit-time' | 'merge-time';
  previousHolder?: string;
}

async function recordTransition(
  repoRoot: string,
  specName: string,
  at: string,
  input: RecordTransitionInput,
): Promise<void> {
  const path = worktreeLogPath(repoRoot, specName);
  await mkdir(dirname(path), { recursive: true });
  const record: WorktreeTransition = {
    event: 'worktree',
    spec: specName,
    ...input,
    at,
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8');
}

export async function readWorktreeLog(
  repoRoot: string,
  specName: string,
): Promise<WorktreeTransition[]> {
  const path = worktreeLogPath(repoRoot, specName);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: WorktreeTransition[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    const transition = parseWorktreeTransition(parsed);
    if (transition !== undefined) out.push(transition);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Worktree existence
// ---------------------------------------------------------------------------

async function listWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  const stdout = await gitCommand(repoRoot, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeListEntry[] = [];
  for (const block of stdout.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length);
      }
    }
    if (path === undefined) continue;
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (err) {
      if (isEnoent(err)) {
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`could not resolve worktree path ${path}: ${reason}`);
    }
    entries.push({
      path: resolved,
      ...(branch === undefined ? {} : { branch }),
    });
  }
  return entries;
}

async function findWorktreeEntry(
  repoRoot: string,
  worktreePath: string,
): Promise<WorktreeListEntry | undefined> {
  let resolved: string;
  try {
    resolved = await realpath(worktreePath);
  } catch {
    return undefined;
  }
  const entries = await listWorktrees(repoRoot);
  return entries.find((entry) => entry.path === resolved);
}

async function assertWorktreeOutsideRepo(
  repoRoot: string,
  worktreePath: string,
  worktreeRoot: string,
): Promise<void> {
  if (isWithinRepo(worktreeRoot, repoRoot)) {
    throw new Error(
      `worktree root ${worktreeRoot} is inside the repository, which is forbidden by Requirement 1.4`,
    );
  }
  if (isWithinRepo(worktreePath, repoRoot)) {
    throw new Error(
      `worktree path ${worktreePath} is inside the repository, which is forbidden by Requirement 1.4`,
    );
  }
}

function isWithinRepo(candidate: string, repoRoot: string): boolean {
  const a = normalizeSlashes(candidate);
  const b = normalizeSlashes(repoRoot);
  if (b === '') return true;
  return a === b || a.startsWith(`${b}/`);
}

function normalizeSlashes(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === '.' || normalized === '/') return '';
  return normalized;
}

async function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  const branchExists = await gitExitOk(repoRoot, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (branchExists) {
    await gitCommand(repoRoot, ['worktree', 'add', worktreePath, branch]);
  } else {
    await gitCommand(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  }
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function defaultPrepareSteps(): PrepareStep[] {
  return [
    { command: 'pnpm', args: ['install'] },
    { command: 'pnpm', args: ['build'] },
  ];
}

async function prepareWorktree(
  worktreePath: string,
  steps: readonly PrepareStep[],
): Promise<void> {
  for (const step of steps) {
    const env = step.env ?? process.env;
    const launcher = await findProgram(step.command, env, worktreePath);
    if (launcher === undefined) {
      throw new Error(`prepare command "${step.command}" was not found on PATH`);
    }
    const launch = launchArguments(launcher, step.args ?? []);
    const observation = await runChild({
      command: launcher.command,
      args: launch.args,
      cwd: worktreePath,
      env,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (observation.spawnError !== undefined) {
      throw new Error(
        `prepare command "${step.command}" could not start: ${observation.spawnError}`,
      );
    }
    if (observation.timedOut) {
      throw new Error(`prepare command "${step.command}" timed out`);
    }
    if (observation.exitCode === undefined) {
      throw new Error(`prepare command "${step.command}" was ended by a signal`);
    }
    if (observation.exitCode !== 0) {
      throw new Error(
        `prepare command "${step.command}" exited with code ${observation.exitCode}; ` +
          `stdout: ${observation.stdout}; stderr: ${observation.stderr}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public: ensure a worktree exists and is prepared
// ---------------------------------------------------------------------------

export async function ensureWorktree(request: EnsureWorktreeRequest): Promise<EnsureWorktreeResult> {
  const repoRoot = resolve(request.repoRoot);
  const worktreeRoot = resolve(request.worktreeRoot ?? defaultWorktreeRoot(repoRoot));
  const worktreePath = specWorktreePath(worktreeRoot, request.specName);
  const branch = branchNameFor(request.specName, request.branchName);
  const now = request.now ?? (() => new Date());

  await assertWorktreeOutsideRepo(repoRoot, worktreePath, worktreeRoot);

  const existing = await findWorktreeEntry(repoRoot, worktreePath);
  if (existing !== undefined) {
    const expectedBranch = `refs/heads/${branch}`;
    if (existing.branch !== expectedBranch) {
      throw new Error(
        `worktree at ${worktreePath} exists on branch ${existing.branch ?? 'unknown'}, ` +
          `expected ${expectedBranch}`,
      );
    }
    return { worktreePath, branch, created: false, prepared: false };
  }

  await createWorktree(repoRoot, worktreePath, branch);
  const createdAt = now().toISOString();
  await recordTransition(repoRoot, request.specName, createdAt, {
    state: 'created',
    worktreePath,
    branch,
  });

  const steps = request.prepareSteps ?? defaultPrepareSteps();
  await prepareWorktree(worktreePath, steps);
  const preparedAt = now().toISOString();
  await recordTransition(repoRoot, request.specName, preparedAt, {
    state: 'prepared',
    worktreePath,
    branch,
  });

  return { worktreePath, branch, created: true, prepared: true };
}

// ---------------------------------------------------------------------------
// Public: claim and reclaim a worktree
// ---------------------------------------------------------------------------

export async function claimWorktree(request: ClaimWorktreeRequest): Promise<ClaimWorktreeResult> {
  const repoRoot = resolve(request.repoRoot);
  const worktreePath = await resolveWorktreePath(repoRoot, request.specName, request.worktreeRoot);
  const branch = branchNameFor(request.specName, request.branchName);
  const now = request.now ?? (() => new Date());

  const entry = await findWorktreeEntry(repoRoot, worktreePath);
  if (entry === undefined) {
    throw new Error(
      `worktree for spec "${request.specName}" does not exist; call ensureWorktree first`,
    );
  }

  const result = await claimCard(repoRoot, request.specName, request.holder, worktreePath);
  if (!result.claimed) {
    return { claimed: false, holder: result.holder };
  }

  await recordTransition(repoRoot, request.specName, now().toISOString(), {
    state: 'dispatched',
    worktreePath,
    branch,
    dispatchId: request.holder,
    enforcement: 'merge-time',
  });

  return { claimed: true, worktreePath };
}

async function judgeHolderLiveness(
  repoRoot: string,
  holder: string,
  probe?: LivenessProbe,
): Promise<LivenessJudgement> {
  const { records } = await readDispatchLog(repoRoot);
  const record = records.find((r) => r.dispatchId === holder);
  if (record === undefined || record.closed !== undefined) {
    return { liveness: 'abandoned', reason: 'dispatch record is closed or missing' };
  }
  const evidence = {
    openedAt: record.openedAt,
    ...(record.host === undefined ? {} : { host: record.host }),
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    ...(record.processStartedAt === undefined
      ? {}
      : { processStartedAt: record.processStartedAt }),
  };
  return judgeLiveness(evidence, probe);
}

export async function reclaimWorktree(
  request: ReclaimWorktreeRequest,
): Promise<ReclaimWorktreeResult> {
  const repoRoot = resolve(request.repoRoot);
  const worktreePath = await resolveWorktreePath(repoRoot, request.specName, request.worktreeRoot);
  const branch = branchNameFor(request.specName, request.branchName);
  const now = request.now ?? (() => new Date());

  const state = await readState(repoRoot);
  const existing = state.workingTrees[worktreePath];

  if (existing === undefined || existing === request.holder) {
    const claim = await claimCard(repoRoot, request.specName, request.holder, worktreePath);
    if (!claim.claimed) {
      return { reclaimed: false, holder: claim.holder, liveness: 'undetermined' };
    }
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'dispatched',
      worktreePath,
      branch,
      dispatchId: request.holder,
      enforcement: 'merge-time',
    });
    return { reclaimed: true, worktreePath };
  }

  const judgement = await judgeHolderLiveness(repoRoot, existing, request.livenessProbe);
  if (judgement.liveness !== 'abandoned') {
    return {
      reclaimed: false,
      holder: existing,
      liveness: judgement.liveness,
      detail: judgement.reason,
    };
  }

  await releaseCard(repoRoot, request.specName, existing);
  const claim = await claimCard(repoRoot, request.specName, request.holder, worktreePath);
  if (!claim.claimed) {
    return { reclaimed: false, holder: claim.holder, liveness: 'undetermined' };
  }

  await recordTransition(repoRoot, request.specName, now().toISOString(), {
    state: 'reclaimed',
    worktreePath,
    branch,
    dispatchId: request.holder,
    previousHolder: existing,
    enforcement: 'merge-time',
  });

  return { reclaimed: true, worktreePath };
}

// ---------------------------------------------------------------------------
// Merge: changed paths and cyv-check
// ---------------------------------------------------------------------------

async function mainBranchName(repoRoot: string): Promise<string> {
  const stdout = await gitCommand(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = stdout.trim();
  if (name.length === 0 || name === 'HEAD') {
    throw new Error(
      'the main repository is not on a named branch, so the worktree has no base to merge into',
    );
  }
  return name;
}

async function worktreeChangedPaths(
  worktreePath: string,
  baseBranch: string,
): Promise<ChangedPathSet> {
  const committed = await gitCommand(worktreePath, [
    'diff',
    '--name-only',
    '--no-renames',
    `${baseBranch}...HEAD`,
  ]);
  const uncommittedDiff = await gitCommand(worktreePath, [
    'diff',
    '--name-only',
    '--no-renames',
    'HEAD',
  ]);
  const untracked = await gitCommand(worktreePath, ['ls-files', '--others', '--exclude-standard']);

  const all = new Set<string>();
  const uncommitted = new Set<string>();

  for (const line of committed.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) all.add(trimmed);
  }
  for (const line of uncommittedDiff.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      all.add(trimmed);
      uncommitted.add(trimmed);
    }
  }
  for (const line of untracked.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      all.add(trimmed);
      uncommitted.add(trimmed);
    }
  }

  return {
    all: [...all].sort(),
    uncommitted: [...uncommitted].sort(),
  };
}

function countBySeverity(severities: readonly string[], wanted: string): number {
  return severities.filter((severity) => severity === wanted).length;
}

async function defaultRunCyvCheck(context: GateContext): Promise<GateResult> {
  const gate = 'cyv-check';
  if (context.changedPaths.length === 0) {
    return {
      gate,
      passed: true,
      detail: 'no file changed, so the analyzers had nothing from this dispatch to check',
    };
  }
  try {
    const { report } = await runCheck({
      cwd: context.repoRoot,
      mode: 'files',
      paths: [...context.changedPaths],
      strict: false,
    });
    const severities = report.violations.map((violation) => violation.severity);
    const errors = countBySeverity(severities, 'error');
    const warnings = countBySeverity(severities, 'warning');
    const diagnosticErrors = report.diagnostics.filter((d) => d.level === 'error').length;
    const detail = `${errors} error(s), ${warnings} warning(s) across ${report.filesChecked} file(s) the dispatch changed`;
    return {
      gate,
      passed: errors === 0 && diagnosticErrors === 0,
      detail,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { gate, passed: false, detail: `cyv check could not run: ${reason}` };
  }
}

async function abortMergeIfInProgress(repoRoot: string): Promise<void> {
  const mergeHead = join(repoRoot, '.git', 'MERGE_HEAD');
  try {
    const info = await stat(mergeHead);
    if (info.isFile()) {
      await gitCommand(repoRoot, ['merge', '--abort']);
    }
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Public: verify and merge a worktree
// ---------------------------------------------------------------------------

export async function mergeWorktree(request: MergeWorktreeRequest): Promise<MergeWorktreeResult> {
  const repoRoot = resolve(request.repoRoot);
  const worktreePath = await resolveWorktreePath(repoRoot, request.specName, request.worktreeRoot);
  const branch = branchNameFor(request.specName, request.branchName);
  const now = request.now ?? (() => new Date());

  const state = await readState(repoRoot);
  const currentHolder = state.workingTrees[worktreePath];
  if (currentHolder !== request.holder) {
    const detail =
      currentHolder === undefined
        ? 'worktree is not claimed'
        : `worktree is held by ${currentHolder}`;
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: `not-claimed: ${detail}`,
      enforcement: 'merge-time',
    });
    return { merged: false, reason: 'not-claimed', detail, worktreePath };
  }

  const entry = await findWorktreeEntry(repoRoot, worktreePath);
  if (entry === undefined) {
    const detail = `worktree at ${worktreePath} is not registered`;
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: `not-found: ${detail}`,
      enforcement: 'merge-time',
    });
    return { merged: false, reason: 'not-found', detail, worktreePath };
  }

  const baseBranch = await mainBranchName(repoRoot);
  await recordTransition(repoRoot, request.specName, now().toISOString(), {
    state: 'verifying',
    worktreePath,
    branch,
    dispatchId: request.holder,
    enforcement: 'merge-time',
  });

  const { all: changedPaths, uncommitted: uncommittedPaths } = await worktreeChangedPaths(
    worktreePath,
    baseBranch,
  );

  const outOfScope = changedPaths.filter((path) => !ownsPath(request.declaration.ownedPaths, path));
  if (outOfScope.length > 0) {
    const detail = `changed paths outside declared ownership: ${outOfScope.join(', ')}`;
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: `out-of-scope: ${detail}`,
      enforcement: 'merge-time',
    });
    return {
      merged: false,
      reason: 'out-of-scope',
      detail,
      worktreePath,
      changedPaths,
    };
  }

  const cyvRunner = request.runCyvCheck ?? defaultRunCyvCheck;
  const cyvContext: GateContext = {
    repoRoot: worktreePath,
    dispatchId: request.holder,
    declaration: request.declaration,
    assignment: request.assignment,
    changedPaths,
    observation: { timedOut: false, stdout: '', stderr: '' },
  };
  const cyvResult = await cyvRunner(cyvContext);
  if (!cyvResult.passed) {
    const detail = cyvResult.detail ?? 'cyv check was not clean';
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: `cyv-check-failed: ${detail}`,
      enforcement: 'merge-time',
    });
    return {
      merged: false,
      reason: 'cyv-check-failed',
      detail,
      worktreePath,
      changedPaths,
      gateResults: [cyvResult],
    };
  }

  const gateRunner = request.gateRunner ?? createGateRunner(process.env);
  const gateContext: GateContext = {
    repoRoot: worktreePath,
    dispatchId: request.holder,
    declaration: request.declaration,
    assignment: request.assignment,
    changedPaths,
    observation: { timedOut: false, stdout: '', stderr: '' },
  };
  const otherGates = request.declaration.gates.filter((gate) => gate !== 'cyv-check');
  const gateResults: GateResult[] = [];
  for (const gate of otherGates) {
    gateResults.push(await gateRunner(gate, gateContext));
  }

  const failedGates = gateResults.filter((result) => !result.passed);
  if (failedGates.length > 0) {
    const firstFailed = failedGates[0];
    const gateName = firstFailed === undefined ? 'unknown' : firstFailed.gate;
    const detail = `gate "${gateName}" failed`;
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: `gate-failed: ${detail}`,
      enforcement: 'merge-time',
    });
    return {
      merged: false,
      reason: 'gate-failed',
      detail,
      worktreePath,
      changedPaths,
      gateResults: [cyvResult, ...gateResults],
    };
  }

  if (uncommittedPaths.length > 0) {
    await gitCommand(worktreePath, ['add', '--', ...uncommittedPaths]);
    const message =
      request.message ?? `Worktree for ${request.specName} from dispatch ${request.holder}`;
    await gitCommand(worktreePath, ['commit', '-m', message]);
  }

  try {
    await gitCommand(repoRoot, ['merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
  } catch (err) {
    await abortMergeIfInProgress(repoRoot);
    const reason = err instanceof Error ? err.message : String(err);
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: `merge-conflict: ${reason}`,
      enforcement: 'merge-time',
    });
    return {
      merged: false,
      reason: 'merge-conflict',
      detail: reason,
      worktreePath,
      changedPaths,
      gateResults: [cyvResult, ...gateResults],
    };
  }

  await releaseCard(repoRoot, request.specName, request.holder);
  await recordTransition(repoRoot, request.specName, now().toISOString(), {
    state: 'merged',
    worktreePath,
    branch,
    dispatchId: request.holder,
    enforcement: 'merge-time',
  });

  return {
    merged: true,
    worktreePath,
    changedPaths,
    gateResults: [cyvResult, ...gateResults],
  };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function hasUnmergedWork(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<{ unmerged: true; reason: string } | { unmerged: false }> {
  const status = await gitCommand(worktreePath, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--no-renames',
  ]);
  if (status.trim().length > 0) {
    return { unmerged: true, reason: 'the worktree has uncommitted changes' };
  }
  const isAncestor = await gitExitOk(repoRoot, ['merge-base', '--is-ancestor', branch, baseBranch]);
  if (!isAncestor) {
    return { unmerged: true, reason: 'the worktree branch has unmerged commits' };
  }
  return { unmerged: false };
}

export async function removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
  const repoRoot = resolve(request.repoRoot);
  const worktreePath = await resolveWorktreePath(repoRoot, request.specName, request.worktreeRoot);
  const branch = branchNameFor(request.specName, request.branchName);
  const now = request.now ?? (() => new Date());

  const entry = await findWorktreeEntry(repoRoot, worktreePath);
  if (entry === undefined) {
    return { removed: true, worktreePath };
  }

  await recordTransition(repoRoot, request.specName, now().toISOString(), {
    state: 'removing',
    worktreePath,
    branch,
    dispatchId: request.holder,
  });

  const state = await readState(repoRoot);
  const currentHolder = state.workingTrees[worktreePath];
  if (currentHolder !== undefined && currentHolder !== request.holder) {
    const detail = `worktree is held by ${currentHolder}`;
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'remove-refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail,
    });
    return { removed: false, reason: 'not-holder', detail, holder: currentHolder, worktreePath };
  }

  const baseBranch = await mainBranchName(repoRoot);
  const unmerged = await hasUnmergedWork(repoRoot, worktreePath, branch, baseBranch);
  if (unmerged.unmerged && request.abandon !== true) {
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'remove-refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: unmerged.reason,
    });
    return { removed: false, reason: 'unmerged-work', detail: unmerged.reason, worktreePath };
  }

  if (unmerged.unmerged && request.abandon === true) {
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'abandoned',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: unmerged.reason,
    });
    await gitCommand(worktreePath, ['reset', '--hard', baseBranch]);
    await gitCommand(worktreePath, ['clean', '-fd']);
  }

  await releaseCard(repoRoot, request.specName, request.holder);

  try {
    await gitCommand(repoRoot, ['worktree', 'remove', worktreePath]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordTransition(repoRoot, request.specName, now().toISOString(), {
      state: 'remove-refused',
      worktreePath,
      branch,
      dispatchId: request.holder,
      detail: reason,
    });
    return { removed: false, reason: 'merge-failed', detail: reason, worktreePath };
  }

  const isAncestor = await gitExitOk(repoRoot, ['merge-base', '--is-ancestor', branch, baseBranch]);
  if (isAncestor) {
    await gitCommand(repoRoot, ['branch', '-d', branch]);
  } else {
    await gitCommand(repoRoot, ['branch', '-D', branch]);
  }

  await recordTransition(repoRoot, request.specName, now().toISOString(), {
    state: 'removed',
    worktreePath,
    branch,
    dispatchId: request.holder,
  });

  return { removed: true, worktreePath };
}
