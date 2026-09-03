/**
 * Taking (or refreshing) the baseline.
 *
 * Regenerating is always an explicit call from `cyv baseline` — never a side
 * effect of `cyv check` (Requirement 1.6) — so this module has no knowledge
 * of flags or confirmation; that belongs to `cli/baseline.ts`.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { RunReport } from '../report/types.js';
import { computeEntries } from './identity.js';
import { baselinePath, serializeBaseline } from './format.js';
import { BASELINE_VERSION } from './types.js';

/**
 * Write the baseline for `report` against `commit`.
 *
 * Writes atomically — to a sibling temp file, then renamed into place — so a
 * process interrupted mid-write (a killed CI job, a `Ctrl+C`) never leaves
 * `checkyourvibe.baseline.json` truncated for the next `readBaseline` or the
 * next `git diff`.
 */
export async function writeBaseline(repoRoot: string, report: RunReport, commit: string): Promise<void> {
  const entries = computeEntries(report.violations, repoRoot).map(({ entry }) => entry);
  const header = { version: BASELINE_VERSION, takenAt: new Date().toISOString(), commit };
  const content = serializeBaseline(header, entries);

  const target = baselinePath(repoRoot);
  const tmpPath = `${target}.${randomUUID()}.tmp`;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, target);
}
