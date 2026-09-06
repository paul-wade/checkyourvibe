import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { deliverOrchestratorNotes } from '../../src/cli/comments.js';
import { isUnknownArray } from '../../src/guards.js';

/**
 * A message addressed to the orchestrator is carried by a lifecycle hook, and
 * "stored" and "delivered" are different facts. The dashboard says which of
 * the two happened, so nothing here may mark a note delivered that no hook
 * carried.
 */
const repos: string[] = [];

afterEach(async () => {
  for (const repo of repos.splice(0)) {
    await rm(repo, { recursive: true, force: true });
  }
});

interface NoteRefs {
  orchestrator?: boolean;
  deliveredAt?: number;
}

interface Note {
  id: number;
  author: string;
  body: string;
  created: number;
  status: 'open' | 'addressed';
  kind: 'note';
  refs?: NoteRefs;
}

async function repoWith(comments: Note[]): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'cyv-orch-'));
  repos.push(repo);
  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await writeFile(
    join(repo, '.cyv-review', 'comments.json'),
    JSON.stringify({ version: 1, comments, drafts: [] }, null, 2),
  );
  return repo;
}

function note(id: number, refs?: NoteRefs): Note {
  return {
    id,
    author: 'owner',
    body: `message ${id}`,
    created: Date.parse('2026-09-08T04:00:00.000Z'),
    status: 'open',
    kind: 'note',
    ...(refs === undefined ? {} : { refs }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

/** The `deliveredAt` the store holds for a note, read without asserting a shape. */
async function deliveredAtFor(repo: string, id: number): Promise<number | undefined> {
  const raw: unknown = JSON.parse(await readFile(join(repo, '.cyv-review', 'comments.json'), 'utf-8'));
  if (!isRecord(raw)) return undefined;
  const comments: unknown = raw['comments'];
  if (!isUnknownArray(comments)) return undefined;
  for (const entry of comments) {
    if (!isRecord(entry) || entry['id'] !== id) continue;
    const refs: unknown = entry['refs'];
    if (!isRecord(refs)) return undefined;
    const at: unknown = refs['deliveredAt'];
    return typeof at === 'number' ? at : undefined;
  }
  return undefined;
}

/**
 * Delivery resolves on the write callback, so a stub that never calls it hangs
 * rather than failing — the first version of this test timed out at thirty
 * seconds against working code.
 */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      for (const arg of rest) {
        if (typeof arg === 'function') arg(null);
      }
      return true;
    });
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('deliverOrchestratorNotes', () => {
  it('writes an undelivered orchestrator note and stamps when it was carried', async () => {
    const repo = await repoWith([note(1, { orchestrator: true })]);
    const captured = captureStdout();
    try {
      const delivered = await deliverOrchestratorNotes(repo, 'antigravity');

      expect(delivered).toBe(true);
      expect(captured.text()).toContain('message 1');
    } finally {
      captured.restore();
    }

    expect(await deliveredAtFor(repo, 1)).toBeTypeOf('number');
  });

  it('does not deliver the same note twice', async () => {
    const repo = await repoWith([
      note(1, { orchestrator: true, deliveredAt: Date.parse('2026-09-08T04:05:00.000Z') }),
    ]);
    const captured = captureStdout();
    try {
      await deliverOrchestratorNotes(repo, 'antigravity');
      expect(captured.text()).not.toContain('message 1');
    } finally {
      captured.restore();
    }
  });

  it('leaves a note addressed to nobody in particular alone', async () => {
    const repo = await repoWith([note(1)]);
    const captured = captureStdout();
    try {
      await deliverOrchestratorNotes(repo, 'antigravity');
      expect(captured.text()).not.toContain('message 1');
    } finally {
      captured.restore();
    }

    // Not addressed to the orchestrator, so it is not the orchestrator's to
    // deliver, and it must not be stamped as though it had been.
    expect(await deliveredAtFor(repo, 1)).toBeUndefined();
  });

  it('refuses an agent it has no delivery route for, and stamps nothing', async () => {
    const repo = await repoWith([note(1, { orchestrator: true })]);

    expect(await deliverOrchestratorNotes(repo, 'not-an-agent')).toBe(false);
    expect(await deliveredAtFor(repo, 1)).toBeUndefined();
  });
});
