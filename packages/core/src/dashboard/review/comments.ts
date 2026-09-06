/**
 * The comment store: the two-way channel between the page and the
 * orchestrating agent (spec 0034, carried into 0040 Requirement 5).
 *
 * Flat JSON on disk. Comments are additive by design, so a note posted while
 * an agent is rewriting the same file cannot clobber it. Records are read
 * leniently: a store written before `kind` or `refs` existed must load exactly
 * as it did (0040 Requirement 8.3), so a missing field takes its historical
 * default rather than rejecting the record.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isUnknownArray } from '../../guards.js';
import type { ExchangeEntry, ExchangeRegion } from '../view-model.js';

export const REVIEW_DIR = '.cyv-review';
const COMMENTS_FILE = 'comments.json';

/**
 * The author recorded for comments this tool writes itself.
 *
 * Two consumers act on authorship: the needs-you region lists open notes as
 * things waiting on a person, and the comment watcher notifies an agent of new
 * ones. Without a distinct author an agent's own reply appeared in both, so
 * replying to a note created a new note asking the user to look at the reply.
 */
export const AGENT_AUTHOR = 'checkyourvibe';

/** The author a note gets when the page does not name one. Deliberately not a person. */
const DEFAULT_AUTHOR = 'owner';

/** Bodies longer than this are cut: the page posts paragraphs, not documents. */
const BODY_LIMIT = 8000;

export type CommentKind = 'note' | 'turn';
export type CommentStatus = 'open' | 'addressed';

export interface CommentRefs {
  task?: string;
  file?: string;
  replyTo?: number;
  orchestrator?: boolean;
  deliveredAt?: number;
}

export interface Comment {
  id: number;
  kind: CommentKind;
  /** Repo-relative path, or '' for a general note. */
  file: string;
  /** Heading slug within the file, or ''. */
  anchor: string;
  body: string;
  author: string;
  status: CommentStatus;
  /** Epoch milliseconds. */
  created: number;
  refs?: CommentRefs;
}

/**
 * A note composed in the dashboard and held back from the exchange until its
 * batch is sent (spec 0051 Requirement 5.2).
 *
 * Drafts live beside `comments`, not inside it, on purpose: the comment
 * watcher and its cursor read `store.comments` only, so a draft can never
 * reach the agent — and can never be skipped by a cursor that advanced past
 * its id while it was still invisible. Promotion issues a fresh id at send
 * time, above any cursor.
 */
export interface CommentDraft {
  id: number;
  kind: CommentKind;
  file: string;
  anchor: string;
  body: string;
  author: string;
  status: 'draft';
  /** Epoch milliseconds. */
  created: number;
  refs?: CommentRefs;
}

export interface CommentStore {
  version: number;
  nextId: number;
  comments: Comment[];
  /** Unsent notes; absent in stores written before drafts existed. */
  drafts?: CommentDraft[];
}

export interface AddCommentInput {
  file?: string;
  anchor?: string;
  body?: string;
  author?: string;
  kind?: CommentKind;
  refs?: CommentRefs;
  replyTo?: number | null;
  orchestrator?: boolean;
}

function emptyStore(): CommentStore {
  return { version: 1, nextId: 1, comments: [] };
}

function storePath(repo: string): string {
  return path.join(repo, REVIEW_DIR, COMMENTS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseRefs(value: unknown, legacyReplyTo: unknown): CommentRefs | undefined {
  const source = isRecord(value) ? value : {};
  const task = asString(source.task);
  const file = asString(source.file);
  const orchestrator = asBoolean(source.orchestrator);
  const deliveredAt = asNumber(source.deliveredAt);
  // Stores written before `refs` existed carried `replyTo` at the top level,
  // usually as null. A number there is still a reply and is kept as one.
  const replyTo = asNumber(source.replyTo) ?? asNumber(legacyReplyTo);
  const refs: CommentRefs = {
    ...(task === undefined ? {} : { task }),
    ...(file === undefined ? {} : { file }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(orchestrator === undefined ? {} : { orchestrator }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
  };
  return Object.keys(refs).length > 0 ? refs : undefined;
}

/** Every field a comment and a draft share; the status is what sets them apart. */
interface ParsedFields {
  id: number;
  kind: CommentKind;
  file: string;
  anchor: string;
  body: string;
  author: string;
  created: number;
  refs?: CommentRefs;
}

function parseFields(value: unknown): ParsedFields | undefined {
  if (!isRecord(value)) return undefined;
  const id = asNumber(value.id);
  if (id === undefined) return undefined;
  const refs = parseRefs(value.refs, value.replyTo);
  return {
    id,
    kind: value.kind === 'turn' ? 'turn' : 'note',
    file: asString(value.file) ?? '',
    anchor: asString(value.anchor) ?? '',
    body: asString(value.body) ?? '',
    author: asString(value.author) ?? DEFAULT_AUTHOR,
    created: asNumber(value.created) ?? 0,
    ...(refs === undefined ? {} : { refs }),
  };
}

function parseComment(value: unknown): Comment | undefined {
  const fields = parseFields(value);
  if (fields === undefined || !isRecord(value)) return undefined;
  return {
    ...fields,
    status: value.status === 'addressed' ? 'addressed' : 'open',
  };
}

/** Anything in the drafts list is a draft; a stored status word is ignored. */
function parseDraft(value: unknown): CommentDraft | undefined {
  const fields = parseFields(value);
  if (fields === undefined) return undefined;
  return { ...fields, status: 'draft' };
}

function parseStore(value: unknown): CommentStore | undefined {
  if (!isRecord(value) || !isUnknownArray(value.comments)) return undefined;
  const comments: Comment[] = [];
  for (const entry of value.comments) {
    const comment = parseComment(entry);
    if (comment !== undefined) comments.push(comment);
  }
  const drafts: CommentDraft[] = [];
  if (isUnknownArray(value.drafts)) {
    for (const entry of value.drafts) {
      const draft = parseDraft(entry);
      if (draft !== undefined) drafts.push(draft);
    }
  }
  const issued = [...comments, ...drafts];
  const highest = issued.reduce((max, c) => Math.max(max, c.id), 0);
  // A store whose counter fell behind its own records would hand out a
  // duplicate id; the records are the truth about what has been issued.
  const nextId = Math.max(asNumber(value.nextId) ?? 1, highest + 1);
  return {
    version: asNumber(value.version) ?? 1,
    nextId,
    comments,
    ...(drafts.length === 0 ? {} : { drafts }),
  };
}

/** A missing or unreadable store is an empty one: the page must still render. */
export async function loadComments(repo: string): Promise<CommentStore> {
  let raw: string;
  try {
    raw = await readFile(storePath(repo), 'utf8');
  } catch {
    return emptyStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  return parseStore(parsed) ?? emptyStore();
}

export async function saveStore(repo: string, store: CommentStore): Promise<void> {
  await mkdir(path.join(repo, REVIEW_DIR), { recursive: true });
  await writeFile(storePath(repo), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function fieldsFromInput(input: AddCommentInput, id: number, now: number): ParsedFields {
  const refs: CommentRefs = { ...(input.refs ?? {}) };
  if (input.replyTo !== null && input.replyTo !== undefined && refs.replyTo === undefined) {
    refs.replyTo = input.replyTo;
  }
  if (input.orchestrator !== undefined && refs.orchestrator === undefined) {
    refs.orchestrator = input.orchestrator;
  }
  const author = input.author === undefined || input.author === '' ? DEFAULT_AUTHOR : input.author;
  return {
    id,
    kind: input.kind === 'turn' ? 'turn' : 'note',
    file: input.file ?? '',
    anchor: input.anchor ?? '',
    body: (input.body ?? '').slice(0, BODY_LIMIT),
    author,
    created: now,
    ...(Object.keys(refs).length > 0 ? { refs } : {}),
  };
}

export async function addComment(
  repo: string,
  input: AddCommentInput,
  now: number,
): Promise<Comment> {
  const store = await loadComments(repo);
  const comment: Comment = { ...fieldsFromInput(input, store.nextId, now), status: 'open' };
  store.nextId += 1;
  store.comments.push(comment);
  await saveStore(repo, store);
  return comment;
}

/** Compose a note without letting the watcher see it: the batch hides in `drafts`. */
export async function addDraft(
  repo: string,
  input: AddCommentInput,
  now: number,
): Promise<CommentDraft> {
  const store = await loadComments(repo);
  const draft: CommentDraft = { ...fieldsFromInput(input, store.nextId, now), status: 'draft' };
  store.nextId += 1;
  store.drafts = [...(store.drafts ?? []), draft];
  await saveStore(repo, store);
  return draft;
}

/** Rewrite an unsent note; the draft keeps its place in the batch. */
export async function editDraft(
  repo: string,
  id: number,
  body: string,
): Promise<CommentDraft | undefined> {
  const store = await loadComments(repo);
  const draft = (store.drafts ?? []).find((candidate) => candidate.id === id);
  if (draft === undefined) return undefined;
  draft.body = body.slice(0, BODY_LIMIT);
  await saveStore(repo, store);
  return draft;
}

/** Remove an unsent note; false when no draft holds the id. */
export async function discardDraft(repo: string, id: number): Promise<boolean> {
  const store = await loadComments(repo);
  const drafts = store.drafts ?? [];
  if (!drafts.some((candidate) => candidate.id === id)) return false;
  store.drafts = drafts.filter((candidate) => candidate.id !== id);
  await saveStore(repo, store);
  return true;
}

/**
 * Promote every draft to open at once: the moment a batch review reaches the
 * agent (spec 0051 Requirement 5.2). Each note is issued a fresh id at send
 * time — never its compose-time id — so a watcher cursor that advanced while
 * the drafts sat hidden cannot have passed them. `created` is the send, not
 * the compose: a note's wait on the agent starts when the agent can see it.
 * Returns the comments in the order they entered the exchange.
 */
export async function sendDrafts(repo: string, now: number): Promise<Comment[]> {
  const store = await loadComments(repo);
  const pending = [...(store.drafts ?? [])].sort((a, b) => a.created - b.created || a.id - b.id);
  if (pending.length === 0) return [];
  const sent: Comment[] = pending.map((draft) => {
    const comment: Comment = {
      id: store.nextId,
      kind: draft.kind,
      file: draft.file,
      anchor: draft.anchor,
      body: draft.body,
      author: draft.author,
      status: 'open',
      created: now,
      ...(draft.refs === undefined ? {} : { refs: draft.refs }),
    };
    store.nextId += 1;
    return comment;
  });
  store.comments.push(...sent);
  store.drafts = [];
  await saveStore(repo, store);
  return sent;
}

/** Anything other than `addressed` reopens the comment; unknown words are not a third state. */
export async function setCommentStatus(
  repo: string,
  id: number,
  status: string,
): Promise<Comment | undefined> {
  const store = await loadComments(repo);
  const comment = store.comments.find((c) => c.id === id);
  if (comment === undefined) return undefined;
  comment.status = status === 'addressed' ? 'addressed' : 'open';
  await saveStore(repo, store);
  return comment;
}

/** What the agent has read, and when "now" is, for the unread ages. */
export interface ReadState {
  /** The highest note id the agent's cursor has passed. */
  cursor: number;
  /** Epoch milliseconds. */
  now: number;
}

function toEntry(comment: Comment, read?: ReadState): ExchangeEntry {
  const task = comment.refs?.task;
  const replyTo = comment.refs?.replyTo;
  // The tool's own turns are not waiting to be read by the tool, so the
  // question does not arise for them.
  const tracked = read !== undefined && comment.author !== AGENT_AUTHOR;
  const readByAgent = tracked ? comment.id <= read.cursor : undefined;
  return {
    id: comment.id,
    author: comment.author,
    isAgent: comment.author === AGENT_AUTHOR,
    kind: comment.kind,
    body: comment.body,
    created: comment.created,
    status: comment.status,
    ...(comment.file === '' ? {} : { file: comment.file }),
    ...(comment.anchor === '' ? {} : { anchor: comment.anchor }),
    ...(task === undefined ? {} : { task }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(comment.refs?.orchestrator === undefined ? {} : { orchestrator: comment.refs.orchestrator }),
    ...(comment.refs?.deliveredAt === undefined ? {} : { deliveredAt: comment.refs.deliveredAt }),
    ...(readByAgent === undefined ? {} : { readByAgent }),
    ...(readByAgent === false && read !== undefined
      ? { unreadForMs: Math.max(0, read.now - comment.created) }
      : {}),
  };
}

/** Newest first, at most `shown`; the rest are counted so the page can say so. */
export function commentsToExchange(
  store: CommentStore,
  shown: number,
  read?: ReadState,
): ExchangeRegion {
  const ordered = [...store.comments].sort((a, b) => b.created - a.created || b.id - a.id);
  const limit = Math.max(0, shown);
  const entries = ordered.slice(0, limit).map((comment) => toEntry(comment, read));
  return { entries, total: ordered.length, omitted: ordered.length - entries.length };
}

/**
 * Owner notes the agent's cursor has not reached, and how long each has waited
 * (spec 0042 Requirement 3.1).
 */
export function unreadByAgent(
  store: CommentStore,
  read: ReadState,
): { comment: Comment; unreadForMs: number }[] {
  return store.comments
    .filter(
      (c) =>
        c.kind === 'note' &&
        c.status === 'open' &&
        c.author !== AGENT_AUTHOR &&
        c.id > read.cursor,
    )
    .map((comment) => ({ comment, unreadForMs: Math.max(0, read.now - comment.created) }))
    .sort((a, b) => b.unreadForMs - a.unreadForMs);
}
