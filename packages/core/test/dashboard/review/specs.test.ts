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

  const HEADING_TASKS = `# 0099 — Heading form tasks

## T99010 — Design the layout

Prose describing the task. No depends-on here.

_Exec: lane=worker-lane, gates=build,test, files=\`packages/core/src/a.ts\`, \`packages/core/src/b.ts\`

## T99011 — Wire the readers

More prose. Depends on T99010.

_Exec: lane=worker-lane, gates=build, files=\`packages/core/src/c.ts\`

## Notes

This heading has no task id and should open a section, not create a task.
`;

  it('parses a heading-form task with its id, title, and _Exec fields', async () => {
    await writeSpec('0099-heading', HEADING_TASKS);
    const parsed = await parseTasks(repo, 'docs/specs/0099-heading/tasks.md', '0099-heading');

    expect(parsed.total).toBe(2);
    // Heading-form tasks carry no checkbox, so done is always false.
    expect(parsed.done).toBe(0);

    const tasks = parsed.sections[0]?.tasks ?? [];
    expect(tasks).toHaveLength(2);
    const [first, second] = tasks;
    if (first === undefined || second === undefined) {
      throw new Error('expected two heading-form tasks');
    }
    expect(first).toMatchObject({
      id: 'T99010',
      title: 'Design the layout',
      done: false,
      executor: 'worker-lane',
      gates: 'build,test',
      files: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
      dependsOn: [],
      specId: '0099-heading',
    });
    expect(second).toMatchObject({
      id: 'T99011',
      title: 'Wire the readers',
      done: false,
      executor: 'worker-lane',
      gates: 'build',
      files: ['packages/core/src/c.ts'],
      dependsOn: ['T99010'],
    });
  });

  it('does not turn a ## heading with no task id into a task', async () => {
    await writeSpec('0099-heading', HEADING_TASKS);
    const parsed = await parseTasks(repo, 'docs/specs/0099-heading/tasks.md', '0099-heading');
    // The `## Notes` heading should open a section (which carries no tasks
    // and is then filtered out), not create a spurious task entry.
    const ids = parsed.sections.flatMap((s) => s.tasks.map((t) => t.id));
    expect(ids).not.toContain('Notes');
    expect(ids).toEqual(['T99010', 'T99011']);
  });

  const MIXED_TASKS = `# 0099 — Mixed form

## Open

- [ ] **T99020** Checkbox task
  _Exec: executor=self kind=mechanical gates=tsc files=packages/core/src/x.ts_

## T99021 — Heading task

Short body.

_Exec: lane=self-lane, gates=tsc, files=\`packages/core/src/y.ts\`
`;

  it('parses a file that mixes checkbox-form and heading-form tasks', async () => {
    await writeSpec('0099-mixed', MIXED_TASKS);
    const parsed = await parseTasks(repo, 'docs/specs/0099-mixed/tasks.md', '0099-mixed');

    expect(parsed.total).toBe(2);
    const all = parsed.sections.flatMap((s) => s.tasks);
    expect(all.map((t) => t.id)).toEqual(['T99020', 'T99021']);
    const [checkboxForm, headingForm] = all;
    if (checkboxForm === undefined || headingForm === undefined) {
      throw new Error('expected one task of each form');
    }
    expect(checkboxForm).toMatchObject({
      id: 'T99020',
      done: false,
      files: ['packages/core/src/x.ts'],
    });
    expect(headingForm).toMatchObject({
      id: 'T99021',
      done: false,
      files: ['packages/core/src/y.ts'],
    });
  });

  it('reports a heading-form task with no completion signal as not done', async () => {
    const noExec = `# 0099\n\n## T99030 — No exec line\n\nJust prose.\n`;
    await writeSpec('0099-nodone', noExec);
    const parsed = await parseTasks(repo, 'docs/specs/0099-nodone/tasks.md', '0099-nodone');
    expect(parsed.total).toBe(1);
    expect(parsed.done).toBe(0);
    expect(parsed.sections[0]?.tasks[0]?.done).toBe(false);
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
