/**
 * The diff review gate: surface what is about to be committed in a browser,
 * and do not commit until it has been looked at (spec 0040 Requirement 7.1).
 *
 * This wraps `difit`, which renders a git diff as a review page with per-line
 * comments. It runs via npx, so there is nothing to install.
 *
 * Deliberately NOT `--include-untracked`: that flag runs `git add -N` on every
 * untracked file so it renders, which pollutes the index with local-only
 * tooling and makes the change list misrepresent what is about to be
 * committed. To review one untracked file, `git add -N <path>` that file alone.
 */
import { execFile, spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

import { isUnknownArray } from '../../guards.js';
import type { DiffInstanceState } from '../view-model.js';

const execFileAsync = promisify(execFile);

/**
 * Fixed so the URL is predictable and the page can link to it. Not difit's own
 * default of 4173: that is also a common preview server's default, and the
 * diff tab once framed a landing page that happened to be served there.
 */
export const DIFIT_PORT = 4381;

/**
 * Bound to every interface. difit binds loopback by default, which leaves the
 * diff unreachable from any machine but this one.
 */
export const DIFIT_HOST = '0.0.0.0';

export interface DifitInstance {
  id: string;
  label: string;
  /** What difit is pointed at: one of its mode words or a ref. */
  target: string;
  port: number;
  description: string;
}

/**
 * The diffs worth having open at once, each on its own port so they can run
 * side by side and the dashboard can show one tab per diff.
 *
 * They answer different questions: `working` is the commit gate, `staged` is
 * what a commit would actually contain, and `branch` is the whole change a
 * reviewer would see. One difit cannot serve all three, because each is a
 * separate diff of a separate pair of revisions.
 */
export const DIFIT_INSTANCES: readonly DifitInstance[] = [
  {
    id: 'working',
    label: 'working',
    target: 'working',
    port: 4381,
    description: 'Uncommitted changes: working tree against staged.',
  },
  {
    id: 'staged',
    label: 'staged',
    target: 'staged',
    port: 4382,
    description: 'What a commit right now would contain: staged against HEAD.',
  },
  {
    id: 'branch',
    label: 'branch',
    target: 'HEAD',
    port: 4383,
    description: 'Working tree and staged together, against the last commit.',
  },
];

/**
 * Ports a difit started outside the dashboard is looked for on: its own
 * default and the next few it takes when that one is busy. A person whose
 * agent starts difit after every task, with no port named, lands here.
 */
export const DIFIT_DISCOVERY_PORTS: readonly number[] = [4173, 4174, 4175, 4176, 4177, 4178, 4179];

const EXTERNAL_ID = /^port-(\d{2,5})$/;

/** The id the page uses for a difit found on `port` rather than started here. */
export function externalInstanceId(port: number): string {
  return `port-${String(port)}`;
}

function externalInstance(port: number): DifitInstance {
  return {
    id: externalInstanceId(port),
    label: `port ${String(port)}`,
    target: '',
    port,
    description:
      `A difit started outside the dashboard, on port ${String(port)}. ` +
      'It shows whatever it was started against.',
  };
}

/** A configured instance by id, or a discovered one by its `port-N` id. */
export function instanceById(id: string): DifitInstance | undefined {
  const configured = DIFIT_INSTANCES.find((entry) => entry.id === id);
  if (configured !== undefined) return configured;
  const match = EXTERNAL_ID.exec(id);
  const port = match?.[1];
  if (port === undefined) return undefined;
  const parsed = Number.parseInt(port, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? externalInstance(parsed) : undefined;
}

async function answersAsDifit(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${String(port)}/`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.text();
    return /difit/i.test(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether difit itself is answering on the port.
 *
 * An HTTP fetch that looks for difit's own name in the page, not a TCP
 * connect: any process may hold the port, and a listener that is not difit
 * would be framed as the diff.
 *
 * Both loopback families are tried because difit binds `::1` only. Probing
 * `127.0.0.1` alone reported "not running" about a server that was up and
 * serving.
 */
export async function difitUp(port: number = DIFIT_PORT, timeoutMs = 1500): Promise<boolean> {
  const results = await Promise.all([
    answersAsDifit('127.0.0.1', port, timeoutMs),
    answersAsDifit('[::1]', port, timeoutMs),
  ]);
  return results.includes(true);
}

export function difitUrl(port: number = DIFIT_PORT): string {
  return `http://localhost:${String(port)}`;
}

/** Each instance with its live listening state, for rendering the tab bar. */
export async function difitInstanceStates(): Promise<DiffInstanceState[]> {
  const configured = Promise.all(
    DIFIT_INSTANCES.map(
      async (entry): Promise<DiffInstanceState> => ({
        id: entry.id,
        label: entry.label,
        port: entry.port,
        description: entry.description,
        up: await difitUp(entry.port),
      }),
    ),
  );
  // A difit someone else started is listed only while it answers; a port with
  // nothing on it is not an instance the page can offer to start.
  const discovered = Promise.all(
    DIFIT_DISCOVERY_PORTS.map(async (port): Promise<DiffInstanceState | undefined> => {
      if (!(await difitUp(port))) return undefined;
      const entry = externalInstance(port);
      return {
        id: entry.id,
        label: entry.label,
        port,
        description: entry.description,
        up: true,
        external: true,
      };
    }),
  );
  const [own, found] = await Promise.all([configured, discovered]);
  return [...own, ...found.filter((entry): entry is DiffInstanceState => entry !== undefined)];
}

/**
 * A git ref, a `a..b` range, or one of difit's own mode words. Constrained
 * because this value is interpolated into a shell command, and because a typo
 * should be refused here rather than becoming a confusing difit error.
 */
const SAFE_TARGET = /^[\w./@-]+(\.\.[\w./@-]+)?$/;

export interface StartDifitOptions {
  /** The repository to diff. */
  cwd: string;
  port?: number;
  target?: string;
}

export interface StartDifitResult {
  started: boolean;
  alreadyRunning: boolean;
  url: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start difit against the working tree and resolve once it answers.
 *
 * difit asks "include these untracked files?" on stdin before it starts
 * listening. That answer has to be supplied: with stdin ignored it waits for
 * input that never arrives and never binds the port, which presents as a
 * 30-second timeout with no explanation. `n` is the answer, for the same reason
 * `--include-untracked` is not used.
 */
export async function startDifit(options: StartDifitOptions): Promise<StartDifitResult> {
  const port = options.port ?? DIFIT_PORT;
  const target = options.target ?? 'working';
  if (!SAFE_TARGET.test(target)) {
    throw new Error(
      `Refusing to run difit against "${target}": expected a ref, a ref range, or a mode word.`,
    );
  }

  if (await difitUp(port)) {
    return { started: false, alreadyRunning: true, url: difitUrl(port) };
  }

  // Run through a shell as one command string, which is the invocation
  // WORKFLOW.md documents, because the alternatives fail here: npx is a `.cmd`
  // on Windows and recent Node refuses to spawn a batch file directly (EINVAL),
  // and writing the prompt's answer to a piped stdin does not reach the child
  // once it is detached. `echo n` answers it the way a person would.
  //
  // `--background` is difit's own detach, which is far more reliable than
  // detaching the shell ourselves. `--host 0.0.0.0` is what makes remote review
  // possible at all: by default difit binds loopback, so the diff is invisible
  // from the phone that the review UI is designed to be read on.
  //
  // Nothing untrusted reaches the shell: every argument is a literal except
  // `target`, which is checked against a fixed set above.
  const command =
    `echo n | npx difit ${target} --no-open --keep-alive --background ` +
    `--host ${DIFIT_HOST} --port ${String(port)}`;

  const child = spawn(command, {
    cwd: options.cwd,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    shell: true,
  });
  child.unref();

  // npx may need to fetch the package on a cold cache, so this waits longer
  // than a local start would need before calling it a failure.
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(500);
    if (await difitUp(port)) {
      return { started: true, alreadyRunning: false, url: difitUrl(port) };
    }
  }

  return { started: false, alreadyRunning: false, url: difitUrl(port) };
}

/** One remark left on the diff, with the place it anchors to. */
export interface DifitComment {
  file: string;
  line: number | null;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * difit answers `{"version":0,"threads":[...]}`. Each thread is one place in
 * the diff and carries its own `comments` array, so this flattens to the
 * individual remarks while keeping the file and line the thread anchors to.
 *
 * Checked against the real response, not guessed: an earlier version of this
 * read `parsed.comments`, a key difit never sends, so it returned an empty
 * review no matter how many comments had been left.
 */
export function parseDifitComments(parsed: unknown): DifitComment[] {
  let threads: unknown[];
  if (isUnknownArray(parsed)) {
    threads = parsed;
  } else if (isRecord(parsed) && isUnknownArray(parsed.threads)) {
    threads = parsed.threads;
  } else {
    return [];
  }

  const comments: DifitComment[] = [];
  for (const thread of threads) {
    if (!isRecord(thread)) continue;
    const file = firstString(thread, ['file', 'path']);
    const line = firstNumber(thread, ['line', 'lineNumber', 'endLine']);
    const remarks = isUnknownArray(thread.comments) ? thread.comments : [thread];
    for (const remark of remarks) {
      if (!isRecord(remark)) continue;
      const body = firstString(remark, ['body', 'text', 'comment']);
      if (body === '') continue;
      comments.push({ file, line, body });
    }
  }
  return comments;
}

/**
 * Review comments left on the diff, read back from the running difit server.
 *
 * This is the half that makes remote review a loop rather than a viewing
 * window: comments left on a phone are readable here, so they can be acted on
 * without anyone retyping them into another tool.
 *
 * Returns `[]` when difit is not running or answers with something unparseable
 * — an empty review is a normal state, and must not be reported as an error.
 */
export async function difitComments(cwd: string, port: number = DIFIT_PORT): Promise<DifitComment[]> {
  if (!(await difitUp(port))) return [];

  let stdout: string;
  try {
    const result = await execFileAsync(
      'npx',
      ['difit', 'comment', 'get', '--port', String(port), '--format', 'json'],
      { cwd, windowsHide: true, ...(process.platform === 'win32' ? { shell: true } : {}) },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  return parseDifitComments(parsed);
}

export interface DifitUrls {
  local: string;
  /** One per non-loopback IPv4 address, so a phone on the same network gets a usable URL. */
  lan: string[];
}

/** Every address the diff can be reached on. */
export function difitUrls(port: number = DIFIT_PORT): DifitUrls {
  const lan: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        lan.push(`http://${address.address}:${String(port)}`);
      }
    }
  }
  return { local: difitUrl(port), lan };
}
