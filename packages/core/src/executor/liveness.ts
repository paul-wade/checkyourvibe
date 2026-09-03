/**
 * Whether an open dispatch is still being supervised (spec 0036 Requirement 5,
 * Decision 2).
 *
 * An `opened` entry carries the host, pid and start time of the cyv process
 * that opened it, written once at open time. Nothing here is maintained by the
 * live session: a heartbeat would fail exactly when the orchestrator fails,
 * which is the case this module exists for (Requirement 5.5).
 *
 * The judgement a later reader forms from those three fields has three values,
 * and the third is not a gap. A reader on another machine, or one that cannot
 * read a process's start time, has no basis to choose between live and
 * abandoned, and Requirement 5.4 requires it to say so rather than pick.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import { isUnknownArray } from '../guards.js';

const execFileAsync = promisify(execFile);

/**
 * Process identity written into an opened dispatch entry. A later reader can
 * use these fields to judge whether the dispatch is still supervised by the
 * cyv process that opened it.
 */
export interface DispatchLiveness {
  /** The machine that opened the dispatch. */
  host: string;
  /** The cyv process that opened the dispatch. */
  pid: number;
  /** When that cyv process began, as an ISO 8601 string. */
  processStartedAt: string;
}

/**
 * Return this process's start time as an ISO 8601 UTC string rounded to the
 * millisecond. process.uptime() is seconds since this process began, so the
 * start is the current wall clock minus that offset.
 */
export function thisProcessStartedAt(): string | undefined {
  const uptime = process.uptime();
  if (!Number.isFinite(uptime) || uptime < 0) return undefined;
  const now = Date.now();
  const startedMs = now - Math.round(uptime * 1000);
  if (!Number.isFinite(startedMs) || startedMs < 0) return undefined;
  return new Date(startedMs).toISOString();
}

/**
 * Return the identity of the cyv process that is opening a dispatch. Missing
 * values are left absent so a later reader treats them as unknown.
 */
export function thisProcessIdentity(): Partial<DispatchLiveness> {
  const identity: Partial<DispatchLiveness> = {};
  const host = hostname();
  const pid = process.pid;
  const processStartedAt = thisProcessStartedAt();
  if (typeof host === 'string' && host.length > 0) identity.host = host;
  if (Number.isInteger(pid) && pid > 0) identity.pid = pid;
  if (processStartedAt !== undefined) identity.processStartedAt = processStartedAt;
  return identity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

/**
 * Read the liveness fields a raw opened entry carries, returning only the
 * values that are present and of the expected type. Missing or malformed
 * fields are left absent so a later reader treats them as unknown.
 */
export function readDispatchLiveness(value: unknown): Partial<DispatchLiveness> {
  const liveness: Partial<DispatchLiveness> = {};
  if (!isRecord(value)) return liveness;
  const host = value.host;
  if (typeof host === 'string' && host.length > 0) liveness.host = host;
  const pid = value.pid;
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) liveness.pid = pid;
  const processStartedAt = value.processStartedAt;
  if (typeof processStartedAt === 'string' && processStartedAt.length > 0) {
    liveness.processStartedAt = processStartedAt;
  }
  return liveness;
}

/** The three states Requirement 5.2 distinguishes for an entry with no close. */
export type LivenessState = 'live' | 'abandoned' | 'undetermined';

export interface LivenessJudgement {
  liveness: LivenessState;
  /** One line stating the evidence the judgement rests on. */
  reason: string;
}

/** What an open record carries that bears on whether it is still supervised. */
export interface LivenessEvidence {
  host?: string;
  pid?: number;
  processStartedAt?: string;
  openedAt: string;
}

/**
 * How the judgement looks at the machine. Every part can be supplied, so the
 * rules can be tested against a pid that was reused without waiting for the
 * operating system to reuse one.
 */
export interface LivenessProbe {
  /** The name of the machine doing the judging. */
  thisHost?: string;
  /** Whether a process with this pid exists on this machine. */
  processExists?: (pid: number) => boolean;
  /** When the process with this pid began, or `undefined` when that cannot be read. */
  processStartedAt?: (pid: number) => Promise<string | undefined>;
}

/**
 * How far apart two readings of one process's start time may be and still be
 * the same process. The recorded value comes from `process.uptime()` and is
 * rounded to the millisecond; the operating system's reading is taken from
 * before the runtime began counting. A pid reused by an unrelated program
 * starts later than this by the whole lifetime of the dispatch.
 */
export const PROCESS_START_TOLERANCE_MS = 5_000;

/** How long to wait on the operating system for a process's start time. */
const START_TIME_PROBE_TIMEOUT_MS = 5_000;

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

/**
 * Signal 0 is the standard existence check: it delivers nothing and fails
 * only when there is no such process (`ESRCH`) or it belongs to someone else
 * (`EPERM`, which proves the process is there). Any other failure is not
 * evidence of absence, so it reads as present and the start-time comparison
 * decides.
 */
function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(hasErrorCode(err) && err.code === 'ESRCH');
  }
}

function toIsoOrUndefined(text: string): string | undefined {
  const parsed = Date.parse(text.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

async function windowsProcessStartedAt(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${String(pid)}).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { timeout: START_TIME_PROBE_TIMEOUT_MS, windowsHide: true },
    );
    return toIsoOrUndefined(stdout);
  } catch {
    return undefined;
  }
}

/**
 * The kernel's clock-tick rate as `/proc` reports process times. Fixed at 100
 * on every mainstream build and not exposed to a script without a native
 * call; a reader on a kernel built with another value gets a start time that
 * is wrong by a constant factor, which the tolerance above will not absorb,
 * and the judgement falls to undetermined by way of the pid-reused branch
 * rather than to a false live.
 */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

async function linuxProcessStartedAt(pid: number): Promise<string | undefined> {
  try {
    const [stat, systemStat] = await Promise.all([
      readFile(`/proc/${String(pid)}/stat`, 'utf-8'),
      readFile('/proc/stat', 'utf-8'),
    ]);
    // The second field is the command name in parentheses and may itself hold
    // spaces or parentheses, so the fields are counted from the last `)`.
    const afterName = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    // `starttime` is field 22 of the whole line; the split above starts at field 3.
    const startField = afterName[19];
    const btimeLine = systemStat.split('\n').find((line) => line.startsWith('btime '));
    if (startField === undefined || btimeLine === undefined) return undefined;
    const ticks = Number(startField);
    const bootSeconds = Number(btimeLine.slice('btime '.length).trim());
    if (!Number.isFinite(ticks) || !Number.isFinite(bootSeconds)) return undefined;
    const startedMs = bootSeconds * 1000 + (ticks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000;
    return new Date(Math.round(startedMs)).toISOString();
  } catch {
    return undefined;
  }
}

async function psProcessStartedAt(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: START_TIME_PROBE_TIMEOUT_MS,
    });
    return toIsoOrUndefined(stdout);
  } catch {
    return undefined;
  }
}

/** When the process with `pid` began on this machine, or `undefined` when that cannot be read. */
export function processStartedAtOnThisHost(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return windowsProcessStartedAt(pid);
  if (process.platform === 'linux') return linuxProcessStartedAt(pid);
  return psProcessStartedAt(pid);
}

function undetermined(reason: string): LivenessJudgement {
  return { liveness: 'undetermined', reason };
}

/**
 * Judge whether the process that opened a dispatch is still running.
 *
 * Live needs three things to agree: the same host, a process with that pid,
 * and a start time that matches what the entry recorded. Abandoned needs the
 * same host and positive evidence the process is gone or has been replaced.
 * Everything else is undetermined, and the reason says which piece of evidence
 * was missing.
 */
export async function judgeLiveness(
  entry: LivenessEvidence,
  options: LivenessProbe = {},
): Promise<LivenessJudgement> {
  if (entry.pid === undefined) return undetermined('entry carries no pid');
  if (entry.host === undefined) return undetermined('entry carries no host');

  const thisHost = options.thisHost ?? hostname();
  if (entry.host !== thisHost) {
    return undetermined(
      `opened on host "${entry.host}"; this is "${thisHost}", which cannot see that host's processes`,
    );
  }

  const exists = options.processExists ?? defaultProcessExists;
  if (!exists(entry.pid)) {
    return { liveness: 'abandoned', reason: `pid ${String(entry.pid)} on this host is not running` };
  }

  if (entry.processStartedAt === undefined) {
    return undetermined(
      `pid ${String(entry.pid)} on this host is running, but the entry does not record when its ` +
        'process started, so a reused pid cannot be told from the original',
    );
  }

  const readStart = options.processStartedAt ?? processStartedAtOnThisHost;
  const actualStartedAt = await readStart(entry.pid);
  if (actualStartedAt === undefined) {
    return undetermined(
      `pid ${String(entry.pid)} on this host is running, but its start time could not be read`,
    );
  }

  const recorded = Date.parse(entry.processStartedAt);
  const actual = Date.parse(actualStartedAt);
  if (!Number.isFinite(recorded) || !Number.isFinite(actual)) {
    return undetermined(
      `pid ${String(entry.pid)} on this host is running, but a start time could not be compared: ` +
        `entry recorded "${entry.processStartedAt}", the process reports "${actualStartedAt}"`,
    );
  }

  const difference = actual - recorded;
  if (Math.abs(difference) <= PROCESS_START_TOLERANCE_MS) {
    return {
      liveness: 'live',
      reason:
        `pid ${String(entry.pid)} on this host is running and started at ${actualStartedAt}, ` +
        'matching the entry',
    };
  }
  if (difference > 0) {
    return {
      liveness: 'abandoned',
      reason:
        `pid ${String(entry.pid)} on this host started at ${actualStartedAt}, after the entry's ` +
        `process started at ${entry.processStartedAt}; the pid has been reused by another program`,
    };
  }
  return undetermined(
    `pid ${String(entry.pid)} on this host started at ${actualStartedAt}, before the entry's ` +
      `process started at ${entry.processStartedAt}, which a reused pid cannot produce`,
  );
}
