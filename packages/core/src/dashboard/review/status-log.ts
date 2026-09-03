/**
 * `docs/STATUS.md`, one entry per `##` heading, rendered with the smallest
 * markup the log uses: paragraphs, inline code and bold. The full renderer is
 * for the document browser; the log is read on the home page and must not
 * pull the vendored renderer in with it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { esc } from '../render.js';

export { esc as escapeHtml } from '../render.js';

export interface StatusEntry {
  titleHtml: string;
  bodyHtml: string;
}

interface RawEntry {
  title: string;
  lines: string[];
}

/** Escape first, then allow back-ticked code and bold. The order is what keeps it safe. */
function renderInline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderBody(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter((para) => para !== '')
    .map((para) => `<p>${renderInline(para).replace(/\n/g, ' ')}</p>`)
    .join('');
}

/** No log is an empty log: a project that has not started one still has a page. */
export async function readStatusLog(repo: string): Promise<StatusEntry[]> {
  let text: string;
  try {
    text = await readFile(path.join(repo, 'docs', 'STATUS.md'), 'utf8');
  } catch {
    return [];
  }

  const entries: RawEntry[] = [];
  let current: RawEntry | undefined;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    const title = heading?.[1];
    if (title !== undefined) {
      if (current !== undefined) entries.push(current);
      current = { title, lines: [] };
      continue;
    }
    if (current !== undefined) current.lines.push(line);
  }
  if (current !== undefined) entries.push(current);

  return entries.map((entry) => ({
    titleHtml: renderInline(entry.title),
    bodyHtml: renderBody(entry.lines.join('\n')),
  }));
}
