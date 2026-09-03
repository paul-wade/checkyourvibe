import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  IGNORED_DIRS,
  fileMtime,
  findMarkdown,
  safeResolve,
  slug,
  splitSections,
} from '../../../src/dashboard/review/documents.js';

describe('findMarkdown', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-docs-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('lists markdown repo-relative with forward slashes, sorted, skipping ignored directories', async () => {
    await mkdir(join(repo, 'docs', 'specs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'specs', 'z.md'), '', 'utf8');
    await writeFile(join(repo, 'docs', 'a.md'), '', 'utf8');
    await writeFile(join(repo, 'README.md'), '', 'utf8');
    await writeFile(join(repo, 'notes.txt'), '', 'utf8');
    for (const ignored of IGNORED_DIRS) {
      await mkdir(join(repo, ignored), { recursive: true });
      await writeFile(join(repo, ignored, 'hidden.md'), '', 'utf8');
    }
    expect(await findMarkdown(repo)).toEqual(['README.md', 'docs/a.md', 'docs/specs/z.md']);
  });

  it('does not follow symbolic links', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cyv-outside-'));
    try {
      await writeFile(join(outside, 'secret.md'), '', 'utf8');
      await writeFile(join(repo, 'a.md'), '', 'utf8');
      let linked = true;
      try {
        await symlink(outside, join(repo, 'link'), 'junction');
      } catch {
        // Creating links may need privileges this account lacks; the walk is
        // then trivially safe and there is nothing to assert against.
        linked = false;
      }
      expect(await findMarkdown(repo)).toEqual(['a.md']);
      if (linked) {
        expect(await safeResolve(repo, 'link/secret.md')).toBeNull();
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('safeResolve', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-safe-'));
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'ok.md'), '# ok\n', 'utf8');
    await writeFile(join(repo, 'docs', 'ok.txt'), 'no', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('resolves a markdown file inside the repository to its real path', async () => {
    const resolved = await safeResolve(repo, 'docs/ok.md');
    expect(resolved).toBe(await realpath(join(repo, 'docs', 'ok.md')));
    expect(resolved?.split(sep).join('/')).toMatch(/\/docs\/ok\.md$/);
  });

  it('refuses paths that escape, are not markdown, or do not exist', async () => {
    expect(await safeResolve(repo, '../ok.md')).toBeNull();
    expect(await safeResolve(repo, 'docs/../../ok.md')).toBeNull();
    expect(await safeResolve(repo, 'docs/ok.txt')).toBeNull();
    expect(await safeResolve(repo, 'docs/missing.md')).toBeNull();
    expect(await safeResolve(repo, 'docs/ok.md\0.md')).toBeNull();
    expect(await safeResolve(repo, '')).toBeNull();
    expect(await safeResolve(repo, null)).toBeNull();
    expect(await safeResolve(repo, undefined)).toBeNull();
  });

  it('refuses an absolute path outside the repository even when it is markdown', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cyv-elsewhere-'));
    try {
      await writeFile(join(outside, 'x.md'), '', 'utf8');
      expect(await safeResolve(repo, join(outside, 'x.md'))).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('splitSections and slug', () => {
  it('slugs a heading the way anchors expect', () => {
    expect(slug('Requirement 2 — Needs you')).toBe('requirement-2-needs-you');
    expect(slug('  ## Odd!!  ')).toBe('odd');
    expect(slug('x'.repeat(80))).toHaveLength(60);
  });

  it('splits at ## outside fences and ignores ## inside them', () => {
    const md = [
      'Intro line',
      '',
      '## First',
      'body',
      '```',
      '## not a heading',
      '```',
      '### deeper stays inside',
      '## Second',
      'more',
    ].join('\n');
    const sections = splitSections(md);
    expect(sections.map((s) => [s.title, s.anchor])).toEqual([
      ['', ''],
      ['First', 'first'],
      ['Second', 'second'],
    ]);
    expect(sections[1]?.source).toBe(
      ['## First', 'body', '```', '## not a heading', '```', '### deeper stays inside'].join('\n'),
    );
    expect(sections[0]?.source).toBe('Intro line\n');
  });

  it('drops empty sections and starts at a heading without a preamble', () => {
    expect(splitSections('\n\n## Only\n\ntext\n').map((s) => s.title)).toEqual(['Only']);
    expect(splitSections('')).toEqual([]);
  });
});

describe('fileMtime', () => {
  it('reads a whole-millisecond modification time', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'cyv-mtime-'));
    try {
      await writeFile(join(repo, 'a.md'), '', 'utf8');
      const at = await fileMtime(repo, 'a.md');
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThan(0);
      await expect(fileMtime(repo, 'missing.md')).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
