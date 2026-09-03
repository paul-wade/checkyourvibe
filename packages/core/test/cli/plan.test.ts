import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { command } from '../../src/cli/plan.js';

const run$ = promisify(execFile);

interface PlannedTask {
  id: string;
  wave: number;
  blockedBy: string[];
}

interface Plan {
  specId: string;
  tasks: PlannedTask[];
}

/**
 * `Array.isArray` narrows `unknown` to `any[]`, which would make every element
 * read below unchecked while looking like careful validation. This guard is the
 * fix `cyv explain no-unsafe-array-narrowing` names.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Read the `--json` output as a `Plan`, checking the shape rather than
 * asserting it. `JSON.parse` returns `any`, and a cast would only relocate the
 * unchecked claim — which is what `no-json-parse-cast` exists to say.
 */
function parsePlan(text: string): Plan {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('plan is not an object');
  const specId = 'specId' in raw ? raw.specId : undefined;
  const tasks = 'tasks' in raw ? raw.tasks : undefined;
  if (typeof specId !== 'string') throw new Error('plan.specId is not a string');
  if (!isUnknownArray(tasks)) throw new Error('plan.tasks is not an array');
  return { specId, tasks: tasks.map(toTask) };
}

function toTask(value: unknown): PlannedTask {
  if (typeof value !== 'object' || value === null) throw new Error('task is not an object');
  const id = 'id' in value ? value.id : undefined;
  const wave = 'wave' in value ? value.wave : undefined;
  const blockedBy = 'blockedBy' in value ? value.blockedBy : undefined;
  if (typeof id !== 'string') throw new Error('task.id is not a string');
  if (typeof wave !== 'number') throw new Error('task.wave is not a number');
  if (!isUnknownArray(blockedBy)) throw new Error('task.blockedBy is not an array');
  return { id, wave, blockedBy: blockedBy.map(String) };
}

let repo: string;
let out: string[];
let err: string[];
const realLog = console.log;
const realError = console.error;

async function writeSpec(id: string, tasks: string | null): Promise<void> {
  const dir = join(repo, 'docs', 'specs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'requirements.md'), `# ${id}\n`, 'utf8');
  if (tasks !== null) {
    await writeFile(join(dir, 'tasks.md'), tasks, 'utf8');
  }
}

function task(
  id: string,
  title: string,
  files: string,
  extras: { done?: boolean; body?: string } = {},
): string {
  const box = extras.done === true ? 'x' : ' ';
  const body = extras.body === undefined ? '' : `  ${extras.body}\n`;
  return (
    `- [${box}] **${id}** ${title}\n` +
    body +
    `  _Exec: executor=self kind=mechanical gates=tsc files=${files}_\n\n`
  );
}

async function run(argv: string[]): Promise<number> {
  return command.run({ cwd: repo, argv, env: process.env });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cyv-plan-'));
  // `repoRoot` asks git, so the fixture has to be a real repository rather
  // than a directory with a `.git` folder in it.
  await run$('git', ['init', '--quiet'], { cwd: repo });
  out = [];
  err = [];
  console.log = (...args: unknown[]): void => {
    out.push(args.join(' '));
  };
  console.error = (...args: unknown[]): void => {
    err.push(args.join(' '));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  await rm(repo, { recursive: true, force: true });
});

describe('cyv plan (spec 0041 Requirement 3.3)', () => {
  it('puts tasks with disjoint file scopes in one wave', async () => {
    await writeSpec(
      '0050-example',
      '# tasks\n\n## Open\n\n' +
        task('T50001', 'One', 'src/a.ts') +
        task('T50002', 'Two', 'src/b.ts'),
    );

    expect(await run(['0050', '--json'])).toBe(0);
    const plan = parsePlan(out.join('\n'));
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.every((t) => t.wave === 1)).toBe(true);
  });

  it('splits tasks whose file scopes overlap into separate waves', async () => {
    await writeSpec(
      '0050-example',
      '# tasks\n\n## Open\n\n' +
        task('T50001', 'One', 'src/shared.ts') +
        task('T50002', 'Two', 'src/shared.ts'),
    );

    await run(['0050', '--json']);
    const waves = parsePlan(out.join('\n')).tasks.map((t) => t.wave);
    expect(new Set(waves).size).toBe(2);
  });

  it('holds a task whose named dependency is still open in wave 0', async () => {
    await writeSpec(
      '0050-example',
      '# tasks\n\n## Open\n\n' +
        task('T50001', 'One', 'src/a.ts') +
        task('T50002', 'Two', 'src/b.ts', { body: 'Depends on T50001.' }),
    );

    await run(['0050', '--json']);
    const plan = parsePlan(out.join('\n'));
    const second = plan.tasks.find((t) => t.id === 'T50002');
    expect(second?.wave).toBe(0);
    expect(second?.blockedBy).toEqual(['T50001']);
  });

  it('releases a task once its dependency is checked off', async () => {
    await writeSpec(
      '0050-example',
      '# tasks\n\n## Open\n\n' +
        task('T50001', 'One', 'src/a.ts', { done: true }) +
        task('T50002', 'Two', 'src/b.ts', { body: 'Depends on T50001.' }),
    );

    await run(['0050', '--json']);
    const plan = parsePlan(out.join('\n'));
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.wave).toBe(1);
  });

  it('refuses an ambiguous spec by naming every candidate', async () => {
    await writeSpec('0050-alpha', '# tasks\n');
    await writeSpec('0051-alpha', '# tasks\n');

    expect(await run(['alpha'])).toBe(1);
    expect(err.join('\n')).toContain('0050-alpha');
    expect(err.join('\n')).toContain('0051-alpha');
  });

  it('resolves a four-digit id exactly, even when it appears inside another name', async () => {
    await writeSpec('0050-example', '# tasks\n\n## Open\n\n' + task('T50001', 'One', 'src/a.ts'));
    await writeSpec('0051-mentions-0050', '# tasks\n');

    expect(await run(['0050', '--json'])).toBe(0);
    expect(parsePlan(out.join('\n')).specId).toBe('0050-example');
  });

  it('says so when a spec has no tasks.md rather than planning nothing', async () => {
    await writeSpec('0050-example', null);

    expect(await run(['0050'])).toBe(1);
    expect(err.join('\n')).toContain('no tasks.md');
  });

  it('needs a spec to plan', async () => {
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('needs a spec');
  });

  it('dispatches nothing and says so', async () => {
    await writeSpec('0050-example', '# tasks\n\n## Open\n\n' + task('T50001', 'One', 'src/a.ts'));

    await run(['0050']);
    expect(out.join('\n')).toContain('Nothing was dispatched');
  });
});
