import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildLanesPage,
  renderLanesPage,
  type LanesPageSource,
} from '../../src/dashboard/lanes-page.js';
import type { CheckYourVibeConfig } from '../../src/config/types.js';
import type { DispatchRecord } from '../../src/executor/dispatch.js';
import type { DispatchOutcome } from '../../src/executor/outcome.js';
import type { LaneDeclaration } from '../../src/executor/lane.js';
import type { DispatchLog } from '../../src/executor/store.js';
import type { QuotaEntry } from '../../src/dashboard/state-store.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

/**
 * The config and log are built in memory: `buildLanesPage` reads nothing from
 * disk itself beyond `PATH`, so a lane's programs resolve against the `env`
 * each test supplies — empty for "not on this machine", a directory of stub
 * files for "found".
 */
function config(lanes: LaneDeclaration[]): CheckYourVibeConfig {
  return {
    packs: [],
    analyzers: [],
    rules: {},
    strict: false,
    exclude: [],
    executor: { lanes },
  };
}

interface LaneOverrides {
  id?: string;
  agentId?: string;
  concurrencyCap?: number;
  models?: LaneDeclaration['models'];
  orchestrator?: boolean;
  acceptsDispatch?: boolean;
  executes?: LaneDeclaration['executes'];
}

function lane(over: LaneOverrides = {}): LaneDeclaration {
  return {
    id: over.id ?? 'lane-a',
    agentId: over.agentId ?? 'gemini',
    concurrencyCap: over.concurrencyCap ?? 1,
    billing: { kind: 'subscription', permitsBilledOverage: false },
    models: over.models ?? [{ kind: 'mechanical-transformation', ordering: ['strong', 'weak'] }],
    orchestrator: over.orchestrator ?? false,
    acceptsDispatch: over.acceptsDispatch ?? true,
    executes: over.executes ?? 'cli',
  };
}

function log(records: readonly DispatchRecord[]): DispatchLog {
  return { records: [...records], refusals: [], acknowledged: [] };
}

function record(
  dispatchId: string,
  laneId: string,
  openedAt: string,
): DispatchRecord {
  return {
    dispatchId,
    workId: `w-${dispatchId}`,
    attempt: 1,
    openedAt,
    declaration: {
      task: `task behind ${dispatchId}`,
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/thing.ts'],
      expectsFileChanges: true,
      gates: ['cyv-check'],
    },
    assignment: {
      laneId,
      agentId: 'gemini',
      model: 'weak',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
}

function closed(
  dispatchId: string,
  laneId: string,
  kind: DispatchOutcome['kind'],
  closedAt: string,
): DispatchRecord {
  const open = record(dispatchId, laneId, '2026-09-01T10:00:00.000Z');
  open.closed = {
    closedAt,
    report: { status: 'success', exitCode: 0, rateLimited: false },
    gateResults: [],
    outcome: {
      kind,
      summary: `the dispatch ${kind}`,
      changedPaths: [],
      outOfScopePaths: [],
      failedGates: [],
    },
  };
  return open;
}

interface SourceOverrides {
  config?: CheckYourVibeConfig;
  log?: DispatchLog;
  quotas?: Readonly<Record<string, QuotaEntry>>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: number;
}

function source(over: SourceOverrides = {}): LanesPageSource {
  return {
    project: '/repo',
    projectName: 'repo',
    config: over.config ?? config([]),
    log: over.log ?? log([]),
    quotas: over.quotas ?? {},
    env: over.env ?? {},
    cwd: over.cwd ?? '/repo',
    now: over.now ?? NOW,
  };
}

/** A directory of empty files standing in for installed agent programs. */
async function binDir(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-lanes-bin-'));
  for (const name of names) {
    // Both names exist so the stub resolves whichever suffix the platform's
    // program lookup tries first: the bare name, or the PATHEXT suffix.
    await writeFile(join(dir, name), '', 'utf-8');
    await writeFile(join(dir, `${name}.EXE`), '', 'utf-8');
  }
  return dir;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return { PATH: dir, PATHEXT: '.EXE;.CMD' };
}

describe('buildLanesPage assembles the /lanes page', () => {
  it('lists every declared lane', async () => {
    const lanes = [
      lane({ id: 'orch', agentId: 'claude-code', orchestrator: true, acceptsDispatch: false, executes: 'subagent' }),
      lane({ id: 'alpha', agentId: 'devin', concurrencyCap: 2 }),
      lane({ id: 'beta', agentId: 'gemini' }),
    ];
    const page = await buildLanesPage(source({ config: config(lanes) }));

    expect(page.lanes.map((row) => row.id)).toEqual(['orch', 'alpha', 'beta']);
    const html = renderLanesPage(page);
    expect(html).toContain('orch');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
  });

  it('says so plainly when no lane is declared', async () => {
    const html = renderLanesPage(await buildLanesPage(source()));
    expect(html).toContain('No lane is declared');
  });

  it('marks a lane whose agent binary is missing unavailable rather than idle', async () => {
    // An empty PATH: nothing is found, so the lane can never run — and the
    // page must say that instead of reporting the lane as free.
    const page = await buildLanesPage(
      source({ config: config([lane({ id: 'gone' })]), env: {} }),
    );

    const row = page.lanes.find((candidate) => candidate.id === 'gone');
    expect(row?.status).toBe('unavailable');
    expect(row?.availability).toEqual({ kind: 'missing-program', program: 'gemini' });

    const html = renderLanesPage(page);
    expect(html).toContain('data-status="unavailable"');
    expect(html).toContain('is not on');
    expect(html).toContain('can never run');
    expect(html).not.toContain('data-status="free"');
  });

  it('does not mark a subagent lane unavailable for a missing program', async () => {
    const page = await buildLanesPage(
      source({
        config: config([
          lane({ id: 'orch', agentId: 'claude-code', orchestrator: true, acceptsDispatch: false, executes: 'subagent' }),
        ]),
        env: {},
      }),
    );

    const row = page.lanes.find((candidate) => candidate.id === 'orch');
    expect(row?.availability).toEqual({ kind: 'subagent' });
    expect(row?.status).toBe('reserved');
  });

  it('counts the dispatches in flight against the lane cap and names them', async () => {
    const records = [
      record('d-open', 'lane-a', '2026-09-01T11:30:00.000Z'),
      closed('d-other', 'lane-b', 'succeeded', '2026-09-01T10:05:00.000Z'),
    ];
    const lanes = [
      lane({ id: 'lane-a', concurrencyCap: 2 }),
      lane({ id: 'lane-b', agentId: 'devin' }),
    ];
    const page = await buildLanesPage(
      source({ config: config(lanes), log: log(records), env: {} }),
    );

    const row = page.lanes.find((candidate) => candidate.id === 'lane-a');
    expect(row?.running).toBe(1);
    expect(row?.inFlight.map((d) => d.dispatchId)).toEqual(['d-open']);

    const html = renderLanesPage(page);
    expect(html).toContain('Running — 1 of 2');
    expect(html).toContain('d-open');
    expect(html).toContain('task behind d-open');
    expect(html).toContain('elapsed 30m');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain('data-dispatch="d-open"');
  });

  it('shows an exhausted lane its reset time', async () => {
    const resetsAt = '2026-09-02T00:00:00.000Z';
    const quotas: Record<string, QuotaEntry> = {
      'lane-a': { exhausted: true, resetsAt },
    };
    // The program resolves, so the badge is the quota's and not the binary's.
    const dir = await binDir(['gemini']);
    const page = await buildLanesPage(
      source({ config: config([lane()]), quotas, env: envFor(dir), cwd: dir }),
    );

    const row = page.lanes.find((candidate) => candidate.id === 'lane-a');
    expect(row?.status).toBe('exhausted');

    const html = renderLanesPage(page);
    expect(html).toContain('data-status="exhausted"');
    expect(html).toContain('Subscription exhausted');
    expect(html).toContain(resetsAt);
  });

  it('shows a cooling lane when it entered cooldown and how it clears', async () => {
    const records = [
      closed('d-nothing', 'lane-a', 'produced-nothing', '2026-09-01T11:00:00.000Z'),
    ];
    const page = await buildLanesPage(
      source({ config: config([lane()]), log: log(records), env: {} }),
    );

    const row = page.lanes.find((candidate) => candidate.id === 'lane-a');
    expect(row?.cooldown?.reason).toBe('produced-nothing');
    expect(row?.cooldown?.dispatchId).toBe('d-nothing');

    const html = renderLanesPage(page);
    expect(html).toContain('In cooldown since');
    expect(html).toContain('d-nothing');
    expect(html).toContain('produced-nothing');
    expect(html).toContain('clears');
  });

  it('renders the model ordering per task kind, in order, naming where a dispatch starts', async () => {
    const lanes = [
      lane({
        models: [
          { kind: 'mechanical-transformation', ordering: ['m-strong', 'm-mid', 'm-weak'] },
          { kind: 'judgment-required', ordering: ['j-strong', 'j-weak'] },
        ],
      }),
    ];
    const html = renderLanesPage(
      await buildLanesPage(source({ config: config(lanes), env: {} })),
    );

    expect(html).toContain('mechanical-transformation');
    expect(html.indexOf('m-strong')).toBeLessThan(html.indexOf('m-mid'));
    expect(html.indexOf('m-mid')).toBeLessThan(html.indexOf('m-weak'));
    expect(html).toContain('judgment-required');
    expect(html.indexOf('j-strong')).toBeLessThan(html.indexOf('j-weak'));
    // The scheduler runs the weakest entry first, so the page marks it.
    expect(html).toContain('m-weak</span><span class="ln-mut"> — starts here');
    expect(html).toContain('j-weak</span><span class="ln-mut"> — starts here');
  });

  it('says a kind the lane declares no model for is refused there', async () => {
    // `lane()` declares only a mechanical ordering.
    const html = renderLanesPage(
      await buildLanesPage(source({ config: config([lane()]), env: {} })),
    );
    expect(html).toContain('judgment-required');
    expect(html).toContain('no model declared');
  });

  it('lists an agent found on PATH that no lane declares', async () => {
    const dir = await binDir(['gemini']);
    const page = await buildLanesPage(
      source({
        config: config([lane({ agentId: 'devin' })]),
        env: envFor(dir),
        cwd: dir,
      }),
    );

    expect(page.undeclared.map((agent) => agent.agentId)).toEqual(['gemini']);

    const html = renderLanesPage(page);
    expect(html).toContain('Discovered in PATH');
    expect(html).toContain('gemini');
  });

  it('lists no undeclared agent when PATH carries none of the known programs', async () => {
    const page = await buildLanesPage(
      source({ config: config([lane()]), env: {} }),
    );
    expect(page.undeclared).toEqual([]);
  });

  it('lists recent dispatches newest first with their outcomes', async () => {
    const records = [
      closed('d-older', 'lane-a', 'succeeded', '2026-09-01T09:00:00.000Z'),
      closed('d-newer', 'lane-a', 'gates-failed', '2026-09-01T11:00:00.000Z'),
    ];
    const page = await buildLanesPage(
      source({ config: config([lane()]), log: log(records), env: {} }),
    );

    expect(page.lanes[0]?.recent.map((d) => d.dispatchId)).toEqual(['d-newer', 'd-older']);

    const html = renderLanesPage(page);
    expect(html.indexOf('d-newer')).toBeLessThan(html.indexOf('d-older'));
    expect(html).toContain('gates-failed');
    expect(html).toContain('the dispatch gates-failed');
  });

  it('reports the count of failures for a lane', async () => {
    const records = [
      closed('d-1', 'lane-a', 'gates-failed', '2026-09-01T10:05:00.000Z'),
      closed('d-2', 'lane-a', 'gates-failed', '2026-09-01T10:10:00.000Z'),
      closed('d-3', 'lane-a', 'succeeded', '2026-09-01T10:15:00.000Z'),
    ];
    const page = await buildLanesPage(
      source({ config: config([lane()]), log: log(records), env: {} }),
    );
    const html = renderLanesPage(page);
    expect(html).toContain('Ran 3 — 1 succeeded, 2 failed gates');
    expect(html).toContain('ln-bad'); // High failure rate should mark it bad
  });

  it('calls a lane stopped by a rate limit out of quota, as every other surface does', async () => {
    // The badge used to read "cooling" — a word no other surface uses for the
    // state the board calls "out of quota". `data-status` stays the machine
    // name; the words a person reads are what had to agree.
    const records = [
      closed('d-rate', 'lane-a', 'rate-limited', '2026-09-01T11:00:00.000Z'),
    ];
    const dir = await binDir(['gemini']);
    const page = await buildLanesPage(
      source({ config: config([lane()]), log: log(records), env: envFor(dir), cwd: dir }),
    );

    const row = page.lanes.find((candidate) => candidate.id === 'lane-a');
    expect(row?.status).toBe('cooling');

    const html = renderLanesPage(page);
    expect(html).toContain('data-status="cooling"');
    expect(html).toContain('ln-st-cooling">out of quota');
    expect(html).not.toContain('>cooling</span>');
  });

  it('says when the page was rendered, and claims no update it does not make', async () => {
    const html = renderLanesPage(await buildLanesPage(source()));

    expect(html).toContain('rendered on request — not updated automatically');
    expect(html).toContain(`data-epoch="${NOW}"`);
    // The age is rewritten from the epoch the page carries — a stale tab is
    // never left showing the server's frozen "just now".
    expect(html).toContain('.cyv-freshness[data-epoch]');
    expect(html).not.toContain('id="board-live-badge"');
    expect(html).not.toContain('polling — ');
  });

  it('escapes lane ids and task text taken from the log', async () => {
    const dangerous = record('d-script', 'lane-a', '2026-09-01T11:00:00.000Z');
    dangerous.declaration.task = 'tick <script>alert(1)</script> the box';
    const page = await buildLanesPage(
      source({ config: config([lane()]), log: log([dangerous]), env: {} }),
    );

    const html = renderLanesPage(page);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
