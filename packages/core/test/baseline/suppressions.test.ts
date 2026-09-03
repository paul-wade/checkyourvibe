import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SuppressionConfigError,
  evaluateSuppressions,
  loadSuppressions,
  suppressionNotice,
  validateSuppressionRules,
} from '../../src/baseline/suppressions.js';
import { computeEntries } from '../../src/baseline/identity.js';
import { FIXTURE_REPO_ROOT, makeViolation } from './fixtures.js';

async function writeConfig(repo: string, body: Record<string, unknown>): Promise<void> {
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(body, null, 2));
}

function fingerprintFor(violation: ReturnType<typeof makeViolation>, repoRoot = FIXTURE_REPO_ROOT): string {
  const entries = computeEntries([violation], repoRoot);
  const first = entries[0];
  if (first === undefined) {
    throw new Error('Could not compute violation identity: the violation may be outside the repo root.');
  }
  return first.entry.fingerprint;
}

describe('loadSuppressions', () => {
  let repo: string;

  it('returns an empty list when checkyourvibe.json does not exist', async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-supp-missing-'));
    try {
      expect(await loadSuppressions(repo)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an empty list when there is no suppressions key', async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-supp-none-'));
    try {
      await writeConfig(repo, { packs: [], analyzers: [], rules: {}, strict: false, exclude: [] });
      expect(await loadSuppressions(repo)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects a suppression with no reason', async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-supp-noreason-'));
    try {
      await writeConfig(repo, {
        suppressions: [{ ruleId: 'no-any', target: 'src/**', expires: '2099-01-01' }],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/reason/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects a suppression with no expiry', async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-supp-noexpiry-'));
    try {
      await writeConfig(repo, {
        suppressions: [{ ruleId: 'no-any', target: 'src/**', reason: 'Legacy module, tracked in TICKET-1.' }],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/expires/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('accepts a suppression carrying both a reason and an expiry', async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-supp-ok-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/legacy/**',
            reason: 'Legacy module, tracked in TICKET-1.',
            expires: '2099-01-01',
          },
        ],
      });
      const suppressions = await loadSuppressions(repo);
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]?.ruleId).toBe('no-any');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('validateSuppressionRules', () => {
  it('rejects a suppression naming a rule that does not exist', () => {
    const suppressions = [
      { ruleId: 'no-such-rule', target: 'src/**', reason: 'x', expires: '2099-01-01' },
    ];
    expect(() => validateSuppressionRules(suppressions, new Set(['no-any']))).toThrow(SuppressionConfigError);
  });

  it('accepts a suppression naming a known rule', () => {
    const suppressions = [{ ruleId: 'no-any', target: 'src/**', reason: 'x', expires: '2099-01-01' }];
    expect(() => validateSuppressionRules(suppressions, new Set(['no-any']))).not.toThrow();
  });
});

describe('evaluateSuppressions', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('suppresses a matching, non-expired violation', () => {
    const violation = makeViolation({ relPath: 'src/legacy/thing.ts', ruleId: 'no-any' });
    const suppressions = [
      { ruleId: 'no-any', target: 'src/legacy/**', reason: 'Legacy.', expires: '2099-01-01' },
    ];

    const result = evaluateSuppressions([violation], suppressions, FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([violation]);
    expect(result.reported).toEqual([]);
    expect(result.activeCount).toBe(1);
    expect(result.expired).toEqual([]);
  });

  it('an expired suppression stops suppressing and is named in the result', () => {
    const violation = makeViolation({ relPath: 'src/legacy/thing.ts', ruleId: 'no-any' });
    const expiredSuppression = {
      ruleId: 'no-any',
      target: 'src/legacy/**',
      reason: 'Legacy, should have been fixed by Q1.',
      expires: '2026-01-01',
    };

    const result = evaluateSuppressions([violation], [expiredSuppression], FIXTURE_REPO_ROOT, now);

    // The violation is reported again, not suppressed.
    expect(result.suppressed).toEqual([]);
    expect(result.reported).toEqual([violation]);
    expect(result.activeCount).toBe(0);
    // And the expired suppression itself is named, not just counted.
    expect(result.expired).toEqual([expiredSuppression]);
  });

  it('counts suppressions expiring within 30 days separately from other active ones', () => {
    const violation = makeViolation({ relPath: 'src/legacy/thing.ts', ruleId: 'no-any' });
    const soon = { ruleId: 'no-any', target: 'src/legacy/**', reason: 'Soon.', expires: '2026-06-15' };
    const later = { ruleId: 'no-any', target: 'src/legacy/**', reason: 'Later.', expires: '2027-01-01' };

    const result = evaluateSuppressions([violation], [soon, later], FIXTURE_REPO_ROOT, now);
    expect(result.activeCount).toBe(2);
    expect(result.expiringWithin30DaysCount).toBe(1);
  });

  it('does not suppress a violation the target glob does not match', () => {
    const violation = makeViolation({ relPath: 'src/other/thing.ts', ruleId: 'no-any' });
    const suppressions = [
      { ruleId: 'no-any', target: 'src/legacy/**', reason: 'Legacy.', expires: '2099-01-01' },
    ];

    const result = evaluateSuppressions([violation], suppressions, FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([]);
    expect(result.reported).toEqual([violation]);
    expect(result.broadSuppressed).toEqual([]);
    expect(result.pinnedSuppressed).toEqual([]);
  });

  it('classifies a path-glob match as broad suppression', () => {
    const violation = makeViolation({ relPath: 'src/legacy/thing.ts', ruleId: 'no-any' });
    const suppressions = [
      { ruleId: 'no-any', target: 'src/legacy/**', reason: 'Legacy.', expires: '2099-01-01' },
    ];

    const result = evaluateSuppressions([violation], suppressions, FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([violation]);
    expect(result.broadSuppressed).toEqual([violation]);
    expect(result.pinnedSuppressed).toEqual([]);
  });

  it('classifies a fingerprint match as pinned suppression', () => {
    const violation = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'const x: any = 1;',
    });
    const suppression = {
      ruleId: 'no-any',
      target: 'src/legacy/thing.ts',
      reason: 'Tracked.',
      expires: '2099-01-01',
      fingerprint: fingerprintFor(violation),
      occurrence: 0,
    };

    const result = evaluateSuppressions([violation], [suppression], FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([violation]);
    expect(result.broadSuppressed).toEqual([]);
    expect(result.pinnedSuppressed).toEqual([violation]);
  });

  it('a pinned suppression does not suppress a different snippet in the same file', () => {
    const pinned = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'const x: any = 1;',
    });
    const newcomer = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'let y: any = 2;',
    });
    const suppression = {
      ruleId: 'no-any',
      target: 'src/legacy/thing.ts',
      reason: 'Tracked.',
      expires: '2099-01-01',
      fingerprint: fingerprintFor(pinned),
      occurrence: 0,
    };

    const result = evaluateSuppressions([pinned, newcomer], [suppression], FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([pinned]);
    expect(result.reported).toEqual([newcomer]);
    expect(result.broadSuppressed).toEqual([]);
    expect(result.pinnedSuppressed).toEqual([pinned]);
  });

  it('a pinned suppression with occurrence pinpoints one duplicate', () => {
    const first = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'const x: any = 1;',
      line: 10,
    });
    const second = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'const x: any = 1;',
      line: 20,
    });
    const secondFingerprint = fingerprintFor(second);

    const suppression = {
      ruleId: 'no-any',
      target: 'src/legacy/thing.ts',
      reason: 'Tracked.',
      expires: '2099-01-01',
      fingerprint: secondFingerprint,
      occurrence: 1,
    };

    const result = evaluateSuppressions([first, second], [suppression], FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([second]);
    expect(result.reported).toEqual([first]);
    expect(result.pinnedSuppressed).toEqual([second]);
    expect(result.broadSuppressed).toEqual([]);
  });

  it('prefers a pinned match over a broad match for the same violation', () => {
    const violation = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'const x: any = 1;',
    });
    const broad = {
      ruleId: 'no-any',
      target: 'src/legacy/**',
      reason: 'Legacy.',
      expires: '2099-01-01',
    };
    const pinned = {
      ruleId: 'no-any',
      target: 'src/legacy/thing.ts',
      reason: 'Tracked.',
      expires: '2099-01-01',
      fingerprint: fingerprintFor(violation),
      occurrence: 0,
    };

    const result = evaluateSuppressions([violation], [broad, pinned], FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([violation]);
    expect(result.broadSuppressed).toEqual([]);
    expect(result.pinnedSuppressed).toEqual([violation]);
  });

  it('an expired pinned suppression is named in the result and stops suppressing', () => {
    const violation = makeViolation({
      relPath: 'src/legacy/thing.ts',
      ruleId: 'no-any',
      snippet: 'const x: any = 1;',
    });
    const expiredSuppression = {
      ruleId: 'no-any',
      target: 'src/legacy/thing.ts',
      reason: 'Tracked, should have been fixed.',
      expires: '2026-01-01',
      fingerprint: fingerprintFor(violation),
      occurrence: 0,
    };

    const result = evaluateSuppressions([violation], [expiredSuppression], FIXTURE_REPO_ROOT, now);
    expect(result.suppressed).toEqual([]);
    expect(result.reported).toEqual([violation]);
    expect(result.expired).toEqual([expiredSuppression]);
  });

  // The fingerprint is a hash of the normalized snippet, and for a rule like
  // no-any the snippet the analyzer reports is the word `any`. Every finding of
  // that rule in the repository therefore carries one fingerprint, and these
  // tests use that snippet so the pinned form is exercised at the entropy it
  // actually has, not at the entropy a long snippet would give it.
  describe('when every finding of the rule shares one fingerprint', () => {
    const first = makeViolation({ relPath: 'src/a.ts', ruleId: 'no-any', snippet: 'any', line: 1 });
    const second = makeViolation({ relPath: 'src/a.ts', ruleId: 'no-any', snippet: 'any', line: 5 });
    const third = makeViolation({ relPath: 'src/b.ts', ruleId: 'no-any', snippet: 'any', line: 1 });
    const shared = fingerprintFor(first);

    it('the three findings do share one fingerprint', () => {
      expect(fingerprintFor(second)).toBe(shared);
      expect(fingerprintFor(third)).toBe(shared);
    });

    it('a pinned suppression defers exactly one of them', () => {
      const suppression = {
        ruleId: 'no-any',
        target: 'src/a.ts',
        reason: 'Tracked in TICKET-1.',
        expires: '2099-01-01',
        fingerprint: shared,
        occurrence: 0,
      };

      const result = evaluateSuppressions(
        [first, second, third],
        [suppression],
        FIXTURE_REPO_ROOT,
        now,
      );
      expect(result.suppressed).toEqual([first]);
      expect(result.reported).toEqual([second, third]);
      expect(result.pinnedSuppressed).toEqual([first]);
    });

    it('an unpinned suppression over the same path defers all three', () => {
      const suppression = {
        ruleId: 'no-any',
        target: 'src/**',
        reason: 'Adoption.',
        expires: '2099-01-01',
      };

      const result = evaluateSuppressions(
        [first, second, third],
        [suppression],
        FIXTURE_REPO_ROOT,
        now,
      );
      expect(result.suppressed).toHaveLength(3);
      expect(result.reported).toEqual([]);
      expect(result.broadSuppressed).toHaveLength(3);
    });

    it('a violation added to the pinned file afterwards is reported (Requirement 4.3)', () => {
      const suppression = {
        ruleId: 'no-any',
        target: 'src/a.ts',
        reason: 'Tracked in TICKET-1.',
        expires: '2099-01-01',
        fingerprint: shared,
        occurrence: 0,
      };
      const addedLater = makeViolation({
        relPath: 'src/a.ts',
        ruleId: 'no-any',
        snippet: 'any',
        line: 30,
      });

      const before = evaluateSuppressions([first], [suppression], FIXTURE_REPO_ROOT, now);
      const after = evaluateSuppressions([first, addedLater], [suppression], FIXTURE_REPO_ROOT, now);

      // One suppression can never defer more than one finding, so writing more
      // code cannot increase what is hidden.
      expect(before.suppressed).toHaveLength(1);
      expect(after.suppressed).toHaveLength(1);
      expect(after.reported).toEqual([addedLater]);
    });

    it('a violation added above the pinned one takes its occurrence, and it is reported instead', () => {
      const suppression = {
        ruleId: 'no-any',
        target: 'src/a.ts',
        reason: 'Tracked in TICKET-1.',
        expires: '2099-01-01',
        fingerprint: shared,
        occurrence: 0,
      };
      // `occurrence` counts position within the file, so inserting an identical
      // snippet above the pinned finding renumbers it. The suppression follows
      // the index, not the finding.
      const insertedAbove = makeViolation({
        relPath: 'src/a.ts',
        ruleId: 'no-any',
        snippet: 'any',
        line: 1,
        column: 1,
      });
      const pinnedNowSecond = makeViolation({
        relPath: 'src/a.ts',
        ruleId: 'no-any',
        snippet: 'any',
        line: 2,
        column: 1,
      });

      const result = evaluateSuppressions(
        [insertedAbove, pinnedNowSecond],
        [suppression],
        FIXTURE_REPO_ROOT,
        now,
      );
      expect(result.suppressed).toEqual([insertedAbove]);
      expect(result.reported).toEqual([pinnedNowSecond]);
    });
  });
});

describe('loadSuppressions with pinned identity', () => {
  it('loads a suppression with fingerprint and occurrence', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-pinned-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/legacy/thing.ts',
            reason: 'Tracked.',
            expires: '2099-01-01',
            fingerprint:
              '0000000000000000000000000000000000000000000000000000000000000000',
            occurrence: 2,
          },
        ],
      });
      const suppressions = await loadSuppressions(repo);
      expect(suppressions).toHaveLength(1);
      const [loaded] = suppressions;
      if (loaded === undefined) {
        throw new Error('Expected one suppression to be loaded');
      }
      expect(loaded).toMatchObject({
        ruleId: 'no-any',
        target: 'src/legacy/thing.ts',
        reason: 'Tracked.',
        expires: '2099-01-01',
        fingerprint:
          '0000000000000000000000000000000000000000000000000000000000000000',
        occurrence: 2,
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects an invalid fingerprint', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-badfp-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/legacy/**',
            reason: 'Tracked.',
            expires: '2099-01-01',
            fingerprint: 'not-a-fingerprint',
          },
        ],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/fingerprint/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects an occurrence without a fingerprint', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-occno-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/legacy/**',
            reason: 'Tracked.',
            expires: '2099-01-01',
            occurrence: 2,
          },
        ],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/occurrence.*fingerprint/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects a fingerprint with no occurrence', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-noocc-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/legacy/thing.ts',
            reason: 'Tracked.',
            expires: '2099-01-01',
            fingerprint:
              '0000000000000000000000000000000000000000000000000000000000000000',
          },
        ],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/fingerprint.*without an "occurrence"/s);
      // The error says where the three values come from.
      await expect(loadSuppressions(repo)).rejects.toThrow(/checkyourvibe\.baseline\.json/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects a pinned suppression whose target is a glob', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-pinglob-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/**',
            reason: 'Tracked.',
            expires: '2099-01-01',
            fingerprint:
              '0000000000000000000000000000000000000000000000000000000000000000',
            occurrence: 0,
          },
        ],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/is a glob/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('still accepts an unpinned suppression over a glob', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-stillbroad-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/**',
            reason: 'Adoption, tracked in TICKET-1.',
            expires: '2099-01-01',
          },
        ],
      });
      const suppressions = await loadSuppressions(repo);
      expect(suppressions).toHaveLength(1);
      expect(suppressions[0]?.fingerprint).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects a negative occurrence', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-supp-negocc-'));
    try {
      await writeConfig(repo, {
        suppressions: [
          {
            ruleId: 'no-any',
            target: 'src/legacy/**',
            reason: 'Tracked.',
            expires: '2099-01-01',
            fingerprint:
              '0000000000000000000000000000000000000000000000000000000000000000',
            occurrence: -1,
          },
        ],
      });
      await expect(loadSuppressions(repo)).rejects.toThrow(SuppressionConfigError);
      await expect(loadSuppressions(repo)).rejects.toThrow(/occurrence/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('suppressionNotice', () => {
  it('counts the findings it hid and names the unpinned suppression that hid them', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const broad = {
      ruleId: 'no-any',
      target: 'src/**',
      reason: 'Adoption.',
      expires: '2099-01-01',
    };
    const result = evaluateSuppressions(
      [makeViolation({ relPath: 'src/legacy/thing.ts', ruleId: 'no-any', snippet: 'const x: any = 1;' })],
      [broad],
      FIXTURE_REPO_ROOT,
      now,
    );

    const notice = suppressionNotice(result, [], [broad]);
    expect(notice).toMatch(/1 finding suppressed this run\./);
    expect(notice).toMatch(/1 of those is unpinned/);
    expect(notice).toContain('no-any on "src/**" — Adoption.');
  });
});
