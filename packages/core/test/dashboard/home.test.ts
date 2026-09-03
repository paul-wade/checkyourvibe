import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { checkIndicatorHtml, relativeTime, renderHome } from '../../src/dashboard/home.js';
import type {
  ExchangeEntry,
  HomePage,
  LaneRow,
  NextTask,
  RunningDispatch,
} from '../../src/dashboard/view-model.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const ROOT = 'C:\\work\\one';

function running(overrides: Partial<RunningDispatch>): RunningDispatch {
  return {
    dispatchId: 'd-0001',
    workId: 'T40003',
    attempt: 1,
    task: 'The shell and the four regions',
    taskId: 'T40003',
    taskKind: 'judgment-required',
    laneId: 'lane-a',
    model: 'strong',
    orchestrator: false,
    openedAt: '2026-09-01T11:40:00.000Z',
    liveness: 'live',
    livenessReason: 'pid 4242 is running and predates the entry',
    canStop: true,
    ownedPaths: ['packages/core/src/dashboard/home.ts'],
    ...overrides,
  };
}

function lane(overrides: Partial<LaneRow> & { id: string }): LaneRow {
  return {
    agentId: 'agent-a',
    orchestrator: false,
    acceptsDispatch: true,
    state: 'free',
    running: 0,
    cap: 1,
    billing: 'subscription',
    programTried: ['agent-a'],
    models: [],
    ...overrides,
  };
}

function entry(overrides: Partial<ExchangeEntry> & { id: number }): ExchangeEntry {
  return {
    author: 'owner',
    isAgent: false,
    kind: 'note',
    body: 'A note.',
    created: NOW - 60_000,
    status: 'open',
    ...overrides,
  };
}

function task(overrides: Partial<NextTask> & { id: string }): NextTask {
  return {
    title: `title of ${overrides.id}`,
    specId: '0040-a-dashboard-that-makes-sense',
    executor: 'lane-a',
    kind: 'judgment',
    files: ['packages/core/src/a.ts', 'packages/core/src/b.ts'],
    blockedBy: [],
    wave: 1,
    ...overrides,
  };
}

function emptyPage(): HomePage {
  return {
    project: { root: ROOT, name: 'one' },
    projects: [{ root: ROOT, name: 'one', reachable: true }],
    check: { state: 'never' },
    needsYou: [],
    motion: {
      running: [],
      next: [],
      finished: [],
      uncommitted: { count: 0, added: 0, removed: 0, named: [], moreCount: 0 },
      unparseableLines: 0,
    },
    lanes: { lanes: [], unused: [], none: true },
    exchange: { entries: [], total: 0, omitted: 0 },
    now: NOW,
  };
}

function fullPage(): HomePage {
  return {
    project: { root: ROOT, name: 'one' },
    projects: [
      { root: ROOT, name: 'one', reachable: true, needsCount: 2, inFlight: 1 },
      { root: 'C:\\work\\two', name: 'two', reachable: true },
      { root: 'C:\\work\\gone', name: 'gone', reachable: false, unreachableReason: 'directory is missing' },
    ],
    check: {
      state: 'finished',
      findings: 3,
      filesChecked: 12,
      finishedAt: '2026-09-01T11:55:00.000Z',
      mode: 'working',
      evidence: 'measured',
    },
    needsYou: [
      {
        kind: 'dispatch',
        id: 'd-0000',
        title: 'gates failed on T40001',
        question: 'Should T40001 be retried with the gate fix applied?',
        detail: ['tsc failed: found 3 errors', 'run: pnpm typecheck'],
        where: 'lane-a',
        href: '/?p=x#motion',
        actions: [
          { kind: 'tell', label: 'tell the agent', prefill: 'Please retry T40001 after fixing the tsc errors.', task: 'T40001' },
          { kind: 'dismiss', label: 'needs nothing', itemId: 'd-0000' },
          { kind: 'close', label: 'close the record', dispatchId: 'd-0000' },
        ],
      },
      {
        kind: 'note',
        id: '#7',
        title: 'Is the wave order right?',
        question: 'Is the wave ordering for spec 0040 correct?',
        where: 'your note, unaddressed',
        href: '/?p=x#exchange',
        actions: [
          { kind: 'addressed', label: 'mark addressed', commentId: 7 },
          { kind: 'open', label: 'open the task', href: '/files?p=x#T40005' },
        ],
      },
    ],
    motion: {
      spec: {
        id: '0040-a-dashboard-that-makes-sense',
        name: '0040 · a dashboard that makes sense',
        done: 2,
        total: 8,
        tasksPath: 'docs/specs/0040-a-dashboard-that-makes-sense/tasks.md',
      },
      running: [
        running({}),
        running({
          dispatchId: 'd-0002',
          task: '<script>x</script>',
          taskId: 'T40004',
          liveness: 'abandoned',
          livenessReason: 'pid 9 is not running',
          canStop: false,
          stopRefusal: 'opened on another host (build-box)',
        }),
      ],
      next: [
        task({ id: 'T40005' }),
        task({ id: 'T40006', files: ['docs/STATUS.md'] }),
        task({ id: 'T40007', wave: 0, blockedBy: ['T40006'] }),
      ],
      finished: [
        {
          dispatchId: 'd-0000',
          workId: 'T40001',
          attempt: 1,
          task: 'Port the review data layer',
          taskId: 'T40001',
          laneId: 'lane-a',
          model: 'strong',
          outcome: 'gates-failed',
          summary: 'tsc failed',
          failedGates: ['tsc'],
          closedAt: '2026-09-01T10:00:00.000Z',
          needsPerson: true,
        },
        {
          dispatchId: 'd-0003',
          workId: 'T40002',
          attempt: 1,
          task: 'Liveness and stall',
          taskId: 'T40002',
          laneId: 'lane-b',
          model: 'strong',
          outcome: 'succeeded',
          summary: 'changed 4 files, every gate passed',
          failedGates: [],
          closedAt: '2026-09-01T11:30:00.000Z',
          needsPerson: false,
        },
      ],
      stall: { idleLanes: ['lane-b'], lastOpenedAt: '2026-09-01T09:00:00.000Z', intervalMinutes: 30 },
      uncommitted: {
        count: 3,
        added: 120,
        removed: 4,
        named: [{ name: 'packages/core/src/dashboard/home.ts', touchedAt: '2026-09-01T11:58:00.000Z' }],
        moreCount: 2,
      },
      unparseableLines: 1,
    },
    lanes: {
      lanes: [
        lane({ id: 'lane-a', state: 'busy', running: 1 }),
        lane({
          id: 'lane-b',
          state: 'cooling',
          cooldown: { reason: 'produced-nothing', dispatchId: 'd-0003', since: '2026-09-01T11:30:00.000Z' },
        }),
        lane({ id: 'lane-c', state: 'unavailable', programTried: ['agent-c', 'agent-c.cmd'] }),
        lane({
          id: 'self',
          state: 'reserved',
          orchestrator: true,
          acceptsDispatch: false,
          selfReport: { state: 'degraded', reason: 'context nearly full', at: '2026-09-01T11:50:00.000Z' },
        }),
      ],
      unused: [{ agentId: 'agent-d', program: 'agent-d', programPath: '/usr/bin/agent-d' }],
      none: false,
    },
    exchange: {
      entries: [
        entry({ id: 8, author: 'cyv', isAgent: true, kind: 'turn', body: 'Done with T40002; wave 2 is next.', task: 'T40002' }),
        entry({ id: 7, body: 'Is the wave order right?' }),
        entry({ id: 6, body: 'Older note, handled.', status: 'addressed' }),
      ],
      total: 12,
      omitted: 9,
    },
    now: NOW,
  };
}

/** The markup between two region ids, so an assertion about one region is not satisfied by another. */
function region(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const rest = html.slice(start);
  const end = rest.indexOf('</section>');
  return rest.slice(0, end);
}

describe('the inline client script', () => {
  it('parses as JavaScript, so a newline that escaped the template literal is caught here', () => {
    const html = renderHome(emptyPage());
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) {
      // Throws a SyntaxError on a malformed script; the page's own tests
      // otherwise never execute what the browser does.
      expect(() => new Script(source)).not.toThrow();
    }
  });
});

describe('relativeTime', () => {
  it('steps up units early because the reader wants staleness, not a duration', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 60_000, NOW)).toBe('60s ago');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
    expect(relativeTime('not a date', NOW)).toBe('at an unreadable time');
  });
});

describe('checkIndicatorHtml', () => {
  it('words each state of the last check', () => {
    expect(checkIndicatorHtml({ state: 'never' }, NOW)).toContain('no check yet');
    expect(checkIndicatorHtml({ state: 'running', startedAt: '2026-09-01T11:59:00.000Z', mode: 'staged' }, NOW))
      .toContain('check running · staged');
    const finished = checkIndicatorHtml(
      { state: 'finished', findings: 3, filesChecked: 1, finishedAt: '2026-09-01T11:55:00.000Z', mode: 'working', evidence: 'measured' },
      NOW,
    );
    expect(finished).toContain('3 findings');
    expect(finished).toContain('class="ev now"');
    expect(finished).toContain('5m ago');
    const clean = checkIndicatorHtml(
      { state: 'finished', findings: 0, filesChecked: 1, finishedAt: '2026-09-01T11:55:00.000Z', mode: 'working', evidence: 'recorded' },
      NOW,
    );
    expect(clean).toContain('clean');
    expect(clean).toContain('class="ev recorded"');
  });
});

describe('renderHome with everything populated', () => {
  const html = renderHome(fullPage());

  it('offers a project selector only when more than one project is registered', () => {
    expect(html).toContain('<select class="project-select"');
    expect(html).toContain('one · 2 needs you · 1 in flight');
    expect(html).toContain('disabled');
    expect(html).toContain('gone · directory is missing');
    expect(renderHome(emptyPage())).not.toContain('<select');
  });

  it('leads with needs-you in the attention treatment, and nowhere else', () => {
    expect(html).toContain('class="sect attention"');
    expect(html.split('class="sect attention"')).toHaveLength(2);
    expect(html).toContain('gates failed on T40001');
    expect(html).toContain('your note, unaddressed');
  });

  it('renders each needs-you item as a block with the question first', () => {
    const needs = region(html, 'needs-you');
    expect(needs).toContain('Should T40001 be retried with the gate fix applied?');
    expect(needs).toContain('Is the wave ordering for spec 0040 correct?');
    expect(needs).toContain('class="q"');
  });

  it('renders a dismiss action as a button with data-item', () => {
    const needs = region(html, 'needs-you');
    expect(needs).toContain('class="act act-dismiss" data-item="d-0000"');
  });

  it('renders a tell action as a button with data-prefill', () => {
    const needs = region(html, 'needs-you');
    expect(needs).toContain('class="act act-tell" data-prefill=');
    expect(needs).toContain('data-task="T40001"');
  });

  it('renders an open action as a link with its href', () => {
    const needs = region(html, 'needs-you');
    expect(needs).toContain('class="act" href="/files?p=x#T40005"');
  });

  it('renders a close action as a button with act-close class', () => {
    const needs = region(html, 'needs-you');
    expect(needs).toContain('class="act act-close" data-dispatch="d-0000"');
  });

  it('does not produce any inline onclick handlers in needs-you', () => {
    const needs = region(html, 'needs-you');
    expect(needs).not.toContain('onclick=');
  });

  it('names the spec being worked with its done-of-total', () => {
    expect(html).toContain('0040 · a dashboard that makes sense');
    expect(html).toContain('2/8');
  });

  it('renders the stop control only when the dispatch can be stopped, and shows the refusal otherwise', () => {
    const motion = region(html, 'motion');
    expect(motion).toContain('<button class="stop" data-dispatch="d-0001">stop</button>');
    expect(motion).not.toContain('data-dispatch="d-0002">stop');
    expect(motion).toContain('opened on another host (build-box)');
  });

  it('escapes a hostile task string', () => {
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('marks liveness with the evidence treatment and gives every running dispatch a diff link', () => {
    const motion = region(html, 'motion');
    expect(motion).toContain('class="ev now">live');
    expect(motion).toContain('class="ev signal">abandoned');
    expect(motion).toContain('pid 9 is not running');
    expect(motion).toContain('/diff?d=working&amp;p=');
  });

  it('groups next-up tasks by wave and lists blocked ones with what they wait on', () => {
    const motion = region(html, 'motion');
    expect(motion).toContain('wave 1 · can run at once');
    expect(motion).toContain('blocked');
    expect(motion).toContain('waiting on T40006');
    expect(motion).toContain('packages/core/src/a.ts, packages/core/src/b.ts');
  });

  it('lists finished dispatches newest first with failures visibly apart', () => {
    const motion = region(html, 'motion');
    expect(motion.indexOf('T40002')).toBeLessThan(motion.indexOf('T40001'));
    expect(motion).toContain('class="bad">gates-failed');
    expect(motion).toContain('class="ok">succeeded');
    expect(motion).toContain('gates failed: tsc');
  });

  it('states the stall as what is and is not happening, and names the idle lanes', () => {
    const motion = region(html, 'motion');
    expect(motion).toContain('Open work, 1 lane free, and nothing dispatched for 3h ago (interval 30m): lane-b.');
  });

  it('shows uncommitted work as a count with the named files, and the unreadable log lines', () => {
    const motion = region(html, 'motion');
    expect(motion).toContain('+120 −4</span> uncommitted across 3 files');
    expect(motion).toContain('packages/core/src/dashboard/home.ts');
    expect(motion).toContain('and 2 more files');
    expect(motion).toContain('1 line of the dispatch log could not be read and are not counted.');
  });

  it('draws lanes as rows with state words, and never a meter, percentage or token count', () => {
    const lanes = region(html, 'lanes');
    expect(lanes).not.toContain('%');
    expect(lanes).not.toContain('meter');
    expect(lanes).not.toContain('token');
    expect(lanes).toContain('running 1 of 1');
    expect(lanes).toContain('class="ev ink">busy');
    expect(lanes).toContain('class="ev stale">cooling');
    expect(lanes).toContain('class="ev muted">unavailable');
    expect(lanes).toContain('class="ev muted">reserved');
  });

  it('tells a cooling lane how cooldown clears and an unavailable lane what was looked for', () => {
    const lanes = region(html, 'lanes');
    expect(lanes).toContain('after d-0003 closed produced-nothing');
    expect(lanes).toContain('cyv dispatch --lane lane-b');
    expect(lanes).toContain('program not found: tried agent-c, agent-c.cmd');
  });

  it('attributes the orchestrator state as self-reported and lists unused agents', () => {
    const lanes = region(html, 'lanes');
    expect(lanes).toContain('orchestrator');
    expect(lanes).toContain('self-reported degraded 10m ago · context nearly full');
    expect(lanes).toContain('Installed and not declared as a lane: <span class="mono">agent-d</span> (agent-d)');
  });

  it('marks agent entries apart from owner entries and offers mark-addressed only on open owner notes', () => {
    const exchange = region(html, 'exchange');
    expect(exchange).toContain('class="cm agent" data-id="8"');
    expect(exchange).toContain('cyv (agent)');
    expect(exchange).toContain('class="cm" data-id="7"');
    expect(exchange).toContain('class="cm addressed" data-id="6"');
    expect(exchange).toContain('data-id="7">mark addressed');
    expect(exchange).not.toContain('class="addressed-btn" data-id="8"');
    expect(exchange).not.toContain('class="addressed-btn" data-id="6"');
    expect(exchange).toContain('9 older not shown');
    expect(exchange).toContain('<textarea id="reply"');
  });

  it('polls its own project and carries the one allowed disclaimer in the footer', () => {
    expect(html).toContain(`data-poll="/api/state?p=${encodeURIComponent(ROOT)}"`);
    expect(html).toContain('Reads .cyv-review/ and git. Runs nothing.');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('onsubmit=');
    expect(html).not.toContain('alert(');
  });
});

describe('renderHome with everything empty', () => {
  const html = renderHome(emptyPage());

  it('shows every region with a designed empty state', () => {
    expect(html).toContain('Nothing is waiting on you.');
    expect(html).toContain('No spec has open tasks.');
    expect(html).toContain('docs/specs/&lt;n&gt;/tasks.md');
    expect(html).toContain('Nothing is running.');
    expect(html).toContain('No open task is unblocked.');
    expect(html).toContain('Nothing has finished yet.');
    expect(html).toContain('Working tree clean.');
    expect(html).toContain('No lane is declared. Add <code>executor.lanes</code> to checkyourvibe.json.');
    expect(html).toContain('No turns recorded yet.');
    expect(html).toContain('cyv comments --record');
  });

  it('does not use the attention treatment, a stop control, or a stall line when there is nothing to attend to', () => {
    expect(html).not.toContain('class="sect attention"');
    expect(html).not.toContain('class="stop"');
    expect(html).not.toContain('Stall');
    expect(html).not.toContain('could not be read');
  });

  it('names the single project without a selector and says no check has run', () => {
    expect(html).not.toContain('<select');
    expect(html).toContain('>one</a>');
    expect(html).toContain('no check yet');
  });
});

