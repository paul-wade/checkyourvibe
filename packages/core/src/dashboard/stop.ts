/**
 * Stopping a running dispatch from the dashboard (spec 0040 Requirement 6,
 * Decision 3).
 *
 * Stopping ends the cyv process that is supervising the dispatch — and through
 * it the executor it spawned — and then appends the `closed` entry the process
 * will never write. The outcome is `did-not-complete` with a detail saying it
 * was stopped from the dashboard; no success or failure of the work is
 * recorded (spec 0011 Requirement 11.2).
 *
 * The kill requires the liveness judgement to be `live`: the entry names this
 * host, a process with that pid exists, and its start time matches. An
 * `abandoned` dispatch is closed without a kill. An `undetermined` one is
 * refused with the judgement's own reason (Requirement 6.2).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { judgeLiveness } from '../executor/liveness.js';
import { closeDispatch, readDispatchLog } from '../executor/store.js';
import type { DispatchRecord } from '../executor/dispatch.js';

const execFileAsync = promisify(execFile);

export type StopResult =
  | { stopped: true; dispatchId: string; closedAt: string }
  | { stopped: false; dispatchId: string; reason: string };

export interface StopOptions {
  /** Ends the process with this pid and whatever it spawned. */
  kill?: (pid: number) => Promise<void>;
  /** The liveness judgement to consult before killing. */
  judge?: typeof judgeLiveness;
  now?: () => Date;
}

/**
 * On Windows a signal does not reach a child's children; `taskkill /T` ends
 * the tree, which is what carries the stop through to the executor. Elsewhere
 * the supervising process receives the signal and its own handling forwards it.
 */
async function defaultKill(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  process.kill(pid, 'SIGTERM');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function closeAsStopped(
  repoRoot: string,
  record: DispatchRecord,
  closedAt: string,
  detail: string,
  summary: string,
): Promise<void> {
  await closeDispatch(repoRoot, {
    dispatchId: record.dispatchId,
    closedAt,
    report: { status: 'did-not-complete', rateLimited: false, detail },
    gateResults: [],
    outcome: {
      kind: 'did-not-complete',
      summary,
      changedPaths: [],
      outOfScopePaths: [],
      failedGates: [],
    },
  });
}

export async function stopDispatch(
  repoRoot: string,
  dispatchId: string,
  options: StopOptions = {},
): Promise<StopResult> {
  const log = await readDispatchLog(repoRoot);
  const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
  if (record === undefined) {
    return { stopped: false, dispatchId, reason: `no dispatch "${dispatchId}" is in the log` };
  }
  if (record.closed !== undefined) {
    return {
      stopped: false,
      dispatchId,
      reason: `dispatch "${dispatchId}" already closed at ${record.closed.closedAt} as ${record.closed.outcome.kind}`,
    };
  }

  const judge = options.judge ?? judgeLiveness;
  const judgement = await judge(record);
  const now = options.now ?? (() => new Date());

  if (judgement.liveness === 'undetermined') {
    return { stopped: false, dispatchId, reason: judgement.reason };
  }

  if (judgement.liveness === 'abandoned') {
    // The process is already gone, so there is nothing to kill; closing the
    // record is exactly what spec 0011 Requirement 11.2 asks for when a dispatch
    // neither completed nor reported.
    const closedAt = now().toISOString();
    await closeAsStopped(
      repoRoot,
      record,
      closedAt,
      'Stopped from the dashboard; the supervising process was already gone',
      `Closed from the dashboard; ${judgement.reason}.`,
    );
    return { stopped: true, dispatchId, closedAt };
  }

  const pid = record.pid;
  if (pid === undefined) {
    return {
      stopped: false,
      dispatchId,
      reason: `dispatch "${dispatchId}" was judged live but its entry carries no pid to end`,
    };
  }

  const kill = options.kill ?? defaultKill;
  try {
    await kill(pid);
  } catch (err) {
    return {
      stopped: false,
      dispatchId,
      reason: `could not end pid ${String(pid)}: ${messageOf(err)}. The record is still open; try again once the process has gone.`,
    };
  }

  const closedAt = now().toISOString();
  await closeAsStopped(
    repoRoot,
    record,
    closedAt,
    'Stopped from the dashboard.',
    'Stopped from the dashboard before the executor finished.',
  );
  return { stopped: true, dispatchId, closedAt };
}
