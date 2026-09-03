/**
 * How far each project's notes have been read (spec 0042 Requirement 3.3).
 *
 * The cursor is the watcher's memory, not the project's, so it lives in the
 * user's home directory beside the project registry rather than in any
 * repository — a checkout that is deleted and re-cloned should not replay every
 * note ever left.
 *
 * It sits here rather than in `cli/comments.ts`, where it was written, because
 * two callers need it and they are on opposite sides of a layer: the `comments`
 * command advances it, and the dashboard reads it to say whether the agent has
 * seen a note. `dashboard/` importing from `cli/` would have been the only such
 * import in the tree and the wrong direction; both importing from here is not.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { REGISTRY_DIR } from '../projects.js';
import { isUnknownArray } from '../../guards.js';
import { REVIEW_DIR } from './comments.js';

const CURSOR_FILE = 'comments-cursor.json';
/** Where the review UI this command replaces kept its cursor: inside the tool's own checkout. */
const LEGACY_CURSOR = join(REVIEW_DIR, 'watch-cursor.json');

export interface Cursors {
  projects: Map<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

export function cursorPath(): string {
  return join(homedir(), REGISTRY_DIR, CURSOR_FILE);
}

function cursorsFrom(value: unknown, legacyRoot: string): Cursors {
  const projects = new Map<string, number>();
  if (!isRecord(value)) return { projects };
  // The single-root shape predates the registry. Read as empty it would replay
  // every note ever left as new, so it is carried onto the root it watched.
  if (typeof value.lastId === 'number') {
    projects.set(legacyRoot, value.lastId);
    return { projects };
  }
  if (isRecord(value.projects)) {
    for (const [root, id] of Object.entries(value.projects)) {
      if (typeof id === 'number') projects.set(root, id);
    }
  }
  return { projects };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

export async function loadCursors(legacyRoot: string): Promise<Cursors> {
  const current = await readJson(cursorPath());
  if (current !== undefined) return cursorsFrom(current, legacyRoot);
  return cursorsFrom(await readJson(join(legacyRoot, LEGACY_CURSOR)), legacyRoot);
}

export async function saveCursors(cursors: Cursors): Promise<void> {
  const target = cursorPath();
  await mkdir(dirname(target), { recursive: true });
  const projects = Object.fromEntries(cursors.projects);
  await writeFile(target, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf-8');
}

/**
 * The highest note id the agent has read in one repository.
 *
 * This is the only evidence the dashboard uses for "read". A note the hook
 * delivered and the agent then ignored counts as read, because it was —
 * inferring attention from anything else would be inventing a fact about a
 * session this process cannot see.
 */
export async function readCursorFor(root: string): Promise<number> {
  const cursors = await loadCursors(root);
  return cursors.projects.get(root) ?? 0;
}
