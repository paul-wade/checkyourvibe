/**
 * On-disk shape of the baseline file.
 *
 * JSON, committed, with every entry rendered on its own line so a pull
 * request diff shows precisely which entries were added or removed —
 * `JSON.stringify(x, null, 2)` on an array of small objects would instead
 * reflow every field onto its own line, burying the one-entry-added-or-removed
 * signal in noise. Entries are sorted deterministically (path, then rule,
 * then fingerprint, then occurrence) so re-serializing the same logical
 * baseline always produces byte-identical output, regardless of the order
 * violations happened to arrive in.
 */
import { join } from 'node:path';
import { isUnknownArray } from '../guards.js';
import type { Baseline, BaselineEntry, BaselineHeader } from './types.js';


export const BASELINE_FILENAME = 'checkyourvibe.baseline.json';
export { BASELINE_VERSION } from './types.js';

export class BaselineFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineFormatError';
  }
}

export function baselinePath(repoRoot: string): string {
  return join(repoRoot, BASELINE_FILENAME);
}

function compareEntries(a: BaselineEntry, b: BaselineEntry): number {
  const path = a.path.localeCompare(b.path);
  if (path !== 0) return path;
  const rule = a.ruleId.localeCompare(b.ruleId);
  if (rule !== 0) return rule;
  const fingerprint = a.fingerprint.localeCompare(b.fingerprint);
  if (fingerprint !== 0) return fingerprint;
  return a.occurrence - b.occurrence;
}

/** Canonical entry order: path, then rule, then fingerprint, then occurrence (Requirements 1.2, 1.4). */
export function sortEntries(entries: readonly BaselineEntry[]): BaselineEntry[] {
  return [...entries].sort(compareEntries);
}

/** Fixed key order, no incidental whitespace — every entry is exactly one line. */
function serializeEntry(entry: BaselineEntry): string {
  return JSON.stringify({
    path: entry.path,
    ruleId: entry.ruleId,
    fingerprint: entry.fingerprint,
    occurrence: entry.occurrence,
    line: entry.line,
  });
}

/**
 * Render a baseline to its on-disk JSON text.
 *
 * Deterministic: the same header and the same set of entries (any input
 * order) always produce the same string, byte for byte.
 */
export function serializeBaseline(header: BaselineHeader, entries: readonly BaselineEntry[]): string {
  const sorted = sortEntries(entries);
  const entryLines = sorted.map(
    (entry, i) => `    ${serializeEntry(entry)}${i < sorted.length - 1 ? ',' : ''}`,
  );

  return [
    '{',
    `  "version": ${JSON.stringify(header.version)},`,
    `  "takenAt": ${JSON.stringify(header.takenAt)},`,
    `  "commit": ${JSON.stringify(header.commit)},`,
    '  "entries": [',
    ...entryLines,
    '  ]',
    '}',
    '',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function parseEntry(raw: unknown, index: number): BaselineEntry {
  if (!isRecord(raw)) {
    throw new BaselineFormatError(`Baseline entry at index ${index} must be an object.`);
  }

  const { path, ruleId, fingerprint, occurrence, line } = raw;
  if (
    typeof path !== 'string' ||
    typeof ruleId !== 'string' ||
    typeof fingerprint !== 'string' ||
    typeof occurrence !== 'number' ||
    typeof line !== 'number'
  ) {
    throw new BaselineFormatError(
      `Baseline entry at index ${index} is missing one of path, ruleId, fingerprint, occurrence, line.`,
    );
  }

  return { path, ruleId, fingerprint, occurrence, line };
}

/**
 * Parse baseline file text into its header and entries.
 *
 * Throws `BaselineFormatError` on anything that does not match the expected
 * shape, rather than returning a partially-usable value — a corrupt or
 * hand-edited baseline should stop `cyv baseline --status` and `--since-baseline`
 * outright, not silently drop entries.
 */
export function parseBaseline(raw: string): { header: BaselineHeader; entries: BaselineEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BaselineFormatError(
      `Baseline file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new BaselineFormatError('Baseline file must contain a JSON object.');
  }

  const { version, takenAt, commit, entries } = parsed;
  if (
    typeof version !== 'number' ||
    typeof takenAt !== 'string' ||
    typeof commit !== 'string' ||
    !isUnknownArray(entries)
  ) {
    throw new BaselineFormatError(
      'Baseline file is missing one of the required top-level fields: version, takenAt, commit, entries.',
    );
  }

  const parsedEntries = entries.map((entry: unknown, i: number) => parseEntry(entry, i));

  return { header: { version, takenAt, commit }, entries: parsedEntries };
}

/** Re-exported so callers that already have a `Baseline` can re-serialize it (e.g. for a diff preview). */
export function serialize(baseline: Pick<Baseline, 'header' | 'entries'>): string {
  return serializeBaseline(baseline.header, baseline.entries);
}
