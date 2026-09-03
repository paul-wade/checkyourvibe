import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeHtml, readStatusLog } from '../../../src/dashboard/review/status-log.js';

describe('status log', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-status-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('escapes html', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('is empty when there is no log', async () => {
    expect(await readStatusLog(repo)).toEqual([]);
  });

  it('splits entries at ## and renders paragraphs, code and bold after escaping', async () => {
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(
      join(repo, 'docs', 'STATUS.md'),
      [
        '# Status',
        'Preamble that belongs to no entry.',
        '',
        '## 2026-09-01 — `cyv check` is **green**',
        'First paragraph',
        'continues here with <b>markup</b>.',
        '',
        '',
        'Second paragraph with `a < b` and **bold**.',
        '',
        '## Older',
        '',
      ].join('\n'),
      'utf8',
    );
    const entries = await readStatusLog(repo);
    expect(entries).toEqual([
      {
        titleHtml: '2026-09-01 — <code>cyv check</code> is <strong>green</strong>',
        bodyHtml:
          '<p>First paragraph continues here with &lt;b&gt;markup&lt;/b&gt;.</p>' +
          '<p>Second paragraph with <code>a &lt; b</code> and <strong>bold</strong>.</p>',
      },
      { titleHtml: 'Older', bodyHtml: '' },
    ]);
  });
});
