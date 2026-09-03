/**
 * The document browser's view of the repository (0040 Requirement 7.2): which
 * markdown files exist, which path a request may open, and how a document
 * splits into sections that can each carry a comment anchor.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { REVIEW_DIR } from './comments.js';

/**
 * `.claude` holds agent worktrees, each a full checkout. Walking them found
 * every spec once per worktree: 2,104 of 1,109 listed documents came from
 * there, burying the project's own docs in copies of themselves.
 */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.claude',
  REVIEW_DIR,
  '.playwright-mcp',
]);

export interface DocumentSection {
  title: string;
  /** `slug(title)`, or '' for the text before the first heading. */
  anchor: string;
  /** The section's markdown, heading line included. */
  source: string;
}

/** Repo-relative, forward slashes, sorted. Symbolic links are never followed. */
export async function findMarkdown(repo: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // A link inside the repository can point outside it.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.md')) {
        found.push(path.relative(repo, full).split(path.sep).join('/'));
      }
    }
  };
  await walk(repo);
  return found.sort();
}

function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * The absolute path a request may read, or null.
 *
 * Lexical containment alone is defeated by a symlink inside the repository
 * pointing outside it, so the path is resolved through realpath and checked
 * again against the resolved root. Only `.md` is served: the browser renders
 * markdown, and anything else would be a file-read endpoint.
 */
export async function safeResolve(
  repo: string,
  rel: string | null | undefined,
): Promise<string | null> {
  if (rel === null || rel === undefined || rel === '' || !rel.endsWith('.md')) return null;
  if (rel.includes('\0')) return null;
  const root = path.resolve(repo);
  const full = path.resolve(root, rel);
  if (!within(full, root)) return null;
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(full), realpath(root)]);
  } catch {
    return null;
  }
  return within(real, realRoot) ? real : null;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

interface OpenSection {
  title: string;
  anchor: string;
  lines: string[];
}

/** Split at `##` headings outside code fences, so each section gets its own anchor. */
export function splitSections(markdown: string): DocumentSection[] {
  const sections: OpenSection[] = [];
  let current: OpenSection = { title: '', anchor: '', lines: [] };
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.+)$/.exec(line);
    const title = heading?.[1];
    if (title !== undefined) {
      if (current.lines.length > 0 || current.title !== '') sections.push(current);
      current = { title: title.trim(), anchor: slug(title), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections
    .filter((s) => s.lines.join('').trim() !== '')
    .map((s) => ({ title: s.title, anchor: s.anchor, source: s.lines.join('\n') }));
}

export async function fileMtime(repo: string, rel: string): Promise<number> {
  const info = await stat(path.join(repo, rel));
  return Math.floor(info.mtimeMs);
}
