import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_AUTHOR, type Comment, type CommentStore } from '../../../src/dashboard/review/comments.js';
import { repoNeedsYou } from '../../../src/dashboard/review/needs-you.js';

function hrefFor(pathname: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ project: 'demo', ...query });
  return `${pathname}?${params.toString()}`;
}

function note(id: number, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    kind: 'note',
    file: '',
    anchor: '',
    body: `note ${id}`,
    author: 'someone',
    status: 'open',
    created: id * 1000,
    ...overrides,
  };
}

const EMPTY: CommentStore = { version: 1, nextId: 1, comments: [] };

describe('repoNeedsYou', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-needs-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is empty for an empty repository', async () => {
    expect(await repoNeedsYou(repo, EMPTY, hrefFor)).toEqual([]);
  });

  it('lists open tasks whose executor is user, with a link to the tasks file', async () => {
    const dir = join(repo, 'docs', 'specs', '0012-some-spec');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'tasks.md'),
      [
        '## Open',
        '- [ ] **T12001** Decide the thing',
        '  Needs a person.',
        '  _Exec: executor=user gates=manual_',
        '- [x] **T12002** Already decided',
        '  _Exec: executor=user gates=manual_',
        '- [ ] **T12003** An agent does this',
        '  _Exec: executor=self gates=tsc_',
        '',
      ].join('\n'),
      'utf8',
    );
    const items = await repoNeedsYou(repo, EMPTY, hrefFor);
    expect(items).toEqual([
      {
        kind: 'task',
        id: 'T12001',
        title: 'Decide the thing',
        question:
          'This task is yours to decide: Decide the thing. Decide, then tell the agent or check the task off in tasks.md.',
        detail: ['Needs a person.'],
        where: '0012 · some spec',
        href: '/view?project=demo&f=docs%2Fspecs%2F0012-some-spec%2Ftasks.md',
        actions: [
          { kind: 'open', label: 'open the task', href: '/view?project=demo&f=docs%2Fspecs%2F0012-some-spec%2Ftasks.md' },
          { kind: 'tell', label: 'tell the agent', prefill: 'Re T12001: ', task: 'T12001' },
          { kind: 'dismiss', label: 'needs nothing', itemId: 'T12001' },
        ],
      },
    ]);
    const task = items[0];
    expect(task?.question).toBe(
      'This task is yours to decide: Decide the thing. Decide, then tell the agent or check the task off in tasks.md.',
    );
    expect(task?.actions).toEqual([
      { kind: 'open', label: 'open the task', href: '/view?project=demo&f=docs%2Fspecs%2F0012-some-spec%2Ftasks.md' },
      { kind: 'tell', label: 'tell the agent', prefill: 'Re T12001: ', task: 'T12001' },
      { kind: 'dismiss', label: 'needs nothing', itemId: 'T12001' },
    ]);
    expect(task?.detail).toEqual(['Needs a person.']);
    expect((task?.detail ?? []).some((line) => line.includes('_Exec:'))).toBe(false);
  });

  it('lists roadmap entries marked blocked', async () => {
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(
      join(repo, 'docs', 'ROADMAP.md'),
      [
        '**0021 — Go.** *(Blocked: no toolchain on the machine. Install it to',
        'unblock.)* The strongest candidate.',
        '**0022 — Not blocked.** Fine.',
        '',
      ].join('\n'),
      'utf8',
    );
    const items = await repoNeedsYou(repo, EMPTY, hrefFor);
    expect(items).toEqual([
      {
        kind: 'blocked',
        id: '0021',
        title: 'Go',
        question: 'Go is blocked: no toolchain on the machine. Unblock it, or leave it parked?',
        detail: [],
        where: 'no toolchain on the machine',
        href: '/view?project=demo&f=docs%2FROADMAP.md',
        actions: [
          { kind: 'open', label: 'open the entry', href: '/view?project=demo&f=docs%2FROADMAP.md' },
          { kind: 'tell', label: 'tell the agent', prefill: 'Re 0021: ' },
          { kind: 'dismiss', label: 'needs nothing', itemId: '0021' },
        ],
      },
    ]);
    const blocked = items[0];
    expect(blocked?.question).toBe('Go is blocked: no toolchain on the machine. Unblock it, or leave it parked?');
    expect(blocked?.actions).toEqual([
      { kind: 'open', label: 'open the entry', href: '/view?project=demo&f=docs%2FROADMAP.md' },
      { kind: 'tell', label: 'tell the agent', prefill: 'Re 0021: ' },
      { kind: 'dismiss', label: 'needs nothing', itemId: '0021' },
    ]);
  });

  it('lists only open owner notes, never turns or agent entries', async () => {
    const comments: CommentStore = {
      version: 1,
      nextId: 6,
      comments: [
        note(1, { body: 'spaced   out\nnote' }),
        note(2, { author: AGENT_AUTHOR }),
        note(3, { kind: 'turn' }),
        note(4, { status: 'addressed' }),
        note(5, { body: 'x'.repeat(200) }),
      ],
    };
    const items = await repoNeedsYou(repo, comments, hrefFor);
    expect(items).toEqual([
      {
        kind: 'note',
        id: '#1',
        title: 'spaced out note',
        question: 'You wrote this and nothing has answered it yet. Still waiting, or is it done?',
        detail: [],
        where: 'your note, unaddressed',
        href: '/?project=demo#exchange',
        at: new Date(1000).toISOString(),
        actions: [
          { kind: 'addressed', label: 'mark addressed', commentId: 1 },
          { kind: 'tell', label: 'tell the agent', prefill: 'Following up on #1: ' },
        ],
      },
      {
        kind: 'note',
        id: '#5',
        title: 'x'.repeat(90),
        question: 'You wrote this and nothing has answered it yet. Still waiting, or is it done?',
        detail: [],
        where: 'your note, unaddressed',
        href: '/?project=demo#exchange',
        at: new Date(5000).toISOString(),
        actions: [
          { kind: 'addressed', label: 'mark addressed', commentId: 5 },
          { kind: 'tell', label: 'tell the agent', prefill: 'Following up on #5: ' },
        ],
      },
    ]);
    const first = items[0];
    expect(first?.question).toBe('You wrote this and nothing has answered it yet. Still waiting, or is it done?');
    expect(first?.actions).toEqual([
      { kind: 'addressed', label: 'mark addressed', commentId: 1 },
      { kind: 'tell', label: 'tell the agent', prefill: 'Following up on #1: ' },
    ]);
    const second = items[1];
    expect(second?.question).toBe('You wrote this and nothing has answered it yet. Still waiting, or is it done?');
    expect(second?.actions).toEqual([
      { kind: 'addressed', label: 'mark addressed', commentId: 5 },
      { kind: 'tell', label: 'tell the agent', prefill: 'Following up on #5: ' },
    ]);
  });
});
