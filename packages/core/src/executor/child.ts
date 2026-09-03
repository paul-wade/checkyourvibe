/**
 * Running an executor as a child process and recording what it said about
 * itself (spec 0011 Requirements 2.1 and 2.6).
 *
 * `ChildObservation` is everything this layer learns from the process: its exit
 * code, the signal that ended it, whether it started at all, and its two output
 * streams. `reportFromObservation` turns that into the `ExecutorReport` a
 * dispatch record carries.
 *
 * The report's `status` is the executor's own account of its run. Nothing here
 * decides whether the dispatch succeeded: that comes from `classifyOutcome`,
 * which reads the changed-file set observed on disk. Requirement 2.1 rules out
 * the exit code as evidence, and `outcome.ts` documents the two narrow uses the
 * status is put to.
 *
 * `rateLimited` is likewise not read out of the streams here. A vendor's
 * rate-limit wording belongs to that vendor's plugin, so a caller supplies a
 * detector or the field stays false.
 */
import { spawn } from 'node:child_process';

import type { ExecutorOutput, ExecutorReport } from './outcome.js';

export interface ChildCommand {
  command: string;
  args?: readonly string[];
  /** Defaults to the repository root the dispatch runs against. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Written to the child's standard input, which is then closed. Absent leaves
   * standard input closed from the start.
   *
   * An executor CLI that takes its prompt here rather than as an argument is
   * the reason this exists: on Windows a CLI installed as a batch shim is
   * launched through the command interpreter, and an argument carrying the
   * prompt would be re-parsed by it. Standard input is not.
   */
  stdin?: string;
  /** Milliseconds after which the child is killed and the run recorded as incomplete. */
  timeoutMs?: number;
  /**
   * Pass `args` to the process untouched. Set by `launchArguments` when the
   * arguments are one command line the interpreter has to receive as written.
   */
  windowsVerbatimArguments?: boolean;
}

/** What running the child produced, before any judgement is made about it. */
export interface ChildObservation {
  /** Absent when the child never started or was ended by a signal. */
  exitCode?: number;
  /** The signal that ended the child, where one did. */
  signal?: string;
  /** Present when the process could not be started at all. */
  spawnError?: string;
  /** True when the child was killed because its timeout elapsed. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Whether the executor surfaced an explicit rate-limit error (Requirement 3.3).
 * Supplied by the caller that knows the executor's wording.
 */
export type RateLimitDetector = (observation: ChildObservation) => boolean;

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
}

/**
 * Spawn `command` and resolve once it has ended, however it ended. A process
 * that cannot be started resolves with `spawnError` rather than rejecting, so
 * the dispatch that asked for it still closes with a record.
 */
export function runChild(command: ChildCommand): Promise<ChildObservation> {
  return new Promise<ChildObservation>((settle) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn(command.command, [...(command.args ?? [])], {
      cwd: command.cwd,
      env: command.env,
      stdio: [command.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(command.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });

    const finish = (partial: Omit<ChildObservation, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      settle({
        ...partial,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    };

    if (command.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, command.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(toBuffer(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(toBuffer(chunk));
    });

    const input = child.stdin;
    if (command.stdin !== undefined && input !== null) {
      // A child that exits without reading makes this write fail with EPIPE.
      // That is the child ending, which the `close` handler already records, so
      // the failed write is absorbed here rather than raised as its own error.
      input.on('error', () => {
        input.destroy();
      });
      input.end(command.stdin);
    }

    child.on('error', (err: Error) => {
      finish({ spawnError: err.message });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      });
    });
  });
}

interface ReportedStatus {
  status: ExecutorReport['status'];
  detail: string;
}

function statusOf(observation: ChildObservation): ReportedStatus {
  if (observation.spawnError !== undefined) {
    return {
      status: 'did-not-complete',
      detail: `the executor could not be started: ${observation.spawnError}`,
    };
  }
  if (observation.timedOut) {
    return {
      status: 'did-not-complete',
      detail: 'the executor was killed after its timeout elapsed',
    };
  }
  if (observation.exitCode === undefined) {
    const signal = observation.signal ?? 'a signal that was not recorded';
    return { status: 'did-not-complete', detail: `the executor was ended by ${signal}` };
  }
  return {
    status: observation.exitCode === 0 ? 'success' : 'failure',
    detail: `the executor exited with code ${observation.exitCode}`,
  };
}

/**
 * Record what the executor said about its own run. The exit code is carried in
 * the report and read by `classifyOutcome` only to separate a reported success
 * that changed nothing from a reported failure that changed nothing.
 */
/**
 * The most of one stream kept in the record. Large enough for a stack trace or
 * a refusal with its reasoning, small enough that a chatty executor cannot make
 * the log unreadable or unbounded.
 */
export const CAPTURED_STREAM_MAX_LENGTH = 8000;

/** The tail of a stream, because a failure explains itself at the end. */
function captureStream(text: string): { kept: string; truncatedFrom?: number } {
  if (text.length <= CAPTURED_STREAM_MAX_LENGTH) return { kept: text };
  return {
    kept: text.slice(text.length - CAPTURED_STREAM_MAX_LENGTH),
    truncatedFrom: text.length,
  };
}

/** The executor's streams, or undefined when it wrote to neither. */
export function capturedOutput(observation: ChildObservation): ExecutorOutput | undefined {
  const stdout = captureStream(observation.stdout.trim());
  const stderr = captureStream(observation.stderr.trim());
  if (stdout.kept.length === 0 && stderr.kept.length === 0) return undefined;

  const truncatedFrom = {
    ...(stdout.truncatedFrom === undefined ? {} : { stdout: stdout.truncatedFrom }),
    ...(stderr.truncatedFrom === undefined ? {} : { stderr: stderr.truncatedFrom }),
  };
  return {
    ...(stdout.kept.length === 0 ? {} : { stdout: stdout.kept }),
    ...(stderr.kept.length === 0 ? {} : { stderr: stderr.kept }),
    ...(Object.keys(truncatedFrom).length === 0 ? {} : { truncatedFrom }),
  };
}

export function reportFromObservation(
  observation: ChildObservation,
  detectRateLimit?: RateLimitDetector,
): ExecutorReport {
  const reported = statusOf(observation);
  const output = capturedOutput(observation);
  return {
    status: reported.status,
    detail: reported.detail,
    rateLimited: detectRateLimit === undefined ? false : detectRateLimit(observation),
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    ...(output === undefined ? {} : { output }),
  };
}
