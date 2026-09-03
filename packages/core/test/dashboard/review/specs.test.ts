import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSpecs,
  parseAllSpecs,
  parseTasks,
  planWaves,
  specDisplayName,
  type SpecTask,
} from '../../../src/dashboard/review/specs.js';

const TASKS = `# 0099 — Example: tasks

**Status:** open

## Done

- [x] **T99001** Write the seam
  _Exec: executor=self kind=judgment gates=tsc files=packages/core/src/a.ts_

## Open

- [ ] **T99002** Port the readers
  Requirement 1. Depends on T99001 and T99003.
  Mentions T99004 in passing, which is not a dependency.
  A long description that runs on for more lines than the old reader would
  have scanned before giving up on finding the dispatch line.
  Fourth line.
  Fifth line.
  Sixth line.
  Seventh line.
  Eighth line.
  Ninth line.
  _Exec: executor=user model=opus kind=mechanical gates=tsc,test files=packages/core/src/b.ts,packages/core/test/b/**_

- [ ] **T99003**
  Title on the next line
  _Exec: executor=lane-a gates=manual_

- [ ] **T99005** No dispatch line at all

## Notes

Prose without tasks is not a section.
`;

describe('spec parsing', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-specs-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function writeSpec(id: string, tasks?: string): Promise<void> {
    const dir = join(repo, 'docs', 'specs', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'requirements.md'), '# req\n', 'utf8');
    if (tasks !== undefined) await writeFile(join(dir, 'tasks.md'), tasks, 'utf8');
  }

  it('reads every _Exec field, files= and the dependencies a task names', async () => {
    await writeSpec('0099-example', TASKS);
    const parsed = await parseTasks(repo, 'docs/specs/0099-example/tasks.md', '0099-example');

    expect(parsed.done).toBe(1);
    expect(parsed.total).toBe(4);
    expect(parsed.sections.map((s) => s.title)).toEqual(['Done', 'Open']);

    const open = parsed.sections[1]?.tasks ?? [];
    expect(open).toMatchObject([
      {
        id: 'T99002',
        title: 'Port the readers',
        done: false,
        executor: 'user',
        model: 'opus',
        kind: 'mechanical',
        gates: 'tsc,test',
        files: ['packages/core/src/b.ts', 'packages/core/test/b/**'],
        dependsOn: ['T99001', 'T99003'],
        specId: '0099-example',
        line: 12,
      },
      {
        id: 'T99003',
        title: 'Title on the next line',
        executor: 'lane-a',
        gates: 'manual',
        files: [],
        dependsOn: [],
      },
      { id: 'T99005', executor: 'unknown', files: [], line: 29 },
    ]);
  });

  it('returns nothing for a tasks file that does not exist', async () => {
    expect(await parseTasks(repo, 'docs/specs/none/tasks.md', 'none')).toEqual({
      sections: [],
      done: 0,
      total: 0,
    });
  });

  it('lists specs in order and keeps one without tasks', async () => {
    await writeSpec('0002-second', TASKS);
    await writeSpec('0001-first');
    await writeFile(join(repo, 'docs', 'specs', 'stray.md'), 'not a spec', 'utf8');
    expect(await findSpecs(repo)).toEqual([
      { id: '0001-first', tasksPath: null },
      { id: '0002-second', tasksPath: 'docs/specs/0002-second/tasks.md' },
    ]);
    expect(await findSpecs(join(repo, 'missing'))).toEqual([]);
  });

  it('rolls every spec up', async () => {
    await writeSpec('0001-first');
    await writeSpec('0002-second', TASKS);
    const rollup = await parseAllSpecs(repo);
    expect(rollup.done).toBe(1);
    expect(rollup.total).toBe(4);
    expect(rollup.specs.map((s) => [s.id, s.tasksPath, s.done, s.total])).toEqual([
      ['0001-first', null, 0, 0],
      ['0002-second', 'docs/specs/0002-second/tasks.md', 1, 4],
    ]);
    expect(rollup.specs[1]?.sections[1]?.tasks[0]?.specId).toBe('0002-second');
  });

  it('renders a spec id as a display name', () => {
    expect(specDisplayName('0037-one-dashboard')).toBe('0037 · one dashboard');
    expect(specDisplayName('no-number')).toBe('no number');
  });
});

function task(
  id: string,
  files: readonly string[],
  extra: Partial<Pick<SpecTask, 'done' | 'dependsOn'>> = {},
): SpecTask {
  return {
    id,
    title: `Task ${id}`,
    done: extra.done ?? false,
    executor: 'self',
    model: '',
    kind: 'mechanical',
    gates: 'tsc',
    files,
    dependsOn: extra.dependsOn ?? [],
    specId: '0099-example',
    line: 1,
  };
}

describe('planWaves', () => {
  it('puts tasks with overlapping scopes in different waves and disjoint ones together', () => {
    const all = [
      task('T1', ['packages/core/src/a/**']),
      task('T2', ['packages/core/src/a/inner.ts']),
      task('T3', ['docs/**']),
      task('T4', ['packages/core/src/b.ts', 'docs/x.md']),
    ];
    const planned = planWaves(all, all);
    const waves = Object.fromEntries(planned.map((t) => [t.id, t.wave]));
    expect(waves).toEqual({ T1: 1, T2: 2, T3: 1, T4: 2 });
    expect(planned.map((t) => t.id)).toEqual(['T1', 'T3', 'T2', 'T4']);
  });

  it('puts a blocked task in wave 0 and names what blocks it', () => {
    const done = task('T0', ['x.ts'], { done: true });
    const openDep = task('T1', ['a.ts']);
    const blocked = task('T2', ['b.ts'], { dependsOn: ['T0', 'T1', 'T404'] });
    const planned = planWaves([openDep, blocked], [done, openDep, blocked]);
    expect(planned).toMatchObject([
      { id: 'T2', wave: 0, blockedBy: ['T1'] },
      { id: 'T1', wave: 1, blockedBy: [] },
    ]);
  });

  it('treats a dependency on a done or unknown task as satisfied', () => {
    const done = task('T0', ['x.ts'], { done: true });
    const free = task('T1', ['a.ts'], { dependsOn: ['T0', 'T999'] });
    expect(planWaves([free], [done, free])).toMatchObject([{ wave: 1, blockedBy: [] }]);
  });

  it('gives a task with no declared files a wave of its own', () => {
    const all = [task('T1', ['a.ts']), task('T2', []), task('T3', ['b.ts'])];
    const waves = Object.fromEntries(planWaves(all, all).map((t) => [t.id, t.wave]));
    expect(waves).toEqual({ T1: 1, T2: 2, T3: 1 });
  });

  it('carries the fields the page shows', () => {
    const only = task('T7', ['a.ts']);
    expect(planWaves([only], [only])).toEqual([
      {
        id: 'T7',
        title: 'Task T7',
        specId: '0099-example',
        executor: 'self',
        kind: 'mechanical',
        files: ['a.ts'],
        blockedBy: [],
        wave: 1,
      },
    ]);
  });
});
