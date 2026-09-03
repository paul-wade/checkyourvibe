import { readFile } from 'node:fs/promises';
import type { Baseline } from './types.js';
import { baselinePath, parseBaseline } from './format.js';

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

/**
 * Read `checkyourvibe.baseline.json`, or `null` if no baseline has ever been
 * taken. `null` is a real, expected state (a repository that has not adopted
 * a baseline yet) rather than an error — callers decide what that means for
 * them (`cyv baseline --status` reports "no baseline recorded"; `cyv check
 * --since-baseline` falls back to reporting everything as fresh).
 */
export async function readBaseline(repoRoot: string): Promise<Baseline | null> {
  let raw: string;
  try {
    raw = await readFile(baselinePath(repoRoot), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }

  const { header, entries } = parseBaseline(raw);
  return { header, entries, repoRoot };
}
