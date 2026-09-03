import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  type ManagedBlockComment,
  type PlannedWrite,
} from '../protocol/index.js';
import { isUnknownArray } from '../guards.js';
import { mergeToml, TomlMergeError } from './toml.js';

export class MergeError extends Error {
  constructor(
    readonly code:
      | 'CORRUPT_BLOCK'
      | 'INVALID_JSON'
      | 'MISSING_BLOCK_ID'
      | 'MISSING_TOML_TABLE_ARRAY_PATH'
      | 'UNPARSEABLE_TOML',
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

export interface MergeOutcome {
  path: string;
  changed: boolean;
  before: string | null;
  after: string;
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && err.code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeCreateIfAbsent(existing: string | null, content: string): string {
  return existing ?? content;
}

function fileEndsWithBlankLine(text: string): boolean {
  if (!text.endsWith('\n')) {
    return false;
  }

  const withoutFinal = text.endsWith('\r\n') ? text.slice(0, -2) : text.slice(0, -1);
  return (
    withoutFinal.length === 0 ||
    withoutFinal.endsWith('\n') ||
    withoutFinal.endsWith('\r\n')
  );
}

function appendBlock(existing: string, start: string, body: string, end: string): string {
  const block = `${start}\n${body}\n${end}`;
  if (existing === '') {
    return block;
  }

  if (fileEndsWithBlankLine(existing)) {
    return `${existing}${block}`;
  }

  const lineEnding = existing.endsWith('\r\n')
    ? '\r\n'
    : existing.endsWith('\n')
      ? '\n'
      : '';

  if (lineEnding === '') {
    return `${existing}\n\n${block}`;
  }

  return `${existing}${lineEnding}${block}`;
}

export function mergeManagedBlock(
  existing: string | null,
  blockId: string,
  body: string,
  comment: ManagedBlockComment = 'html',
): string {
  const start = MANAGED_BLOCK_START(blockId, comment);
  const end = MANAGED_BLOCK_END(blockId, comment);

  if (existing === null || existing === '') {
    return `${start}\n${body}\n${end}`;
  }

  // A single occurrence has firstIndexOf === lastIndexOf; that equality is the
  // invariant this function needs, and it costs nothing to check with plain
  // `number` results instead of collecting every position into an array whose
  // indexing the checker cannot trust.
  const firstStart = existing.indexOf(start);
  const lastStart = existing.lastIndexOf(start);

  if (firstStart === -1) {
    if (existing.includes(end)) {
      throw new MergeError(
        'CORRUPT_BLOCK',
        '',
        `End delimiter found without start for block ${blockId}`,
      );
    }
    return appendBlock(existing, start, body, end);
  }

  if (firstStart !== lastStart) {
    throw new MergeError(
      'CORRUPT_BLOCK',
      '',
      `Multiple start delimiters for block ${blockId}`,
    );
  }

  const startIndex = firstStart;
  const endIndex = existing.indexOf(end, startIndex + start.length);

  if (endIndex === -1) {
    throw new MergeError(
      'CORRUPT_BLOCK',
      '',
      `Missing end delimiter for block ${blockId}`,
    );
  }

  const firstEnd = existing.indexOf(end);
  if (firstEnd !== -1 && firstEnd < startIndex) {
    throw new MergeError(
      'CORRUPT_BLOCK',
      '',
      `End delimiter appears before start for block ${blockId}`,
    );
  }

  const between = `\n${body}\n`;
  return existing.slice(0, startIndex + start.length) + between + existing.slice(endIndex);
}

/**
 * Merge two arrays, keeping entries that are not ours.
 *
 * Replacing an array wholesale keeps a re-run from duplicating our own entry,
 * but it also deletes entries belonging to other tools. An agent's settings
 * file is shared ground — someone else's hook has to survive our install.
 *
 * With a marker, an existing entry containing it is one of ours from a previous
 * run and is dropped in favour of the new set; everything else is preserved in
 * its original order, with ours appended. Without a marker there is no way to
 * tell ours from theirs, so the old replace-wholesale behaviour stands.
 */
function mergeArray(existing: unknown[], ours: unknown[], marker: string | undefined): unknown[] {
  if (marker === undefined) {
    return ours;
  }
  const isOurs = (entry: unknown): boolean => JSON.stringify(entry)?.includes(marker) ?? false;
  const foreign = existing.filter((entry) => !isOurs(entry));
  return [...foreign, ...ours];
}

function mergeDeep(
  existing: Record<string, unknown>,
  ours: Record<string, unknown>,
  marker: string | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };

  for (const key of Object.keys(ours)) {
    const existingValue = result[key];
    const ourValue = ours[key];

    if (
      Object.prototype.hasOwnProperty.call(result, key) &&
      isPlainObject(existingValue) &&
      isPlainObject(ourValue)
    ) {
      result[key] = mergeDeep(existingValue, ourValue, marker);
    } else if (
      Object.prototype.hasOwnProperty.call(result, key) &&
      isUnknownArray(existingValue) &&
      isUnknownArray(ourValue)
    ) {
      result[key] = mergeArray(existingValue, ourValue, marker);
    } else {
      result[key] = ourValue;
    }
  }

  return result;
}

function detectIndent(raw: string): string | number {
  const match = raw.match(/\n([ \t]+)\S/);
  const candidate = match?.[1];

  if (candidate === '  ' || candidate === '    ' || candidate === '\t') {
    return candidate;
  }

  return 2;
}

function detectFinalNewline(raw: string): string {
  if (raw.endsWith('\r\n')) {
    return '\r\n';
  }

  if (raw.endsWith('\n')) {
    return '\n';
  }

  return '';
}

export function mergeJson(
  existing: string | null,
  ourKeys: Record<string, unknown>,
  ownershipMarker?: string,
): string {
  const raw = existing === null || existing.trim().length === 0 ? '{}' : existing;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MergeError(
      'INVALID_JSON',
      '',
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new MergeError('INVALID_JSON', '', 'JSON root is not an object');
  }

  const merged = mergeDeep(parsed, ourKeys, ownershipMarker);
  const indent = detectIndent(existing ?? '');
  const finalNewline = detectFinalNewline(existing ?? '');

  return JSON.stringify(merged, null, indent) + finalNewline;
}

export async function applyPlannedWrite(write: PlannedWrite): Promise<MergeOutcome> {
  const before = await readTarget(write.path);
  const after = mergeForWrite(write, before);
  const changed = after !== before;

  if (changed) {
    const temp = join(dirname(write.path), `.${randomUUID()}.tmp`);
    await writeFile(temp, after, 'utf-8');
    await rename(temp, write.path);
  }

  return { path: write.path, changed, before, after };
}

export async function planDiff(
  writes: PlannedWrite[],
): Promise<{ path: string; changed: boolean; preview: string }[]> {
  const results: { path: string; changed: boolean; preview: string }[] = [];

  for (const write of writes) {
    const before = await readTarget(write.path);
    const after = mergeForWrite(write, before);
    const changed = after !== before;

    results.push({
      path: write.path,
      changed,
      preview: changed ? formatDiff(write.path, before, after) : '',
    });
  }

  return results;
}

async function readTarget(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) {
      return null;
    }
    throw err;
  }
}

function mergeForWrite(write: PlannedWrite, existing: string | null): string {
  switch (write.strategy) {
    case 'create-if-absent':
      return mergeCreateIfAbsent(existing, write.content);

    case 'managed-block': {
      if (write.blockId === undefined) {
        throw new MergeError(
          'MISSING_BLOCK_ID',
          write.path,
          'blockId is required for managed-block',
        );
      }
      try {
        return mergeManagedBlock(existing, write.blockId, write.content, write.blockComment);
      } catch (err) {
        if (err instanceof MergeError && err.path === '') {
          throw new MergeError(err.code, write.path, err.message);
        }
        throw err;
      }
    }

    case 'json-merge': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(write.content);
      } catch (err) {
        throw new MergeError(
          'INVALID_JSON',
          write.path,
          `Invalid JSON in planned content: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!isPlainObject(parsed)) {
        throw new MergeError('INVALID_JSON', write.path, 'Planned JSON content is not an object');
      }

      try {
        return mergeJson(existing, parsed, write.ownershipMarker);
      } catch (err) {
        if (err instanceof MergeError && err.path === '') {
          throw new MergeError(err.code, write.path, err.message);
        }
        throw err;
      }
    }

    case 'toml-merge': {
      if (write.tomlTableArrayPath === undefined) {
        throw new MergeError(
          'MISSING_TOML_TABLE_ARRAY_PATH',
          write.path,
          'tomlTableArrayPath is required for toml-merge',
        );
      }
      try {
        return mergeToml(
          existing,
          write.tomlTableArrayPath,
          splitLines(write.content),
          write.ownershipMarker,
        );
      } catch (err) {
        if (err instanceof TomlMergeError) {
          throw new MergeError('UNPARSEABLE_TOML', write.path, err.message);
        }
        throw err;
      }
    }
  }
}

type Edit = { type: 'keep' | 'add' | 'remove'; line: string };

/**
 * Read an array element that a loop invariant guarantees is present.
 *
 * `noUncheckedIndexedAccess` types every index read as possibly `undefined`
 * because the compiler has no way to see loop bounds as a proof of presence.
 * Rather than assert past that with `!`, this checks for real: if the
 * invariant is ever wrong, it throws with the context needed to find the bug
 * instead of silently continuing on corrupted state. None of the arrays this
 * is used on (lines, diff rows, edits) legitimately contain `undefined`
 * elements, so `undefined` here only ever means "index out of bounds".
 */
function elementAt<T>(array: readonly T[], index: number, what: string): T {
  const value = array[index];
  if (value === undefined) {
    throw new Error(`diff algorithm invariant violated: expected ${what} at index ${index}`);
  }
  return value;
}

function splitLines(text: string | null): string[] {
  if (text === null) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function diffLines(old: string[], now: string[]): Edit[] {
  const m = old.length;
  const n = now.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  // Every row and every cell in `dp` is preallocated above, so a lookup at any
  // `0 <= i <= m, 0 <= j <= n` always hits a real number; `elementAt` states
  // that invariant as a check instead of a blind assertion.
  const cellAt = (i: number, j: number): number =>
    elementAt(elementAt(dp, i, 'dp row'), j, 'dp cell');

  for (let i = 1; i <= m; i++) {
    const row = elementAt(dp, i, 'dp row');
    const oldLine = elementAt(old, i - 1, 'old line');

    for (let j = 1; j <= n; j++) {
      const nowLine = elementAt(now, j - 1, 'now line');
      row[j] =
        oldLine === nowLine
          ? cellAt(i - 1, j - 1) + 1
          : Math.max(cellAt(i - 1, j), cellAt(i, j - 1));
    }
  }

  const edits: Edit[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && elementAt(old, i - 1, 'old line') === elementAt(now, j - 1, 'now line')) {
      edits.unshift({ type: 'keep', line: elementAt(old, i - 1, 'old line') });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || cellAt(i, j - 1) >= cellAt(i - 1, j))) {
      edits.unshift({ type: 'add', line: elementAt(now, j - 1, 'now line') });
      j--;
    } else {
      edits.unshift({ type: 'remove', line: elementAt(old, i - 1, 'old line') });
      i--;
    }
  }

  return edits;
}

function formatDiff(path: string, before: string | null, after: string): string {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const edits = diffLines(oldLines, newLines);

  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    if (edit.type === 'add') added++;
    else if (edit.type === 'remove') removed++;
  }

  if (added === 0 && removed === 0) {
    return '';
  }

  const firstChange = edits.findIndex(edit => edit.type !== 'keep');
  if (firstChange === -1) {
    return '';
  }

  const context = 2;
  const maxChanged = 10;

  let windowStart = Math.max(0, firstChange - context);
  let windowEnd = firstChange;
  let seen = 0;

  for (let k = firstChange; k < edits.length; k++) {
    const edit = elementAt(edits, k, 'edit');
    if (edit.type !== 'keep') {
      seen++;
    }
    windowEnd = k;
    if (seen === maxChanged) break;
  }

  windowEnd = Math.min(edits.length - 1, windowEnd + context);

  let oldLine = 1;
  let newLine = 1;
  for (let k = 0; k < windowStart; k++) {
    const edit = elementAt(edits, k, 'edit');
    if (edit.type === 'keep') {
      oldLine++;
      newLine++;
    } else if (edit.type === 'remove') {
      oldLine++;
    } else {
      newLine++;
    }
  }

  let oldCount = 0;
  let newCount = 0;
  const hunkLines: string[] = [];

  for (let k = windowStart; k <= windowEnd; k++) {
    const edit = elementAt(edits, k, 'edit');
    if (edit.type === 'keep') {
      oldCount++;
      newCount++;
      hunkLines.push(` ${edit.line}`);
    } else if (edit.type === 'remove') {
      oldCount++;
      hunkLines.push(`-${edit.line}`);
    } else {
      newCount++;
      hunkLines.push(`+${edit.line}`);
    }
  }

  const oldRange = oldCount === 1 ? `${oldLine}` : `${oldLine},${oldCount}`;
  const newRange = newCount === 1 ? `${newLine}` : `${newLine},${newCount}`;
  const lines = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...hunkLines,
  ];

  if (windowEnd < edits.length - 1) {
    lines.push('...');
  }

  lines.push(`+${added}, -${removed}`);
  return lines.join('\n');
}
