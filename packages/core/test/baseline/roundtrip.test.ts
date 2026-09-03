import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBaseline } from '../../src/baseline/read.js';
import { writeBaseline } from '../../src/baseline/write.js';
import { baselinePath } from '../../src/baseline/format.js';
import { partitionViolations } from '../../src/baseline/partition.js';
import type { RunReport } from '../../src/report/types.js';
import { makeViolation } from './fixtures.js';

function reportFor(violations: RunReport['violations']): RunReport {
  return {
    violations,
    skipped: [],
    diagnostics: [],
    filesChecked: violations.length,
    mode: 'all',
    projectRulesSkipped: [],
    strict: false,
  };
}

describe('baseline read/write round-trip', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-baseline-rt-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(repo, { recursive: true, force: true });
  });

  it('reads back exactly what was written', async () => {
    const violations = [
      makeViolation({ repoRoot: repo, relPath: 'src/a.ts', line: 3, ruleId: 'no-any', snippet: 'a: any' }),
      makeViolation({ repoRoot: repo, relPath: 'src/b.ts', line: 9, ruleId: 'no-console', snippet: 'console.log(1)' }),
    ];

    await writeBaseline(repo, reportFor(violations), 'commit-1');
    const baseline = await readBaseline(repo);

    expect(baseline).not.toBeNull();
    expect(baseline?.header.commit).toBe('commit-1');
    expect(baseline?.entries).toHaveLength(2);
    expect(baseline?.repoRoot).toBe(repo);
  });

  it('returns null when no baseline has been taken', async () => {
    expect(await readBaseline(repo)).toBeNull();
  });

  it('writes byte-identical files across two runs given the same input', async () => {
    const violations = [
      makeViolation({ repoRoot: repo, relPath: 'src/a.ts', line: 3, ruleId: 'no-any', snippet: 'a: any' }),
      makeViolation({ repoRoot: repo, relPath: 'src/b.ts', line: 9, ruleId: 'no-console', snippet: 'console.log(1)' }),
    ];

    await writeBaseline(repo, reportFor(violations), 'commit-1');
    const firstText = await readFile(baselinePath(repo), 'utf-8');

    // Same logical set, different array order — as if a different analyzer
    // traversal order had produced them.
    await writeBaseline(repo, reportFor([...violations].reverse()), 'commit-1');
    const secondText = await readFile(baselinePath(repo), 'utf-8');

    expect(secondText).toBe(firstText);
  });

  it('detects a stale entry once its violation is fixed', async () => {
    const stillPresent = makeViolation({ repoRoot: repo, relPath: 'src/a.ts', line: 3, ruleId: 'no-any', snippet: 'a: any' });
    const willBeFixed = makeViolation({
      repoRoot: repo,
      relPath: 'src/b.ts',
      line: 9,
      ruleId: 'no-console',
      snippet: 'console.log(1)',
    });

    await writeBaseline(repo, reportFor([stillPresent, willBeFixed]), 'commit-1');
    const baseline = await readBaseline(repo);
    expect(baseline).not.toBeNull();

    if (baseline === null) {
      throw new Error('baseline unexpectedly missing');
    }

    // `willBeFixed` no longer shows up in the current violation set.
    const result = partitionViolations([stillPresent], baseline);

    expect(result.baselined).toEqual([stillPresent]);
    expect(result.fresh).toEqual([]);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.ruleId).toBe('no-console');
  });
});
