import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runMiddle, type Dispatcher } from '../../src/cli/middle.js';
import type { CommandContext } from '../../src/cli/types.js';

const run$ = promisify(execFile);

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

async function run(argv: string[], dispatcher: Dispatcher): Promise<number> {
  const ctx: CommandContext = { cwd: repo, argv, env: process.env };
  return runMiddle(ctx, dispatcher);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'cyv-middle-'));
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

describe('cyv middle (spec 0062)', () => {
  it('exits 0 with no action if a spec has no open tasks', async () => {
    await writeSpec(
      '0062-orchestration-tiers',
      '# tasks\n\n## Done\n\n' + task('T62001', 'One', 'src/a.ts', { done: true }),
    );

    const dispatcher = vi.fn();
    const code = await run(['0062'], dispatcher);
    
    expect(code).toBe(0);
    expect(dispatcher).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('has no open tasks');
  });

  it('reports failure if a task fails its gates twice', async () => {
    await writeSpec(
      '0062-orchestration-tiers',
      '# tasks\n\n## Open\n\n' + task('T62001', 'One', 'src/a.ts'),
    );

    const dispatcher: Dispatcher = async () => ({
      code: 1,
      stdout: JSON.stringify({
        scheduled: true,
        attempts: [
          { outcome: { kind: 'gates-failed' } },
          { outcome: { kind: 'gates-failed' } }
        ],
        outcome: { kind: 'gates-failed', summary: 'Failed gates' }
      }),
      stderr: ''
    });

    const code = await run(['0062'], dispatcher);
    
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('gates-failed (2 attempt(s))');
    expect(out.join('\n')).toContain('Remaining unfinished tasks: T62001');
  });

  it('reports success if a task fails once then passes', async () => {
    await writeSpec(
      '0062-orchestration-tiers',
      '# tasks\n\n## Open\n\n' + task('T62001', 'One', 'src/a.ts'),
    );

    const dispatcher: Dispatcher = async () => ({
      code: 0,
      stdout: JSON.stringify({
        scheduled: true,
        attempts: [
          { outcome: { kind: 'gates-failed' } },
          { outcome: { kind: 'succeeded' } }
        ],
        outcome: { kind: 'succeeded', summary: 'Passed gates' }
      }),
      stderr: ''
    });

    const code = await run(['0062'], dispatcher);
    
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('succeeded (2 attempt(s))');
    expect(out.join('\n')).toContain('All tasks completed successfully.');
  });

  it('stops and reports failure if no lane is free to dispatch to', async () => {
    await writeSpec(
      '0062-orchestration-tiers',
      '# tasks\n\n## Open\n\n' + task('T62001', 'One', 'src/a.ts'),
    );

    const dispatcher: Dispatcher = async () => ({
      code: 1,
      stdout: JSON.stringify({
        scheduled: false,
        refusal: { reason: 'at-concurrency-cap' }
      }),
      stderr: ''
    });

    const code = await run(['0062'], dispatcher);
    
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('refused scheduling: no lane free');
    expect(out.join('\n')).toContain('refused (0 attempt(s))');
  });

  it('reports an error when the dispatch output has an unexpected shape', async () => {
    await writeSpec(
      '0062-orchestration-tiers',
      '# tasks\n\n## Open\n\n' + task('T62001', 'One', 'src/a.ts'),
    );

    const dispatcher: Dispatcher = async () => ({
      code: 0,
      stdout: JSON.stringify({
        scheduled: true,
        attempts: 'two',
        outcome: { kind: 'succeeded', summary: 'Passed gates' }
      }),
      stderr: ''
    });

    const code = await run(['0062'], dispatcher);

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Invalid dispatch output');
    expect(out.join('\n')).toContain('error (0 attempt(s)) - Invalid JSON');
    expect(out.join('\n')).toContain('Remaining unfinished tasks: T62001');
  });
});
