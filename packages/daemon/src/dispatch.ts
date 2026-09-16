/**
 * Async wrapper: spawn `cyv dispatch` and return workId once opened is visible.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRecord, readString } from './parse.js';

export interface DispatchRequest {
  cwd: string;
  task: string;
  lane?: string;
  kind?: string;
  own?: string[];
  gate?: string[];
  expectsNoFileChanges?: boolean;
  timeoutSeconds?: number;
  workId?: string;
  cyvBin?: string;
}

export interface DispatchAccepted {
  workId: string;
  pid: number;
  cwd: string;
}

function coreCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'core', 'dist', 'cli', 'index.js');
}

function newWorkId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `work-${stamp}-${randomBytes(3).toString('hex')}`;
}

function findOpenedWorkId(cwd: string, workId: string): boolean {
  const logPath = join(cwd, '.cyv-review', 'dispatches.ndjson');
  if (!existsSync(logPath)) return false;
  const text = readFileSync(logPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `daemon: skip corrupt dispatch line while waiting for open: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    if (!isRecord(raw) || raw.event !== 'opened') continue;
    if (readString(raw, 'workId') === workId) return true;
  }
  return false;
}

/** Spawn cyv dispatch detached from the HTTP request; resolve when opened is on disk or after short wait. */
export async function startDispatch(req: DispatchRequest): Promise<DispatchAccepted> {
  const workId = req.workId ?? newWorkId();
  const dispatchArgs: string[] = [
    'dispatch',
    '--task',
    req.task,
    '--work-id',
    workId,
    '--json',
  ];
  if (req.lane !== undefined) {
    dispatchArgs.push('--lane', req.lane);
  }
  if (req.kind !== undefined) {
    dispatchArgs.push('--kind', req.kind);
  }
  if (req.expectsNoFileChanges === true) {
    dispatchArgs.push('--expects-no-file-changes');
  }
  if (req.timeoutSeconds !== undefined) {
    dispatchArgs.push('--timeout', String(req.timeoutSeconds));
  }
  for (const p of req.own ?? []) {
    dispatchArgs.push('--own', p);
  }
  for (const g of req.gate ?? []) {
    dispatchArgs.push('--gate', g);
  }

  // Prefer node + built CLI (avoids Windows .cmd ENOENT). Fall back to CYV_BIN / cyv.
  const cli = coreCliPath();
  let command: string;
  let args: string[];
  if (req.cyvBin !== undefined && req.cyvBin.length > 0) {
    command = req.cyvBin;
    args = dispatchArgs;
  } else if (process.env.CYV_BIN !== undefined && process.env.CYV_BIN.length > 0) {
    command = process.env.CYV_BIN;
    args = dispatchArgs;
  } else if (existsSync(cli)) {
    command = process.execPath;
    args = [cli, ...dispatchArgs];
  } else {
    command = 'cyv';
    args = dispatchArgs;
  }

  const child = spawn(command, args, {
    cwd: req.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', () => {
    /* discard; status comes from the ndjson store */
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`daemon dispatch[${workId}] stderr: ${chunk.toString('utf8')}`);
  });
  child.on('error', (err) => {
    process.stderr.write(
      `daemon dispatch[${workId}] spawn error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });

  const pid = child.pid ?? 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (findOpenedWorkId(req.cwd, workId)) {
      return { workId, pid, cwd: req.cwd };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { workId, pid, cwd: req.cwd };
}

export function readDispatchStatus(
  cwd: string,
  workId: string,
): { workId: string; state: 'unknown' | 'opened' | 'closed' | 'refused'; latest?: Record<string, unknown> } {
  const logPath = join(cwd, '.cyv-review', 'dispatches.ndjson');
  if (!existsSync(logPath)) return { workId, state: 'unknown' };
  const text = readFileSync(logPath, 'utf8');
  let state: 'unknown' | 'opened' | 'closed' | 'refused' = 'unknown';
  let latest: Record<string, unknown> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `daemon: skip corrupt dispatch line in status: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    if (!isRecord(raw)) continue;
    const rowWorkId = readString(raw, 'workId');
    const dispatchId = readString(raw, 'dispatchId');
    const matches =
      rowWorkId === workId ||
      dispatchId === workId ||
      (dispatchId !== undefined && dispatchId.startsWith(`${workId}-`));
    if (!matches) continue;
    const event = readString(raw, 'event');
    latest = raw;
    if (event === 'opened') state = 'opened';
    else if (event === 'closed') state = 'closed';
    else if (event === 'refused') state = 'refused';
  }
  if (latest !== undefined) return { workId, state, latest };
  return { workId, state };
}