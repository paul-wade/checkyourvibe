import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimCard,
  claimEditLock,
  markQuotaExhausted,
  markQuotaRestored,
  parseDashboardState,
  readQuota,
  readState,
  registerSession,
  releaseCard,
  releaseEditLock,
  stateStorePath,
  unregisterSession,
  writeState,
} from '../../src/dashboard/state-store.js';

describe('state-store', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-state-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Empty / missing file
  // -------------------------------------------------------------------------

  describe('readState with no file', () => {
    it('returns empty state rather than throwing when no file exists', async () => {
      const state = await readState(repo);
      expect(state.sessions).toEqual({});
      expect(state.cardAssignments).toEqual({});
      expect(state.workingTrees).toEqual({});
      expect(state.editLocks).toEqual({});
      expect(state.quotas).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // parseDashboardState
  // -------------------------------------------------------------------------

  describe('parseDashboardState', () => {
    it('returns null for non-object input', () => {
      expect(parseDashboardState(null)).toBeNull();
      expect(parseDashboardState('string')).toBeNull();
      expect(parseDashboardState(42)).toBeNull();
      expect(parseDashboardState([])).toBeNull();
    });

    it('returns null when a required top-level key is missing', () => {
      expect(
        parseDashboardState({ sessions: {}, cardAssignments: {}, workingTrees: {}, editLocks: {} }),
      ).toBeNull();
    });

    it('returns null when a session entry is malformed', () => {
      const result = parseDashboardState({
        sessions: { s1: { projectRoot: '/p', agentId: 'a', state: 'unknown-state', lastResumedAt: 'x' } },
        cardAssignments: {},
        workingTrees: {},
        editLocks: {},
        quotas: {},
      });
      expect(result).toBeNull();
    });

    it('round-trips a valid state', () => {
      const input = {
        sessions: {
          s1: { projectRoot: '/p', agentId: 'a', state: 'idle', lastResumedAt: '2026-01-01T00:00:00.000Z' },
        },
        cardAssignments: {
          T1: { sessionId: 's1', workingTree: '/wt' },
        },
        workingTrees: { '/wt': 's1' },
        editLocks: {
          'docs/specs/x.md': { holder: 's1', acquiredAt: '2026-01-01T00:00:00.000Z' },
        },
        quotas: {
          lane1: { exhausted: true, resetsAt: '2026-02-01T00:00:00.000Z' },
        },
      };
      const result = parseDashboardState(input);
      expect(result).toEqual(input);
    });
  });

  // -------------------------------------------------------------------------
  // writeState / readState round-trip
  // -------------------------------------------------------------------------

  describe('writeState and readState', () => {
    it('persists and restores a non-empty state', async () => {
      const state = await readState(repo);
      state.sessions['sess-1'] = {
        projectRoot: '/my/project',
        agentId: 'agent-a',
        state: 'running',
        lastResumedAt: '2026-01-01T00:00:00.000Z',
      };
      await writeState(repo, state);

      const restored = await readState(repo);
      const entry = restored.sessions['sess-1'];
      expect(entry).toBeDefined();
      expect(entry).toEqual({
        projectRoot: '/my/project',
        agentId: 'agent-a',
        state: 'running',
        lastResumedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('writes to the expected path under .cyv-review/', async () => {
      const path = stateStorePath(repo);
      expect(path).toContain('.cyv-review');
      expect(path).toContain('dashboard-state.json');
    });
  });

  // -------------------------------------------------------------------------
  // Session registry
  // -------------------------------------------------------------------------

  describe('registerSession / unregisterSession', () => {
    it('registers a session and reads it back', async () => {
      await registerSession(repo, 'sess-1', {
        projectRoot: '/proj',
        agentId: 'agent-x',
        state: 'idle',
        lastResumedAt: '2026-01-01T00:00:00.000Z',
      });
      const state = await readState(repo);
      const registered = state.sessions['sess-1'];
      expect(registered).toBeDefined();
      expect(registered).toMatchObject({ agentId: 'agent-x', state: 'idle' });
    });

    it('unregisters a session', async () => {
      await registerSession(repo, 'sess-1', {
        projectRoot: '/proj',
        agentId: 'agent-x',
        state: 'idle',
        lastResumedAt: '2026-01-01T00:00:00.000Z',
      });
      await unregisterSession(repo, 'sess-1');
      const state = await readState(repo);
      expect(Object.hasOwn(state.sessions, 'sess-1')).toBe(false);
    });

    it('unregister is a no-op for a session that does not exist', async () => {
      await expect(unregisterSession(repo, 'nonexistent')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Card claim / release
  // -------------------------------------------------------------------------

  describe('claimCard', () => {
    it('succeeds on the first claim', async () => {
      const result = await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      expect(result.claimed).toBe(true);
    });

    it('fails when the same card is already held by another session', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      const result = await claimCard(repo, 'T001', 'sess-2', '/wt/b');
      expect(result.claimed).toBe(false);
      if (!result.claimed) {
        expect(result.holder).toBe('sess-1');
      }
    });

    it('fails when the working tree is already occupied by another session', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/shared');
      const result = await claimCard(repo, 'T002', 'sess-2', '/wt/shared');
      expect(result.claimed).toBe(false);
      if (!result.claimed) {
        expect(result.holder).toBe('sess-1');
      }
    });

    it('succeeds when the same session re-claims its own card', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      const result = await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      expect(result.claimed).toBe(true);
    });
  });

  describe('releaseCard', () => {
    it('releases a card so it can be claimed again by another session', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      await releaseCard(repo, 'T001', 'sess-1');

      const result = await claimCard(repo, 'T001', 'sess-2', '/wt/b');
      expect(result.claimed).toBe(true);
    });

    it('also frees the working tree after release', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/shared');
      await releaseCard(repo, 'T001', 'sess-1');

      const result = await claimCard(repo, 'T002', 'sess-2', '/wt/shared');
      expect(result.claimed).toBe(true);
    });

    it('release is a no-op when the card is held by a different session', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      await releaseCard(repo, 'T001', 'sess-2');

      const state = await readState(repo);
      expect(state.cardAssignments['T001']?.sessionId).toBe('sess-1');
    });

    it('release is a no-op when the card is not claimed at all', async () => {
      await expect(releaseCard(repo, 'T999', 'sess-1')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Edit locks
  // -------------------------------------------------------------------------

  describe('claimEditLock', () => {
    it('succeeds on the first claim', async () => {
      const result = await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');
      expect(result.claimed).toBe(true);
    });

    it('fails when the lock is held by a different holder', async () => {
      await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');
      const result = await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-B');
      expect(result.claimed).toBe(false);
      if (!result.claimed) {
        expect(result.holder).toBe('user-A');
      }
    });

    it('succeeds when the same holder re-claims the lock', async () => {
      await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');
      const result = await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');
      expect(result.claimed).toBe(true);
    });
  });

  describe('releaseEditLock', () => {
    it('releases a lock so another holder can claim it', async () => {
      await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');
      await releaseEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');

      const result = await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-B');
      expect(result.claimed).toBe(true);
    });

    it('release is a no-op when the lock is held by a different holder', async () => {
      await claimEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A');
      await releaseEditLock(repo, 'docs/specs/0051/tasks.md', 'user-B');

      const state = await readState(repo);
      expect(state.editLocks['docs/specs/0051/tasks.md']?.holder).toBe('user-A');
    });

    it('release is a no-op when the lock does not exist', async () => {
      await expect(releaseEditLock(repo, 'docs/specs/0051/tasks.md', 'user-A')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Quota state
  // -------------------------------------------------------------------------

  describe('quota', () => {
    it('reads as non-exhausted when no entry exists', async () => {
      const quota = await readQuota(repo, 'lane-fast');
      expect(quota.exhausted).toBe(false);
      expect(quota.resetsAt).toBeUndefined();
    });

    it('records exhaustion with a reset time and reads it back', async () => {
      const resetsAt = '2026-06-01T00:00:00.000Z';
      await markQuotaExhausted(repo, 'lane-fast', resetsAt);

      const quota = await readQuota(repo, 'lane-fast');
      expect(quota.exhausted).toBe(true);
      expect(quota.resetsAt).toBe(resetsAt);
    });

    it('restores a quota after it was exhausted', async () => {
      await markQuotaExhausted(repo, 'lane-fast', '2026-06-01T00:00:00.000Z');
      await markQuotaRestored(repo, 'lane-fast');

      const quota = await readQuota(repo, 'lane-fast');
      expect(quota.exhausted).toBe(false);
    });

    it('does not affect other lanes when one is exhausted', async () => {
      await markQuotaExhausted(repo, 'lane-fast', '2026-06-01T00:00:00.000Z');

      const other = await readQuota(repo, 'lane-slow');
      expect(other.exhausted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: release then re-claim succeeds
  // -------------------------------------------------------------------------

  describe('release then re-claim', () => {
    it('card: release then re-claim by the original session succeeds', async () => {
      await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      await releaseCard(repo, 'T001', 'sess-1');
      const result = await claimCard(repo, 'T001', 'sess-1', '/wt/a');
      expect(result.claimed).toBe(true);
    });

    it('edit lock: release then re-claim by original holder succeeds', async () => {
      await claimEditLock(repo, 'docs/specs/x/tasks.md', 'holder-1');
      await releaseEditLock(repo, 'docs/specs/x/tasks.md', 'holder-1');
      const result = await claimEditLock(repo, 'docs/specs/x/tasks.md', 'holder-1');
      expect(result.claimed).toBe(true);
    });
  });
});
