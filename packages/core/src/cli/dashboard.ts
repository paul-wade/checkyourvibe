import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo, hostname } from 'node:os';
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, loadConfig } from '../config/load.js';
import { configuredLanes, maxConcurrentDispatches } from '../config/lanes.js';
import { resolveRules } from '../config/resolve.js';
import { allRules, loadAnalyzers } from '../registry/load.js';
import { repoRoot } from '../run/discover.js';
import { runCheck } from '../run/check.js';
import { renderDashboard, renderVolatilePanels } from '../dashboard/render.js';
import { pathsWrittenByOutsideSessions } from '../dashboard/attribution.js';
import { specDiff } from '../dashboard/spec-diff.js';
import { readHistory } from '../dashboard/history.js';
import { readLatestRun, type LatestRun } from '../dashboard/latest.js';
import { readExecutorView, type ExecutorView } from '../dashboard/executor-view.js';
import { loadSuppressions, readBaseline } from '../baseline/index.js';
import { buildGlancePage, renderGlanceBody, renderGlancePage } from '../dashboard/glance-page.js';
import { summarizeGate, type GateHealth } from '../dashboard/gate-health.js';
import { NAV_PAGES } from '../dashboard/nav.js';
import { readHookDecisions, readLifecycleEvents } from './hook.js';
import {
  renderDiffPage,
  renderDocsPage,
  renderEditPage,
  renderViewPage,
} from '../dashboard/pages.js';
import type { ShellOptions } from '../dashboard/shell.js';
import { normalizeProjectPath, readRegistry } from '../dashboard/projects.js';
import {
  addComment,
  addDraft,
  commentsToExchange,
  discardDraft,
  editDraft,
  loadComments,
  sendDrafts,
  setCommentStatus,
} from '../dashboard/review/comments.js';
import { readCursorFor } from '../dashboard/review/cursor.js';
import {
  fileMtime,
  findMarkdown,
  safeResolve,
  splitSections,
} from '../dashboard/review/documents.js';
import {
  difitComments,
  difitInstanceStates,
  instanceById,
  startDifit,
} from '../dashboard/review/difit.js';
import { proxyToDifit } from '../dashboard/review/difit-proxy.js';
import { gitLog, uncommittedWork } from '../dashboard/review/progress.js';
import { findSpecs, parseAllSpecs } from '../dashboard/review/specs.js';
import { readStatusLog } from '../dashboard/review/status-log.js';
import { stopDispatch } from '../dashboard/stop.js';
import { openSelfDispatch } from '../executor/run.js';
import { closeDispatch, acknowledgeItem, dispatchLogPath, readDispatchLog } from '../executor/store.js';
import { scheduleDispatch } from '../executor/schedule.js';
import { replayLaneRuntimes } from '../executor/replay.js';
import { isTaskKind, TASK_KINDS, type TaskKind } from '../executor/task-kind.js';
import { agentCommandFor, knownAgentIds } from '../executor/invocation.js';
import { findProgram } from '../executor/program.js';
import { executorPrompt } from '../executor/prompt.js';
import { judgeLiveness, type LivenessEvidence, type LivenessJudgement } from '../executor/liveness.js';
import { HISTORY_DIR } from '../dashboard/history.js';
import { pathIsWithin, pathsOverlap } from '../executor/ownership.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import type {
  DispatchDeclaration,
  DispatchRecord,
  LaneIneligibility,
  LaneRejection,
  OwnershipConflict,
  SchedulingRefusal,
} from '../executor/dispatch.js';
import { isUnknownArray } from '../guards.js';
import type { RuleManifest } from '../protocol/index.js';
import type { RunRecord } from '../dashboard/history.js';
import type { Baseline, Suppression } from '../baseline/index.js';
import type { LaneDeclaration, ResolvedLaneDeclaration } from '../executor/lane.js';
import type { Command, CommandContext } from './types.js';
import { buildBoardModel, specNumbersIn, type BoardCard, type BoardModel } from '../dashboard/board-model.js';
import { specDisplayName } from '../dashboard/review/specs.js';
import { boardCss, diffPanelForCard, renderBoard, renderBoardFragment, type BoardExchange } from '../dashboard/board-render.js';
import { diffDrawerCss, renderDiffDrawer, renderSpecDrawer } from '../dashboard/diff-drawer.js';
import {
  boardClientScript,
  BOARD_ACK_PATH,
  BOARD_DRAWER_PATH,
  BOARD_EXPLORER_READ_PATH,
  BOARD_EXPLORER_TREE_PATH,
  BOARD_EXPLORER_WRITE_PATH,
  BOARD_INSPECT_PATH,
} from '../dashboard/board-client.js';
import { claimEditLock, readState, writeState } from '../dashboard/state-store.js';
import { createSessionManager, type SessionManager, type SessionView } from '../dashboard/session-manager.js';
import { subscribeToProject } from '../dashboard/live.js';
import {
  renderSpecDetailPage,
  toSpecTab,
  isValidSpecId,
  type SpecTab,
} from '../dashboard/spec-detail-page.js';
import { renderSpecMarkdown, renderSpecPage, type SpecPageInput } from '../dashboard/spec-page.js';
import { buildLanesPage, renderLanesPage } from '../dashboard/lanes-page.js';
import { buildLivePage, renderLivePage } from '../dashboard/live-page.js';
import { renderTasksPage } from '../dashboard/tasks-page.js';
import {
  claimSpecFile,
  listSpecFiles,
  readSpecFile,
  releaseSpecFile,
  writeSpecFile,
} from '../dashboard/spec-editor.js';

const DEFAULT_PORT = 4300;

/** Names the difit port the diff frame is proxying for this browser. */
const DIFIT_COOKIE = 'cyv_difit';

/** The dashboard's own `/api/` routes; anything else under `/api/` belongs to difit. */
const OWN_API_PATHS = new Set([
  '/api/state',
  '/api/comment',
  '/api/comment/status',
  '/api/comment/draft',
  '/api/comment/draft/discard',
  '/api/comment/send',
  BOARD_ACK_PATH,
  '/api/stop',
  '/api/abandon',
  '/api/retry',
  '/api/dispatch',
  '/api/save',
  '/api/difit/start',
  BOARD_DRAWER_PATH,
  BOARD_EXPLORER_READ_PATH,
  BOARD_EXPLORER_TREE_PATH,
  BOARD_EXPLORER_WRITE_PATH,
  BOARD_INSPECT_PATH,
  '/api/spec-diff',
  '/api/spec/list',
  '/api/spec/read',
  '/api/spec/write',
  '/api/spec/release',
  '/api/spec/preview',
  '/api/session/start',
  '/api/session/stop',
  '/api/live',
  '/api/fragment',
  '/api/glance',
]);

/** A path difit's page fetches: its bundle, its icons, and its API. */
/** Where the editor's own files are served from. */
const VENDOR_PREFIX = '/vendor/';

function vendorRoot(pkg: 'monaco'): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', 'monaco-editor', 'min', 'vs');
}

async function resolveVendorFile(rel: string): Promise<string | null> {
  if (rel === '' || rel.includes('\0') || rel.split(/[\/]/).includes('..')) return null;
  const [pkgName, ...restOfPath] = rel.split('/');
  const pkgRel = restOfPath.join('/');

  // The comparison narrows `pkgName` to the union `vendorRoot` accepts, so no
  // assertion is needed to pass it on.
  if (pkgName !== 'monaco') return null;
  if (pkgRel === '') return null;

  let rootReal: string;
  try {
    rootReal = await realpath(vendorRoot(pkgName));
  } catch {
    return null;
  }
  const full = resolve(rootReal, pkgRel);
  if (!isWithinResolvedRoot(rootReal, full)) return null;
  try {
    const info = await stat(full);
    return info.isFile() ? full : null;
  } catch {
    return null;
  }
}

function vendorContentType(file: string): string {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

function isDifitPath(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  if (pathname === '/favicon.svg' || pathname === '/favicon-white.svg') return true;
  return pathname.startsWith('/api/') && !OWN_API_PATHS.has(pathname);
}

function difitPortFrom(cookieHeader: string | undefined): number | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name !== DIFIT_COOKIE || value === undefined) continue;
    const port = Number.parseInt(value, 10);
    if (Number.isFinite(port) && port > 0 && port < 65536) return port;
  }
  return undefined;
}

export function lanAddresses(
  interfaces: NodeJS.Dict<readonly NetworkInterfaceInfo[] | NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  return Object.values(interfaces)
    .flat()
    .filter((n): n is NonNullable<typeof n> => n !== undefined)
    .filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('127.'))
    .map((n) => n.address);
}

export interface StartupBannerOptions {
  port: number;
  exposeToLan: boolean;
  projects: readonly string[];
  addresses?: readonly string[];
}

export function formatStartupBanner(
  options: StartupBannerOptions & { accessToken?: string },
): string {
  const suffix = options.accessToken === undefined ? '' : `/?t=${options.accessToken}`;
  const lines: string[] = [
    '',
    '  checkyourvibe dashboard',
    '',
    `  http://localhost:${options.port}`,
  ];
  if (options.exposeToLan) {
    const addresses = options.addresses ?? lanAddresses();
    if (addresses.length > 0) {
      for (const ip of addresses) {
        lines.push(`  http://${ip}:${options.port}${suffix}`);
      }
    } else {
      lines.push('  (no non-loopback IPv4 addresses found)');
    }
  } else {
    lines.push('  (localhost only — pass --host to reach it from a phone)');
  }
  if (options.accessToken !== undefined) {
    lines.push('');
    lines.push('  the link above carries the access token; every request needs it');
    lines.push('  it is kept under .cyv-review/ so a restart keeps it working — --new-token rotates it');
  }
  lines.push('');
  lines.push(`  projects (${options.projects.length}):`);
  for (const project of options.projects) {
    lines.push(`    ${project}`);
  }
  lines.push('');
  lines.push('  Ctrl+C to stop');
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWithinResolvedRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate).replace(/\\/g, '/');
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

async function resolveExplorerPath(
  repoRoot: string,
  rel: string,
  forWrite: boolean,
): Promise<string | null> {
  if (rel === '' || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(repoRoot);
  } catch {
    return null;
  }
  const full = resolve(rootReal, rel);
  if (!isWithinResolvedRoot(rootReal, full)) return null;

  if (forWrite) {
    let current = full;
    while (true) {
      try {
        const real = await realpath(current);
        if (!isWithinResolvedRoot(rootReal, real)) return null;
        if (current === full) {
          try {
            const info = await stat(real);
            if (!info.isFile()) return null;
          } catch (err) {
            if (!isEnoent(err)) return null;
          }
        }
        return full;
      } catch (err) {
        if (isEnoent(err)) {
          const parent = dirname(current);
          if (parent === current) return null;
          current = parent;
          continue;
        }
        return null;
      }
    }
  }

  try {
    const real = await realpath(full);
    if (!isWithinResolvedRoot(rootReal, real)) return null;
    const info = await stat(real);
    return info.isFile() ? real : null;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function readExplorerFile(repoRoot: string, rel: string): Promise<string> {
  const absolute = await resolveExplorerPath(repoRoot, rel, false);
  if (absolute === null) throw new Error(`Path refused: "${rel}" is outside the repository.`);
  return readFile(absolute, 'utf-8');
}

async function writeExplorerFile(
  repoRoot: string,
  rel: string,
  content: string,
  holder: string,
): Promise<void> {
  const absolute = await resolveExplorerPath(repoRoot, rel, true);
  if (absolute === null) throw new Error(`Path refused: "${rel}" is outside the repository.`);

  const claim = await claimEditLock(repoRoot, rel, holder);
  if (!claim.claimed) {
    throw new Error(`Write refused: "${rel}" is locked by "${claim.holder}".`);
  }

  await mkdir(dirname(absolute), { recursive: true });
  const temp = `${absolute}.tmp`;
  await writeFile(temp, content, 'utf-8');
  await rename(temp, absolute);
}

async function checkExplorerFile(
  repoRoot: string,
  rel: string,
): Promise<{ findings: ExplorerFinding[]; blocked: boolean }> {
  const { report } = await runCheck({ cwd: repoRoot, mode: 'files', paths: [rel], strict: false });
  const findings: ExplorerFinding[] = report.violations.map((v) => ({
    ruleId: v.ruleId,
    message: v.message,
    line: v.line,
    column: v.column,
    severity: v.severity,
  }));
  const blocked = findings.some((f) => f.severity === 'error');
  return { findings, blocked };
}

function sortExplorerNodes(nodes: ExplorerNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind === b.kind) return a.name.localeCompare(b.name);
    return a.kind === 'dir' ? -1 : 1;
  });
}

function buildExplorerTree(paths: string[]): ExplorerNode {
  const root: ExplorerNode = { name: '', kind: 'dir', children: [] };
  for (const filePath of paths) {
    const segments = filePath.split('/');
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      if (name === undefined) continue;
      if (i === segments.length - 1) {
        current.children.push({ name, kind: 'file', path: filePath, children: [] });
      } else {
        let dir = current.children.find((c) => c.kind === 'dir' && c.name === name);
        if (dir === undefined) {
          dir = { name, kind: 'dir', children: [] };
          current.children.push(dir);
        }
        current = dir;
      }
    }
  }
  function sortNode(node: ExplorerNode): void {
    sortExplorerNodes(node.children);
    for (const child of node.children) {
      if (child.kind === 'dir') sortNode(child);
    }
  }
  sortNode(root);
  return root;
}

async function gitExplorerFiles(repoRoot: string): Promise<string[]> {
  return new Promise<string[]>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err: Error) => {
      rejectPromise(err);
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolvePromise(stdout.split('\0').filter((p) => p !== ''));
      } else {
        rejectPromise(new Error(stderr.trim() || `git exited with ${String(code)}`));
      }
    });
  });
}

/**
 * Find a spec edit lock that overlaps any path an agent wants to own.
 * Returns the holder when a user is currently editing a file the dispatch
 * would touch.
 */
async function findEditLockConflict(
  repoRoot: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const state = await readState(repoRoot);
  for (const candidate of candidates) {
    for (const [lockedFile, lock] of Object.entries(state.editLocks)) {
      if (pathsOverlap(candidate, lockedFile)) return lock.holder;
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (typeof value === 'boolean') return value;
  return undefined;
}

const PROMPT_DIRECTORY = 'dispatch-prompts';

const DISPATCH_OPEN_TIMEOUT_MS = 5000;

const DISPATCH_OPEN_POLL_MS = 50;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (isUnknownArray(value)) {
    return value.filter((item): item is string => isNonEmptyString(item));
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(isNonEmptyString);
  }
  return [];
}

function taskKindOrDefault(record: Record<string, unknown>): TaskKind {
  const value = record['kind'];
  if (typeof value === 'string' && isTaskKind(value)) return value;
  return 'mechanical-transformation';
}

function generateWorkId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `work-${stamp}-${randomBytes(3).toString('hex')}`;
}

function orchestratorLaneId(lanes: readonly LaneDeclaration[]): string | undefined {
  return lanes.find((lane) => lane.orchestrator)?.id;
}

function describeIneligibility(reason: LaneIneligibility): string {
  switch (reason.reason) {
    case 'lane-not-declared':
      return 'no lane with this id is declared';
    case 'not-the-named-lane':
      return `the dispatch named lane "${reason.namedLaneId}", so this one was not considered`;
    case 'metered-not-named':
      return 'metered — billed per use — and not named by the dispatch, so the core did not select it';
    case 'does-not-accept-dispatch':
      return reason.orchestrator
        ? 'does not accept dispatched work: it is the orchestrating lane, whose capacity is ' +
          'reserved for planning, review and integration. Set acceptsDispatch: true on it to ' +
          'spend that capacity on dispatched work'
        : 'does not accept dispatched work: the lane declares acceptsDispatch: false';
    case 'no-model-for-kind':
      return `declares no model for task kind "${reason.taskKind}"`;
    case 'in-cooldown':
      return (
        `in cooldown since ${reason.since}, after a dispatch that was ${reason.cause}. ` +
        'Cooldown clears on an observed-effect success on this lane, and naming it with ' +
        '--lane dispatches to it despite the cooldown so that success can happen'
      );
    case 'at-concurrency-cap':
      return (
        `running its declared cap of ${reason.concurrencyCap} (${reason.inFlight} in flight). ` +
        'That is the self-imposed cap in use, not a reading of the account'
      );
    case 'at-global-cap':
      return (
        `the run is at executor.maxConcurrentDispatches: ${reason.openDispatches} of ` +
        `${reason.maxConcurrentDispatches} open across every lane. This lane may have room; ` +
        'the run does not. Close a dispatch or raise the number'
      );
  }
}

function readableRefusal(refusal: SchedulingRefusal, orchestratorLane?: string): string {
  if (refusal.reason === 'overlapping-ownership') {
    return [
      '  refused: another dispatch already in flight declares paths this one also claims.',
      ...refusal.conflicts.map(
        (conflict: OwnershipConflict) =>
          `    ${conflict.withDispatchId} on lane ${conflict.laneId}: ${conflict.paths.join(', ')}`,
      ),
    ].join('\n');
  }

  const lines = [
    '  refused: no declared lane was a candidate for this work.',
    ...refusal.rejections.map(
      (rejection: LaneRejection) =>
        `    ${rejection.laneId}: ${describeIneligibility(rejection.reason)}`,
    ),
  ];

  if (orchestratorLane !== undefined) {
    lines.push(
      '  `--self` runs this task on lane ' +
        orchestratorLane +
        ' — this session, as a sub-agent of itself. It opens the record and prints the prompt; ' +
        '`cyv dispatch --close <id>` runs the gates and judges what changed.',
    );
  }
  return lines.join('\n');
}

async function readTaskText(
  body: Record<string, unknown>,
  root: string,
): Promise<{ ok: true; task: string } | { ok: false; error: string }> {
  const task = stringField(body, 'task');
  const taskFile = stringField(body, 'taskFile') ?? stringField(body, 'task-file');

  if (task !== undefined && taskFile !== undefined) {
    return { ok: false, error: 'pass task text or a task file, not both' };
  }
  if (task !== undefined) {
    return { ok: true, task };
  }
  if (taskFile === undefined) {
    return { ok: false, error: 'task text or a task file path is required' };
  }
  if (!taskFile.endsWith('.md')) {
    return { ok: false, error: 'task file must be a .md file under docs/specs/**' };
  }

  const resolved = await safeResolve(root, taskFile);
  if (resolved === null) {
    return { ok: false, error: `task file "${taskFile}" does not resolve to a path inside the repository` };
  }
  if (!pathIsWithin(taskFile, 'docs/specs')) {
    return { ok: false, error: `task file "${taskFile}" is not under docs/specs/**` };
  }

  try {
    const content = await readFile(resolved, 'utf-8');
    return { ok: true, task: content };
  } catch (err) {
    return { ok: false, error: `task file "${taskFile}" could not be read: ${messageOf(err)}` };
  }
}

interface ExplorerNode {
  name: string;
  kind: 'dir' | 'file';
  path?: string;
  children: ExplorerNode[];
}

interface ExplorerFinding {
  ruleId: string;
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
}

interface ParsedDispatchBody {
  laneId: string | undefined;
  declaration: DispatchDeclaration;
}

async function parseDispatchBody(
  root: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; input: ParsedDispatchBody } | { ok: false; error: string }> {
  const taskRead = await readTaskText(body, root);
  if (!taskRead.ok) return { ok: false, error: taskRead.error };

  const taskKind = taskKindOrDefault(body);
  // A form's lane select posts an empty string for "no lane named"; that is
  // the same as the field being absent, not a lane called "".
  const rawLane = stringField(body, 'lane');
  const laneId = rawLane === undefined || rawLane === '' ? undefined : rawLane;
  const ownedPaths = stringArrayField(body, 'ownedPaths');
  if (ownedPaths.length === 0) {
    return { ok: false, error: 'at least one owned path is required' };
  }

  const gates = stringArrayField(body, 'gates');
  if (gates.length === 0) gates.push('cyv-check');

  const declaration: DispatchDeclaration = {
    task: taskRead.task,
    taskKind,
    ownedPaths,
    expectsFileChanges: booleanField(body, 'expectsFileChanges') ?? true,
    gates,
  };

  return { ok: true, input: { laneId, declaration } };
}

async function assertLaneExecutorsReachable(
  lanes: readonly LaneDeclaration[],
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<void> {
  for (const lane of lanes) {
    if (lane.executes === 'subagent') continue;
    const spec = agentCommandFor(lane.agentId);
    if (spec === undefined) {
      throw new Error(
        `Executor lane "${lane.id}" names agent "${lane.agentId}", which this build has no ` +
          `command line for. Known agents: ${knownAgentIds().join(', ')}. Add an entry to ` +
          'packages/core/src/executor/invocation.ts, or change the lane\'s agentId.',
      );
    }
    const launcher = await findProgram(spec.program, env, repoRoot);
    if (launcher === undefined) {
      throw new Error(
        `Executor lane "${lane.id}" runs agent "${lane.agentId}" through the program ` +
          `"${spec.program}", which is not on PATH. Install it and authenticate it, or remove ` +
          'the lane.',
      );
    }
  }
}

interface WaitForRecordResult {
  dispatchId: string;
  record?: DispatchRecord;
  refusal?: SchedulingRefusal;
  error?: string;
}

async function waitForRecord(
  root: string,
  dispatchId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<WaitForRecordResult> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = await readDispatchLog(root);
    const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
    if (record !== undefined) return { dispatchId, record };
    const refused = log.refusals.find((candidate) => candidate.dispatchId === dispatchId);
    if (refused !== undefined) return { dispatchId, refusal: refused.refusal };
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return { dispatchId, error: `dispatch ${dispatchId} did not open within ${timeoutMs}ms` };
}

function spawnCliDispatch(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  declaration: DispatchDeclaration,
  lane: LaneDeclaration,
  workId: string,
  maxAttempts: number,
): ChildProcess {
  const moduleUrl = new URL('../../dist/cli/dispatch.js', import.meta.url).href;
  const argv = [
    '--task',
    declaration.task,
    '--kind',
    declaration.taskKind,
    ...declaration.ownedPaths.flatMap((path): [string, string] => ['--own', path]),
    ...declaration.gates.flatMap((gate): [string, string] => ['--gate', gate]),
    '--lane',
    lane.id,
    '--work-id',
    workId,
    '--max-attempts',
    String(maxAttempts),
  ];

  const worker =
    'import { command } from ' +
    JSON.stringify(moduleUrl) +
    ';' +
    'try {' +
    '  const code = await command.run({' +
    '    cwd: process.env.CYV_DISPATCH_CWD,' +
    '    argv: JSON.parse(process.env.CYV_DISPATCH_ARGV || \'[]\'),' +
    '    env: process.env,' +
    '  });' +
    '  process.exit(typeof code === \'number\' ? code : 2);' +
    '} catch (err) {' +
    '  console.error(err instanceof Error ? err.message : String(err));' +
    '  process.exit(2);' +
    '}';

  const child = spawn(process.argv[0] ?? 'node', ['--input-type=module', '-e', worker], {
    cwd: repoRoot,
    env: { ...env, CYV_DISPATCH_CWD: repoRoot, CYV_DISPATCH_ARGV: JSON.stringify(argv) },
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });

  child.unref();
  return child;
}

interface StartDispatchResult {
  dispatchId: string;
  workId: string;
  laneId: string;
  model: string;
}

type StartDispatchOutcome =
  | { ok: true; result: StartDispatchResult }
  | { ok: false; error: string; refusal?: SchedulingRefusal };

async function startDispatch(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  config: CheckYourVibeConfig,
  lanes: readonly LaneDeclaration[],
  laneId: string | undefined,
  declaration: DispatchDeclaration,
  maxAttempts = 3,
): Promise<StartDispatchOutcome> {
  const log = await readDispatchLog(repoRoot);
  const runtimes = replayLaneRuntimes(lanes, log.records);
  const workId = generateWorkId(new Date());
  const dispatchId = `${workId}-attempt-1`;

  const preview = scheduleDispatch(
    {
      dispatchId,
      taskKind: declaration.taskKind,
      ownedPaths: declaration.ownedPaths,
      ...(laneId === undefined ? {} : { laneId }),
    },
    runtimes,
    { maxConcurrentDispatches: maxConcurrentDispatches(config) },
  );

  if (preview.decision === 'refused') {
    return {
      ok: false,
      error: readableRefusal(preview.refusal, orchestratorLaneId(lanes)),
      refusal: preview.refusal,
    };
  }

  const lane = lanes.find((candidate) => candidate.id === preview.laneId);
  if (lane === undefined) {
    return { ok: false, error: `scheduled lane "${preview.laneId}" is not in the configuration` };
  }

  if (lane.executes === 'subagent') {
    const promptPath = join(repoRoot, HISTORY_DIR, PROMPT_DIRECTORY, `${workId}.md`);
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, executorPrompt(declaration), 'utf-8');

    const opened = await openSelfDispatch({
      repoRoot,
      dispatchId,
      workId,
      attempt: 1,
      declaration,
      assignment: {
        laneId: lane.id,
        agentId: lane.agentId,
        model: preview.model,
        billing: lane.billing.kind,
        permitsBilledOverage: lane.billing.permitsBilledOverage,
        orchestrator: lane.orchestrator,
        declaredHeadroomAtSchedule: preview.declaredHeadroom,
      },
    });

    return { ok: true, result: { dispatchId, workId, laneId: lane.id, model: opened.opened.assignment.model } };
  }

  try {
    await assertLaneExecutorsReachable(lanes, env, repoRoot);
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }

  spawnCliDispatch(repoRoot, env, declaration, lane, workId, maxAttempts);

  const waited = await waitForRecord(repoRoot, dispatchId, DISPATCH_OPEN_TIMEOUT_MS, DISPATCH_OPEN_POLL_MS);
  if (waited.error !== undefined) {
    return { ok: false, error: waited.error };
  }
  if (waited.refusal !== undefined) {
    return {
      ok: false,
      error: readableRefusal(waited.refusal, orchestratorLaneId(lanes)),
      refusal: waited.refusal,
    };
  }
  if (waited.record === undefined) {
    return { ok: false, error: `dispatch ${dispatchId} did not open` };
  }

  return {
    ok: true,
    result: {
      dispatchId,
      workId,
      laneId: lane.id,
      model: waited.record.assignment.model,
    },
  };
}

async function dashboardJudge(record: LivenessEvidence): Promise<LivenessJudgement> {
  if (record.pid === process.pid && record.host === hostname()) {
    return {
      liveness: 'abandoned',
      reason:
        'the dispatch is supervised by this dashboard session; the record will be closed without ' +
        'killing the dashboard',
    };
  }
  return judgeLiveness(record);
}

async function closeAsAbandoned(
  root: string,
  dispatchId: string,
  now: () => Date,
): Promise<{ closedAt: string }> {
  const closedAt = now().toISOString();
  await closeDispatch(root, {
    dispatchId,
    closedAt,
    report: { status: 'did-not-complete', rateLimited: false, detail: 'Abandoned from the dashboard.' },
    gateResults: [],
    outcome: {
      kind: 'did-not-complete',
      summary: 'abandoned from the dashboard',
      changedPaths: [],
      outOfScopePaths: [],
      failedGates: [],
    },
  });
  return { closedAt };
}

/**
 * Whether `checkyourvibe.json` declares a `suppressions` key at all, as
 * distinct from `loadSuppressions` returning an empty array — which happens
 * both when the key is absent and when it is present but empty. The rules page
 * keeps those two facts apart.
 */
async function suppressionsConfigured(root: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(root, CONFIG_FILENAME), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed.suppressions !== undefined;
}

/** The parsed, on-disk inputs the rules page renders from. Nothing here executes an analyzer. */
interface VolatileInputs {
  history: RunRecord[];
  baseline: Baseline | null;
  suppressions: Suppression[];
  configured: boolean;
  latest: LatestRun | null;
  executor: ExecutorView;
}

async function readVolatileInputs(
  root: string,
  lanes: readonly LaneDeclaration[],
): Promise<VolatileInputs> {
  const [history, baseline, suppressions, configured, latest, executor] = await Promise.all([
    readHistory(root),
    readBaseline(root),
    loadSuppressions(root),
    suppressionsConfigured(root),
    readLatestRun(root),
    readExecutorView(root, lanes),
  ]);
  return { history, baseline, suppressions, configured, latest, executor };
}

/** The static half of the rules page for one project, loaded once per root. */
interface RulesContext {
  lanes: readonly LaneDeclaration[];
  enabled: RuleManifest[];
  analyzerIds: string[];
  ruleAnalyzers: Record<string, string>;
}

async function loadRulesContext(root: string): Promise<RulesContext> {
  const config = await loadConfig(root);
  const lanes = configuredLanes(config);
  const manifests = await loadAnalyzers(config.analyzers, root);
  const available = allRules(manifests);
  const enabledIds = new Set(resolveRules(config, available).keys());
  const enabled = available.filter((rule) => enabledIds.has(rule.id));
  const ruleAnalyzers: Record<string, string> = {};
  for (const manifest of manifests) {
    for (const rule of manifest.rules) ruleAnalyzers[rule.id] = manifest.id;
  }
  return { lanes, enabled, analyzerIds: manifests.map((m) => m.id), ruleAnalyzers };
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf('--port');
  if (index === -1) return DEFAULT_PORT;
  const raw = argv[index + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readBody(req));
  if (!isRecord(parsed)) throw new Error('expected a JSON object');
  return parsed;
}

/**
 * A plain HTML form posts `application/x-www-form-urlencoded`, not JSON. The
 * dispatch route accepts it so the tasks page's form works with no script at
 * all: the declaration's fields arrive as text, `ownedPaths` and `gates` one
 * per line, which `stringArrayField` already reads.
 */
async function readFormBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(await readBody(req))) {
    record[key] = value;
  }
  return record;
}

/**
 * A key that changes whenever anything the home page shows could have changed:
 * the dispatch log, the comment store, the last run, the working tree, and
 * every spec's task list. The page polls it and reloads on a change, so a
 * reader on a phone sees a dispatch open without pulling to refresh.
 */
async function stateKey(root: string): Promise<string> {
  const files = [
    dispatchLogPath(root),
    join(root, '.cyv-review', 'comments.json'),
    join(root, '.cyv-review', 'latest-run.json'),
    join(root, '.git', 'index'),
    join(root, '.git', 'HEAD'),
  ];
  const specs = await parseAllSpecs(root);
  for (const spec of specs.specs) {
    if (spec.tasksPath !== null) files.push(join(root, spec.tasksPath));
  }
  const stamps: string[] = [];
  for (const file of files) {
    try {
      stamps.push(String(Math.floor((await stat(file)).mtimeMs)));
    } catch {
      stamps.push('-');
    }
  }
  return stamps.join(':');
}

export interface DashboardServerOptions {
  /** The repository `cyv dashboard` was started in; served when nothing is registered. */
  root: string;
  /** Overrides the registry read from the home directory, for tests. */
  registry?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Required on every request when the server is reachable beyond loopback.
   * Omitted for a loopback bind, where the network already limits who can ask.
   */
  accessToken?: string;
  /** Injected session manager, used by tests to avoid spawning real agents. */
  sessionManager?: SessionManager;
}

/** A configured, not-yet-listening dashboard server. */
export interface DashboardServer {
  server: Server;
  /** The roots the server will serve. */
  projects: readonly string[];
}

type Send = (code: number, type: string, body: string) => void;

/**
 * Build the dashboard's HTTP server: one server, every registered project,
 * the home page first and the rules page one tab away (spec 0040 R1, R7, R8).
 *
 * Almost nothing served here runs an analyzer or an executor. The explorer
 * save endpoint is the exception: it writes a file and then runs `cyv check` on
 * it so the UI can show rule id and message. The other writes are a comment and
 * a guarded document save; the one process it ends is a running dispatch.
 */
export async function createDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const env = options.env ?? process.env;
  const registry = options.registry ?? (await readRegistry());
  // With nothing registered the checkout the command ran in stands in, as one
  // project that happens to be there, not as the subject of every route.
  const projects = registry.length > 0 ? registry : [normalizeProjectPath(options.root)];
  const sessionManager = options.sessionManager ?? createSessionManager({ env });

  /**
   * Shared context used by both the full board page and the live-update
   * fragments: the same files are read so the two renders cannot drift.
   */
  const buildBoardContext = async (
    root: string,
    now = Date.now(),
    projectFilter = '',
  ): Promise<{ model: BoardModel; lanes: readonly ResolvedLaneDeclaration[]; exchange: BoardExchange; sessions: SessionView[]; gate: GateHealth }> => {
    const [log, comments, config, cursor, sessions, decisions, specs, lifecycleEvents] = await Promise.all([
      readDispatchLog(root),
      loadComments(root),
      loadConfig(root),
      readCursorFor(root),
      sessionManager.listSessions(root),
      readHookDecisions(root),
      parseAllSpecs(root),
      readLifecycleEvents(root),
    ]);
    const lanes = configuredLanes(config);
    // To Do is drawn from the specs: a unit of work is a spec with tasks left,
    // not a dispatch that failed.
    // A project groups specs; `?p=` is the workspace and is a different axis.
    const model = buildBoardModel({
      log,
      comments,
      lanes,
      specs: specs.specs,
      ...(projectFilter === '' ? {} : { projectFilter }),
      decisions,
      lifecycleEvents,
    });
    const region = commentsToExchange(comments, 50, { cursor, now });
    const exchange: BoardExchange = {
      entries: region.entries,
      omitted: region.omitted,
      drafts: comments.drafts ?? [],
    };
    return { model, lanes, exchange, sessions, gate: summarizeGate(decisions, now) };
  };

  const rulesContexts = new Map<string, Promise<RulesContext>>();

  const rulesFor = (root: string): Promise<RulesContext> => {
    const cached = rulesContexts.get(root);
    if (cached !== undefined) return cached;
    const loading = loadRulesContext(root);
    rulesContexts.set(root, loading);
    return loading;
  };

  /**
   * The project a request is about. `?p=` names it; an unregistered root is
   * refused rather than served, because the query string decides which
   * directory's files are read.
   */
  const resolveProject = (url: URL): string | null => {
    const asked = url.searchParams.get('p');
    if (asked === null || asked === '') return projects[0] ?? null;
    const normalized = normalizeProjectPath(asked);
    return projects.includes(normalized) ? normalized : null;
  };

  const accessToken = options.accessToken;

  /**
   * Constant-time equality that cannot throw on a length mismatch, which
   * `timingSafeEqual` does when the buffers differ in size.
   */
  const tokenMatches = (offered: string): boolean => {
    if (accessToken === undefined) return true;
    const a = Buffer.from(offered);
    const b = Buffer.from(accessToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  const offeredToken = (req: IncomingMessage, url: URL): string => {
    const fromQuery = url.searchParams.get('t');
    if (fromQuery !== null && fromQuery !== '') return fromQuery;
    const header = req.headers['x-cyv-token'];
    if (typeof header === 'string' && header !== '') return header;
    const cookie = req.headers.cookie ?? '';
    const match = /(?:^|;\s*)cyv_token=([^;]+)/.exec(cookie);
    return match?.[1] ?? '';
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The vendored runtime — Monaco — is a third-party library
    // files, byte-identical to what a CDN serves, and carry nothing about this
    // repository. Requiring the token for them made the board's own scripts
    // depend on a cookie reaching a subresource, and when it did not the page
    // silently rendered without its editor or its docking: the failure the
    // owner saw as "the workbench is missing its drawers again".
    const isVendorAsset = url.pathname.startsWith(VENDOR_PREFIX);
    if (accessToken !== undefined && !isVendorAsset && !tokenMatches(offeredToken(req, url))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('unauthorized\n');
      return;
    }
    if (accessToken !== undefined && url.searchParams.get('t') !== null) {
      res.setHeader('set-cookie', `cyv_token=${accessToken}; Path=/; HttpOnly; SameSite=Strict`);
    }
    const send: Send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code: number, value: unknown): void =>
      send(code, 'application/json; charset=utf-8', JSON.stringify(value));
    const html = (code: number, body: string): void =>
      send(code, 'text/html; charset=utf-8', body);

    if (url.pathname === '/vendor/marked.min.js') {
      const file = new URL('../../vendor/marked.min.js', import.meta.url);
      send(200, 'text/javascript; charset=utf-8', await readFile(file, 'utf-8'));
      return;
    }

    // The diff frame. difit is served through this origin so the page can
    // style it for a phone; which difit is meant travels in a cookie, because
    // difit's own page fetches absolute paths that carry no instance of their
    // own. The instance id is a configured one or `port-N` for one discovered.
    if (url.pathname === '/frame') {
      const entry = instanceById(url.searchParams.get('d') ?? '');
      if (entry === undefined) {
        send(404, 'text/plain; charset=utf-8', 'Unknown diff. Open the diff tab and pick one.');
        return;
      }
      res.setHeader('set-cookie', `${DIFIT_COOKIE}=${String(entry.port)}; Path=/; SameSite=Lax`);
      req.url = '/';
      await proxyToDifit(req, res, { port: entry.port });
      return;
    }

    // Vendor files (Monaco, Dockview), served from the package rather than a CDN:
    // the dashboard is reached through a tunnel and has to work with no internet
    // at all. Only files under the editor's own directory are reachable, and the
    // path is resolved and contained before anything is read.
    if (url.pathname.startsWith(VENDOR_PREFIX)) {
      const rel = url.pathname.slice(VENDOR_PREFIX.length);
      const file = await resolveVendorFile(rel);
      if (file === null) {
        send(404, 'text/plain; charset=utf-8', 'not found');
        return;
      }
      res.writeHead(200, {
        'content-type': vendorContentType(file),
        // The packages are versioned with the dashboard, so they can be cached hard.
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(await readFile(file));
      return;
    }

    if (isDifitPath(url.pathname)) {
      const port = difitPortFrom(req.headers.cookie);
      if (port === undefined) {
        send(404, 'text/plain; charset=utf-8', 'No diff is open. Open the diff tab first.');
        return;
      }
      await proxyToDifit(req, res, { port });
      return;
    }

    const root = resolveProject(url);
    if (root === null) {
      json(404, {
        error: 'unknown project',
        detail:
          'The ?p= root is not registered. Register it with `cyv projects --add <path>`; ' +
          'the server serves registered projects only.',
      });
      return;
    }

    const projectName = basename(root);
    const shellOpts: ShellOptions = {
      project: root,
      projectName,
      showProjects: projects.length > 1,
    };
    const isFormPost =
      req.method === 'POST' &&
      (req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
    const body = isFormPost
      ? await readFormBody(req)
      : req.method === 'POST'
        ? await readJsonBody(req)
        : {};

    // ------------------------------------------------------------- HOME
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/api/glance') {
      const builtAt = Date.now();
      // `/api/glance` serves the part of the page that goes out of date, so the
      // page can replace it when the live channel says something changed.
      const glanceBodyOnly = url.pathname === '/api/glance';
      const [log, comments, config, state, specs, tree, latest, sessions, decisions] = await Promise.all([
        readDispatchLog(root),
        loadComments(root),
        loadConfig(root),
        readState(root),
        parseAllSpecs(root),
        uncommittedWork(root, builtAt),
        readLatestRun(root),
        sessionManager.listSessions(root),
        readHookDecisions(root),
      ]);
      const page = buildGlancePage({
        project: root,
        projectName,
        projects,
        log,
        comments,
        lanes: configuredLanes(config),
        quotas: state.quotas,
        specs,
        tree,
        latest,
        sessions,
        gate: summarizeGate(decisions, builtAt),
        now: builtAt,
      });
      html(200, glanceBodyOnly ? renderGlanceBody(page) : renderGlancePage(page));
      return;
    }

    if (url.pathname === '/api/state') {
      json(200, { key: await stateKey(root) });
      return;
    }

    // --------------------------------------------------------- EXCHANGE
    if (url.pathname === '/api/comment' && req.method === 'POST') {
      const text = stringField(body, 'body') ?? '';
      if (text.trim().length === 0) {
        json(400, { error: 'empty comment' });
        return;
      }
      const file = stringField(body, 'file');
      if (file !== undefined && file !== '' && (await safeResolve(root, file)) === null) {
        json(400, { error: 'bad file' });
        return;
      }
      const task = stringField(body, 'task');
      const replyTo = numberField(body, 'replyTo');
      const orchestrator = booleanField(body, 'orchestrator');
      const input = {
        body: text,
        ...(file === undefined ? {} : { file }),
        anchor: stringField(body, 'anchor') ?? '',
        refs: {
          ...(task === undefined || task === '' ? {} : { task }),
          ...(replyTo === undefined ? {} : { replyTo }),
        },
        ...(orchestrator === undefined ? {} : { orchestrator }),
      };
      // `draft` holds the note back from the comment watcher: a batch review is
      // composed first and published by 'Send review', so the agent cannot see
      // a half-written set of notes (spec 0051 Requirement 5.2).
      const asDraft =
        booleanField(body, 'draft') === true || stringField(body, 'status') === 'draft';
      const comment = asDraft
        ? await addDraft(root, input, Date.now())
        : await addComment(root, input, Date.now());
      json(200, comment);
      return;
    }

    if (url.pathname === '/api/comment/status' && req.method === 'POST') {
      const id = numberField(body, 'id');
      const status = stringField(body, 'status') ?? 'open';
      const updated = id === undefined ? undefined : await setCommentStatus(root, id, status);
      if (updated === undefined) {
        json(404, { error: 'no such comment' });
        return;
      }
      json(200, updated);
      return;
    }

    if (url.pathname === '/api/comment/draft' && req.method === 'POST') {
      const id = numberField(body, 'id');
      const text = stringField(body, 'body') ?? '';
      if (id === undefined) {
        json(400, { error: 'id is required' });
        return;
      }
      if (text.trim().length === 0) {
        json(400, { error: 'empty comment' });
        return;
      }
      const updated = await editDraft(root, id, text);
      if (updated === undefined) {
        json(404, { error: 'no such draft' });
        return;
      }
      json(200, updated);
      return;
    }

    if (url.pathname === '/api/comment/draft/discard' && req.method === 'POST') {
      const id = numberField(body, 'id');
      if (id === undefined) {
        json(400, { error: 'id is required' });
        return;
      }
      if (!(await discardDraft(root, id))) {
        json(404, { error: 'no such draft' });
        return;
      }
      json(200, { ok: true, id });
      return;
    }

    if (url.pathname === '/api/comment/send' && req.method === 'POST') {
      const sent = await sendDrafts(root, Date.now());
      json(200, { sent: sent.length, comments: sent });
      return;
    }

    // ------------------------------------------------------------- STOP
    // A person saw a dispatch that needed them and it needs nothing more. The
    // record stays as it was; the acknowledgement is its own log entry.
    if (url.pathname === BOARD_ACK_PATH && req.method === 'POST') {
      const itemId = stringField(body, 'itemId') ?? stringField(body, 'dispatchId');
      if (itemId === undefined) {
        json(400, { error: 'itemId is required' });
        return;
      }
      const note = stringField(body, 'note');
      const entry = await acknowledgeItem(root, {
        itemId,
        acknowledgedAt: new Date().toISOString(),
        ...(note === undefined || note === '' ? {} : { note }),
      });
      json(200, entry);
      return;
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const dispatchId = stringField(body, 'dispatchId');
      if (dispatchId === undefined) {
        json(400, { error: 'dispatchId is required' });
        return;
      }
      const result = await stopDispatch(root, dispatchId, { judge: dashboardJudge });
      json(result.stopped ? 200 : 409, result);
      return;
    }

    if (url.pathname === '/api/abandon' && req.method === 'POST') {
      const dispatchId = stringField(body, 'dispatchId');
      if (dispatchId === undefined) {
        json(400, { error: 'dispatchId is required' });
        return;
      }
      const log = await readDispatchLog(root);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      if (record === undefined) {
        json(404, { error: `no dispatch "${dispatchId}" is in the log` });
        return;
      }
      if (record.closed !== undefined) {
        json(409, {
          error: `dispatch "${dispatchId}" is already closed at ${record.closed.closedAt} as ${record.closed.outcome.kind}`,
        });
        return;
      }
      const judgement = await dashboardJudge(record);
      if (judgement.liveness === 'live') {
        json(409, {
          error:
            'the executor is still running. Stop the dispatch instead; abandon is for closing a ' +
            'record whose supervisor has already gone.',
        });
        return;
      }
      const { closedAt } = await closeAsAbandoned(root, dispatchId, () => new Date());
      json(200, { dispatchId, closedAt, detail: 'The record was closed without killing a process.' });
      return;
    }

    if (url.pathname === '/api/retry' && req.method === 'POST') {
      const dispatchId = stringField(body, 'dispatchId');
      if (dispatchId === undefined) {
        json(400, { error: 'dispatchId is required' });
        return;
      }
      const [log, config] = await Promise.all([readDispatchLog(root), loadConfig(root)]);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      if (record === undefined) {
        json(404, { error: `no dispatch "${dispatchId}" is in the log` });
        return;
      }
      if (record.closed === undefined) {
        json(409, { error: `dispatch "${dispatchId}" is still in motion and cannot be retried` });
        return;
      }
      if (record.closed.outcome.kind !== 'gates-failed') {
        json(409, {
          error: `dispatch "${dispatchId}" outcome is ${record.closed.outcome.kind}; only gate failures can be retried`,
        });
        return;
      }
      const lanes = configuredLanes(config);
      const laneId = record.assignment.laneId;
      const lane = lanes.find((candidate) => candidate.id === laneId);
      if (lane === undefined) {
        json(400, { error: `original lane "${laneId}" is no longer configured` });
        return;
      }
      const lockHolder = await findEditLockConflict(root, record.declaration.ownedPaths);
      if (lockHolder !== undefined) {
        json(409, {
          error: `Dispatch refused: a spec file is locked by "${lockHolder}".`,
          holder: lockHolder,
        });
        return;
      }
      const started = await startDispatch(
        root,
        env,
        config,
        lanes,
        laneId,
        record.declaration,
      );
      if (!started.ok) {
        json(started.refusal === undefined ? 400 : 409, {
          error: started.error,
          ...(started.refusal === undefined ? {} : { refusal: started.refusal }),
        });
        return;
      }
      json(200, started.result);
      return;
    }

    if (url.pathname === '/api/dispatch' && req.method === 'POST') {
      const parsed = await parseDispatchBody(root, body);
      if (!parsed.ok) {
        json(400, { error: parsed.error });
        return;
      }
      const taskFile = stringField(body, 'taskFile') ?? stringField(body, 'task-file');
      const lockPaths = [...parsed.input.declaration.ownedPaths];
      if (taskFile !== undefined) lockPaths.push(taskFile);
      const lockHolder = await findEditLockConflict(root, lockPaths);
      if (lockHolder !== undefined) {
        json(409, {
          error: `Dispatch refused: a spec file is locked by "${lockHolder}".`,
          holder: lockHolder,
        });
        return;
      }
      const config = await loadConfig(root);
      const lanes = configuredLanes(config);
      const chosenLane = parsed.input.laneId === undefined
        ? undefined
        : lanes.find((candidate) => candidate.id === parsed.input.laneId);
      if (parsed.input.laneId !== undefined && chosenLane === undefined) {
        json(400, { error: `lane "${parsed.input.laneId}" is not configured` });
        return;
      }
      const started = await startDispatch(
        root,
        env,
        config,
        lanes,
        parsed.input.laneId,
        parsed.input.declaration,
      );
      if (!started.ok) {
        json(started.refusal === undefined ? 400 : 409, {
          error: started.error,
          ...(started.refusal === undefined ? {} : { refusal: started.refusal }),
        });
        return;
      }
      if (isFormPost) {
        // A browser form's answer is a page, not a JSON blob: send it back to
        // the task list, which now reads the dispatch as in motion.
        const back = new URLSearchParams({ p: root });
        const spec = stringField(body, 'spec');
        const state = stringField(body, 'state');
        if (spec !== undefined && spec !== '') back.set('spec', spec);
        if (state !== undefined && state !== '') back.set('state', state);
        res.writeHead(303, {
          location: `/tasks?${back.toString()}`,
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      json(200, started.result);
      return;
    }

    // ------------------------------------------------------------- DOCS
    if (url.pathname === '/files') {
      const [specs, commits, status, files] = await Promise.all([
        parseAllSpecs(root),
        gitLog(root, 20),
        readStatusLog(root),
        findMarkdown(root),
      ]);
      const query = (query: Record<string, string>): string =>
        `?${new URLSearchParams({ p: root, ...query }).toString()}`;
      const documents = await Promise.all(
        files.map(async (file) => {
          const info = await stat(join(root, file));
          const specId = /^docs\/specs\/([^/]+)\//.exec(file)?.[1];
          return {
            file,
            when: new Date(info.mtimeMs).toLocaleString(),
            kb: (info.size / 1024).toFixed(1),
            ...(specId === undefined ? {} : { specId }),
          };
        }),
      );
      html(
        200,
        renderDocsPage(
          {
            specs: specs.specs.map((spec) => ({
              id: spec.id,
              name: spec.id.replace(/^\d+-/, '').replace(/-/g, ' '),
              done: spec.done,
              total: spec.total,
              href: `/view${query({
                f: spec.tasksPath ?? `docs/specs/${spec.id}/requirements.md`,
              })}`,
            })),
            commits,
            status,
            documents,
          },
          shellOpts,
        ),
      );
      return;
    }

    if (url.pathname === '/view') {
      const rel = url.searchParams.get('f') ?? '';
      const full = await safeResolve(root, rel);
      if (full === null) {
        send(400, 'text/plain; charset=utf-8', 'bad path');
        return;
      }
      const [markdown, store] = await Promise.all([readFile(full, 'utf-8'), loadComments(root)]);
      const exchange = commentsToExchange(store, Number.MAX_SAFE_INTEGER);
      const sections = splitSections(markdown).map((section, index) => {
        const anchor = section.anchor === '' ? `s${index}` : section.anchor;
        return {
          title: section.title,
          anchor,
          source: section.source,
          comments: exchange.entries.filter((entry) => entry.file === rel && entry.anchor === anchor),
        };
      });
      const query = new URLSearchParams({ p: root, f: rel }).toString();
      html(
        200,
        renderViewPage(
          {
            file: rel,
            sections,
            editHref: `/edit?${query}`,
            vendorScriptHref: '/vendor/marked.min.js',
          },
          shellOpts,
        ),
      );
      return;
    }

    if (url.pathname === '/edit') {
      const rel = url.searchParams.get('f') ?? '';
      const full = await safeResolve(root, rel);
      if (full === null) {
        send(400, 'text/plain; charset=utf-8', 'bad path');
        return;
      }
      const [source, mtime] = await Promise.all([readFile(full, 'utf-8'), fileMtime(root, rel)]);
      const query = new URLSearchParams({ p: root, f: rel }).toString();
      html(200, renderEditPage({ file: rel, source, mtime, viewHref: `/view?${query}` }, shellOpts));
      return;
    }

    if (url.pathname === '/api/save' && req.method === 'POST') {
      const rel = stringField(body, 'file') ?? '';
      const full = await safeResolve(root, rel);
      if (full === null) {
        json(400, { error: 'bad file' });
        return;
      }
      const current = Math.floor((await stat(full)).mtimeMs);
      // An agent may be writing this file right now; a save from a stale copy
      // would silently discard its work.
      if (numberField(body, 'mtime') !== current) {
        json(409, { error: 'file changed on disk since you opened it — reload and reapply' });
        return;
      }
      await writeFile(full, stringField(body, 'content') ?? '', 'utf-8');
      json(200, { ok: true, mtime: Math.floor((await stat(full)).mtimeMs) });
      return;
    }

    // ------------------------------------------------------------- DIFF
    if (url.pathname === '/diff') {
      const instances = await difitInstanceStates();
      const wanted = url.searchParams.get('d');
      const current =
        instances.find((entry) => entry.id === wanted) ??
        instances.find((entry) => entry.up) ??
        instances[0];
      if (current === undefined) {
        html(200, renderDiffPage({ instances: [], currentId: '', comments: [] }, shellOpts));
        return;
      }
      const comments = current.up ? await difitComments(root, current.port) : [];
      html(200, renderDiffPage({ instances, currentId: current.id, comments }, shellOpts));
      return;
    }

    if (url.pathname === '/api/difit/start' && req.method === 'POST') {
      const entry = instanceById(stringField(body, 'id') ?? '');
      if (entry === undefined) {
        json(400, { error: 'Unknown diff id.' });
        return;
      }
      const result = await startDifit({ cwd: root, port: entry.port, target: entry.target });
      const ok = result.started || result.alreadyRunning;
      json(ok ? 200 : 500, {
        started: result.started,
        alreadyRunning: result.alreadyRunning,
        ...(ok ? {} : { error: `difit did not start on port ${entry.port}.` }),
      });
      return;
    }

    // ------------------------------------------------------------- BOARD
    if (url.pathname === '/board') {
      const now = Date.now();
      const { model, lanes, exchange, sessions, gate } = await buildBoardContext(
        root,
        now,
        url.searchParams.get('project') ?? '',
      );
      const page = renderBoard({
        model,
        lanes,
        projectRoot: root,
        exchange,
        sessions,
        gate,
        now,
      })
        .replace('</style>', `${diffDrawerCss()}</style>`)
        // The nav is the renderer's. This route used to patch links into the
        // rendered HTML because the board shipped an incomplete nav with dead
        // `href="#"` tabs; once the renderer emitted a real one, those patches
        // injected a second Glance and a stray Specs.
        // Monaco's AMD loader first, from the dashboard's own origin. The
        // editor is optional: if this never loads, the textarea it would have
        // replaced is still there and still saves.
        .replace(
          '</body>',
          `<script src="${VENDOR_PREFIX}monaco/loader.js"></script>` +
            `<script>${boardClientScript()}</script></body>`,
        );
      html(200, page);
      return;
    }

    // ------------------------------------------------------------- LIVE
    if (url.pathname === '/api/live') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      let closed = false;
      const sendEvent = (kind: string, data: unknown): void => {
        if (closed) return;
        res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent('connected', { fragments: [] });
      const unsubscribe = subscribeToProject(root, (event) => {
        sendEvent(event.kind, { fragments: event.fragments });
      });

      // A quiet project sends nothing for minutes at a time, and an idle
      // connection is what a proxy drops first — the dashboard is reached
      // through a tunnel, where that is the common case. The client would
      // reconnect, but between the drop and the retry the page is showing
      // stale data under a live badge. A comment line costs nothing and keeps
      // the connection from going quiet; SSE readers ignore it.
      const heartbeat = setInterval(() => {
        if (closed) return;
        res.write(': keep-alive\n\n');
      }, LIVE_HEARTBEAT_MS);
      heartbeat.unref();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    if (url.pathname === '/api/fragment' && req.method === 'GET') {
      const region = url.searchParams.get('region') ?? '';
      if (region === '') {
        json(400, { error: 'region is required' });
        return;
      }
      const now = Date.now();
      const { model, lanes, exchange, sessions, gate } = await buildBoardContext(
        root,
        now,
        url.searchParams.get('project') ?? '',
      );
      const fragment = renderBoardFragment(
        {
          model,
          lanes,
          projectRoot: root,
          exchange,
          sessions,
          gate,
          now,
        },
        region,
      );
      if (fragment === undefined) {
        json(404, { error: `unknown region "${region}"` });
        return;
      }
      html(200, fragment);
      return;
    }

    // ----------------------------------------------------------- SESSIONS
    if (url.pathname === '/api/session/start' && req.method === 'POST') {
      const agentId = stringField(body, 'agentId') ?? '';
      if (agentId === '') {
        json(400, { error: 'agentId is required' });
        return;
      }
      const result = await sessionManager.startSession(root, agentId, env);
      if (!result.ok) {
        const code = result.holder === undefined ? 400 : 409;
        json(code, { error: result.error, ...(result.holder === undefined ? {} : { holder: result.holder }) });
        return;
      }
      const sessions = await sessionManager.listSessions(root);
      const view = sessions.find((s) => s.sessionId === result.sessionId);
      json(200, { ok: true, session: view ?? { sessionId: result.sessionId, pid: result.pid } });
      return;
    }

    if (url.pathname === '/api/session/stop' && req.method === 'POST') {
      const sessionId = stringField(body, 'sessionId') ?? '';
      if (sessionId === '') {
        json(400, { error: 'sessionId is required' });
        return;
      }
      const result = await sessionManager.stopSession(root, sessionId);
      if (!result.ok) {
        json(500, { error: result.error });
        return;
      }
      json(200, { ok: true, stopped: result.stopped });
      return;
    }

    if (url.pathname === BOARD_DRAWER_PATH && req.method === 'GET') {
      // A spec is the unit a person reviews: everything it touched, which is
      // what a pull request would carry. Reviewing one dispatch at a time asks
      // for a sign-off on every individual change, which is an agent's job.
      const specId = url.searchParams.get('spec') ?? '';
      if (specId !== '') {
        const log = await readDispatchLog(root);
        const numeric = /^(\d{4})/.exec(specId)?.[1];
        const matching = log.records.filter(
          (record) => numeric !== undefined && specNumbersIn(record).includes(numeric),
        );
        html(
          200,
          renderSpecDrawer({
            specId,
            title: specDisplayName(specId),
            diffHref: `/diff?s=${encodeURIComponent(specId)}`,
            dispatches: matching
              .slice()
              .reverse()
              .map((record) => ({
                dispatchId: record.dispatchId,
                task: record.declaration.task.split('\n')[0] ?? record.dispatchId,
                outcome: record.closed?.outcome.kind ?? 'in motion',
                ...(record.closed === undefined ? {} : { closedAt: record.closed.closedAt }),
                changedPaths: record.closed?.outcome.changedPaths ?? [],
              })),
          }),
        );
        return;
      }

      const dispatchId = url.searchParams.get('dispatch') ?? '';
      if (dispatchId === '') {
        json(400, { error: 'dispatch or spec is required' });
        return;
      }
      const log = await readDispatchLog(root);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      if (record === undefined) {
        json(404, { error: `no dispatch "${dispatchId}" is in the log` });
        return;
      }
      if (record.closed === undefined) {
        json(409, {
          error:
            `Dispatch ${dispatchId} is still in motion: it has no close entry, so the working tree ` +
            'it would be judged against is still changing and cannot be reviewed yet.',
        });
        return;
      }
      const diffHref = `/diff?d=${encodeURIComponent(dispatchId)}`;
      // The outcome charges every file that changed in the window to this
      // dispatch. The decision log knows which of them another session wrote.
      const writtenByOthers = pathsWrittenByOutsideSessions({
        openedAt: record.openedAt,
        closedAt: record.closed.closedAt,
        paths: record.closed.outcome.outOfScopePaths,
        decisions: await readHookDecisions(root),
      });
      html(200, renderDiffDrawer({ record, diffHref, writtenByOthers }));
      return;
    }

    // The diff a person signs off is the spec's, against the branch it lands on.
    if (url.pathname === '/api/spec-diff' && req.method === 'GET') {
      const specId = url.searchParams.get('spec') ?? '';
      const dispatchId = url.searchParams.get('dispatch') ?? '';
      if (specId === '' && dispatchId === '') {
        json(400, { error: 'spec or dispatch is required' });
        return;
      }
      const numeric = /^(\d{4})/.exec(specId)?.[1];
      const log = await readDispatchLog(root);
      const paths = new Set<string>();
      // Most dispatches are one-off briefs naming no spec. Asked about one of
      // those, this answers for that dispatch alone rather than refusing: what
      // it changed is on its own record.
      for (const record of log.records) {
        const matches =
          dispatchId === ''
            ? numeric !== undefined && specNumbersIn(record).includes(numeric)
            : record.dispatchId === dispatchId;
        if (!matches) continue;
        for (const path of record.closed?.outcome.changedPaths ?? []) paths.add(path);
      }
      const diff = await specDiff({
        root,
        paths: [...paths],
        ...(url.searchParams.get('base') === null ? {} : { base: url.searchParams.get('base') ?? '' }),
      });
      json(200, { specId, dispatchId, ...diff });
      return;
    }

    if (url.pathname === BOARD_INSPECT_PATH && req.method === 'GET') {
      const dispatchId = url.searchParams.get('dispatch') ?? '';
      if (dispatchId === '') {
        json(400, { error: 'dispatch is required' });
        return;
      }
      const [log, comments, config, decisions, lifecycleEvents] = await Promise.all([
        readDispatchLog(root),
        loadComments(root),
        loadConfig(root),
        readHookDecisions(root),
        readLifecycleEvents(root),
      ]);
      const lanes = configuredLanes(config);
      const model = buildBoardModel({ log, comments, lanes, decisions, lifecycleEvents });
      const now = Date.now();
      const inNeedsYou = model.needsYou.find(
        (item): item is BoardCard => item.kind === 'card' && item.dispatchId === dispatchId,
      );
      const card =
        inNeedsYou ??
        model.review.find((candidate) => candidate.dispatchId === dispatchId) ??
        model.done.find((candidate) => candidate.dispatchId === dispatchId) ??
        model.inMotion.find((candidate) => candidate.dispatchId === dispatchId);
      if (card === undefined) {
        json(404, { error: `no dispatch "${dispatchId}" is available to inspect` });
        return;
      }
      if (card.outcome === undefined) {
        json(409, {
          error:
            `Dispatch ${dispatchId} is still in motion: it has no close entry, so the working tree ` +
            'it would be judged against is still changing and cannot be reviewed yet.',
        });
        return;
      }
      html(200, diffPanelForCard(card, now));
      return;
    }

    // ------------------------------------------------------------- SPECS
    if (url.pathname === '/api/spec/list' && req.method === 'GET') {
      json(200, await listSpecFiles(root));
      return;
    }

    if (url.pathname === '/api/spec/read' && req.method === 'GET') {
      const file = url.searchParams.get('f') ?? '';
      if (file === '') {
        json(400, { error: 'file is required' });
        return;
      }
      try {
        const content = await readSpecFile(root, file);
        json(200, { content });
      } catch (err) {
        const message = messageOf(err);
        if (message.startsWith('Path refused')) {
          json(400, { error: message });
          return;
        }
        json(404, { error: message });
      }
      return;
    }

    if (url.pathname === '/api/spec/write' && req.method === 'POST') {
      const file = stringField(body, 'file') ?? '';
      const content = stringField(body, 'content') ?? '';
      const holder = stringField(body, 'holder') ?? '';
      if (file === '' || holder === '') {
        json(400, { error: 'file and holder are required' });
        return;
      }
      try {
        const claim = await claimSpecFile(root, file, holder);
        if (!claim.claimed) {
          json(409, {
            error: `Write refused: "${file}" is locked by "${claim.holder}".`,
            holder: claim.holder,
          });
          return;
        }
        await writeSpecFile(root, file, content, holder);
        json(200, { ok: true });
      } catch (err) {
        const message = messageOf(err);
        if (message.startsWith('Path refused')) {
          json(400, { error: message });
          return;
        }
        const match = /locked by "([^"]+)"/.exec(message);
        const currentHolder = match?.[1] ?? 'unknown';
        json(409, { error: message, holder: currentHolder });
      }
      return;
    }

    if (url.pathname === '/api/spec/release' && req.method === 'POST') {
      const file = stringField(body, 'file') ?? '';
      const holder = stringField(body, 'holder') ?? '';
      if (file === '' || holder === '') {
        json(400, { error: 'file and holder are required' });
        return;
      }
      try {
        await releaseSpecFile(root, file, holder);
        json(200, { ok: true });
      } catch (err) {
        const message = messageOf(err);
        if (message.startsWith('Path refused')) {
          json(400, { error: message });
          return;
        }
        json(500, { error: message });
      }
      return;
    }

    if (url.pathname === '/api/spec/preview' && req.method === 'POST') {
      const markdown = stringField(body, 'markdown') ?? '';
      json(200, { html: renderSpecMarkdown(markdown) });
      return;
    }

    if (url.pathname === BOARD_EXPLORER_TREE_PATH && req.method === 'GET') {
      try {
        const paths = await gitExplorerFiles(root);
        const tree = buildExplorerTree(paths);
        tree.name = projectName;
        json(200, { tree });
      } catch (err) {
        json(500, { error: `Could not list files: ${messageOf(err)}` });
      }
      return;
    }

    if (url.pathname === BOARD_EXPLORER_READ_PATH && req.method === 'GET') {
      const file = url.searchParams.get('f') ?? '';
      if (file === '') {
        json(400, { error: 'file is required' });
        return;
      }
      try {
        const content = await readExplorerFile(root, file);
        json(200, { content });
      } catch (err) {
        const message = messageOf(err);
        if (message.startsWith('Path refused')) {
          json(400, { error: message });
        } else if (isEnoent(err)) {
          json(404, { error: message });
        } else {
          json(500, { error: message });
        }
      }
      return;
    }

    if (url.pathname === BOARD_EXPLORER_WRITE_PATH && req.method === 'POST') {
      const file = stringField(body, 'file') ?? '';
      const content = stringField(body, 'content') ?? '';
      const holder = stringField(body, 'holder') ?? '';
      if (file === '' || holder === '') {
        json(400, { error: 'file and holder are required' });
        return;
      }
      try {
        await writeExplorerFile(root, file, content, holder);
      } catch (err) {
        const message = messageOf(err);
        if (message.startsWith('Path refused')) {
          json(400, { error: message });
          return;
        }
        const lockedMatch = /locked by "([^"]+)"/.exec(message);
        if (lockedMatch !== null && lockedMatch[1] !== undefined) {
          json(409, { error: message, holder: lockedMatch[1] });
          return;
        }
        json(500, { error: message });
        return;
      }
      try {
        const { findings, blocked } = await checkExplorerFile(root, file);
        json(200, { ok: !blocked, findings });
      } catch (err) {
        json(500, { error: `cyv check failed: ${messageOf(err)}` });
      }
      return;
    }

    // ------------------------------------------------------------- SPECS
    if (url.pathname === '/specs') {
      const directories = await listSpecFiles(root);
      const file = url.searchParams.get('f') ?? '';
      const holder = url.searchParams.get('h') ?? '';
      const projectName = basename(root);
      const input: SpecPageInput = { project: root, projectName, directories };
      if (file !== '' && holder !== '') {
        try {
          const content = await readSpecFile(root, file);
          const claim = await claimSpecFile(root, file, holder);
          input.open = {
            file,
            content,
            holder,
            readOnly: !claim.claimed,
            lockedBy: claim.claimed ? undefined : claim.holder,
          };
        } catch (err) {
          const message = messageOf(err);
          if (message.startsWith('Path refused') || isEnoent(err)) {
            input.error = message;
          } else {
            throw err;
          }
        }
      }
      html(200, renderSpecPage(input));
      return;
    }

    // ------------------------------------------------------------ TASKS
    if (url.pathname === '/tasks') {
      const [specs, log, config] = await Promise.all([
        parseAllSpecs(root),
        readDispatchLog(root),
        loadConfig(root),
      ]);
      html(
        200,
        renderTasksPage({
          project: root,
          projectName,
          specs: specs.specs,
          records: log.records,
          lanes: configuredLanes(config),
          spec: url.searchParams.get('spec') ?? '',
          state: url.searchParams.get('state') ?? '',
          forTask: url.searchParams.get('for') ?? '',
        }),
      );
      return;
    }

    // ------------------------------------------------------------ SPEC
    if (url.pathname === '/spec') {
      const specId = url.searchParams.get('spec') ?? '';
      const tab = toSpecTab(url.searchParams.get('tab'));
      if (specId === '' || !isValidSpecId(specId)) {
        html(
          400,
          renderSpecDetailPage({
            project: root,
            projectName,
            specId,
            tab: 'requirements',
            error: 'The spec id is missing or malformed.',
          }),
        );
        return;
      }
      const specs = await findSpecs(root);
      if (!specs.some((candidate) => candidate.id === specId)) {
        html(
          404,
          renderSpecDetailPage({
            project: root,
            projectName,
            specId,
            tab,
            error: `No spec "${specId}" exists in this project.`,
          }),
        );
        return;
      }
      const files: Partial<Record<SpecTab, string>> = {};
      for (const fileTab of ['requirements', 'design', 'tasks'] as const) {
        const rel = `docs/specs/${specId}/${fileTab}.md`;
        const full = await safeResolve(root, rel);
        if (full !== null) {
          files[fileTab] = await readFile(full, 'utf8');
        }
      }
      html(
        200,
        renderSpecDetailPage({
          project: root,
          projectName,
          specId,
          tab,
          files,
        }),
      );
      return;
    }

    // ------------------------------------------------------------ LANES
    if (url.pathname === '/lanes') {
      const [config, log, state] = await Promise.all([
        loadConfig(root),
        readDispatchLog(root),
        readState(root),
      ]);
      const page = await buildLanesPage({
        project: root,
        projectName,
        config,
        log,
        quotas: state.quotas,
        env,
        cwd: root,
      });
      html(200, renderLanesPage(page));
      return;
    }

    // ------------------------------------------------------------ LIVE
    if (url.pathname === '/live') {
      const [config, log, decisions, lifecycleEvents, sessions, specs, comments] = await Promise.all([
        loadConfig(root),
        readDispatchLog(root),
        readHookDecisions(root),
        readLifecycleEvents(root),
        sessionManager.listSessions(root),
        parseAllSpecs(root),
        loadComments(root),
      ]);
      const page = await buildLivePage({
        project: root,
        projectName,
        now: Date.now(),
        decisions,
        comments,
        lifecycleEvents,
        log,
        sessions,
        lanes: configuredLanes(config),
        specs: specs.specs,
      });
      html(200, renderLivePage(page));
      return;
    }

    // ------------------------------------------------------------ RULES
    if (url.pathname === '/rules') {
      const context = await rulesFor(root);
      const inputs = await readVolatileInputs(root, context.lanes);
      html(
        200,
        renderDashboard(
          context.enabled,
          context.analyzerIds,
          inputs.history,
          context.ruleAnalyzers,
          {
            baseline: inputs.baseline,
            suppressionsConfigured: inputs.configured,
            suppressions: inputs.suppressions,
            repoRoot: root,
          },
          inputs.latest,
          inputs.executor,
          {
            project: root,
            homeHref: `/?${new URLSearchParams({ p: root }).toString()}`,
            // Everything but Glance, which the back link already is, and Rules,
            // which is this page.
            pages: NAV_PAGES.filter((page) => page.path !== '/' && page.path !== '/rules').map(
              (page) => ({
                href: `${page.path}?${new URLSearchParams({ p: root }).toString()}`,
                label: page.label,
              }),
            ),
            volatileHref: `/volatile.html?${new URLSearchParams({ p: root }).toString()}`,
          },
        ),
      );
      return;
    }

    if (url.pathname === '/volatile.html') {
      const context = await rulesFor(root);
      const inputs = await readVolatileInputs(root, context.lanes);
      html(
        200,
        renderVolatilePanels(
          context.enabled,
          inputs.history,
          {
            baseline: inputs.baseline,
            suppressionsConfigured: inputs.configured,
            suppressions: inputs.suppressions,
            repoRoot: root,
          },
          inputs.latest,
          Date.now(),
          inputs.executor,
        ),
      );
      return;
    }

    send(404, 'text/plain; charset=utf-8', 'not found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`The dashboard could not answer this request: ${messageOf(err)}`);
    });
  });

  return { server, projects };
}

/** Milliseconds a connect probe waits before treating a port as free. */
const PORT_PROBE_TIMEOUT_MS = 500;

/**
 * True when a TCP connection to `host:port` completes. The handshake finishing
 * is all the evidence needed that something is bound and listening there; the
 * socket is closed without a byte being written.
 */
function connectSucceeds(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (reached: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reached);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    // Stays attached for the socket's life: an EventEmitter 'error' with no
    // listener throws, and a refused connection is precisely the "free" answer.
    socket.on('error', () => {
      finish(false);
    });
  });
}

/**
 * True when something on this machine already accepts connections on `port`.
 *
 * The bind alone cannot be trusted to report a held port: on Windows a
 * `0.0.0.0` listener and a `127.0.0.1` listener can share one port, and each
 * then answers only the requests that arrive on its own address — a second
 * dashboard starts silently, prints a token the other instance does not
 * honor, and a link that works locally fails through a tunnel. Connecting to
 * every address this machine owns catches an occupant bound to any of them.
 */
export async function dashboardPortInUse(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1', ...lanAddresses()]) {
    if (await connectSucceeds(host, port)) return true;
  }
  return false;
}

/** What a refused start tells the operator: which port, and what to stop. */
function portInUseMessage(port: number): string {
  return (
    `port ${port} is already in use — another dashboard instance is probably ` +
    'already serving on it. Stop the other one before starting a new instance: ' +
    'two listeners on one port each answer only the requests that arrive on ' +
    'their own bind address.'
  );
}

/** What binding the dashboard's port came back with. */
export type ListenOutcome = { ok: true } | { ok: false; error: string };

/**
 * `server.listen` with its failure made a value: an `error` event resolves to
 * a report instead of leaving a pending promise behind, which is how a failed
 * bind used to say nothing at all.
 */
export function listenDashboard(server: Server, port: number, host: string): Promise<ListenOutcome> {
  return new Promise<ListenOutcome>((resolve) => {
    const fail = (err: unknown): void => {
      resolve({
        ok: false,
        error:
          hasErrorCode(err) && err.code === 'EADDRINUSE'
            ? portInUseMessage(port)
            : `could not bind ${host}:${port}: ${messageOf(err)}`,
      });
    };
    const onError = (err: Error): void => {
      fail(err);
    };
    server.once('error', onError);
    try {
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve({ ok: true });
      });
    } catch (err) {
      server.removeListener('error', onError);
      fail(err);
    }
  });
}

/** How often an idle live connection is nudged so a proxy does not drop it. */
const LIVE_HEARTBEAT_MS = 20_000;

/** Where the access token lives: under `.cyv-review/`, which the repository's `.gitignore` already excludes. */
const TOKEN_FILENAME = 'dashboard-token';

/** A minted token is base64url; anything else in the file is not a token to hand out. */
const STORED_TOKEN = /^[A-Za-z0-9_-]{20,}$/;

/** Options controlling where the dashboard's access token comes from. */
export interface AccessTokenOptions {
  /** False for a loopback bind, where no token is minted and none is stored. */
  exposed: boolean;
  /** `--new-token`: replace the stored token instead of reusing it. */
  regenerate: boolean;
}

async function readStoredToken(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    // A missing file is the first run. Anything else is said aloud and then
    // treated as absent — the write below reports its own failure if the
    // directory is truly unreachable.
    if (!isEnoent(err)) {
      process.stderr.write(
        `cyv dashboard: the stored access token could not be read (${messageOf(err)})\n`,
      );
    }
    return undefined;
  }
  const token = raw.trim();
  return STORED_TOKEN.test(token) ? token : undefined;
}

/**
 * The token every request must carry when the dashboard answers beyond
 * loopback.
 *
 * A token minted per run retired every link already shared, so the first one
 * this repository minted is kept at `.cyv-review/dashboard-token` — a
 * directory `.gitignore` already excludes, in a file only the owner can read
 * where the platform supports that — and read back on the next start.
 * `--new-token` replaces it for when a link has been shared too widely.
 * Loopback never reaches here: no token, nothing stored.
 */
export async function resolveAccessToken(
  root: string,
  options: AccessTokenOptions,
): Promise<string | undefined> {
  if (!options.exposed) return undefined;

  const file = join(root, '.cyv-review', TOKEN_FILENAME);
  if (!options.regenerate) {
    const stored = await readStoredToken(file);
    if (stored !== undefined) return stored;
  }

  const token = randomBytes(24).toString('base64url');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  // `mode` applies only when the file is created; one that already existed
  // keeps the permissions it had, so a rotated token is tightened explicitly.
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
  }
  return token;
}

/**
 * `cyv dashboard` — what needs you, what is in motion, and the lanes, for
 * every registered project.
 *
 * Binds to localhost unless `--host` is passed. A tool that exposes a
 * repository's contents to the local network by default is a hazard, not a
 * convenience. Beyond loopback every request must carry the access token the
 * banner prints; it is kept under `.cyv-review/` so a restart keeps shared
 * links working, and `--new-token` rotates it.
 */
async function run(ctx: CommandContext): Promise<number> {
  const port = parsePort(ctx.argv);
  const exposeToLan = ctx.argv.includes('--host');
  const host = exposeToLan ? '0.0.0.0' : '127.0.0.1';

  const root = await repoRoot(ctx.cwd);

  // A refused start must not rotate a stored token or build a server it will
  // abandon, so the port is probed before either.
  if (await dashboardPortInUse(port)) {
    process.stderr.write(`cyv dashboard: ${portInUseMessage(port)}\n`);
    return 2;
  }

  // Beyond loopback the network no longer limits who can ask, and this server
  // writes spec files and dispatches agents that run on this machine, so every
  // request must carry the token.
  const accessToken = await resolveAccessToken(root, {
    exposed: exposeToLan,
    regenerate: ctx.argv.includes('--new-token'),
  });
  const { server, projects } = await createDashboardServer({
    root,
    env: ctx.env,
    ...(accessToken === undefined ? {} : { accessToken }),
  });

  const bound = await listenDashboard(server, port, host);
  if (!bound.ok) {
    process.stderr.write(`cyv dashboard: ${bound.error}\n`);
    return 2;
  }

  process.stdout.write(
    formatStartupBanner({
      port,
      exposeToLan,
      projects,
      ...(accessToken === undefined ? {} : { accessToken }),
    }),
  );

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => {
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return 0;
}

export const command: Command = { run };
