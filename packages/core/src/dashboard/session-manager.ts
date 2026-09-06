/**
 * Manage orchestrator sessions: start an agent CLI for a project, stop it,
 * reconcile dead records, and list what is actually alive.
 *
 * The session registry lives in `state-store.ts` and is not modified here.
 * Its `SessionEntry` carries the project root, agent, state and the last
 * resumed time, which is also the process start time. The pid is encoded in
 * the session id itself, so the registry key (`sess-<pid>-<startedAtMs>-<entropy>`)
 * can be verified against the process table without needing extra fields.
 *
 * Working-tree mutual exclusion uses the existing card-to-session claim
 * operations: each session claims a synthetic card `__session:<sessionId>`
 * against the project root, which makes `workingTrees[projectRoot]` the
 * session id. Releasing a session scans and releases every card assignment
 * it holds, including the synthetic one, so the tree is freed.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { agentCommandFor } from '../executor/invocation.js';
import { findProgram, launchArguments, type ProgramLauncher } from '../executor/program.js';
import { judgeLiveness, processStartedAtOnThisHost } from '../executor/liveness.js';
import { readDispatchLog } from '../executor/store.js';
import type { OrchestratorReported } from '../executor/dispatch.js';
import { readLifecycleEvents, type LifecycleEvent } from '../cli/hook.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { configuredLanes } from '../config/lanes.js';
import {
  claimCard,
  readState,
  registerSession,
  releaseCard,
  type SessionEntry,
  type SessionState,
} from './state-store.js';

const CYV_DIR = '.cyv-review';
const SESSION_PROMPT_DIR = 'session-prompts';
const SESSION_ID_PREFIX = 'sess';
const LIFECYCLE_STALE_MS = 60 * 60 * 1000;

/**
 * How long a session observed only through its hooks stays on the list after
 * it goes quiet. A session that has said nothing for this long is not coming
 * back, and listing it forever turned the panel into a record of every session
 * that ever ran — eight rows, seven of them hours stale, saying the same three
 * things.
 */
const OBSERVED_FORGET_MS = 2 * 60 * 60 * 1000;

/** One spawned session process. */
export interface SessionProcess {
  pid: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

/** How a caller supplies a replacement for `child_process.spawn` in tests. */
export interface SessionSpawn {
  (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean },
  ): SessionProcess;
}

export interface SessionManagerOptions {
  env?: NodeJS.ProcessEnv;
  spawn?: SessionSpawn;
  findProgram?: (
    program: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ) => Promise<ProgramLauncher | undefined>;
  terminate?: (pid: number) => boolean;
  processExists?: (pid: number) => boolean;
  processStartedAt?: (pid: number) => Promise<string | undefined>;
  thisHost?: string;
  now?: () => number;
  staleAfterMs?: number;
}

export interface SessionView {
  sessionId: string;
  projectRoot: string;
  agentId: string;
  state: SessionState | 'stale';
  pid: number;
  startedAt: string;
  uptimeMs: number;
  alive: boolean;
  reason?: string;
  statusSource: 'hook' | 'dispatch';
  /** True when the dashboard did not spawn this session and only sees it
   *  through its hooks. There is no pid, so it cannot be stopped from here. */
  observed?: boolean;
  /**
   * When this session's most recent hook fired. Distinct from `startedAt`: the
   * board reported the session's start under the words "a hook fired", which
   * read as thirteen minutes of silence while one had fired a minute earlier.
   */
  lastEventAt?: string;
  activeTurns: number;
  discrepancy?: string;
}

export type StartSessionResult =
  | { ok: true; sessionId: string; pid: number }
  | { ok: false; error: string; holder?: string };

export interface StopSessionResult {
  ok: boolean;
  stopped: boolean;
  error?: string;
}

export interface SessionManager {
  startSession(repoRoot: string, agentId: string, env?: NodeJS.ProcessEnv): Promise<StartSessionResult>;
  stopSession(repoRoot: string, sessionId: string): Promise<StopSessionResult>;
  listSessions(repoRoot: string): Promise<SessionView[]>;
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return !(hasErrorCode(err) && err.code === 'ESRCH');
  }
}

function defaultTerminate(pid: number): boolean {
  try {
    return process.kill(pid, 'SIGTERM');
  } catch (err: unknown) {
    return hasErrorCode(err) && err.code === 'ESRCH';
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean },
): SessionProcess {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    throw new Error('The spawned session process did not receive a pid.');
  }

  return {
    pid,
    kill: (signal) => child.kill(signal),
    unref: () => child.unref(),
  };
}

function makeSessionId(pid: number, startedAt: string, entropy: string): string {
  const startedMs = Date.parse(startedAt);
  return `${SESSION_ID_PREFIX}-${pid}-${startedMs}-${entropy}`;
}

function parseSessionId(sessionId: string): { pid: number; startedAt: string } | undefined {
  const parts = sessionId.split('-');
  if (parts.length < 4) return undefined;

  const [prefix, rawPid, rawStartedMs] = parts;
  if (prefix !== SESSION_ID_PREFIX || rawPid === undefined || rawStartedMs === undefined) {
    return undefined;
  }

  const pid = Number.parseInt(rawPid, 10);
  const startedMs = Number.parseInt(rawStartedMs, 10);
  if (!Number.isInteger(pid) || pid < 1 || !Number.isFinite(startedMs) || startedMs < 0) {
    return undefined;
  }

  return { pid, startedAt: new Date(startedMs).toISOString() };
}

function sessionCardId(sessionId: string): string {
  return `__session:${sessionId}`;
}

function sessionPromptPath(repoRoot: string, token: string): string {
  return join(repoRoot, CYV_DIR, SESSION_PROMPT_DIR, `${token}.md`);
}

function sessionPrompt(projectRoot: string, agentId: string, model: string): string {
  return [
    '# Orchestrator session',
    '',
    `Project: ${projectRoot}`,
    `Agent: ${agentId}`,
    `Model: ${model}`,
    '',
    'Continue running as an orchestrator session until stopped from the dashboard.',
  ].join('\n');
}

async function defaultModelForAgent(repoRoot: string, agentId: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(repoRoot);
    const lanes = configuredLanes(config);
    for (const lane of lanes) {
      if (lane.agentId !== agentId) continue;
      const firstOffering = lane.models[0];
      if (firstOffering === undefined) continue;
      const firstModel = firstOffering.ordering[0];
      if (firstModel !== undefined) return firstModel;
    }
  } catch (err: unknown) {
    if (!(err instanceof ConfigError) || err.code !== 'MISSING') throw err;
  }
  return undefined;
}

async function claimWorkingTree(repoRoot: string, sessionId: string): Promise<{
  claimed: boolean;
  holder?: string;
}> {
  const result = await claimCard(repoRoot, sessionCardId(sessionId), sessionId, repoRoot);
  return result.claimed ? { claimed: true } : { claimed: false, holder: result.holder };
}

async function releaseAllClaimsForSession(repoRoot: string, sessionId: string): Promise<void> {
  const state = await readState(repoRoot);
  const cardIds = Object.keys(state.cardAssignments).filter(
    (cardId) => state.cardAssignments[cardId]?.sessionId === sessionId,
  );

  for (const cardId of cardIds) {
    await releaseCard(repoRoot, cardId, sessionId);
  }
}

async function markStopped(repoRoot: string, sessionId: string, entry: SessionEntry): Promise<void> {
  if (entry.state === 'stopped') return;
  await registerSession(repoRoot, sessionId, { ...entry, state: 'stopped' });
}

interface DerivedSessionStatus {
  alive: boolean;
  state: SessionState | 'stale';
  statusSource: 'hook' | 'dispatch';
  activeTurns: number;
  reason: string;
  discrepancy?: string;
  /** When the most recent hook for this session fired. */
  lastEventAt?: string;
}

function lifecycleEventsForSession(events: LifecycleEvent[], sessionId: string): LifecycleEvent[] {
  return events.filter((event) => event.sessionId === sessionId);
}

/** Every session id the lifecycle log has seen, in first-seen order. */
function observedSessionIds(events: LifecycleEvent[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const event of events) {
    if (seen.has(event.sessionId)) continue;
    seen.add(event.sessionId);
    ids.push(event.sessionId);
  }
  return ids;
}

function earliestLifecycleEvent(events: LifecycleEvent[]): LifecycleEvent | undefined {
  let earliest: LifecycleEvent | undefined;
  for (const event of events) {
    if (earliest === undefined || event.at < earliest.at) {
      earliest = event;
    }
  }
  return earliest;
}

function latestLifecycleEvent(events: LifecycleEvent[]): LifecycleEvent | undefined {
  let latest: LifecycleEvent | undefined;
  for (const event of events) {
    if (latest === undefined || event.at > latest.at) {
      latest = event;
    }
  }
  return latest;
}

function activeTurnsFrom(events: LifecycleEvent[], after?: string): number {
  let started = 0;
  let stopped = 0;
  for (const event of events) {
    if (after !== undefined && event.at < after) continue;
    if (event.event === 'UserPromptSubmit') started += 1;
    if (event.event === 'Stop') stopped += 1;
  }
  return Math.max(0, started - stopped);
}

function deriveFromDispatch(
  liveness: { pid: number; judgement: Awaited<ReturnType<typeof judgeLiveness>> } | undefined,
  entry: SessionEntry,
): DerivedSessionStatus {
  if (liveness === undefined) {
    return {
      alive: false,
      state: entry.state,
      statusSource: 'dispatch',
      activeTurns: 0,
      reason: 'session id does not record a pid',
    };
  }

  if (liveness.judgement.liveness === 'live') {
    return {
      alive: true,
      state: 'running',
      statusSource: 'dispatch',
      activeTurns: 0,
      reason: liveness.judgement.reason,
    };
  }

  if (liveness.judgement.liveness === 'abandoned') {
    return {
      alive: false,
      state: 'stopped',
      statusSource: 'dispatch',
      activeTurns: 0,
      reason: liveness.judgement.reason,
    };
  }

  return {
    alive: false,
    state: entry.state,
    statusSource: 'dispatch',
    activeTurns: 0,
    reason: liveness.judgement.reason,
  };
}

function deriveFromHooks(
  sessionId: string,
  events: LifecycleEvent[],
  nowMs: number,
  staleAfterMs: number,
): DerivedSessionStatus | undefined {
  const sessionEvents = lifecycleEventsForSession(events, sessionId);
  if (sessionEvents.length === 0) return undefined;

  const starts = sessionEvents.filter((event) => event.event === 'SessionStart');
  const ends = sessionEvents.filter((event) => event.event === 'SessionEnd');

  const latestStart = latestLifecycleEvent(starts);
  const latestEnd = latestLifecycleEvent(ends);

  const startAt = latestStart?.at ?? '';
  const hasEndAfterStart =
    latestEnd !== undefined && (latestStart === undefined || latestEnd.at >= startAt);

  if (hasEndAfterStart) {
    return {
      alive: false,
      state: 'stopped',
      statusSource: 'hook',
      activeTurns: 0,
      reason: `SessionEnd at ${latestEnd.at} (source: hook)`,
    };
  }

  const lastEvent = latestLifecycleEvent(sessionEvents);
  if (lastEvent === undefined) return undefined;

  const lastAtMs = Date.parse(lastEvent.at);
  const age = nowMs - lastAtMs;
  const live = Number.isFinite(lastAtMs) && age <= staleAfterMs;

  if (live) {
    return {
      alive: true,
      state: 'running',
      statusSource: 'hook',
      activeTurns: activeTurnsFrom(sessionEvents, startAt),
      reason: `${lastEvent.event} at ${lastEvent.at} (source: hook)`,
      lastEventAt: lastEvent.at,
    };
  }

  return {
    alive: false,
    state: 'stale',
    statusSource: 'hook',
    activeTurns: activeTurnsFrom(sessionEvents, startAt),
    reason: `no lifecycle event since ${lastEvent.at} (source: hook)`,
  };
}

function isReportForSession(report: OrchestratorReported, startedAt: string): boolean {
  return report.reportedAt >= startedAt;
}

function describeDiscrepancy(
  derived: DerivedSessionStatus,
  startedAt: string,
  report: OrchestratorReported | undefined,
): string | undefined {
  if (report === undefined) return undefined;
  if (!isReportForSession(report, startedAt)) return undefined;
  if (report.state === 'healthy' && !derived.alive) {
    return `self-reported healthy at ${report.reportedAt}, but hook-derived status is ${derived.state}`;
  }
  if (report.state === 'exhausted' && derived.alive) {
    return `self-reported exhausted at ${report.reportedAt}, but hook-derived status is ${derived.state}`;
  }
  return undefined;
}

export function createSessionManager(options?: SessionManagerOptions): SessionManager {
  const env = options?.env ?? process.env;
  const spawnSession = options?.spawn ?? defaultSpawn;
  const findProgramFn = options?.findProgram ?? findProgram;
  const terminate = options?.terminate ?? defaultTerminate;
  const processExists = options?.processExists ?? defaultProcessExists;
  const processStartedAtFn = options?.processStartedAt ?? processStartedAtOnThisHost;
  const thisHost = options?.thisHost ?? hostname();
  const nowFn = options?.now ?? Date.now;
  const staleAfterMs = options?.staleAfterMs ?? LIFECYCLE_STALE_MS;

  async function livenessFor(
    sessionId: string,
    entry: SessionEntry,
  ): Promise<{ pid: number; judgement: Awaited<ReturnType<typeof judgeLiveness>> } | undefined> {
    const parsed = parseSessionId(sessionId);
    if (parsed === undefined) return undefined;

    const judgement = await judgeLiveness(
      {
        host: thisHost,
        pid: parsed.pid,
        processStartedAt: entry.lastResumedAt,
        openedAt: entry.lastResumedAt,
      },
      { thisHost, processExists, processStartedAt: processStartedAtFn },
    );

    return { pid: parsed.pid, judgement };
  }

  async function releaseIfDead(repoRoot: string, holderSessionId: string): Promise<boolean> {
    const state = await readState(repoRoot);
    const entry = state.sessions[holderSessionId];

    if (entry === undefined) {
      await releaseAllClaimsForSession(repoRoot, holderSessionId);
      return true;
    }

    const liveness = await livenessFor(holderSessionId, entry);
    if (liveness === undefined) {
      if (entry.state === 'stopped') {
        await releaseAllClaimsForSession(repoRoot, holderSessionId);
        return true;
      }
      return false;
    }

    if (liveness.judgement.liveness === 'abandoned' || entry.state === 'stopped') {
      await releaseAllClaimsForSession(repoRoot, holderSessionId);
      await markStopped(repoRoot, holderSessionId, entry);
      return true;
    }

    return false;
  }

  async function startSession(
    repoRoot: string,
    agentId: string,
    callEnv?: NodeJS.ProcessEnv,
  ): Promise<StartSessionResult> {
    const spec = agentCommandFor(agentId);
    if (spec === undefined) {
      return { ok: false, error: `Unknown agent "${agentId}".` };
    }

    const resolvedEnv = callEnv ?? env;
    const launcher = await findProgramFn(spec.program, resolvedEnv, repoRoot);
    if (launcher === undefined) {
      return {
        ok: false,
        error: `The program for agent "${agentId}" ("${spec.program}") is not on PATH.`,
      };
    }

    const model = (await defaultModelForAgent(repoRoot, agentId)) ?? 'default';
    const entropy = randomBytes(4).toString('hex');
    const prompt = sessionPrompt(repoRoot, agentId, model);
    const promptPath = sessionPromptPath(repoRoot, entropy);

    await mkdir(join(repoRoot, CYV_DIR, SESSION_PROMPT_DIR), { recursive: true });
    await writeFile(promptPath, prompt, 'utf-8');

    const launch = spec.build({ cwd: repoRoot, model, prompt, promptPath });
    const launchArgs = launchArguments(launcher, launch.args);

    const child = spawnSession(launcher.command, launchArgs.args, {
      cwd: repoRoot,
      env: resolvedEnv,
      windowsVerbatimArguments: launchArgs.windowsVerbatimArguments,
    });

    const pid = child.pid;
    if (pid === undefined) {
      child.kill();
      return { ok: false, error: 'The spawned session process did not report a pid.' };
    }

    const startedAt = (await processStartedAtFn(pid)) ?? new Date().toISOString();
    const sessionId = makeSessionId(pid, startedAt, entropy);

    let claim = await claimWorkingTree(repoRoot, sessionId);
    if (!claim.claimed) {
      const released = await releaseIfDead(repoRoot, claim.holder ?? '');
      if (released) {
        claim = await claimWorkingTree(repoRoot, sessionId);
      }
      if (!claim.claimed) {
        child.kill();
        const holder = claim.holder ?? 'unknown';
        return {
          ok: false,
          error: `The project root is already held by session "${holder}".`,
          ...(claim.holder === undefined ? {} : { holder: claim.holder }),
        };
      }
    }

    const entry: SessionEntry = {
      projectRoot: repoRoot,
      agentId,
      state: 'running',
      lastResumedAt: startedAt,
    };
    await registerSession(repoRoot, sessionId, entry);

    return { ok: true, sessionId, pid };
  }

  async function stopSession(repoRoot: string, sessionId: string): Promise<StopSessionResult> {
    const state = await readState(repoRoot);
    const entry = state.sessions[sessionId];

    if (entry !== undefined) {
      const liveness = await livenessFor(sessionId, entry);
      if (liveness !== undefined && entry.state !== 'stopped') {
        if (liveness.judgement.liveness === 'live') {
          terminate(liveness.pid);
        }
      }

      await releaseAllClaimsForSession(repoRoot, sessionId);
      await markStopped(repoRoot, sessionId, entry);
    } else {
      // The session is not one we started, so there is no pid to signal. It
      // may still be running; claiming otherwise would be a lie the dashboard
      // tells about a session it can only observe. Claims are still released,
      // because those are ours to release.
      await releaseAllClaimsForSession(repoRoot, sessionId);
      return {
        ok: false,
        stopped: false,
        error:
          'This session was not started from the dashboard, so there is no process handle to stop. Its claims have been released. End it where it is running.',
      };
    }

    return { ok: true, stopped: true };
  }

  async function listSessions(repoRoot: string): Promise<SessionView[]> {
    const state = await readState(repoRoot);
    const nowMs = nowFn();
    const views: SessionView[] = [];

    const [log, lifecycleEvents] = await Promise.all([
      readDispatchLog(repoRoot),
      readLifecycleEvents(repoRoot),
    ]);

    for (const sessionId of Object.keys(state.sessions)) {
      const entry = state.sessions[sessionId];
      if (entry === undefined) continue;

      const liveness = await livenessFor(sessionId, entry);
      let derived = deriveFromHooks(sessionId, lifecycleEvents, nowMs, staleAfterMs);
      if (derived === undefined) {
        derived = deriveFromDispatch(liveness, entry);
      }

      const discrepancy = describeDiscrepancy(derived, entry.lastResumedAt, log.orchestrator);
      if (discrepancy !== undefined) {
        derived.discrepancy = discrepancy;
      }

      if (derived.state === 'stopped' && entry.state !== 'stopped') {
        await releaseAllClaimsForSession(repoRoot, sessionId);
        await markStopped(repoRoot, sessionId, entry);
      }

      const startedAtMs = Date.parse(entry.lastResumedAt);
      const uptimeMs = Number.isFinite(startedAtMs) ? nowMs - startedAtMs : 0;

      views.push({
        sessionId,
        projectRoot: entry.projectRoot,
        agentId: entry.agentId,
        state: derived.state,
        pid: liveness?.pid ?? 0,
        startedAt: entry.lastResumedAt,
        uptimeMs,
        alive: derived.alive,
        reason: derived.reason,
        statusSource: derived.statusSource,
        activeTurns: derived.activeTurns,
        ...(derived.lastEventAt === undefined ? {} : { lastEventAt: derived.lastEventAt }),
        ...(derived.discrepancy === undefined ? {} : { discrepancy: derived.discrepancy }),
      });
    }

    // A session the dashboard did not spawn has no entry in `state.sessions`,
    // so the loop above cannot see it — and those are most of them: every
    // session started from a terminal, including the one reading this. Hooks
    // fire for those too, which is the whole reason status is derived from
    // hooks rather than from a self-report. Observe them here.
    //
    // They are observed, not managed: there is no pid to signal, so the board
    // must not offer to stop one. A session whose hooks say it ended is over
    // and is left out; this panel is about what is running.
    for (const sessionId of observedSessionIds(lifecycleEvents)) {
      if (state.sessions[sessionId] !== undefined) continue;

      const derived = deriveFromHooks(sessionId, lifecycleEvents, nowMs, staleAfterMs);
      if (derived === undefined || derived.state === 'stopped') continue;

      // A session nothing has heard from in hours is gone whether or not it
      // said so. Keeping it listed is the same mistake as rendering a six-day
      // old self-report as a current state.
      const lastHeard = lifecycleEventsForSession(lifecycleEvents, sessionId)
        .map((event) => Date.parse(event.at))
        .filter((parsed) => Number.isFinite(parsed))
        .sort((a, b) => b - a)
        .at(0);
      if (lastHeard !== undefined && nowMs - lastHeard > OBSERVED_FORGET_MS) continue;

      const sessionEvents = lifecycleEventsForSession(lifecycleEvents, sessionId);
      const firstStart = earliestLifecycleEvent(
        sessionEvents.filter((event) => event.event === 'SessionStart'),
      );
      const anchor = firstStart ?? sessionEvents[0];
      if (anchor === undefined) continue;

      const startedAtMs = Date.parse(anchor.at);

      views.push({
        sessionId,
        projectRoot: anchor.cwd ?? repoRoot,
        agentId: anchor.agentId ?? 'unknown',
        state: derived.state,
        pid: 0,
        startedAt: anchor.at,
        uptimeMs: Number.isFinite(startedAtMs) ? nowMs - startedAtMs : 0,
        alive: derived.alive,
        reason: derived.reason,
        statusSource: derived.statusSource,
        activeTurns: derived.activeTurns,
        ...(derived.lastEventAt === undefined ? {} : { lastEventAt: derived.lastEventAt }),
        observed: true,
      });
    }

    for (const [cardId, assignment] of Object.entries(state.cardAssignments)) {
      if (assignment === undefined) continue;
      if (state.sessions[assignment.sessionId] === undefined) {
        await releaseCard(repoRoot, cardId, assignment.sessionId);
      }
    }

    return views;
  }

  return { startSession, stopSession, listSessions };
}
