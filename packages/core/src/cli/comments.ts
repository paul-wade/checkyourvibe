import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { readRegistry } from '../dashboard/projects.js';
import { loadCursors, saveCursors, type Cursors } from '../dashboard/review/cursor.js';
import {
  AGENT_AUTHOR,
  addComment,
  loadComments,
  REVIEW_DIR,
  setCommentStatus,
  type Comment,
  type CommentRefs,
} from '../dashboard/review/comments.js';
import { isUnknownArray } from '../guards.js';
import { repoRoot } from '../run/discover.js';
import type { Command, CommandContext } from './types.js';

const DEFAULT_WATCH_SECONDS = 5;

const USAGE = `Usage: cyv comments [--peek | --reset] [--json]
       cyv comments --hook <agent>
       cyv comments --watch [--interval <seconds>]
       cyv comments --record <text> [--task <id>] [--file <path>] [--reply-to <n>]

New notes across every registered project, then exit. Silent when there is
nothing new, so any output is a signal.

  (no flags)          Print notes not yet seen and advance the cursor.
  --peek              Print them without advancing the cursor.
  --reset             Drop the cursor so everything counts as new again.
  --json              Print the new notes as JSON.
  --hook <agent>      Deliver this repository's unread notes into an agent
                      session, on the stream and exit code that agent treats as
                      context for the model. For an agent's own hook to run,
                      not for a person.
  --watch             Run until interrupted, printing each note as it appears.
  --interval <n>      Seconds between polls under --watch. Default ${DEFAULT_WATCH_SECONDS}.
  --record <text>     Append a turn to this repository's exchange, authored by
                      the tool, so the dashboard shows what the agent said.
                      A turn is not something waiting on a person.

The cursor is the watcher's memory, kept in your home directory; each
project's notes stay in its own ${REVIEW_DIR}/.`;

/**
 * How one agent's hook contract carries text to the model.
 *
 * This mirrors what each adapter's own `formatResult` does with a blocking
 * finding, and it is a table here rather than a call into the adapter for two
 * reasons. Requirement 1.4 caps this command's cost at reading two small files,
 * and loading an adapter module on every file edit is not that. And the
 * adapter's `formatResult` takes violations: handing it a note dressed as a
 * `Violation` to reuse the mapping would be inventing a finding, which is the
 * one thing this project will not do.
 *
 * The right long-term home is the plugin contract — a `formatNotes` beside
 * `formatResult` — which is 0042 T42002's territory, where the adapters are
 * already being edited.
 */
interface HookDelivery {
  stream: 'stdout' | 'stderr';
  exitCode: number;
}

const HOOK_DELIVERY = new Map<string, HookDelivery>([
  // Exit 2 with stderr is the one route that reaches the model as something it
  // must read before continuing; stdout at 0 is surfaced but not handed back.
  ['claude-code', { stream: 'stderr', exitCode: 2 }],
  ['codex', { stream: 'stdout', exitCode: 0 }],
  ['cursor', { stream: 'stdout', exitCode: 0 }],
  ['gemini', { stream: 'stdout', exitCode: 0 }],
  ['antigravity', { stream: 'stdout', exitCode: 0 }],
  ['devin', { stream: 'stdout', exitCode: 0 }],
]);

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined ? undefined : value;
}

function printComment(root: string, comment: Comment): void {
  const name = basename(root);
  const where = comment.file
    ? `${comment.file}${comment.anchor ? ` #${comment.anchor}` : ''}`
    : 'general';
  console.log(`  #${comment.id}  [${name} · ${where}]  ${comment.author}`);
  for (const line of comment.body.split('\n')) console.log(`      ${line}`);
  console.log('');
}

async function record(ctx: CommandContext, text: string): Promise<number> {
  const root = await repoRoot(ctx.cwd);
  const refs: CommentRefs = {};
  const task = valueAfter(ctx.argv, '--task');
  const file = valueAfter(ctx.argv, '--file');
  const replyTo = valueAfter(ctx.argv, '--reply-to');
  if (task !== undefined) refs.task = task;
  if (file !== undefined) refs.file = file;
  if (replyTo !== undefined && /^\d+$/.test(replyTo)) refs.replyTo = Number.parseInt(replyTo, 10);
  const comment = await addComment(
    root,
    { body: text, author: AGENT_AUTHOR, kind: 'turn', refs, ...(file === undefined ? {} : { file }) },
    Date.now(),
  );
  console.log(`Recorded turn #${comment.id} in ${basename(root)}.`);
  // Answering a note is what addresses it; leaving it open would keep it on
  // the owner's needs-you list after the owner has been answered.
  if (refs.replyTo !== undefined) {
    const addressed = await setCommentStatus(root, refs.replyTo, 'addressed');
    if (addressed !== undefined) console.log(`Marked #${String(refs.replyTo)} addressed.`);
  }
  return 0;
}


/**
 * How far the agent has read in this repository's notes (spec 0042
 * Requirement 3.1).
 *
 * The cursor is the only evidence the dashboard uses. A note the hook delivered
 * and the agent then ignored reads as read, because it was — inferring
 * attention from anything else would be inventing a fact about a session this
 * process cannot see (Requirement 3.3).
 */
/**
 * Unread open notes for one repository, without advancing anything (spec 0042
 * Requirement 2.2).
 *
 * Exported so `cyv dispatch` can show what arrived while a dispatch ran. It is
 * deliberately read-only: a note shown twice is cheaper than a note shown to a
 * process that was about to exit, so only the hook of Requirement 1 or an
 * explicit `cyv comments` moves the cursor.
 */
export async function peekUnread(root: string): Promise<Comment[]> {
  const cursors = await loadCursors(root);
  return unreadFor(root, cursors.projects.get(root) ?? 0);
}

/** One unread note, as `cyv dispatch` shows it after an outcome. */
export function summariseNote(note: Comment): string[] {
  const where = note.file
    ? `${note.file}${note.anchor ? ` #${note.anchor}` : ''}`
    : 'general';
  const lines = [`    #${note.id} (${where}) — ${note.author}`];
  for (const line of note.body.split('\n')) lines.push(`      ${line}`);
  return lines;
}

/** Unread open notes for one repository, oldest first. */
async function unreadFor(root: string, since: number): Promise<Comment[]> {
  const store = await loadComments(root);
  return store.comments
    .filter((c) => c.id > since && c.status === 'open' && c.author !== AGENT_AUTHOR)
    .sort((a, b) => a.id - b.id);
}

/** The highest comment id in a repository, or the cursor when it holds none. */
async function highestId(root: string, fallback: number): Promise<number> {
  const store = await loadComments(root);
  return store.comments.length === 0
    ? fallback
    : Math.max(fallback, ...store.comments.map((c) => c.id));
}

function renderForHook(root: string, notes: readonly Comment[]): string {
  const lines = [
    `${notes.length} unread note${notes.length === 1 ? '' : 's'} from the owner of ` +
      `${basename(root)}, left on the dashboard:`,
    '',
  ];
  for (const note of notes) {
    const where = note.file
      ? `${note.file}${note.anchor ? ` #${note.anchor}` : ''}`
      : 'general';
    lines.push(`#${note.id} (${where}) — ${note.author}`);
    for (const line of note.body.split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }
  lines.push(
    'Read these before continuing. `cyv comments --record "<text>" --reply-to <id>` answers one ' +
      'and marks it addressed.',
  );
  return lines.join('\n');
}

/**
 * Write to a stream and resolve only once it has actually been flushed.
 *
 * Requirement 1.3 turns on this: the cursor may advance only when the session
 * has received the note. `console.log` returns before the write reaches the
 * far end, so advancing on its return would mark a note read that a closing
 * pipe swallowed. This waits for the callback and reports failure instead.
 */
async function deliver(stream: NodeJS.WriteStream, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    stream.write(`${text}\n`, (err) => {
      resolve(err === null || err === undefined);
    });
  });
}

/**
 * `cyv comments --hook <agent>` — the notes hook (spec 0042 Requirements 1.3,
 * 1.4).
 *
 * Reads this repository only, from the working directory, because a hook fires
 * inside one project and the registry is about the dashboard. Silent and exit 0
 * when nothing is unread, so an agent that runs this after every edit pays
 * nothing for the common case.
 */
async function runHook(ctx: CommandContext, agentId: string): Promise<number> {
  const delivery = HOOK_DELIVERY.get(agentId);
  if (delivery === undefined) {
    const known = [...HOOK_DELIVERY.keys()].join(', ');
    console.error(`--hook does not know agent "${agentId}". Known agents: ${known}.`);
    return 2;
  }

  const root = await repoRoot(ctx.cwd).catch(() => ctx.cwd);
  const cursors = await loadCursors(root);
  const since = cursors.projects.get(root) ?? 0;
  const notes = await unreadFor(root, since);
  if (notes.length === 0) return 0;

  const stream = delivery.stream === 'stderr' ? process.stderr : process.stdout;
  const written = await deliver(stream, renderForHook(root, notes));
  if (!written) {
    // The note stays unread, so the next hook run delivers it again.
    return 0;
  }

  const advanced: Cursors = { projects: new Map(cursors.projects) };
  advanced.projects.set(root, await highestId(root, since));
  await saveCursors(advanced);
  return delivery.exitCode;
}

/**
 * `cyv comments --watch` — one line per note as it appears (spec 0042
 * Requirement 4).
 *
 * Runs until interrupted. The cursor advances after each note is printed, so a
 * supervisor consuming this stream sees every note exactly once and does not
 * have to keep its own memory of what it has seen.
 */
async function runWatch(ctx: CommandContext, intervalMs: number): Promise<number> {
  const root = await repoRoot(ctx.cwd).catch(() => ctx.cwd);
  let stopped = false;
  // A signal arriving mid-sleep wakes the loop instead of being noticed one
  // interval later, so Ctrl-C is not held for the poll interval.
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(
    `Watching ${basename(root)} for new notes every ${String(intervalMs / 1000)}s. Ctrl-C to stop.`,
  );

  while (!stopped) {
    const cursors = await loadCursors(root);
    const since = cursors.projects.get(root) ?? 0;
    for (const note of await unreadFor(root, since)) {
      printComment(root, note);
    }
    const advanced: Cursors = { projects: new Map(cursors.projects) };
    advanced.projects.set(root, await highestId(root, since));
    await saveCursors(advanced);

    if (stopped) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
  }
  return 0;
}

/**
 * `cyv comments` — what the dashboard's owner wrote that the agent has not
 * seen, and the agent's way of writing back (spec 0040 Requirements 5, 8.2).
 */
async function run(ctx: CommandContext): Promise<number> {
  const { argv } = ctx;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const hookAgent = valueAfter(argv, '--hook');
  if (argv.includes('--hook')) {
    if (hookAgent === undefined) {
      console.error('--hook needs an agent id.\n\n' + USAGE);
      return 2;
    }
    return runHook(ctx, hookAgent);
  }

  if (argv.includes('--watch')) {
    const raw = valueAfter(argv, '--interval');
    const seconds = raw === undefined ? DEFAULT_WATCH_SECONDS : Number.parseFloat(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error(`--interval takes a positive number of seconds, got "${raw ?? ''}".`);
      return 2;
    }
    return runWatch(ctx, Math.round(seconds * 1000));
  }

  const text = valueAfter(argv, '--record');
  if (argv.includes('--record')) {
    if (text === undefined || text.trim().length === 0) {
      console.error('--record needs the text of the turn.\n\n' + USAGE);
      return 2;
    }
    return record(ctx, text);
  }

  const peek = argv.includes('--peek');
  const reset = argv.includes('--reset');
  const asJson = argv.includes('--json');

  const here = await repoRoot(ctx.cwd).catch(() => ctx.cwd);
  const registered = await readRegistry();
  const roots = registered.length > 0 ? registered : [here];

  const cursors = reset ? { projects: new Map<string, number>() } : await loadCursors(here);
  const advanced: Cursors = { projects: new Map(cursors.projects) };
  const fresh: { root: string; comment: Comment }[] = [];

  for (const root of roots) {
    const store = await loadComments(root);
    const since = cursors.projects.get(root) ?? 0;
    const comments = store.comments
      .filter((c) => c.id > since && c.status === 'open' && c.author !== AGENT_AUTHOR)
      .sort((a, b) => a.id - b.id);
    for (const comment of comments) fresh.push({ root, comment });
    // Each project advances on its own notes, so a quiet one keeps its place.
    if (store.comments.length > 0) {
      advanced.projects.set(root, Math.max(since, ...store.comments.map((c) => c.id)));
    }
  }

  if (asJson) {
    console.log(JSON.stringify(fresh.map(({ root, comment }) => ({ project: root, ...comment })), null, 2));
  } else {
    let lastRoot = '';
    for (const { root, comment } of fresh) {
      if (root !== lastRoot) {
        const count = fresh.filter((entry) => entry.root === root).length;
        console.log(`${count} new note${count === 1 ? '' : 's'} in ${basename(root)}:\n`);
        lastRoot = root;
      }
      printComment(root, comment);
    }
  }

  if (!peek) await saveCursors(advanced);
  return 0;
}

export const command: Command = { run };
