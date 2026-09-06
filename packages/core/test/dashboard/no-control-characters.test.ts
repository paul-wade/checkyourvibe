import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * No source file carries a stray control character.
 *
 * This has landed twice. Both times an edit wrote an escape sequence — `\b` in
 * a regular expression, `\25b8` in a CSS `content` rule — through a layer that
 * resolved it before the file was written. The result compiles, passes every
 * other test, and is invisible in a diff: the regex silently stopped matching
 * word boundaries, and the disclosure triangle rendered as `b8`.
 *
 * Nothing in this codebase wants a raw control character in its source. Tab,
 * newline and carriage return are the only ones that belong.
 */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
const SKIP = new Set(['node_modules', 'dist', '.git', 'fixtures']);

function isControl(code: number): boolean {
  return (code < 0x20 || code === 0x7f) && !ALLOWED.has(code);
}

function collect(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(path, found);
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('source text', () => {
  it('contains no control characters outside tab and newline', () => {
    const files = collect(join('packages', 'core', 'src'), collect(join('packages', 'core', 'test'), []));

    // A file list this test cannot build is a test that proves nothing.
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (!isControl(code)) continue;
        const line = text.slice(0, i).split('\n').length;
        offenders.push(`${file}:${line} U+${code.toString(16).padStart(4, '0').toUpperCase()}`);
        break;
      }
    }

    expect(offenders).toEqual([]);
  });
});
