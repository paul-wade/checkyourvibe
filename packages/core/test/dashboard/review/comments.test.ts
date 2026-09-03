import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_AUTHOR,
  REVIEW_DIR,
  addComment,
  commentsToExchange,
  loadComments,
  setCommentStatus,
} from '../../../src/dashboard/review/comments.js';

describe('comment store', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-comments-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function writeStore(content: string): Promise<void> {
    await mkdir(join(repo, REVIEW_DIR), { recursive: true });
    await writeFile(join(repo, REVIEW_DIR, 'comments.json'), content, 'utf8');
  }

  it('reads an empty store when the file is missing', async () => {
    expect(await loadComments(repo)).toEqual({ version: 1, nextId: 1, comments: [] });
  });

  it('reads an empty store when the file is not JSON or not a store', async () => {
    await writeStore('{ not json');
    expect(await loadComments(repo)).toEqual({ version: 1, nextId: 1, comments: [] });
    await writeStore('[]');
    expect(await loadComments(repo)).toEqual({ version: 1, nextId: 1, comments: [] });
  });

  it('loads a legacy record without kind as a note and keeps its fields', async () => {
    // The shape the first stores were written in: no kind, no refs, a
    // top-level replyTo of null.
    await writeStore(
      JSON.stringify({
        version: 1,
        nextId: 3,
        comments: [
          {
            id: 1,
            file: '',
            anchor: '',
            body: 'first',
            author: 'someone',
            replyTo: null,
            status: 'addressed',
            created: 1000,
          },
          {
            id: 2,
            file: 'docs/a.md',
            anchor: 'intro',
            body: 'second',
            author: AGENT_AUTHOR,
            replyTo: 1,
            status: 'open',
            created: 2000,
            kind: 'turn',
          },
        ],
      }),
    );
    const store = await loadComments(repo);
    expect(store.nextId).toBe(3);
    expect(store.comments).toEqual([
      {
        id: 1,
        kind: 'note',
        file: '',
        anchor: '',
        body: 'first',
        author: 'someone',
        status: 'addressed',
        created: 1000,
      },
      {
        id: 2,
        kind: 'turn',
        file: 'docs/a.md',
        anchor: 'intro',
        body: 'second',
        author: AGENT_AUTHOR,
        status: 'open',
        created: 2000,
        refs: { replyTo: 1 },
      },
    ]);
  });

  it('keeps refs written by the newer store shape', async () => {
    await writeStore(
      JSON.stringify({
        version: 1,
        nextId: 2,
        comments: [
          {
            id: 1,
            kind: 'note',
            file: '',
            anchor: '',
            body: 'x',
            author: 'someone',
            status: 'open',
            created: 5,
            refs: { task: 'T40001', file: 'a.ts', replyTo: 7 },
          },
        ],
      }),
    );
    const store = await loadComments(repo);
    expect(store.comments[0]?.refs).toEqual({ task: 'T40001', file: 'a.ts', replyTo: 7 });
  });

  it('never issues an id a record already holds, even when nextId fell behind', async () => {
    await writeStore(
      JSON.stringify({
        version: 1,
        nextId: 1,
        comments: [{ id: 9, body: 'x', author: 'a', status: 'open', created: 1 }],
      }),
    );
    const added = await addComment(repo, { body: 'y' }, 2);
    expect(added.id).toBe(10);
  });

  it('adds a comment with the owner default author, caps the body and persists it', async () => {
    const body = 'a'.repeat(9000);
    const added = await addComment(repo, { body, file: 'docs/x.md', anchor: 'h' }, 1234);
    expect(added).toEqual({
      id: 1,
      kind: 'note',
      file: 'docs/x.md',
      anchor: 'h',
      body: 'a'.repeat(8000),
      author: 'owner',
      status: 'open',
      created: 1234,
    });
    const raw = await readFile(join(repo, REVIEW_DIR, 'comments.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const reloaded = await loadComments(repo);
    expect(reloaded.nextId).toBe(2);
    expect(reloaded.comments).toEqual([added]);
  });

  it('records a turn with its refs and folds replyTo into them', async () => {
    const turn = await addComment(
      repo,
      { body: 'reply', author: AGENT_AUTHOR, kind: 'turn', refs: { task: 'T1' }, replyTo: 4 },
      10,
    );
    expect(turn.kind).toBe('turn');
    expect(turn.refs).toEqual({ task: 'T1', replyTo: 4 });

    const explicit = await addComment(repo, { body: 'x', refs: { replyTo: 2 }, replyTo: 9 }, 11);
    expect(explicit.refs).toEqual({ replyTo: 2 });

    const none = await addComment(repo, { body: 'x', replyTo: null }, 12);
    expect(none.refs).toBeUndefined();
  });

  it('marks a comment addressed and reopens it on any other word', async () => {
    const added = await addComment(repo, { body: 'x' }, 1);
    expect((await setCommentStatus(repo, added.id, 'addressed'))?.status).toBe('addressed');
    expect((await loadComments(repo)).comments[0]?.status).toBe('addressed');
    expect((await setCommentStatus(repo, added.id, 'whatever'))?.status).toBe('open');
    expect(await setCommentStatus(repo, 99, 'addressed')).toBeUndefined();
  });

  it('turns the store into an exchange region, newest first, at most shown', async () => {
    await addComment(repo, { body: 'oldest', author: 'me' }, 100);
    await addComment(repo, { body: 'middle', author: AGENT_AUTHOR, kind: 'turn', refs: { task: 'T2', replyTo: 1 } }, 200);
    await addComment(repo, { body: 'newest', file: 'docs/a.md', anchor: 'a' }, 300);
    const store = await loadComments(repo);

    const region = commentsToExchange(store, 2);
    expect(region.total).toBe(3);
    expect(region.omitted).toBe(1);
    expect(region.entries).toEqual([
      {
        id: 3,
        author: 'owner',
        isAgent: false,
        kind: 'note',
        body: 'newest',
        created: 300,
        status: 'open',
        file: 'docs/a.md',
        anchor: 'a',
      },
      {
        id: 2,
        author: AGENT_AUTHOR,
        isAgent: true,
        kind: 'turn',
        body: 'middle',
        created: 200,
        status: 'open',
        task: 'T2',
        replyTo: 1,
      },
    ]);

    const all = commentsToExchange(store, 10);
    expect(all.entries).toHaveLength(3);
    expect(all.omitted).toBe(0);
  });
});
