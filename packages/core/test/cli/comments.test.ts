import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { command } from '../../src/cli/comments.js';
import { addComment, loadComments } from '../../src/dashboard/review/comments.js';
import { REGISTRY_DIR } from '../../src/dashboard/projects.js';

const run$ = promisify(execFile);

let repo: string;
let out: string[];
let err: string[];
const realLog = console.log;
const realError = console.error;
let stdoutText: string;
let stderrText: string;

/**
 * Capture a stream's writes and acknowledge them.
 *
 * `process.stdout.write` is overloaded — `(chunk, cb)` and
 * `(chunk, encoding, cb)` — so the callback may arrive in either position.
 * `vi.spyOn` keeps this typed; a hand-rolled stub needs an `as` cast to satisfy
 * the overload set, which is a claim the test cannot back.
 */
function captureStream(
  stream: NodeJS.WriteStream,
  onText: (text: string) => void,
  fail?: Error,
): void {
  vi.spyOn(stream, 'write').mockImplementation((chunk, encodingOrCb, maybeCb) => {
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    if (fail === undefined) {
      onText(String(chunk));
      done?.(null);
      return true;
    }
    done?.(fail);
    return false;
  });
}

/**
 * The cursor lives in the real home directory, so each test starts by clearing
 * this repository's entry rather than by isolating HOME — which `homedir()`
 * reads once and would not see changed.
 */
async function clearCursor(): Promise<void> {
  await rm(join(homedir(), REGISTRY_DIR, 'comments-cursor.json'), { force: true });
}

async function note(body: string, author = 'owner'): Promise<number> {
  const comment = await addComment(repo, { body, author }, Date.now());
  return comment.id;
}

async function runCmd(argv: string[]): Promise<number> {
  return command.run({ cwd: repo, argv, env: process.env });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cyv-comments-'));
  await run$('git', ['init', '--quiet'], { cwd: repo });
  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await clearCursor();

  out = [];
  err = [];
  stdoutText = '';
  stderrText = '';
  console.log = (...a: unknown[]): void => {
    out.push(a.join(' '));
  };
  console.error = (...a: unknown[]): void => {
    err.push(a.join(' '));
  };
  captureStream(process.stdout, (t) => {
    stdoutText += t;
  });
  captureStream(process.stderr, (t) => {
    stderrText += t;
  });
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  vi.restoreAllMocks();
  await clearCursor();
  await rm(repo, { recursive: true, force: true });
});

describe('cyv comments --hook (spec 0042 Requirements 1.3, 1.4)', () => {
  it('is silent and exits 0 when nothing is unread', async () => {
    expect(await runCmd(['--hook', 'claude-code'])).toBe(0);
    expect(stderrText).toBe('');
    expect(stdoutText).toBe('');
  });

  it('delivers to stderr and exits 2 for Claude Code, the route that reaches the model', async () => {
    await note('the lease table is wrong');

    expect(await runCmd(['--hook', 'claude-code'])).toBe(2);
    expect(stderrText).toContain('the lease table is wrong');
    expect(stdoutText).toBe('');
  });

  it('delivers to stdout and exits 0 for an agent whose contract has no blocking route', async () => {
    await note('a note for codex');

    expect(await runCmd(['--hook', 'codex'])).toBe(0);
    expect(stdoutText).toContain('a note for codex');
    expect(stderrText).toBe('');
  });

  it('advances the cursor, so a second run is silent', async () => {
    await note('read me once');

    expect(await runCmd(['--hook', 'claude-code'])).toBe(2);
    stderrText = '';
    expect(await runCmd(['--hook', 'claude-code'])).toBe(0);
    expect(stderrText).toBe('');
  });

  it('leaves the note unread when the delivery write fails', async () => {
    await note('never delivered');
    captureStream(process.stderr, () => undefined, new Error('EPIPE'));

    // Nothing was received, so the run must not claim the note was read.
    expect(await runCmd(['--hook', 'claude-code'])).toBe(0);

    captureStream(process.stderr, (t) => {
      stderrText += t;
    });
    expect(await runCmd(['--hook', 'claude-code'])).toBe(2);
    expect(stderrText).toContain('never delivered');
  });

  it('ignores the tool\'s own turns, so a reply does not notify the replier', async () => {
    await addComment(repo, { body: 'agent said this', author: 'checkyourvibe', kind: 'turn' }, Date.now());

    expect(await runCmd(['--hook', 'claude-code'])).toBe(0);
    expect(stderrText).toBe('');
  });

  it('refuses an agent it has no delivery contract for, and names the ones it has', async () => {
    expect(await runCmd(['--hook', 'nonesuch'])).toBe(2);
    expect(err.join('\n')).toContain('claude-code');
  });

  it('needs an agent id', async () => {
    expect(await runCmd(['--hook'])).toBe(2);
    expect(err.join('\n')).toContain('needs an agent id');
  });

  it('reads no analyzer and spawns nothing — the note text is all that is written', async () => {
    await note('cheap');
    await runCmd(['--hook', 'claude-code']);
    // A run that had analysed anything would name a rule or a file it checked.
    expect(stderrText).not.toMatch(/no-[a-z-]+|Checked \d+ file/);
  });
});

describe('cyv comments --watch (spec 0042 Requirement 4)', () => {
  it('rejects an interval that is not a positive number', async () => {
    expect(await runCmd(['--watch', '--interval', 'soon'])).toBe(2);
    expect(err.join('\n')).toContain('positive number');
    expect(await runCmd(['--watch', '--interval', '0'])).toBe(2);
  });

  it('prints notes and advances the cursor, then stops on a signal', async () => {
    await note('watched note');

    const finished = runCmd(['--watch', '--interval', '30']);
    // The first poll happens before the first sleep, so the note is out by the
    // time the signal lands.
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.emit('SIGINT');
    expect(await finished).toBe(0);

    expect(out.join('\n')).toContain('watched note');

    // Cursor advanced: a plain run afterwards has nothing new.
    out.length = 0;
    await runCmd([]);
    expect(out.join('\n')).not.toContain('watched note');
  });
});

describe('the notes the exchange holds', () => {
  it('records a reply and marks the note it answers addressed', async () => {
    const id = await note('please look at this');

    expect(await runCmd(['--record', 'looked', '--reply-to', String(id)])).toBe(0);

    const store = await loadComments(repo);
    expect(store.comments.find((c) => c.id === id)?.status).toBe('addressed');
  });
});

describe('a closing dispatch shows what arrived (spec 0042 Requirement 2)', () => {
  it('peekUnread reports the notes without moving the cursor', async () => {
    await note('arrived mid-dispatch');

    const { peekUnread } = await import('../../src/cli/comments.js');
    expect((await peekUnread(repo)).map((c) => c.body)).toEqual(['arrived mid-dispatch']);

    // Requirement 2.2: showing is not reading. A second peek still sees it, and
    // so does the hook that is supposed to deliver it.
    expect((await peekUnread(repo)).map((c) => c.body)).toEqual(['arrived mid-dispatch']);
    expect(await runCmd(['--hook', 'claude-code'])).toBe(2);
    expect(stderrText).toContain('arrived mid-dispatch');
  });

  it('summariseNote carries the id, the location and every line of the body', async () => {
    const { peekUnread, summariseNote } = await import('../../src/cli/comments.js');
    await addComment(repo, { body: 'line one\nline two', author: 'owner', file: 'src/a.ts' }, Date.now());

    const [first] = await peekUnread(repo);
    if (first === undefined) throw new Error('expected a note');
    const text = summariseNote(first).join('\n');

    expect(text).toContain(`#${first.id}`);
    expect(text).toContain('src/a.ts');
    expect(text).toContain('line one');
    expect(text).toContain('line two');
  });
});
