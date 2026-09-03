/**
 * Specs and their tasks, read from `docs/specs/NNNN-name/tasks.md`.
 *
 * The checkbox list and the `_Exec:` line are the whole record of what is
 * planned and what is done. Everything the page says about a spec derives from
 * them, so nothing here is a list an agent maintains by hand. A malformed task
 * line degrades to `unknown` rather than throwing, so one bad line does not
 * blank the whole region.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeOwnedPath, overlappingPaths } from '../../executor/ownership.js';
import type { NextTask } from '../view-model.js';

export interface SpecTask {
  id: string;
  title: string;
  done: boolean;
  /** The lane the `_Exec:` line names, or `unknown`. */
  executor: string;
  model: string;
  kind: string;
  gates: string;
  /** The `files=` globs, as written. */
  files: readonly string[];
  /** Task ids the description names in a `depends on` phrase. */
  dependsOn: readonly string[];
  specId: string;
  /** 1-based line of the task in its tasks.md. */
  line: number;
}

export interface SpecSection {
  title: string;
  tasks: SpecTask[];
}

export interface ParsedTasks {
  sections: SpecSection[];
  done: number;
  total: number;
}

export interface ParsedSpec extends ParsedTasks {
  id: string;
  /** Repo-relative path to tasks.md, or null for a spec that has none yet. */
  tasksPath: string | null;
}

export interface SpecRollup {
  specs: ParsedSpec[];
  done: number;
  total: number;
}

export interface SpecLocation {
  id: string;
  tasksPath: string | null;
}

const TASK_LINE = /^-\s*\[( |x|X)\]\s*\*\*(T\d+)\*\*\s*(.*)$/;
const EXEC_LINE = /^\s*_Exec:\s*(.*?)_\s*$/;
const HEADING_LINE = /^##\s+(.+?)\s*$/;
const TASK_ID = /\bT\d+\b/g;

/**
 * Every spec folder, newest last.
 *
 * This read one hardcoded path until the first spec reached 31 of 31, at which
 * point the page showed complete and stayed there while every later spec went
 * uncounted. A spec with requirements but no tasks yet is still listed.
 */
export async function findSpecs(repo: string): Promise<SpecLocation[]> {
  const specsDir = path.join(repo, 'docs', 'specs');
  let entries: Dirent[];
  try {
    entries = await readdir(specsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const specs: SpecLocation[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const rel = ['docs', 'specs', entry.name, 'tasks.md'].join('/');
    let hasTasks = true;
    try {
      await stat(path.join(repo, rel));
    } catch {
      hasTasks = false;
    }
    specs.push({ id: entry.name, tasksPath: hasTasks ? rel : null });
  }
  return specs;
}

export async function parseAllSpecs(repo: string): Promise<SpecRollup> {
  const specs: ParsedSpec[] = [];
  let done = 0;
  let total = 0;
  for (const spec of await findSpecs(repo)) {
    if (spec.tasksPath === null) {
      specs.push({ id: spec.id, tasksPath: null, sections: [], done: 0, total: 0 });
      continue;
    }
    const parsed = await parseTasks(repo, spec.tasksPath, spec.id);
    specs.push({ id: spec.id, tasksPath: spec.tasksPath, ...parsed });
    done += parsed.done;
    total += parsed.total;
  }
  return { specs, done, total };
}

function execField(exec: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(exec);
  return match?.[1] ?? '';
}

/** The lines a task owns: from the line after it to its `_Exec:` line, next task, or heading. */
function taskBlock(lines: readonly string[], from: number): { body: string[]; exec: string } {
  const body: string[] = [];
  for (let j = from; j < lines.length; j++) {
    const line = lines[j] ?? '';
    const exec = EXEC_LINE.exec(line);
    if (exec) return { body, exec: exec[1] ?? '' };
    if (TASK_LINE.test(line) || HEADING_LINE.test(line)) break;
    body.push(line);
  }
  return { body, exec: '' };
}

function dependencies(body: readonly string[], selfId: string): string[] {
  const found: string[] = [];
  for (const line of body) {
    if (!/depends on/i.test(line)) continue;
    for (const match of line.matchAll(TASK_ID)) {
      const id = match[0];
      if (id !== selfId && !found.includes(id)) found.push(id);
    }
  }
  return found;
}

export async function parseTasks(
  repo: string,
  relPath: string,
  specId: string,
): Promise<ParsedTasks> {
  let text: string;
  try {
    text = await readFile(path.join(repo, relPath), 'utf8');
  } catch {
    return { sections: [], done: 0, total: 0 };
  }

  const sections: SpecSection[] = [];
  let current: SpecSection | undefined;
  const openSection = (title: string): SpecSection => {
    const section: SpecSection = { title, tasks: [] };
    sections.push(section);
    return section;
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Any `##` heading opens a section, not only `## Wave N`. An earlier
    // version matched waves alone and dropped every task filed under
    // `## Done` or `## Open`, so those specs reported 0 of 0.
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      current = openSection((heading[1] ?? '').trim());
      continue;
    }

    const task = TASK_LINE.exec(line);
    if (!task) continue;
    // A task before any heading still counts; losing it would be the same
    // silent omission in a smaller form.
    const section = current ?? openSection('Tasks');
    current = section;

    const id = task[2] ?? '';
    const next = lines[i + 1] ?? '';
    // A title may continue on the following indented line.
    let title = (task[3] ?? '').trim();
    if (title === '' && next.trim() !== '') title = next.trim();

    const { body, exec } = taskBlock(lines, i + 1);
    const files = execField(exec, 'files')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '');

    section.tasks.push({
      id,
      title: title.replace(/\s+/g, ' ').slice(0, 160),
      done: (task[1] ?? '').toLowerCase() === 'x',
      executor: execField(exec, 'executor') || 'unknown',
      model: execField(exec, 'model'),
      kind: execField(exec, 'kind'),
      gates: execField(exec, 'gates'),
      files,
      dependsOn: dependencies(body, id),
      specId,
      line: i + 1,
    });
  }

  // Headings that carry no tasks are prose, not empty groups.
  const withTasks = sections.filter((s) => s.tasks.length > 0);
  const all = withTasks.flatMap((s) => s.tasks);
  return { sections: withTasks, done: all.filter((t) => t.done).length, total: all.length };
}

/**
 * The part of a glob that names a real path prefix. Ownership comparison is
 * lexical on directories, so `packages/core/src/*.ts` stands for
 * `packages/core/src` and `docs/**` for `docs`: a wider claim than the glob
 * makes, which errs toward finding an overlap rather than missing one.
 */
function scopePrefix(glob: string): string {
  const normalized = normalizeOwnedPath(glob);
  const wildcard = normalized.search(/[*?[{]/);
  if (wildcard < 0) return normalized;
  const literal = normalized.slice(0, wildcard);
  const slash = literal.lastIndexOf('/');
  return slash < 0 ? '' : literal.slice(0, slash);
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  // A task that declares no files could write anywhere, so it shares a wave
  // with nothing.
  if (left.length === 0 || right.length === 0) return true;
  return overlappingPaths(left, right).length > 0;
}

interface Wave {
  scopes: (readonly string[])[];
}

/**
 * Group the open tasks into what can run at once (0040 Decision 4).
 *
 * A task is blocked when a dependency it names is still open. An id no task
 * carries is treated as done: a typo in a dependency should not hide a task
 * forever. Unblocked tasks are packed greedily, in file order, into the first
 * wave whose members' file scopes do not overlap; blocked tasks sit in wave 0.
 */
export function planWaves(open: readonly SpecTask[], allTasks: readonly SpecTask[]): NextTask[] {
  const openIds = new Set(allTasks.filter((t) => !t.done).map((t) => t.id));
  const waves: Wave[] = [];
  const planned: NextTask[] = [];

  for (const task of open) {
    const blockedBy = task.dependsOn.filter((id) => openIds.has(id));
    let wave = 0;
    if (blockedBy.length === 0) {
      const scope = task.files.map(scopePrefix);
      let index = waves.findIndex((w) => w.scopes.every((other) => !scopesOverlap(scope, other)));
      if (index < 0) {
        waves.push({ scopes: [] });
        index = waves.length - 1;
      }
      waves[index]?.scopes.push(scope);
      wave = index + 1;
    }
    planned.push({
      id: task.id,
      title: task.title,
      specId: task.specId,
      executor: task.executor,
      kind: task.kind,
      files: task.files,
      blockedBy,
      wave,
    });
  }

  return planned.sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));
}

/** `0037-one-dashboard` reads as `0037 · one dashboard`. */
export function specDisplayName(id: string): string {
  return id.replace(/^(\d+)-/, '$1 · ').replace(/-/g, ' ');
}
