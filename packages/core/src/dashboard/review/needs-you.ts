/**
 * The needs-you items that come from the repository itself (0040
 * Requirement 2.1): tasks whose `_Exec:` names `executor=user`, roadmap
 * entries marked blocked, and open notes the owner wrote. The dispatch,
 * liveness and stall items come from the record folder and are added by the
 * model builder, not here.
 *
 * Every source is something already written down, so nothing has to be
 * maintained by hand and an empty list means the sources are empty.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NeedsYouItem } from '../view-model.js';
import {
  AGENT_AUTHOR,
  unreadByAgent,
  type CommentStore,
  type ReadState,
} from './comments.js';
import { parseAllSpecs, specDisplayName } from './specs.js';

/** Builds a page link; the caller supplies it so the project query is applied once. */
export type HrefBuilder = (pathname: string, query?: Record<string, string>) => string;

const BLOCKED_ENTRY = /\*\*(\d{4}) — ([^*]+?)\.\*\*\s*\*\(Blocked:\s*([^)]+)\)\*/g;
const EXEC_LINE = /^\s*_Exec:\s*.*_\s*$/;
const TASK_LINE = /^-\s*\[( |x|X)\]\s*\*\*(T\d+)\*\*\s*(.*)$/;
const HEADING_LINE = /^##\s+(.+?)\s*$/;

/** Body text shown for a note before the page truncates it. */
const NOTE_TITLE_LIMIT = 90;

async function tasksLines(repo: string, relPath: string): Promise<readonly string[]> {
  const text = await readFile(path.join(repo, relPath), 'utf8');
  return text.split(/\r?\n/);
}

/** The non-empty, trimmed description lines between a task and its `_Exec:` or the next task. */
function taskDetail(lines: readonly string[], taskLine: number): readonly string[] {
  const detail: string[] = [];
  for (let i = taskLine; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) break;
    if (EXEC_LINE.test(raw)) break;
    if (TASK_LINE.test(raw)) break;
    if (HEADING_LINE.test(raw)) break;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    detail.push(trimmed);
    if (detail.length === 6) break;
  }
  return detail;
}

async function userTasks(repo: string, hrefFor: HrefBuilder): Promise<NeedsYouItem[]> {
  const items: NeedsYouItem[] = [];
  const rollup = await parseAllSpecs(repo);
  for (const spec of rollup.specs) {
    if (spec.tasksPath === null) continue;
    const href = hrefFor('/view', { f: spec.tasksPath });
    let lines: readonly string[] | undefined;
    for (const section of spec.sections) {
      for (const task of section.tasks) {
        if (task.done || task.executor !== 'user') continue;
        if (lines === undefined) {
          lines = await tasksLines(repo, spec.tasksPath);
        }
        const title = task.title;
        items.push({
          kind: 'task',
          id: task.id,
          title,
          question: `This task is yours to decide: ${title}. Decide, then tell the agent or check the task off in tasks.md.`,
          detail: taskDetail(lines, task.line),
          where: specDisplayName(spec.id),
          href,
          actions: [
            { kind: 'open', label: 'open the task', href },
            { kind: 'tell', label: 'tell the agent', prefill: `Re ${task.id}: `, task: task.id },
                      { kind: 'dismiss', label: 'needs nothing', itemId: task.id },
          ],
        });
      }
    }
  }
  return items;
}

/**
 * Roadmap entries someone marked blocked, read from the roadmap rather than
 * tracked separately so there is one place to write it down. No roadmap is
 * not a problem to report: the specs are the primary source and this is a
 * second look at the same question.
 */
async function blockedEntries(repo: string, hrefFor: HrefBuilder): Promise<NeedsYouItem[]> {
  let roadmap: string;
  try {
    roadmap = await readFile(path.join(repo, 'docs', 'ROADMAP.md'), 'utf8');
  } catch {
    return [];
  }
  const href = hrefFor('/view', { f: 'docs/ROADMAP.md' });
  const items: NeedsYouItem[] = [];
  for (const match of roadmap.matchAll(BLOCKED_ENTRY)) {
    const id = match[1] ?? '';
    const rawTitle = match[2];
    const title = rawTitle === undefined ? '' : rawTitle.trim();
    const rawReason = match[3] ?? '';
    const reasonSentence = rawReason.split('.')[0];
    const reason = reasonSentence === undefined ? '' : reasonSentence.trim();
    const where = reason === '' ? 'blocked' : reason;
    items.push({
      kind: 'blocked',
      id,
      title,
      question: `${title} is blocked: ${where}. Unblock it, or leave it parked?`,
      detail: [],
      where,
      href,
      actions: [
        { kind: 'open', label: 'open the entry', href },
        { kind: 'tell', label: 'tell the agent', prefill: `Re ${id}: ` },
              { kind: 'dismiss', label: 'needs nothing', itemId: match[1] ?? '' },
      ],
    });
  }
  return items;
}

/** Only open, owner-authored notes wait on a person; recorded turns and the agent's replies do not. */
function openNotes(comments: CommentStore, hrefFor: HrefBuilder): NeedsYouItem[] {
  const href = `${hrefFor('/', {})}#exchange`;
  return comments.comments
    .filter((c) => c.status === 'open' && c.author !== AGENT_AUTHOR && c.kind === 'note')
    .map((c) => {
      const title = c.body.replace(/\s+/g, ' ').slice(0, NOTE_TITLE_LIMIT);
      return {
        kind: 'note',
        id: `#${c.id}`,
        title,
        question: 'You wrote this and nothing has answered it yet. Still waiting, or is it done?',
        detail: [],
        where: 'your note, unaddressed',
        href,
        at: new Date(c.created).toISOString(),
        actions: [
          { kind: 'addressed', label: 'mark addressed', commentId: c.id },
          { kind: 'tell', label: 'tell the agent', prefill: `Following up on #${c.id}: ` },
        ],
      };
    });
}

/**
 * Minutes, as a phrase a person reads rather than a number they convert.
 */
function forHowLong(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Notes the agent has not read for longer than the stall interval (spec 0042
 * Requirement 3.2).
 *
 * Worded as a description of a state, not an accusation. The tool cannot see
 * whether a session is alive, busy, or has the note in front of it right now —
 * only that the cursor has not moved past it. "Has not read" is what the
 * evidence supports; "is ignoring" is not.
 */
function unreadNotes(
  comments: CommentStore,
  read: ReadState,
  thresholdMs: number,
  hrefFor: HrefBuilder,
): NeedsYouItem[] {
  const href = `${hrefFor('/', {})}#exchange`;
  return unreadByAgent(comments, read)
    .filter((entry) => entry.unreadForMs >= thresholdMs)
    .map(({ comment, unreadForMs }) => ({
      kind: 'unread-note' as const,
      id: `unread-#${comment.id}`,
      title: comment.body.replace(/\s+/g, ' ').slice(0, NOTE_TITLE_LIMIT),
      question:
        `The agent has not read this. It has been waiting ${forHowLong(unreadForMs)}. ` +
        'Is a session running?',
      detail: [
        'Read is the cursor and nothing else — a note delivered and not acted on counts as read.',
        'A session with the notes hook installed picks this up on its next edit.',
      ],
      where: 'your note, unread',
      href,
      at: new Date(comment.created).toISOString(),
      actions: [
        { kind: 'addressed', label: 'mark addressed', commentId: comment.id },
      ],
    }));
}

export async function repoNeedsYou(
  repo: string,
  comments: CommentStore,
  hrefFor: HrefBuilder,
  unread?: { read: ReadState; thresholdMs: number },
): Promise<NeedsYouItem[]> {
  const [tasks, blocked] = await Promise.all([
    userTasks(repo, hrefFor),
    blockedEntries(repo, hrefFor),
  ]);
  const stale =
    unread === undefined
      ? []
      : unreadNotes(comments, unread.read, unread.thresholdMs, hrefFor);
  return [...tasks, ...blocked, ...openNotes(comments, hrefFor), ...stale];
}
