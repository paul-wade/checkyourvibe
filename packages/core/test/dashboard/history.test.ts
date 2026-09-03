import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRun,
  appendRunRecord,
  buildRunRecord,
  historyPath,
  readHistory,
  type RunRecord,
} from '../../src/dashboard/history.js';
import type { RunReport } from '../../src/report/types.js';

/**
 * Violation file paths are built under `repoRoot` (rather than a fixed
 * `/repo/...` prefix) so `buildRunRecord`'s repo-relativization actually has
 * something to relativize against — `repoRoot` here is always the real
 * temp directory a test is using, never a placeholder string it doesn't
 * match.
 */
function reportFor(ruleIds: string[], repoRoot: string, filesChecked = ruleIds.length): RunReport {
  return {
    violations: ruleIds.map((ruleId, i) => ({
      file: join(repoRoot, 'src', `file${i}.ts`),
      line: 1,
      column: 1,
      ruleId,
      message: 'boom',
      snippet: 'x',
      severity: 'error' as const,
    })),
    skipped: [],
    diagnostics: [],
    filesChecked,
    mode: 'all',
    projectRulesSkipped: [],
    strict: false,
  };
}

describe('dashboard history', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-history-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('returns an empty history when no file has been written yet', async () => {
    expect(await readHistory(repo)).toEqual([]);
  });

  it('appends and reads back a run, round-tripping every field', async () => {
    const report = reportFor(['no-any', 'no-any', 'no-console'], repo);
    const written = await appendRun(repo, report, 'abc123', new Date('2026-01-01T00:00:00.000Z'));

    const history = await readHistory(repo);
    expect(history).toEqual([written]);
    expect(written).toEqual({
      timestamp: '2026-01-01T00:00:00.000Z',
      commit: 'abc123',
      totalViolations: 3,
      ruleCounts: { 'no-any': 2, 'no-console': 1 },
      fileCounts: { 'src/file0.ts': 1, 'src/file1.ts': 1, 'src/file2.ts': 1 },
      filesChecked: 3,
    });
  });

  it('appends multiple runs in order, oldest first', async () => {
    await appendRun(repo, reportFor(['no-any'], repo), 'commit-1', new Date('2026-01-01T00:00:00.000Z'));
    await appendRun(repo, reportFor([], repo), 'commit-2', new Date('2026-01-02T00:00:00.000Z'));

    const history = await readHistory(repo);
    expect(history).toHaveLength(2);
    expect(history.map((r) => r.commit)).toEqual(['commit-1', 'commit-2']);
    expect(history[1]?.totalViolations).toBe(0);
  });

  it('writes each record as exactly one line, so a single write lands atomically', async () => {
    const record = buildRunRecord(reportFor(['no-any'], repo), repo, 'commit-1', new Date('2026-01-01T00:00:00.000Z'));
    await appendRunRecord(repo, record);
    await appendRunRecord(
      repo,
      buildRunRecord(reportFor([], repo), repo, 'commit-2', new Date('2026-01-02T00:00:00.000Z')),
    );

    const raw = await readFile(historyPath(repo), 'utf-8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('does not corrupt the file when two runs append concurrently', async () => {
    const a = buildRunRecord(reportFor(['no-any'], repo), repo, 'commit-a', new Date('2026-01-01T00:00:00.000Z'));
    const b = buildRunRecord(
      reportFor(['no-console', 'no-console'], repo),
      repo,
      'commit-b',
      new Date('2026-01-02T00:00:00.000Z'),
    );

    await Promise.all([appendRunRecord(repo, a), appendRunRecord(repo, b)]);

    const history = await readHistory(repo);
    expect(history).toHaveLength(2);
    const commits = history.map((r) => r.commit).sort();
    expect(commits).toEqual(['commit-a', 'commit-b']);
  });

  it('skips a malformed line instead of discarding the whole history', async () => {
    const good = buildRunRecord(reportFor(['no-any'], repo), repo, 'commit-1', new Date('2026-01-01T00:00:00.000Z'));
    await appendRunRecord(repo, good);

    const target = historyPath(repo);
    await appendFile(target, 'not valid json\n{"totalViolations":"nope"}\n');

    const history = await readHistory(repo);
    expect(history).toEqual([good]);
  });

  it('buildRunRecord counts violations per rule and leaves rules with zero findings out of the map', () => {
    const record: RunRecord = buildRunRecord(
      reportFor(['no-any', 'no-console', 'no-any'], repo),
      repo,
      'commit-1',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(record.ruleCounts).toEqual({ 'no-any': 2, 'no-console': 1 });
    // Asserting key ABSENCE rather than indexing and asserting the value is
    // undefined. Both express the same intent, but only this one says it
    // directly — and indexing to prove a value is missing is the one shape
    // no-unsafe-index-access cannot distinguish from indexing and using it.
    expect(Object.hasOwn(record.ruleCounts, 'no-as-cast')).toBe(false);
  });

  describe('per-file counts (docs/ROADMAP.md, "0031 — The dashboard as something you would leave open")', () => {
    it('buildRunRecord counts violations per repo-relative file, keyed with forward slashes', () => {
      const record = buildRunRecord(
        reportFor(['no-any', 'no-any', 'no-console'], repo),
        repo,
        'commit-1',
        new Date('2026-01-01T00:00:00.000Z'),
      );
      // Three violations from `reportFor` land on three distinct files
      // (file0.ts, file1.ts, file2.ts), one violation each.
      expect(record.fileCounts).toEqual({
        'src/file0.ts': 1,
        'src/file1.ts': 1,
        'src/file2.ts': 1,
      });
    });

    it('counts multiple violations in the same file under one key', () => {
      const report: RunReport = {
        violations: [
          { file: join(repo, 'src', 'hot.ts'), line: 1, column: 1, ruleId: 'no-any', message: 'x', snippet: 'x', severity: 'error' },
          { file: join(repo, 'src', 'hot.ts'), line: 2, column: 1, ruleId: 'no-console', message: 'x', snippet: 'x', severity: 'error' },
          { file: join(repo, 'src', 'cold.ts'), line: 1, column: 1, ruleId: 'no-any', message: 'x', snippet: 'x', severity: 'error' },
        ],
        skipped: [],
        diagnostics: [],
        filesChecked: 2,
        mode: 'all',
        projectRulesSkipped: [],
        strict: false,
      };
      const record = buildRunRecord(report, repo, 'commit-1', new Date('2026-01-01T00:00:00.000Z'));
      expect(record.fileCounts).toEqual({ 'src/hot.ts': 2, 'src/cold.ts': 1 });
    });

    it('leaves a violation whose file falls outside repoRoot out of fileCounts, mirroring baseline identity', () => {
      const report: RunReport = {
        violations: [
          { file: join(repo, 'src', 'in.ts'), line: 1, column: 1, ruleId: 'no-any', message: 'x', snippet: 'x', severity: 'error' },
          { file: '/somewhere/else/out.ts', line: 1, column: 1, ruleId: 'no-any', message: 'x', snippet: 'x', severity: 'error' },
        ],
        skipped: [],
        diagnostics: [],
        filesChecked: 2,
        mode: 'all',
        projectRulesSkipped: [],
        strict: false,
      };
      const record = buildRunRecord(report, repo, 'commit-1', new Date('2026-01-01T00:00:00.000Z'));
      // Both violations still count toward ruleCounts/totalViolations — only
      // the per-file breakdown drops the one outside the repo.
      expect(record.totalViolations).toBe(2);
      expect(record.fileCounts).toEqual({ 'src/in.ts': 1 });
    });

    it('round-trips fileCounts through append and read', async () => {
      const written = await appendRun(
        repo,
        reportFor(['no-any', 'no-any'], repo),
        'commit-1',
        new Date('2026-01-01T00:00:00.000Z'),
      );
      const history = await readHistory(repo);
      expect(history).toEqual([written]);
      expect(history[0]?.fileCounts).toEqual({ 'src/file0.ts': 1, 'src/file1.ts': 1 });
    });

    it('accepts a legacy history line recorded before fileCounts existed', async () => {
      // A record written by a version of this tool that predates per-file
      // tracking simply has no `fileCounts` key at all — not an empty object,
      // absent entirely. `isRunRecord` must still accept it: rejecting every
      // line ever recorded before this feature shipped would silently empty
      // out a user's whole trend and never-fired history the moment they
      // upgrade.
      const legacyLine = JSON.stringify({
        timestamp: '2025-01-01T00:00:00.000Z',
        commit: 'legacy-commit',
        totalViolations: 1,
        ruleCounts: { 'no-any': 1 },
        filesChecked: 1,
      });
      await mkdir(join(repo, '.cyv-review'), { recursive: true });
      await appendFile(historyPath(repo), `${legacyLine}\n`, 'utf-8');

      const history = await readHistory(repo);
      expect(history).toHaveLength(1);
      expect(history[0]?.commit).toBe('legacy-commit');
      expect(history[0]?.fileCounts).toBeUndefined();
    });

    it('rejects a history line whose fileCounts is not a record of numbers', async () => {
      const badLine = JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        commit: 'commit-1',
        totalViolations: 1,
        ruleCounts: { 'no-any': 1 },
        filesChecked: 1,
        fileCounts: { 'src/a.ts': 'not-a-number' },
      });
      await mkdir(join(repo, '.cyv-review'), { recursive: true });
      await appendFile(historyPath(repo), `${badLine}\n`, 'utf-8');

      const stats = { unparseableLines: 0 };
      const history = await readHistory(repo, stats);
      expect(history).toEqual([]);
      expect(stats.unparseableLines).toBe(1);
    });
  });
});
