import { describe, expect, it } from 'vitest';
import { renderTasksPage, type TasksPageInput } from '../../src/dashboard/tasks-page.js';
import type { ParsedSpec, SpecTask } from '../../src/dashboard/review/specs.js';
import type { DispatchRecord } from '../../src/executor/dispatch.js';
import type { DispatchOutcomeKind } from '../../src/executor/outcome.js';
import type { LaneDeclaration } from '../../src/executor/lane.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

const LANE: LaneDeclaration = {
  id: 'devin-cli',
  agentId: 'devin',
  concurrencyCap: 1,
  billing: { kind: 'subscription', permitsBilledOverage: false },
  models: [{ kind: 'mechanical-transformation', ordering: ['m'] }],
  orchestrator: false,
  acceptsDispatch: true,
};

function task(id: string, title: string, over: Partial<SpecTask> = {}): SpecTask {
  return {
    id,
    title,
    done: over.done ?? false,
    executor: over.executor ?? 'devin-cli',
    model: over.model ?? '',
    kind: over.kind ?? 'mechanical',
    gates: over.gates ?? 'cyv-check,tsc',
    files: over.files ?? ['packages/core/src/x.ts'],
    dependsOn: over.dependsOn ?? [],
    specId: over.specId ?? '0099-fixture',
    line: over.line ?? 1,
  };
}

function spec(id: string, tasks: readonly SpecTask[]): ParsedSpec {
  return {
    id,
    tasksPath: `docs/specs/${id}/tasks.md`,
    sections: [{ title: 'Open', tasks: [...tasks] }],
    done: tasks.filter((entry) => entry.done).length,
    total: tasks.length,
  };
}

function record(dispatchId: string, taskText: string): DispatchRecord {
  return {
    dispatchId,
    workId: `w-${dispatchId}`,
    attempt: 1,
    openedAt: '2026-09-01T10:00:00.000Z',
    declaration: {
      task: taskText,
      taskKind: 'mechanical-transformation',
      ownedPaths: ['packages/core/src/x.ts'],
      expectsFileChanges: true,
      gates: ['cyv-check'],
    },
    assignment: {
      laneId: 'devin-cli',
      agentId: 'devin',
      model: 'm',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
}

function closedRecord(
  dispatchId: string,
  taskText: string,
  kind: DispatchOutcomeKind,
): DispatchRecord {
  const open = record(dispatchId, taskText);
  open.closed = {
    closedAt: '2026-09-01T10:05:00.000Z',
    report: { status: 'success', exitCode: 0, rateLimited: false },
    gateResults: [],
    outcome: { kind, summary: `the dispatch ${kind}`, changedPaths: [], outOfScopePaths: [], failedGates: [] },
  };
  return open;
}

function input(over: Partial<TasksPageInput> = {}): TasksPageInput {
  return {
    project: '/repo',
    projectName: 'repo',
    specs: over.specs ?? [],
    records: over.records ?? [],
    lanes: over.lanes ?? [LANE],
    spec: over.spec ?? '',
    state: over.state ?? '',
    forTask: over.forTask ?? '',
    ...(over.now === undefined ? {} : { now: over.now }),
  };
}

describe('renderTasksPage', () => {
  it('lists tasks from more than one spec, newest spec first', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0001-first', [task('T1001', 'the older task')]),
          spec('0002-second', [task('T2001', 'the newer task')]),
        ],
      }),
    );
    expect(html.indexOf('0002 · second')).toBeLessThan(html.indexOf('0001 · first'));
    expect(html).toContain('T1001');
    expect(html).toContain('T2001');
  });

  it('a task that was never dispatched offers a Dispatch control', () => {
    const html = renderTasksPage(
      input({ specs: [spec('0002-second', [task('T2001', 'the newer task')])] }),
    );
    expect(html).toContain('for=T2001');
    expect(html).toContain('>Dispatch</a>');
    expect(html).toContain('never dispatched');
  });

  it('pre-populates the dispatch form from the task’s _Exec: line', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0002-second', [
            task('T2001', 'the newer task', {
              executor: 'devin-cli',
              kind: 'judgment',
              gates: 'cyv-check,run:pnpm test',
              files: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
            }),
          ]),
        ],
        forTask: 'T2001',
      }),
    );
    expect(html).toContain('id="dispatch"');
    expect(html).toContain('value="devin-cli" selected');
    expect(html).toContain('value="judgment-required" selected');
    expect(html).toContain('cyv-check\nrun:pnpm test');
    expect(html).toContain('packages/core/src/a.ts\npackages/core/src/b.ts');
    expect(html).toContain('T2001 — the newer task');
    expect(html).toContain('action="/api/dispatch?p=');
  });

  it('a task with no _Exec: line says so and does not guess a scope', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0002-second', [
            task('T2002', 'undeclared work', {
              executor: 'unknown',
              kind: '',
              model: '',
              gates: '',
              files: [],
            }),
          ]),
        ],
        forTask: 'T2002',
      }),
    );
    expect(html).toContain('No _Exec: line was read');
    expect(html).toContain('the dispatch is refused without at least one');
    expect(html).toMatch(/<textarea name="ownedPaths"[^>]*><\/textarea>/);
    expect(html).toMatch(/<textarea name="gates"[^>]*><\/textarea>/);
  });

  it('a task in motion shows its dispatch and no Dispatch control', () => {
    const html = renderTasksPage(
      input({
        specs: [spec('0002-second', [task('T2001', 'the newer task')])],
        records: [record('d-open', 'T2001 the newer task')],
      }),
    );
    expect(html).toContain('d-open');
    expect(html).toContain('in motion');
    expect(html).toContain('/board?p=');
    expect(html).not.toContain('for=T2001');
  });

  it('a succeeded task shows the outcome; a failed one names what happened', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0002-second', [task('T2001', 'won'), task('T2002', 'lost')]),
        ],
        records: [
          closedRecord('d-won', 'T2001 won', 'succeeded'),
          closedRecord('d-lost', 'T2002 lost', 'gates-failed'),
        ],
      }),
    );
    expect(html).toContain('succeeded');
    expect(html).toContain('gates-failed');
    expect(html).toContain('d-won');
    expect(html).toContain('d-lost');
    expect(html).not.toContain('for=T2001');
    expect(html).not.toContain('for=T2002');
  });

  it('a checked-off task reads done and offers no Dispatch control', () => {
    const html = renderTasksPage(
      input({ specs: [spec('0002-second', [task('T2001', 'finished', { done: true })])] }),
    );
    expect(html).toContain('data-state="done"');
    expect(html).not.toContain('for=T2001');
  });

  it('escapes markup in a task’s text', () => {
    const html = renderTasksPage(
      input({
        specs: [spec('0002-second', [task('T2001', 'a <b>bold</b> & "quoted" thing')])],
      }),
    );
    expect(html).toContain('a &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot; thing');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('filters the list by spec and by state', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0001-first', [task('T1001', 'older')]),
          spec('0002-second', [task('T2001', 'newer open'), task('T2002', 'newer done', { done: true })]),
        ],
        spec: '0002-second',
        state: 'never',
      }),
    );
    expect(html).toContain('T2001');
    expect(html).not.toContain('T2002');
    expect(html).not.toContain('T1001');
    // The other spec stays in the filter's options; its section is not listed.
    expect(html).not.toContain('<h2>0001 · first</h2>');
    expect(html).toContain('value="0002-second" selected');
    expect(html).toContain('value="never" selected');
  });

  it('says when the page was rendered, and claims no update it does not make', () => {
    const html = renderTasksPage(input({ now: NOW }));

    expect(html).toContain('rendered on request — not updated automatically');
    expect(html).toContain(`data-epoch="${NOW}"`);
    // The age is rewritten from the epoch the page carries — a stale tab is
    // never left showing the server's frozen "just now".
    expect(html).toContain('.cyv-freshness[data-epoch]');
    expect(html).not.toContain('id="board-live-badge"');
    expect(html).not.toContain('polling — ');
  });

  it('names a dependency that is still open', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0002-second', [
            task('T2001', 'first'),
            task('T2002', 'second', { dependsOn: ['T2001'] }),
          ]),
        ],
      }),
    );
    expect(html).toContain('waits on T2001');
  });
});
