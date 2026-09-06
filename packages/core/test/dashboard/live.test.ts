import { describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveFragmentRegions, subscribeToProject } from '../../src/dashboard/live.js';
import type { LiveEvent } from '../../src/dashboard/live.js';
import { boardClientScript } from '../../src/dashboard/board-client.js';
import { buildBoardModel } from '../../src/dashboard/board-model.js';
import { commentsToExchange } from '../../src/dashboard/review/comments.js';
import { renderBoard, renderBoardFragment } from '../../src/dashboard/board-render.js';
import { dispatchLogPath } from '../../src/executor/store.js';
import { stateStorePath } from '../../src/dashboard/state-store.js';
import { REVIEW_DIR } from '../../src/dashboard/review/comments.js';

const INTERVAL_MS = 50;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await wait(50);
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cyv-live-'));
  return root;
}

function makeStore() {
  const now = Date.now();
  return {
    version: 1,
    nextId: 3,
    comments: [
      {
        id: 1,
        kind: 'note' as const,
        file: '',
        anchor: '',
        body: 'hello',
        author: 'owner',
        status: 'open' as const,
        created: now,
      },
    ],
    drafts: [
      {
        id: 2,
        kind: 'note' as const,
        file: '',
        anchor: '',
        body: 'draft text',
        author: 'owner',
        status: 'draft' as const,
        created: now,
      },
    ],
  };
}

function makeBoardInput() {
  const log = { records: [], refusals: [], acknowledged: [] };
  const comments = makeStore();
  const exchange = commentsToExchange(comments, 50, { cursor: 0, now: Date.now() });
  const model = buildBoardModel({ log, comments, lanes: [] });
  return {
    model,
    lanes: [] as const,
    exchange: {
      entries: exchange.entries,
      omitted: exchange.omitted,
      drafts: comments.drafts ?? [],
    },
  };
}

describe('live project watcher', () => {
  it('emits a dispatch event when the dispatch log is appended', async () => {
    const root = await makeRoot();
    const events: LiveEvent[] = [];
    const stop = subscribeToProject(root, (event) => events.push(event), INTERVAL_MS);
    await wait(INTERVAL_MS);

    await mkdir(join(root, REVIEW_DIR), { recursive: true });
    await appendFile(dispatchLogPath(root), JSON.stringify({ event: 'opened', dispatchId: 'd-1' }) + '\n');

    await waitFor(() => events.length > 0);
    stop();

    const [event] = events;
    if (event === undefined) throw new Error('expected at least one live event');
    expect(event).toMatchObject({
      kind: 'dispatch',
      fragments: ['status', 'todo', 'in-progress', 'done', 'decisions'],
    });
  });

  it('emits a comment event when the comments file changes', async () => {
    const root = await makeRoot();
    const events: LiveEvent[] = [];
    const stop = subscribeToProject(root, (event) => events.push(event), INTERVAL_MS);
    await wait(INTERVAL_MS);

    await mkdir(join(root, REVIEW_DIR), { recursive: true });
    const commentsPath = join(root, REVIEW_DIR, 'comments.json');
    const store = makeStore();
    await writeFile(commentsPath, JSON.stringify(store));

    await waitFor(() => events.length > 0);
    stop();

    const [event] = events;
    if (event === undefined) throw new Error('expected at least one live event');
    expect(event).toMatchObject({
      kind: 'comment',
      fragments: ['conversation', 'drafts', 'decisions', 'in-progress', 'status'],
    });
  });

  it('emits a session event when the dashboard state file changes', async () => {
    const root = await makeRoot();
    const events: LiveEvent[] = [];
    const stop = subscribeToProject(root, (event) => events.push(event), INTERVAL_MS);
    await wait(INTERVAL_MS);

    await mkdir(join(root, REVIEW_DIR), { recursive: true });
    await writeFile(stateStorePath(root), JSON.stringify({ sessions: [{ id: 's-1' }] }));

    await waitFor(() => events.length > 0);
    stop();

    const [event] = events;
    if (event === undefined) throw new Error('expected at least one live event');
    expect(event).toMatchObject({
      kind: 'session',
      fragments: ['sessions', 'status'],
    });
  });

  it('stops emitting after the subscription is cancelled', async () => {
    const root = await makeRoot();
    const events: LiveEvent[] = [];
    const stop = subscribeToProject(root, (event) => events.push(event), INTERVAL_MS);
    await wait(INTERVAL_MS);

    await mkdir(join(root, REVIEW_DIR), { recursive: true });
    await appendFile(dispatchLogPath(root), JSON.stringify({ event: 'opened', dispatchId: 'd-1' }) + '\n');
    await waitFor(() => events.length > 0);

    const before = events.length;
    stop();

    await appendFile(dispatchLogPath(root), JSON.stringify({ event: 'closed', dispatchId: 'd-1' }) + '\n');
    await wait(INTERVAL_MS * 3);

    expect(events.length).toBe(before);
  });
});

// The live channel names regions and the renderer serves them. Nothing held the
// two lists together, so when the columns were renamed for the columns they are,
// three of the names the channel sends went stale. Every dispatch and comment
// event then asked the client to refresh regions that answer 404: the board kept
// its live badge and quietly stopped updating.
describe('the live channel and the renderer agree on region names', () => {
  it('serves every region the live channel can ask a client to refresh', () => {
    const { model, exchange } = makeBoardInput();
    const regions = liveFragmentRegions();
    expect(regions.length).toBeGreaterThan(0);

    const unserved = regions.filter(
      (region) =>
        renderBoardFragment({ model, lanes: [], exchange, projectRoot: '/repo' }, region) ===
        undefined,
    );

    expect(unserved).toEqual([]);
  });
});

describe('live update fragments', () => {
  it('renders the full board with stable fragment ids', () => {
    const { model, exchange } = makeBoardInput();
    const html = renderBoard({ model, lanes: [], exchange });
    expect(html).toContain('id="board-status"');
    // Named for the column each one is, not for where it sits. `left` used to
    // mean the Review column and `right` the Needs You column, which inverted
    // the order the board actually renders.
    expect(html).toContain('id="board-todo-body"');
    expect(html).toContain('id="board-in-progress-body"');
        expect(html).toContain('id="board-done-body"');
    expect(html).toContain('id="board-conversation"');
    expect(html).toContain('id="board-drafts"');
    expect(html).toContain('id="board-note-form"');
  });

  it('renders a fragment for the conversation without replacing the compose form', () => {
    const { model, exchange } = makeBoardInput();
    const fragment = renderBoardFragment({ model, lanes: [], exchange }, 'conversation');
    expect(fragment).toBeTruthy();
    expect(fragment).not.toContain('id="board-note-form"');
    expect(fragment).not.toContain('id="board-note-body"');
  });

  it('renders draft textareas in the drafts fragment', () => {
    const { model, exchange } = makeBoardInput();
    const fragment = renderBoardFragment({ model, lanes: [], exchange }, 'drafts');
    expect(fragment).toBeTruthy();
    expect(fragment).toContain('data-draft-body="2"');
    expect(fragment).toContain('<textarea');
  });

  it('client script captures and restores field values', () => {
    const script = boardClientScript();
    expect(script).toContain('saveField');
    expect(script).toContain('restoreField');
    expect(script).toContain('input, select, textarea');
    expect(script).toContain('EventSource');
    expect(() => new Function(script)).not.toThrow();
  });
});
