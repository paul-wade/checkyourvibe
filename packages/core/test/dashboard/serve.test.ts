import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { Server } from 'node:http';
import {
  command,
  createDashboardServer,
  formatStartupBanner,
  lanAddresses,
  listenDashboard,
  resolveAccessToken,
} from '../../src/cli/dashboard.js';
import { isUnknownArray } from '../../src/guards.js';
import { dispatchLogPath, readDispatchLog } from '../../src/executor/store.js';
import { markQuotaExhausted, readState } from '../../src/dashboard/state-store.js';
import {
  commentsToExchange,
  loadComments,
} from '../../src/dashboard/review/comments.js';
import {
  createSessionManager,
  type SessionManager,
  type SessionProcess,
  type SessionSpawn,
} from '../../src/dashboard/session-manager.js';
import type { ProgramLauncher } from '../../src/executor/program.js';

/**
 * What `cyv dashboard` actually serves, fetched over HTTP from the server the
 * command builds.
 *
 * Every other test in this directory calls `renderDashboard` directly and so
 * chooses its own arguments. That is exactly how T6006 stayed invisible: the
 * renderer had always grouped by analyzer when handed a rule-to-analyzer map,
 * and the command assembled the map and did not pass it, so the page fell back
 * to `rule.pack` while the render tests stayed green. These tests read the
 * bytes a browser would receive.
 *
 * The fixture puts both analyzers' rules in one shared pack, so pack grouping
 * and analyzer grouping produce visibly different pages: one group named
 * `shared`, or two named `alpha` and `beta`.
 */

const PACK = 'shared';

/** A 64-character lowercase hex digest, the shape a pinned suppression requires. */
const FINGERPRINT = 'a'.repeat(64);

function alphaManifest(): unknown {
  return {
    protocol: 1,
    id: 'alpha',
    match: ['**/*.ts'],
    rules: [
      {
        id: 'a-one',
        category: 'type-safety',
        scope: 'file',
        severity: 'error',
        pack: PACK,
        summary: 'summary for a-one',
        why: 'why for a-one',
        allowedFixes: ['fix a-one'],
        notFixes: [{ pattern: 'reach for a-two', because: 'trades one for another', rule: 'a-two' }],
        examples: { bad: 'bad a-one', good: 'good a-one' },
      },
      {
        id: 'a-two',
        category: 'type-safety',
        scope: 'file',
        severity: 'warning',
        pack: PACK,
        summary: 'summary for a-two',
        why: 'why for a-two',
        allowedFixes: ['fix a-two'],
        notFixes: [],
        examples: { bad: 'bad a-two', good: 'good a-two' },
      },
    ],
    // Never executed: the dashboard renders from static manifests, so this
    // module is not written to disk. A request that ran an analyzer would fail
    // to find it.
    exec: { type: 'node', module: './alpha.mjs' },
  };
}

function betaManifest(): unknown {
  return {
    protocol: 1,
    id: 'beta',
    match: ['**/*.cs'],
    rules: [
      {
        id: 'b-one',
        category: 'error-handling',
        scope: 'file',
        severity: 'error',
        pack: PACK,
        summary: 'summary for b-one',
        why: 'why for b-one',
        allowedFixes: ['fix b-one'],
        // Names a rule in the other analyzer. Grouped by analyzer this is a
        // dead end with no edge to draw; grouped by pack it would become an
        // edge between two analyzers that cannot constrain each other.
        notFixes: [{ pattern: 'reach for a-one', because: 'different analyzer', rule: 'a-one' }],
        examples: { bad: 'bad b-one', good: 'good b-one' },
      },
      {
        id: 'b-two',
        category: 'error-handling',
        scope: 'file',
        severity: 'warning',
        pack: PACK,
        summary: 'summary for b-two',
        why: 'why for b-two',
        allowedFixes: ['fix b-two'],
        notFixes: [],
        examples: { bad: 'bad b-two', good: 'good b-two' },
      },
    ],
    exec: { type: 'node', module: './beta.mjs' },
  };
}

function config(): Record<string, unknown> {
  return {
    packs: [PACK],
    analyzers: [
      { id: 'alpha', package: './alpha.manifest.json' },
      { id: 'beta', package: './beta.manifest.json' },
    ],
    rules: {},
    strict: false,
    exclude: [],
    suppressions: [
      {
        ruleId: 'a-one',
        target: 'src/**',
        reason: 'adopting the rule across the tree',
        expires: '2099-01-01',
      },
      {
        ruleId: 'a-two',
        target: 'src/one.ts',
        reason: 'one recorded finding, pinned',
        expires: '2099-01-01',
        fingerprint: FINGERPRINT,
        occurrence: 0,
      },
      {
        ruleId: 'b-one',
        target: 'src/**',
        reason: 'lapsed and never renewed',
        expires: '2020-01-01',
      },
    ],
  };
}

function baselineFile(): string {
  const entry = (ruleId: string, path: string, occurrence: number): unknown => ({
    path,
    ruleId,
    fingerprint: FINGERPRINT,
    occurrence,
    line: occurrence + 1,
  });
  return JSON.stringify(
    {
      version: 1,
      takenAt: '2026-01-01T00:00:00.000Z',
      commit: 'abc123def4567890',
      entries: [
        entry('a-one', 'src/one.ts', 0),
        entry('a-one', 'src/one.ts', 1),
        // A rule no analyzer declares: recorded debt with no rule below to
        // annotate, which the page has to state rather than drop.
        entry('ghost-rule', 'src/two.ts', 0),
      ],
    },
    null,
    2,
  );
}

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-dashboard-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(), null, 2));
  await writeFile(join(repo, 'alpha.manifest.json'), JSON.stringify(alphaManifest(), null, 2));
  await writeFile(join(repo, 'beta.manifest.json'), JSON.stringify(betaManifest(), null, 2));
  await writeFile(join(repo, 'checkyourvibe.baseline.json'), baselineFile());
  return repo;
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The dashboard server is not bound to a TCP port.');
  }
  return address.port;
}

interface Served {
  /** The glance page, `/`: the six questions a landing reader asks. */
  home: string;
  /** The rules page, `/rules`: the rule browser and interlock, one tab away (spec 0040 R7.3). */
  page: string;
  volatile: string;
}

/**
 * Bind the command's own server on an ephemeral port, fetch the two documents
 * it serves, and close it. Port 0 keeps concurrent test files from colliding on
 * a fixed one.
 */
async function serve(repo: string): Promise<Served> {
  const { server } = await createDashboardServer({ root: repo, registry: [repo] });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const base = `http://127.0.0.1:${boundPort(server)}`;
    const homeResponse = await fetch(`${base}/`);
    expect(homeResponse.status).toBe(200);
    const home = await homeResponse.text();

    const pageResponse = await fetch(`${base}/rules`);
    expect(pageResponse.status).toBe(200);
    const page = await pageResponse.text();

    const volatileResponse = await fetch(`${base}/volatile.html`);
    expect(volatileResponse.status).toBe(200);
    const volatilePanels = await volatileResponse.text();

    return { home, page, volatile: volatilePanels };
  } finally {
    // undici keeps its sockets alive, and `close` alone waits for them.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

describe('cyv dashboard serves the interlock grouped by analyzer (T6006)', () => {
  it('draws one graph per analyzer, not one per pack', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('<h3><code>alpha</code></h3>');
    expect(page).toContain('<h3><code>beta</code></h3>');
    expect(page).not.toContain(`<h3><code>${PACK}</code></h3>`);
  });

  it('states isolation as a fact about the analyzer, not the pack', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('isolated within the beta analyzer');
    expect(page).not.toContain(`isolated within the ${PACK} pack`);
  });

  it('draws no edge between rules in different analyzers', async () => {
    const { page } = await serve(await makeRepo());

    // a-one → a-two is inside alpha and is drawn. b-one names a-one, which is
    // in another analyzer, so it is counted as a dead end instead.
    expect(page).toContain('a-one → a-two');
    expect(page).not.toContain('b-one → a-one');
  });

  it('serves the page without executing an analyzer', async () => {
    const { page } = await serve(await makeRepo());

    // Neither manifest's `exec.module` exists on disk, so a page that ran one
    // could not have been produced.
    expect(page).toContain('no analyzer is executed to render this page');
    expect(page).toContain('summary for a-one');
  });
});

describe('cyv dashboard serves suppressions and baseline (T6005)', () => {
  it('splits active suppressions into broad and pinned, as cyv check does', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('2 active suppression(s)');
    expect(page).toContain('1 broad, 1 pinned');
    expect(page).toContain('every match, including');
    expect(page).toContain('one finding (fingerprint, occurrence 0)');
  });

  it('marks the expired suppression as suppressing nothing', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('class="expired-row"');
    expect(page).toContain('EXPIRED and no longer suppressing anything');
    expect(page).toContain('lapsed and never renewed');
  });

  it('reports the baseline it recorded, by rule and by file', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('3 entries recorded');
    expect(page).toContain('By rule');
    expect(page).toContain('By file (worst first)');
    expect(page).toContain('src/one.ts');
    expect(page).toContain('not verified against');
  });

  it('annotates each rule with its own debt and leaves unannotated rules bare', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('2 baseline entries');
    expect(page).toContain('1 broad suppression<');
    expect(page).toContain('1 pinned suppression<');
    // b-two has neither, and must not be shown as zero of everything.
    expect(page).not.toMatch(/b-two[\s\S]{0,600}0 baseline/);
  });

  it('names recorded debt whose rule this configuration does not enable', async () => {
    const { page } = await serve(await makeRepo());

    expect(page).toContain('ghost-rule');
    expect(page).toContain('this configuration does not enable');
  });

  it('refreshes the same panels from /volatile.html without the page around them', async () => {
    const { volatile: panels } = await serve(await makeRepo());

    expect(panels).toContain('<h2>Suppressions</h2>');
    expect(panels).toContain('<h2>Baseline</h2>');
    expect(panels).toContain('1 broad, 1 pinned');
    expect(panels).not.toContain('<!doctype');
    // The rule browser is rendered once at startup and is not part of the poll.
    expect(panels).not.toContain('<h2>The interlock</h2>');
  });
});

/**
 * A dispatch log written under `.cyv-review/` before the server is built, so the
 * executor tests below read the panels out of the bytes the command actually
 * serves rather than out of a renderer a test called with arguments of its own
 * choosing — the T6006 lesson this file already exists for.
 *
 * It covers the four states Requirement 10 has to keep apart: a dispatch in
 * flight, one that succeeded, one classified `produced-nothing`, and the lane
 * that outcome left in cooldown.
 */
async function writeDispatchLog(repo: string): Promise<void> {
  const declaration = {
    task: 'Tighten the ownership check',
    taskKind: 'judgment-required',
    ownedPaths: ['src/ownership.ts'],
    expectsFileChanges: true,
    gates: ['typecheck'],
  };
  const entries: unknown[] = [
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-done',
      workId: 'w-1',
      attempt: 1,
      openedAt: '2026-08-29T10:00:00.000Z',
      declaration: {
        ...declaration,
        task: 'Rename the parser entry point',
        ownedPaths: ['src/parse.ts'],
      },
      assignment: {
        laneId: 'lane-alpha',
        agentId: 'agent-alpha',
        model: 'alpha-small',
        billing: 'subscription',
        permitsBilledOverage: false,
        orchestrator: false,
        declaredHeadroomAtSchedule: 2,
      },
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-done',
      closedAt: '2026-08-29T10:04:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [{ gate: 'typecheck', passed: true }],
      outcome: {
        kind: 'succeeded',
        summary: 'changed 1 declared file(s) and every gate passed',
        changedPaths: ['src/parse.ts'],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-nothing',
      workId: 'w-2',
      attempt: 1,
      openedAt: '2026-08-29T10:05:00.000Z',
      declaration,
      assignment: {
        laneId: 'lane-beta',
        agentId: 'agent-beta',
        model: 'beta-small',
        billing: 'subscription',
        permitsBilledOverage: false,
        orchestrator: false,
        declaredHeadroomAtSchedule: 1,
      },
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-nothing',
      closedAt: '2026-08-29T10:06:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [],
      outcome: {
        kind: 'produced-nothing',
        summary: 'the executor reported success and none of its declared files changed',
        changedPaths: [],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-running',
      workId: 'w-2',
      attempt: 2,
      openedAt: '2026-08-29T10:07:00.000Z',
      declaration,
      assignment: {
        laneId: 'lane-alpha',
        agentId: 'agent-alpha',
        model: 'alpha-small',
        billing: 'subscription',
        permitsBilledOverage: false,
        orchestrator: true,
        declaredHeadroomAtSchedule: 3,
      },
      escalation: {
        fromLaneId: 'lane-beta',
        fromModel: 'beta-small',
        reason: 'rate-exhaustion',
        detail: 'the executor reported success and none of its declared files changed',
        priorDispatchId: 'd-nothing',
      },
    },
    {
      event: 'refused',
      schemaVersion: 1,
      dispatchId: 'd-blocked',
      workId: 'w-3',
      refusedAt: '2026-08-29T10:09:00.000Z',
      declaration: {
        ...declaration,
        task: 'Document the dispatch record',
        ownedPaths: ['docs/dispatch.md'],
      },
      refusal: {
        reason: 'no-eligible-lane',
        rejections: [
          {
            laneId: 'lane-alpha',
            reason: { reason: 'at-concurrency-cap', concurrencyCap: 3, inFlight: 3 },
          },
          {
            laneId: 'lane-beta',
            reason: {
              reason: 'in-cooldown',
              since: '2026-08-29T10:06:00.000Z',
              cause: 'produced-nothing',
            },
          },
        ],
      },
    },
  ];

  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await writeFile(
    join(repo, '.cyv-review', 'dispatches.ndjson'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  );
}

/** Collapse the served HTML's wrapping so an assertion can name a whole sentence. */
function flatten(html: string): string {
  return html.replace(/\s+/g, ' ');
}

/** The executor panels, sliced out of the page, with no other panel's text in them. */
function executorPanels(page: string): string {
  const html = flatten(page);
  const start = html.indexOf('<h2>Executor dispatches</h2>');
  const end = html.indexOf('<h2>Results</h2>', start);
  if (start === -1 || end === -1) {
    throw new Error('The served page has no executor section between the run panel and Results.');
  }
  return html.slice(start, end);
}

describe('cyv dashboard serves the executor view (spec 0011 Requirement 10)', () => {
  it('shows which lane is running what, on which model, and why that model', async () => {
    const repo = await makeRepo();
    await writeDispatchLog(repo);
    const html = flatten((await serve(repo)).page);

    expect(html).toContain('<h2>Executor dispatches</h2>');
    expect(html).toContain('<h3>In flight</h3>');
    expect(html).toContain('d-running');
    expect(html).toContain('alpha-small');
    expect(html).toContain('the weakest model this lane declares for this task kind');
    expect(html).toContain('3 declared headroom at the moment it was scheduled');
    expect(html).toContain('Escalated to this lane');
  });

  it('states concurrency as a count against a declared cap, never as a quota reading', async () => {
    const repo = await makeRepo();
    await writeDispatchLog(repo);
    const { page } = await serve(repo);
    const panels = executorPanels(page);

    expect(panels).toContain('1 of 3, against a cap taken from');
    expect(panels).toContain('at its declared concurrency cap: 3 of 3 running');
    // No percentage-full meter and no figure purporting to be what a dispatch
    // cost: neither number is observable through an authenticated CLI.
    expect(panels).not.toContain('%');
    expect(panels).not.toContain('$');
  });

  it('keeps cooldown apart from a lane merely at its cap', async () => {
    const repo = await makeRepo();
    await writeDispatchLog(repo);
    const panels = executorPanels((await serve(repo)).page);

    expect(panels).toContain('In cooldown since 2026-08-29T10:06:00.000Z');
    expect(panels).toContain('separate states with separate causes');
  });

  it('surfaces what needs a person without a record being opened', async () => {
    const repo = await makeRepo();
    await writeDispatchLog(repo);
    const { page, volatile: panels } = await serve(repo);

    expect(flatten(page)).toContain('2 item(s) need a person');
    expect(flatten(page)).toContain('produced-nothing');
    expect(flatten(page)).toContain('Blocked: no lane was a candidate');
    // The dispatch log changes while dispatches run, so these panels are polled.
    expect(flatten(panels)).toContain('<h2>Executor dispatches</h2>');
  });

  it('says an absent dispatch log is an absent record, not an idle fleet', async () => {
    const html = flatten((await serve(await makeRepo())).page);

    expect(html).toContain('No dispatches are recorded');
    expect(html).toContain('nothing has been dispatched from this repository');
    expect(html).not.toContain('<h3>In flight</h3>');
  });
});

interface ServerHandle {
  base: string;
  stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function startDashboard(repo: string, sessionManager?: SessionManager): Promise<ServerHandle> {
  const { server } = await createDashboardServer({
    root: repo,
    registry: [repo],
    ...(sessionManager !== undefined ? { sessionManager } : {}),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const base = `http://127.0.0.1:${boundPort(server)}`;
  return {
    base,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function boardDeclaration(task: string, ownedPaths: string[], expectsFileChanges = true): unknown {
  return {
    task,
    taskKind: 'mechanical-transformation',
    ownedPaths,
    expectsFileChanges,
    gates: ['typecheck'],
  };
}

function boardAssignment(laneId = 'lane-test'): unknown {
  return {
    laneId,
    agentId: 'agent-test',
    model: 'test',
    billing: 'subscription',
    permitsBilledOverage: false,
    orchestrator: false,
    declaredHeadroomAtSchedule: 1,
  };
}

async function writeBoardLog(repo: string): Promise<void> {
  const entries: unknown[] = [
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-needs',
      workId: 'w-needs',
      attempt: 1,
      openedAt: '2026-09-01T10:00:00.000Z',
      declaration: boardDeclaration('T90001 produced nothing', ['src/needs.ts']),
      assignment: boardAssignment(),
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-needs',
      closedAt: '2026-09-01T10:01:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [],
      outcome: {
        kind: 'produced-nothing',
        summary: 'the executor reported success and none of its declared files changed',
        changedPaths: [],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-review',
      workId: 'w-review',
      attempt: 1,
      openedAt: '2026-09-01T10:02:00.000Z',
      declaration: boardDeclaration('T90002 Render the review panel', ['src/review.ts']),
      assignment: boardAssignment(),
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-review',
      closedAt: '2026-09-01T10:03:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [{ gate: 'typecheck', passed: true }],
      outcome: {
        kind: 'succeeded',
        summary: 'changed 1 declared file(s) and every gate passed',
        changedPaths: ['src/review.ts'],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-done',
      workId: 'w-done',
      attempt: 1,
      openedAt: '2026-09-01T10:04:00.000Z',
      declaration: boardDeclaration('T90003 Mark as done', ['src/done.ts'], false),
      assignment: boardAssignment(),
    },
    {
      event: 'closed',
      schemaVersion: 1,
      dispatchId: 'd-done',
      closedAt: '2026-09-01T10:05:00.000Z',
      report: { status: 'success', exitCode: 0, rateLimited: false },
      gateResults: [{ gate: 'test', passed: true }],
      outcome: {
        kind: 'succeeded',
        summary: 'no files changed',
        changedPaths: [],
        outOfScopePaths: [],
        failedGates: [],
      },
    },
    {
      event: 'opened',
      schemaVersion: 1,
      dispatchId: 'd-motion',
      workId: 'w-motion',
      attempt: 1,
      openedAt: '2026-09-01T10:06:00.000Z',
      declaration: boardDeclaration('T90004 Keep moving', ['src/motion.ts']),
      assignment: boardAssignment(),
    },
  ];

  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await writeFile(
    join(repo, '.cyv-review', 'dispatches.ndjson'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  );
}

async function writeSpecTree(repo: string): Promise<void> {
  const specDir = join(repo, 'docs', 'specs', '0099-fixture');
  await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, 'requirements.md'), '# Requirements\n\nR1. Something.\n', 'utf-8');
  await writeFile(join(specDir, 'tasks.md'), '# Tasks\n\nT1. Do the thing.\n', 'utf-8');
}

describe('cyv dashboard serves the board, drawer, and spec editor (spec 0051)', () => {
  it('serves the board page with all three column headings', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const html = flatten(await response.text());

      // Assert on the heading elements, not on the text appearing anywhere.
      // This test previously matched 'In Motion' against an HTML comment, so
      // it would have passed with no headings rendered at all.
      const columns = [...html.matchAll(/<section class="board-column" data-column="([^"]+)"/g)].map(
        ([, columnId]) => columnId,
      );
      expect(columns).toEqual(['todo', 'in-progress', 'done']);

      const headings = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1]?.trim());
      expect(headings.slice(0, 3)).toEqual(['To Do', 'In Progress', 'Done']);
    } finally {
      await stop();
    }
  });

  it('serves drawer content for a dispatch that reached Review or Done', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/drawer?dispatch=d-review`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const drawer = await response.text();
      expect(drawer).toContain('data-reviewable="true"');
      expect(drawer).toContain('In scope');
      expect(drawer).toContain('src/review.ts');
      expect(drawer).toContain('succeeded');
    } finally {
      await stop();
    }
  });

  // Most dispatches are one-off briefs naming no spec. The Diff tab answered
  // every one of them with "select a card scoped to a spec" — for a card the
  // reader had already selected, whose changed paths are on its own record.
  it('diffs a single dispatch, not only a spec', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/spec-diff?dispatch=d-review`);
      expect(response.status).toBe(200);

      const body: unknown = await response.json();
      expect(body).toMatchObject({ dispatchId: 'd-review' });
      expect(body).toHaveProperty('files');

      // Asked for neither, it still refuses rather than diffing everything.
      const neither = await fetch(`${base}/api/spec-diff`);
      expect(neither.status).toBe(400);
    } finally {
      await stop();
    }
  });

  it('refuses a dispatch that is still in motion and explains why', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/drawer?dispatch=d-motion`);
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The drawer refusal response was not a JSON object.');
      }
      expect(typeof body.error).toBe('string');
      expect(String(body.error)).toContain('still in motion');
    } finally {
      await stop();
    }
  });

  it('lists spec files', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/spec/list`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isUnknownArray(body)).toBe(true);
      if (!isUnknownArray(body)) {
        throw new Error('The spec list response was not an array.');
      }
      expect(body.length).toBe(1);

      const first = body[0];
      expect(isRecord(first)).toBe(true);
      if (!isRecord(first)) {
        throw new Error('The first spec directory was not an object.');
      }
      expect(first.name).toBe('0099-fixture');
      expect(isUnknownArray(first.files)).toBe(true);
      if (isUnknownArray(first.files)) {
        const fileNames = first.files
          .map((file) => (isRecord(file) && typeof file.name === 'string') ? file.name : '')
          .sort();
        expect(fileNames).toEqual(['requirements.md', 'tasks.md']);
      }
    } finally {
      await stop();
    }
  });

  it('reads one spec file as markdown', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(
        `${base}/api/spec/read?f=${encodeURIComponent('docs/specs/0099-fixture/requirements.md')}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The spec read response was not a JSON object.');
      }
      expect(typeof body.content).toBe('string');
      expect(String(body.content)).toContain('# Requirements');
    } finally {
      await stop();
    }
  });

  it('writes a spec file and refuses a second write while the lock is held', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const file = 'docs/specs/0099-fixture/tasks.md';

      const first = await fetch(`${base}/api/spec/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, content: '# Updated tasks\n', holder: 'user-A' }),
      });
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const firstBody: unknown = await first.json();
      expect(isRecord(firstBody)).toBe(true);
      if (!isRecord(firstBody)) {
        throw new Error('The spec write response was not a JSON object.');
      }
      expect(firstBody.ok).toBe(true);

      const second = await fetch(`${base}/api/spec/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, content: '# Stolen tasks\n', holder: 'user-B' }),
      });
      expect(second.status).toBe(409);
      expect(second.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const secondBody: unknown = await second.json();
      expect(isRecord(secondBody)).toBe(true);
      if (!isRecord(secondBody)) {
        throw new Error('The second spec write response was not a JSON object.');
      }
      expect(typeof secondBody.error).toBe('string');
      expect(String(secondBody.error)).toContain('user-A');
      expect(secondBody.holder).toBe('user-A');
    } finally {
      await stop();
    }
  });

  it('acknowledges a needs-you item and returns the log entry', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/acknowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'd-needs' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The acknowledge response was not a JSON object.');
      }
      expect(body.itemId).toBe('d-needs');
      expect(body.event).toBe('acknowledged');

      const log = await readFile(join(repo, '.cyv-review', 'dispatches.ndjson'), 'utf-8');
      const lines = log.trim().split('\n');
      const rawLine = lines[lines.length - 1];
      if (rawLine === undefined) {
        throw new Error('The dispatch log is empty.');
      }
      const last: unknown = JSON.parse(rawLine);
      expect(isRecord(last)).toBe(true);
      if (isRecord(last)) {
        expect(typeof last.event).toBe('string');
        expect(String(last.event)).toBe('acknowledged');
        expect(typeof last.itemId).toBe('string');
        expect(String(last.itemId)).toBe('d-needs');
      }
    } finally {
      await stop();
    }
  });

  it('refuses an acknowledge request without an item id and reports the error', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/acknowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The acknowledge failure response was not a JSON object.');
      }
      expect(typeof body.error).toBe('string');
      expect(String(body.error)).toContain('itemId');
    } finally {
      await stop();
    }
  });

  it('inspects a closed dispatch and returns the scope split', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/inspect?dispatch=d-review`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const html = await response.text();
      expect(html).toContain('In scope');
      expect(html).toContain('src/review.ts');
      expect(html).toContain('succeeded');
      expect(html).toContain('data-dispatch="d-review"');
    } finally {
      await stop();
    }
  });

  it('refuses to inspect a dispatch that is still in motion', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/inspect?dispatch=d-motion`);
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The inspect refusal response was not a JSON object.');
      }
      expect(typeof body.error).toBe('string');
      expect(String(body.error)).toContain('still in motion');
    } finally {
      await stop();
    }
  });

  it('renders the phone layout with To Do expanded and the other columns collapsed', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toMatch(/id="board-todo-toggle"[^>]*checked/);
      expect(html).not.toMatch(/id="board-review-toggle"[^>]*checked/);
      expect(html).not.toMatch(/id="board-in-progress-toggle"[^>]*checked/);
    } finally {
      await stop();
    }
  });
});

describe('cyv dashboard serves the glance page at /', () => {
  it('GET / returns the glance page: every tile, the shared live badge, and the nav', async () => {
    const repo = await makeRepo();
    await writeBoardLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const html = flatten(await response.text());
      for (const id of ['gl-needs', 'gl-running', 'gl-lanes', 'gl-tree', 'gl-specs', 'gl-judgment']) {
        expect(html).toContain(`id="${id}"`);
      }
      expect(html).toContain('id="board-live-badge"');
      expect(html).toContain('data-live="connecting"');

      // The board's needs-you item and its in-motion task are named here.
      expect(html).toContain('T90001');
      expect(html).toContain('produced-nothing');
      expect(html).toContain('T90004');
      expect(html).not.toContain('d-motion');

      // Navigation reaches the working surfaces.
      expect(html).toContain('href="/board?p=');
      expect(html).toContain('href="/tasks?p=');
      expect(html).toContain('href="/lanes?p=');
      expect(html).toContain('href="/specs?p=');
    } finally {
      await stop();
    }
  });

  it('GET / words every tile when nothing is recorded, instead of showing frames', async () => {
    const repo = await makeRepo();
    // `makeRepo` inits a git repo but commits nothing, so its fixture files are
    // genuinely uncommitted; the clean zero state needs them committed first.
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo });
    const { base, stop } = await startDashboard(repo);

    try {
      const html = flatten(await (await fetch(`${base}/`)).text());
      expect(html).toContain('Nothing needs you right now.');
      expect(html).toContain('Nothing is in motion.');
      expect(html).toContain('No lane is declared');
      expect(html).toContain('The working tree is clean');
      expect(html).toContain('No spec under docs/specs declares tasks yet.');
      expect(html).toContain('No dispatch is waiting on a decision.');
    } finally {
      await stop();
    }
  });

  it('GET / names an exhausted lane with its reset time', async () => {
    const repo = await makeDispatchRepo();
    await markQuotaExhausted(repo, 'lane-capped', '2030-01-01T00:00:00.000Z');
    const { base, stop } = await startDashboard(repo);

    try {
      const html = flatten(await (await fetch(`${base}/`)).text());
      expect(html).toContain('lane-capped');
      expect(html).toContain('subscription exhausted');
      expect(html).toContain('2030-01-01T00:00:00.000Z');
      expect(html).not.toContain('No lanes are blocked.');
    } finally {
      await stop();
    }
  });

  it('GET / carries the stale marking every tile shows while the stream is down', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const html = await (await fetch(`${base}/`)).text();
      // Six tiles, each with the stale line the badge's data-live state reveals.
      expect(html.split('class="gl-stale"').length - 1).toBe(6);
      expect(html).toContain('data-live="disconnected"');
      expect(html).toContain('/api/live');
    } finally {
      await stop();
    }
  });

  it('GET / escapes markup carried in a dispatch record', async () => {
    const repo = await makeRepo();
    // An in-flight dispatch's task text is named verbatim on the running tile.
    const entries: unknown[] = [
      {
        event: 'opened',
        schemaVersion: 1,
        dispatchId: 'd-evil',
        workId: 'w-evil',
        attempt: 1,
        openedAt: '2026-09-01T10:00:00.000Z',
        declaration: boardDeclaration('<script>alert(1)</script> change the thing', ['src/evil.ts']),
        assignment: boardAssignment(),
      },
    ];
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await writeFile(
      join(repo, '.cyv-review', 'dispatches.ndjson'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf-8',
    );
    const { base, stop } = await startDashboard(repo);

    try {
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
    } finally {
      await stop();
    }
  });

  it('links the board nav back to the glance page', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const html = await (await fetch(`${base}/board`)).text();
      expect(html).toContain('>Glance</a>');
      expect(html).toContain('href="/?p=');
    } finally {
      await stop();
    }
  });
});

describe('cyv dashboard serves the /specs editor (spec 0051)', () => {
  it('lists specs grouped by directory', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/specs`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const html = await response.text();
      expect(html).toContain('0099-fixture');
      expect(html).toContain('requirements.md');
      expect(html).toContain('tasks.md');
      expect(html).toContain('data-file="docs/specs/0099-fixture/requirements.md"');
      expect(html).toContain('data-file="docs/specs/0099-fixture/tasks.md"');
    } finally {
      await stop();
    }
  });

  it('opens a spec file and claims the edit lock', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const file = 'docs/specs/0099-fixture/requirements.md';
      const response = await fetch(`${base}/specs?f=${encodeURIComponent(file)}&h=user-A`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain('id="spec-source"');
      expect(html).toContain('data-file="docs/specs/0099-fixture/requirements.md"');

      const state = await readState(repo);
      expect(state.editLocks[file]?.holder).toBe('user-A');
    } finally {
      await stop();
    }
  });

  it('shows a read-only view and names the holder when the file is already locked', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const file = 'docs/specs/0099-fixture/requirements.md';
      const first = await fetch(`${base}/specs?f=${encodeURIComponent(file)}&h=user-A`);
      expect(first.status).toBe(200);

      const second = await fetch(`${base}/specs?f=${encodeURIComponent(file)}&h=user-B`);
      expect(second.status).toBe(200);

      const html = await second.text();
      expect(html).toContain('user-A');
      expect(html).toContain('read only');
      expect(html).toContain('<h1>Requirements</h1>');
      expect(html).not.toContain('id="spec-source"');
    } finally {
      await stop();
    }
  });

  it('saves a spec file through the page API', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const file = 'docs/specs/0099-fixture/tasks.md';
      const open = await fetch(`${base}/specs?f=${encodeURIComponent(file)}&h=user-A`);
      expect(open.status).toBe(200);

      const response = await fetch(`${base}/api/spec/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, content: '# Updated tasks\n', holder: 'user-A' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The spec write response was not a JSON object.');
      }
      expect(body.ok).toBe(true);

      const saved = await readFile(join(repo, file), 'utf-8');
      expect(saved).toContain('# Updated tasks');
    } finally {
      await stop();
    }
  });

  it('refuses to save when the lock was lost and names the current holder', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const file = 'docs/specs/0099-fixture/tasks.md';
      const open = await fetch(`${base}/specs?f=${encodeURIComponent(file)}&h=user-A`);
      expect(open.status).toBe(200);

      const response = await fetch(`${base}/api/spec/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, content: '# Stolen tasks\n', holder: 'user-B' }),
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The refused spec write response was not a JSON object.');
      }
      expect(typeof body.error).toBe('string');
      expect(String(body.error)).toContain('user-A');
      expect(body.holder).toBe('user-A');

      const saved = await readFile(join(repo, file), 'utf-8');
      expect(saved).toContain('Do the thing');
    } finally {
      await stop();
    }
  });

  it('escapes a script tag in the editor and in the preview', async () => {
    const repo = await makeRepo();
    await writeSpecTree(repo);
    const file = 'docs/specs/0099-fixture/tasks.md';
    await writeFile(join(repo, file), '# Tasks\n\n<script>alert(1)</script>\n', 'utf-8');

    const { base, stop } = await startDashboard(repo);

    try {
      const editor = await fetch(`${base}/specs?f=${encodeURIComponent(file)}&h=user-A`);
      expect(editor.status).toBe(200);

      const html = await editor.text();
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');

      const preview = await fetch(`${base}/api/spec/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '<script>alert(1)</script>' }),
      });
      expect(preview.status).toBe(200);

      const body: unknown = await preview.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) {
        throw new Error('The preview response was not a JSON object.');
      }
      expect(typeof body.html).toBe('string');
      expect(String(body.html)).toContain('&lt;script&gt;');
      expect(body.html).not.toContain('<script>alert(1)</script>');
    } finally {
      await stop();
    }
  });

  it('exposes a Specs link from the board top bar', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain('board-topbar-right');
      expect(html).toContain('Specs');
      expect(html).toContain('/specs?p=');
    } finally {
      await stop();
    }
  });
});

async function postJson(base: string, path: string, payload: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('cyv dashboard serves the note exchange (spec 0051 Requirement 5.2)', () => {
  it('composes a note as a draft the watcher cannot see, then sends the batch at once', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const first = await postJson(base, '/api/comment', { body: 'hold this', draft: true });
      expect(first.status).toBe(200);
      const firstBody: unknown = await first.json();
      if (!isRecord(firstBody)) throw new Error('expected a JSON object');
      expect(firstBody.status).toBe('draft');

      const second = await postJson(base, '/api/comment', { body: 'and this', draft: true });
      expect(second.status).toBe(200);

      // Drafts are not comments: nothing the watcher reads can see them.
      const held = await loadComments(repo);
      expect(held.comments).toEqual([]);
      expect(held.drafts).toHaveLength(2);
      expect(commentsToExchange(held, 10).total).toBe(0);

      const sent = await postJson(base, '/api/comment/send', {});
      expect(sent.status).toBe(200);
      const sentBody: unknown = await sent.json();
      if (!isRecord(sentBody)) throw new Error('expected a JSON object');
      expect(sentBody.sent).toBe(2);

      const after = await loadComments(repo);
      expect(after.drafts ?? []).toEqual([]);
      expect(after.comments).toHaveLength(2);
      expect(after.comments.every((c) => c.status === 'open')).toBe(true);
      expect(after.comments.map((c) => c.body)).toEqual(['hold this', 'and this']);
    } finally {
      await stop();
    }
  });

  it('posts a note without the draft flag straight to open, as before', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await postJson(base, '/api/comment', { body: 'immediate' });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('expected a JSON object');
      expect(body.status).toBe('open');

      const store = await loadComments(repo);
      expect(store.comments).toHaveLength(1);
      expect(store.drafts ?? []).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('edits and discards a draft through the page API before it is sent', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const created = await postJson(base, '/api/comment', { body: 'first wording', draft: true });
      const createdBody: unknown = await created.json();
      if (!isRecord(createdBody)) throw new Error('expected a JSON object');
      const id = createdBody.id;

      const edited = await postJson(base, '/api/comment/draft', { id, body: 'better wording' });
      expect(edited.status).toBe(200);
      const editedBody: unknown = await edited.json();
      if (!isRecord(editedBody)) throw new Error('expected a JSON object');
      expect(editedBody.body).toBe('better wording');
      expect(editedBody.status).toBe('draft');

      const missing = await postJson(base, '/api/comment/draft', { id: 999, body: 'x' });
      expect(missing.status).toBe(404);

      const discarded = await postJson(base, '/api/comment/draft/discard', { id });
      expect(discarded.status).toBe(200);
      const again = await postJson(base, '/api/comment/draft/discard', { id });
      expect(again.status).toBe(404);

      const store = await loadComments(repo);
      expect(store.drafts ?? []).toEqual([]);
      expect(store.comments).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('threads a reply under its parent and marks a note addressed through the status route', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const question = await postJson(base, '/api/comment', { body: 'why did the gate fail?' });
      const questionBody: unknown = await question.json();
      if (!isRecord(questionBody)) throw new Error('expected a JSON object');
      const parentId = questionBody.id;

      const reply = await postJson(base, '/api/comment', {
        body: 'because <i>this</i> happened',
        replyTo: parentId,
        draft: true,
      });
      expect(reply.status).toBe(200);
      const replyBody: unknown = await reply.json();
      if (!isRecord(replyBody)) throw new Error('expected a JSON object');
      expect(replyBody.status).toBe('draft');
      expect(replyBody.refs).toEqual({ replyTo: parentId });

      await postJson(base, '/api/comment/send', {});
      const store = await loadComments(repo);
      const promoted = store.comments.find((c) => c.body === 'because <i>this</i> happened');
      expect(promoted?.status).toBe('open');
      expect(promoted?.refs?.replyTo).toBe(parentId);

      const addressed = await postJson(base, '/api/comment/status', { id: parentId, status: 'addressed' });
      expect(addressed.status).toBe(200);
      const addressedBody: unknown = await addressed.json();
      if (!isRecord(addressedBody)) throw new Error('expected a JSON object');
      expect(addressedBody.status).toBe('addressed');
    } finally {
      await stop();
    }
  });

  it('serves the exchange on the board with note text escaped', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      await postJson(base, '/api/comment', { body: '<script>alert(1)</script>' });
      await postJson(base, '/api/comment', { body: 'held <b>back</b>', draft: true });

      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).toContain('Agent Note Exchange');
      expect(html).toContain('id="board-note-form"');
      expect(html).toContain('Unsent review');
      expect(html).toContain('Send Review (1)');
      expect(html).toContain('1 draft');
      expect(html).toContain('held &lt;b&gt;back&lt;/b&gt;');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
    } finally {
      await stop();
    }
  });
});

function dispatchConfig(): unknown {
  const base = config();
  const billing = { kind: 'subscription', permitsBilledOverage: false };
  return {
    ...base,
    executor: {
      lanes: [
        {
          id: 'lane-self',
          agentId: 'claude-code',
          concurrencyCap: 2,
          orchestrator: true,
          acceptsDispatch: true,
          billing,
          executes: 'subagent',
          models: [{ kind: 'mechanical-transformation', ordering: ['strong'] }],
        },
        {
          id: 'lane-capped',
          agentId: 'claude-code',
          concurrencyCap: 1,
          billing,
          executes: 'subagent',
          models: [{ kind: 'mechanical-transformation', ordering: ['strong'] }],
        },
      ],
    },
  };
}

async function makeDispatchRepo(): Promise<string> {
  const repo = await makeRepo();
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(dispatchConfig(), null, 2));
  await writeFile(join(repo, 'README.md'), '# README\n', 'utf-8');
  return repo;
}

function dispatchBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    task: 'do the thing',
    ownedPaths: ['src/thing.ts'],
    lane: 'lane-self',
    kind: 'mechanical-transformation',
    gates: ['cyv-check'],
    ...overrides,
  });
}

async function writeCappedLog(repo: string): Promise<void> {
  const blocker = {
    event: 'opened',
    schemaVersion: 1,
    dispatchId: 'd-blocker',
    workId: 'w-blocker',
    attempt: 1,
    openedAt: '2026-09-01T10:00:00.000Z',
    declaration: {
      task: 'blocker',
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/blocker.ts'],
      expectsFileChanges: true,
      gates: ['cyv-check'],
    },
    assignment: {
      laneId: 'lane-capped',
      agentId: 'claude-code',
      model: 'strong',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await writeFile(join(repo, '.cyv-review', 'dispatches.ndjson'), `${JSON.stringify(blocker)}
`, 'utf-8');
}

async function writeRetryableLog(repo: string): Promise<void> {
  const opened = {
    event: 'opened',
    schemaVersion: 1,
    dispatchId: 'd-failed',
    workId: 'w-failed',
    attempt: 1,
    openedAt: '2026-09-01T10:00:00.000Z',
    declaration: {
      task: 'failed task',
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/failed.ts'],
      expectsFileChanges: true,
      gates: ['cyv-check'],
    },
    assignment: {
      laneId: 'lane-capped',
      agentId: 'claude-code',
      model: 'strong',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
  const closed = {
    event: 'closed',
    schemaVersion: 1,
    dispatchId: 'd-failed',
    closedAt: '2026-09-01T10:05:00.000Z',
    report: { status: 'success', exitCode: 1, rateLimited: false },
    gateResults: [{ gate: 'cyv-check', passed: false }],
    outcome: {
      kind: 'gates-failed',
      summary: 'gate cyv-check failed',
      changedPaths: [],
      outOfScopePaths: [],
      failedGates: ['cyv-check'],
    },
  };
  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await writeFile(join(repo, '.cyv-review', 'dispatches.ndjson'), `${JSON.stringify(opened)}\n${JSON.stringify(closed)}\n`, 'utf-8');
}

function requireField(value: Record<string, unknown>, key: string): unknown {
  const got = value[key];
  if (got === undefined) throw new Error(`expected JSON body to have field "${key}"`);
  return got;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const got = requireField(value, key);
  if (typeof got !== 'string') throw new Error(`expected "${key}" to be a string, got ${typeof got}`);
  return got;
}

function requireBoolean(value: Record<string, unknown>, key: string): boolean {
  const got = requireField(value, key);
  if (typeof got !== 'boolean') throw new Error(`expected "${key}" to be a boolean, got ${typeof got}`);
  return got;
}

function optionalRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const got = value[key];
  if (got === undefined) return undefined;
  if (!isRecord(got)) throw new Error(`expected "${key}" to be an object`);
  return got;
}

describe('cyv dashboard dispatches work from the board', () => {
  it('POST /api/dispatch opens a self-dispatch record and returns the id', async () => {
    const repo = await makeDispatchRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: dispatchBody(),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('expected a JSON object');

      const dispatchId = requireString(body, 'dispatchId');
      expect(dispatchId).toMatch(/^work-/);
      expect(requireString(body, 'laneId')).toBe('lane-self');
      expect(requireString(body, 'model')).toBe('strong');

      const log = await readDispatchLog(repo);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      expect(record).toBeDefined();
      expect(record?.closed).toBeUndefined();
      expect(record?.declaration.task).toBe('do the thing');
    } finally {
      await stop();
    }
  });

  it('POST /api/dispatch refuses a task file outside docs/specs', async () => {
    const repo = await makeDispatchRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: dispatchBody({ task: undefined, taskFile: 'README.md' }),
      });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('expected a JSON object');
      expect(requireString(body, 'error')).toContain('docs/specs');
    } finally {
      await stop();
    }
  });

  it('POST /api/dispatch refuses a dispatch with no owned paths', async () => {
    const repo = await makeDispatchRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: dispatchBody({ ownedPaths: [] }),
      });
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('expected a JSON object');
      expect(requireString(body, 'error')).toContain('owned path');
    } finally {
      await stop();
    }
  });

  it('POST /api/dispatch returns the exact scheduling refusal when a lane is at cap', async () => {
    const repo = await makeDispatchRepo();
    await writeCappedLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: dispatchBody({ lane: 'lane-capped' }),
      });
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('expected a JSON object');
      const error = requireString(body, 'error');
      expect(error).toContain('lane-capped');
      expect(error).toContain('running its declared cap of 1 (1 in flight)');
      const refusal = optionalRecord(body, 'refusal');
      expect(refusal).toBeDefined();
      if (refusal !== undefined) {
        expect(requireString(refusal, 'reason')).toBe('no-eligible-lane');
      }
    } finally {
      await stop();
    }
  });

  it('POST /api/stop closes a live self-dispatch', async () => {
    const repo = await makeDispatchRepo();
    const { base, stop } = await startDashboard(repo);

    let dispatchId = '';
    try {
      const opened = await fetch(`${base}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: dispatchBody(),
      });
      const openedBody: unknown = await opened.json();
      if (!isRecord(openedBody)) throw new Error('expected a JSON object');
      dispatchId = requireString(openedBody, 'dispatchId');

      const stopped = await fetch(`${base}/api/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dispatchId }),
      });
      expect(stopped.status).toBe(200);
      const stoppedBody: unknown = await stopped.json();
      if (!isRecord(stoppedBody)) throw new Error('expected a JSON object');
      expect(requireBoolean(stoppedBody, 'stopped')).toBe(true);
      expect(requireString(stoppedBody, 'closedAt')).toMatch(/^\d{4}-/);

      const log = await readDispatchLog(repo);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      expect(record?.closed).toBeDefined();
      expect(record?.closed?.outcome.kind).toBe('did-not-complete');
    } finally {
      await stop();
    }
  });

  it('POST /api/abandon closes a live self-dispatch without killing a process', async () => {
    const repo = await makeDispatchRepo();
    const { base, stop } = await startDashboard(repo);

    let dispatchId = '';
    try {
      const opened = await fetch(`${base}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: dispatchBody(),
      });
      const openedBody: unknown = await opened.json();
      if (!isRecord(openedBody)) throw new Error('expected a JSON object');
      dispatchId = requireString(openedBody, 'dispatchId');

      const abandoned = await fetch(`${base}/api/abandon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dispatchId }),
      });
      expect(abandoned.status).toBe(200);
      const abandonedBody: unknown = await abandoned.json();
      if (!isRecord(abandonedBody)) throw new Error('expected a JSON object');
      expect(requireString(abandonedBody, 'closedAt')).toMatch(/^\d{4}-/);
      expect(requireString(abandonedBody, 'detail')).toContain('without killing a process');

      const log = await readDispatchLog(repo);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      expect(record?.closed).toBeDefined();
      expect(record?.closed?.outcome.kind).toBe('did-not-complete');
      expect(record?.closed?.outcome.summary).toContain('abandoned');
    } finally {
      await stop();
    }
  });

  it('POST /api/retry re-dispatches a gate-failed record on the same lane', async () => {
    const repo = await makeDispatchRepo();
    await writeRetryableLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dispatchId: 'd-failed' }),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error('expected a JSON object');
      const dispatchId = requireString(body, 'dispatchId');
      expect(dispatchId).toMatch(/^work-/);
      expect(requireString(body, 'laneId')).toBe('lane-capped');

      const log = await readDispatchLog(repo);
      const record = log.records.find((candidate) => candidate.dispatchId === dispatchId);
      expect(record).toBeDefined();
      expect(record?.closed).toBeUndefined();
      expect(record?.assignment.laneId).toBe('lane-capped');
      expect(record?.declaration.ownedPaths).toEqual(['src/failed.ts']);
    } finally {
      await stop();
    }
  });

  it('GET /board renders the dispatch form and in-motion action controls', async () => {
    const repo = await makeDispatchRepo();
    await writeCappedLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/board`);
      const html = flatten(await response.text());

      expect(html).toContain('id="board-form"');
      expect(html).toContain('id="board-dispatch-form"');
      expect(html).toContain('name="task"');
      expect(html).toContain('name="taskFile"');
      expect(html).toContain('name="ownedPaths"');
      expect(html).toContain('name="gates"');
      expect(html).toContain('value="lane-self"');
      expect(html).toContain('value="lane-capped"');
      expect(html).toContain('data-action="dispatch"');

      expect(html).toContain('data-action="stop"');
      expect(html).toContain('data-action="abandon"');
      expect(html).toContain('data-dispatch="d-blocker"');
    } finally {
      await stop();
    }
  });
});

function makeInterface(
  address: string,
  family: 'IPv4' | 'IPv6',
  internal: boolean,
): NetworkInterfaceInfo {
  if (family === 'IPv4') {
    return {
      address,
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal,
      cidr: null,
    };
  }
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
    scopeid: 0,
  };
}

describe('cyv dashboard host mode and lan address discovery', () => {
  it('extracts non-loopback IPv4 addresses and skips internal and IPv6 interfaces', () => {
    const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [
        makeInterface('127.0.0.1', 'IPv4', true),
        makeInterface('::1', 'IPv6', true),
      ],
      eth0: [
        makeInterface('192.168.1.50', 'IPv4', false),
        makeInterface('fe80::1', 'IPv6', false),
      ],
      wlan0: [
        makeInterface('10.0.0.15', 'IPv4', false),
      ],
    };

    expect(lanAddresses(interfaces)).toEqual(['192.168.1.50', '10.0.0.15']);
  });

  it('returns an empty array when only internal or non-IPv4 interfaces exist', () => {
    const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo: [makeInterface('127.0.0.1', 'IPv4', true)],
      eth0: [makeInterface('fe80::1', 'IPv6', false)],
    };

    expect(lanAddresses(interfaces)).toEqual([]);
  });

  it('host mode lists every discovered LAN address with the port', () => {
    const banner = formatStartupBanner({
      port: 4300,
      exposeToLan: true,
      projects: ['/path/to/project'],
      addresses: ['192.168.1.50', '10.0.0.15'],
    });

    expect(banner).toContain('http://localhost:4300');
    expect(banner).toContain('http://192.168.1.50:4300');
    expect(banner).toContain('http://10.0.0.15:4300');
    expect(banner).not.toContain('localhost only');
    expect(banner).not.toContain('no non-loopback IPv4 addresses found');
  });

  it('host mode says so when no non-loopback IPv4 address is found', () => {
    const banner = formatStartupBanner({
      port: 4300,
      exposeToLan: true,
      projects: ['/path/to/project'],
      addresses: [],
    });

    expect(banner).toContain('http://localhost:4300');
    expect(banner).toContain('(no non-loopback IPv4 addresses found)');
    expect(banner).not.toContain('localhost only');
  });

  it('loopback mode prints what it prints today and nothing extra', () => {
    const banner = formatStartupBanner({
      port: 4300,
      exposeToLan: false,
      projects: ['/path/to/project'],
    });

    expect(banner).toContain('http://localhost:4300');
    expect(banner).toContain('(localhost only — pass --host to reach it from a phone)');
    expect(banner).not.toContain('no non-loopback IPv4 addresses found');
    expect(banner).not.toMatch(/http:\/\/(?!localhost)\S+:4300/);
  });
});

interface SessionFakes {
  manager: SessionManager;
  alive: Map<number, FakeProcessRecord>;
}

interface FakeProcessRecord {
  startTime: string;
  killed: boolean;
}

function makeSessionFakes(): SessionFakes {
  let nextPid = 1000;
  const alive = new Map<number, FakeProcessRecord>();

  const findProgram: (
    program: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ) => Promise<ProgramLauncher | undefined> = async () => ({
    command: 'test-agent',
    prefixArgs: [],
    path: 'test-agent',
  });

  const spawn: SessionSpawn = () => {
    nextPid += 1;
    const pid = nextPid;
    const startTime = new Date().toISOString();
    alive.set(pid, { startTime, killed: false });

    const child: SessionProcess = {
      pid,
      kill: (signal?: NodeJS.Signals | number) => {
        const record = alive.get(pid);
        if (record !== undefined && signal !== 0) record.killed = true;
        return true;
      },
      unref: () => {},
    };

    return child;
  };

  const processExists = (pid: number): boolean => {
    const record = alive.get(pid);
    return record !== undefined && !record.killed;
  };

  const processStartedAt = async (pid: number): Promise<string | undefined> => {
    return alive.get(pid)?.startTime;
  };

  const terminate = (pid: number): boolean => {
    const record = alive.get(pid);
    if (record !== undefined) record.killed = true;
    return true;
  };

  const manager = createSessionManager({
    findProgram,
    spawn,
    processExists,
    processStartedAt,
    terminate,
  });

  return { manager, alive };
}

describe('cyv dashboard session controls', () => {
  it('renders the sessions panel and a running session', async () => {
    const repo = await makeRepo();
    const fakes = makeSessionFakes();
    const started = await fakes.manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const { base, stop } = await startDashboard(repo, fakes.manager);
    try {
      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain('id="board-sessions-panel"');
      expect(html).toContain('id="board-session-form"');
      // The board carries no session prose at all: the fold's own summary says
      // how many are live, and eight cards, seven of them hours stale, buried
      // the working surface. A session the dashboard started keeps its stop
      // control, which is the one thing on that line nothing else offers.
      expect(html).not.toContain('Sessions:');
      expect(html).toContain(`data-session="${started.sessionId}"`);
      expect(html).toContain(`pid ${started.pid}`);
      expect(html).toContain('Stop');
    } finally {
      await stop();
    }
  });

  it('starts a session through the POST endpoint', async () => {
    const repo = await makeRepo();
    const fakes = makeSessionFakes();
    const { base, stop } = await startDashboard(repo, fakes.manager);

    try {
      const response = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'devin' }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) return;
      expect(body.ok).toBe(true);

      const session = body.session;
      expect(isRecord(session)).toBe(true);
      if (!isRecord(session)) return;
      expect(typeof session.sessionId).toBe('string');
      expect(typeof session.pid).toBe('number');

      const state = await readState(repo);
      const treeHolder = state.workingTrees[repo];
      if (treeHolder === undefined) throw new Error('The working tree was not claimed.');
      expect(treeHolder).toBe(session.sessionId);
    } finally {
      await stop();
    }
  });

  it('refuses a second start on the same tree and names the holder', async () => {
    const repo = await makeRepo();
    const fakes = makeSessionFakes();
    const first = await fakes.manager.startSession(repo, 'devin');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const { base, stop } = await startDashboard(repo, fakes.manager);

    try {
      const response = await fetch(`${base}/api/session/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'devin' }),
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) return;
      expect(typeof body.error).toBe('string');
      expect(body.holder).toBe(first.sessionId);
    } finally {
      await stop();
    }
  });

  it('stops a session through the POST endpoint', async () => {
    const repo = await makeRepo();
    const fakes = makeSessionFakes();
    const started = await fakes.manager.startSession(repo, 'devin');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const { base, stop } = await startDashboard(repo, fakes.manager);

    try {
      const response = await fetch(`${base}/api/session/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.sessionId }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const body: unknown = await response.json();
      expect(isRecord(body)).toBe(true);
      if (!isRecord(body)) return;
      expect(body.ok).toBe(true);
      expect(body.stopped).toBe(true);

      const state = await readState(repo);
      expect(state.sessions[started.sessionId]?.state).toBe('stopped');
      const treeHolder = state.workingTrees[repo];
      if (treeHolder !== undefined) throw new Error(`Expected no tree holder, found ${treeHolder}`);
    } finally {
      await stop();
    }
  });
});

/**
 * A spec whose tasks.md exercises the four states the page derives: one task
 * never sent, one with no `_Exec:` line, one with a dispatch still open, and
 * one already checked off.
 */
async function writeTasksSpec(repo: string): Promise<void> {
  const dir = join(repo, 'docs', 'specs', '0098-tasks-page');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'tasks.md'),
    [
      '# 0098 — Tasks page: Tasks',
      '',
      '## Open',
      '',
      '- [ ] **T98001** Wire the page',
      '  The body of the task.',
      '  _Exec: executor=lane-self kind=mechanical gates=cyv-check files=src/page.ts,src/other.ts_',
      '',
      '- [ ] **T98002** Undeclared work',
      '  No exec line on this one.',
      '',
      '- [ ] **T98004** Already moving',
      '  _Exec: executor=lane-self kind=mechanical gates=cyv-check files=src/moving.ts_',
      '',
      '- [x] **T98003** Already done',
      '  _Exec: executor=lane-self kind=mechanical gates=cyv-check files=src/done.ts_',
      '',
    ].join('\n'),
    'utf-8',
  );
  const opened = {
    event: 'opened',
    schemaVersion: 1,
    dispatchId: 'd-moving',
    workId: 'w-moving',
    attempt: 1,
    openedAt: '2026-09-01T10:00:00.000Z',
    declaration: {
      task: 'T98004 Already moving',
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/moving.ts'],
      expectsFileChanges: true,
      gates: ['cyv-check'],
    },
    assignment: {
      laneId: 'lane-self',
      agentId: 'claude-code',
      model: 'strong',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
  await mkdir(join(repo, '.cyv-review'), { recursive: true });
  await writeFile(
    join(repo, '.cyv-review', 'dispatches.ndjson'),
    `${JSON.stringify(opened)}\n`,
    'utf-8',
  );
}

describe('cyv dashboard serves the waves & tasks page', () => {
  it('GET /tasks lists a spec’s tasks with the state the log gives them', async () => {
    const repo = await makeRepo();
    await writeTasksSpec(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/tasks`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const html = flatten(await response.text());
      expect(html).toContain('0098 · tasks page');
      expect(html).toContain('T98001');
      expect(html).toContain('Wire the page');
      expect(html).toContain('never dispatched');
      // Never sent → the Dispatch link; in motion → the dispatch id; checked → done.
      expect(html).toContain('for=T98001');
      expect(html).toContain('d-moving');
      expect(html).toContain('/board?p=');
      expect(html).not.toContain('for=T98004');
      expect(html).toContain('data-state="done"');
    } finally {
      await stop();
    }
  });

  it('GET /tasks?for= fills the dispatch form from the task’s _Exec: line', async () => {
    const repo = await makeDispatchRepo();
    await writeTasksSpec(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/tasks?for=T98001`);
      expect(response.status).toBe(200);

      const html = flatten(await response.text());
      expect(html).toContain('id="dispatch"');
      expect(html).toContain('action="/api/dispatch');
      expect(html).toContain('name="task"');
      expect(html).toContain('T98001 — Wire the page');
      expect(html).toContain('value="lane-self" selected');
      expect(html).toContain('src/page.ts src/other.ts');
      expect(html).toContain('name="gates"');
    } finally {
      await stop();
    }
  });

  it('says plainly when a task has no _Exec: line and guesses no scope', async () => {
    const repo = await makeRepo();
    await writeTasksSpec(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/tasks?for=T98002`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain('No _Exec: line was read');
      expect(html).toMatch(/<textarea name="ownedPaths"[^>]*><\/textarea>/);
    } finally {
      await stop();
    }
  });

  it('links the board’s Waves & Tasks nav item to the page', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('href="/tasks?p=');
      expect(html).toContain('Waves &amp; Tasks');
    } finally {
      await stop();
    }
  });

  it('a urlencoded form post to /api/dispatch opens the record and redirects back', async () => {
    const repo = await makeDispatchRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/api/dispatch?p=${encodeURIComponent(repo)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          task: 'T98001 Wire the page',
          lane: 'lane-self',
          kind: 'mechanical-transformation',
          ownedPaths: 'src/page.ts\nsrc/other.ts',
          gates: 'cyv-check',
        }).toString(),
        redirect: 'manual',
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toContain('/tasks?p=');

      const log = await readDispatchLog(repo);
      const opened = log.records.find(
        (candidate) => candidate.declaration.task === 'T98001 Wire the page',
      );
      expect(opened).toBeDefined();
      expect(opened?.closed).toBeUndefined();
      expect(opened?.declaration.ownedPaths).toEqual(['src/page.ts', 'src/other.ts']);
      expect(opened?.assignment.laneId).toBe('lane-self');
    } finally {
      await stop();
    }
  });
});

function cliLaneConfig(): unknown {
  const base = config();
  return {
    ...base,
    executor: {
      lanes: [
        {
          id: 'gemini-cli',
          agentId: 'gemini',
          concurrencyCap: 1,
          billing: { kind: 'subscription', permitsBilledOverage: false },
          executes: 'cli',
          models: [{ kind: 'mechanical-transformation', ordering: ['strong'] }],
        },
      ],
    },
  };
}

async function makeCliLaneRepo(): Promise<string> {
  const repo = await makeRepo();
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(cliLaneConfig(), null, 2));
  return repo;
}

/**
 * A dashboard whose env is chosen by the test: an empty `PATH` means no
 * agent program is ever found, which is how "the binary is missing" is
 * exercised without depending on what this machine happens to carry.
 */
async function startDashboardWithEnv(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<{ base: string; stop: () => Promise<void> }> {
  const { server } = await createDashboardServer({ root: repo, registry: [repo], env });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${boundPort(server)}`;
  return {
    base,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('cyv dashboard serves the lanes page', () => {
  it('GET /lanes lists every declared lane with what it is running', async () => {
    const repo = await makeDispatchRepo();
    await writeCappedLog(repo);
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/lanes`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');

      const html = flatten(await response.text());
      expect(html).toContain('lane-self');
      expect(html).toContain('lane-capped');
      expect(html).toContain('orchestrator');
      expect(html).toContain('Running — 1 of 1');
      expect(html).toContain('d-blocker');
      // Both lanes execute as sub-agents, so PATH is not consulted for them.
      expect(html).not.toContain('data-status="unavailable"');
    } finally {
      await stop();
    }
  });

  it('GET /lanes marks a lane unavailable when its agent binary is missing', async () => {
    const repo = await makeCliLaneRepo();
    const { base, stop } = await startDashboardWithEnv(repo, {});

    try {
      const response = await fetch(`${base}/lanes`);
      expect(response.status).toBe(200);

      const html = flatten(await response.text());
      expect(html).toContain('gemini-cli');
      expect(html).toContain('data-status="unavailable"');
      expect(html).toContain('can never run');
      expect(html).not.toContain('data-status="free"');
    } finally {
      await stop();
    }
  });

  it('GET /lanes shows an exhausted lane its reset time', async () => {
    const repo = await makeDispatchRepo();
    await markQuotaExhausted(repo, 'lane-capped', '2030-01-01T00:00:00.000Z');
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/lanes`);
      const html = flatten(await response.text());

      expect(html).toContain('Subscription exhausted');
      expect(html).toContain('2030-01-01T00:00:00.000Z');
    } finally {
      await stop();
    }
  });

  it('GET /lanes says so plainly when the configuration declares no lane', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/lanes`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('No lane is declared');
    } finally {
      await stop();
    }
  });

  it('links the board’s Lanes nav item to the page', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startDashboard(repo);

    try {
      const response = await fetch(`${base}/board`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('href="/lanes?p=');
      expect(html).not.toContain('<a class="board-nav-item" href="#">Lanes</a>');
    } finally {
      await stop();
    }
  });
});

describe('live endpoints', () => {
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function startLiveServer(repo: string, token?: string) {
    const { server } = await createDashboardServer({
      root: repo,
      registry: [repo],
      ...(token === undefined ? {} : { accessToken: token }),
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${boundPort(server)}`;
    return {
      base,
      stop: (): Promise<void> =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  function readSseOnce(url: string, predicate: (chunk: string) => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSE timeout')), 1000);
      let buffer = '';
      const req = httpGet(url, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          if (predicate(buffer)) {
            clearTimeout(timer);
            res.destroy();
            resolve(buffer);
          }
        });
        res.on('error', () => {
          clearTimeout(timer);
        });
      });
      req.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it('rejects unauthenticated access to the live stream', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startLiveServer(repo, 'secret-token');
    try {
      const response = await fetch(`${base}/api/live?p=${encodeURIComponent(repo)}`);
      expect(response.status).toBe(401);
    } finally {
      await stop();
    }
  });

  it('serves an event stream and emits a connected event', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startLiveServer(repo);
    try {
      const url = `${base}/api/live?p=${encodeURIComponent(repo)}`;
      const chunk = await readSseOnce(url, (b) => b.includes('event: connected'));
      expect(chunk).toContain('event: connected');
    } finally {
      await stop();
    }
  });

  it('emits a dispatch event when the dispatch log is appended', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    const { base, stop } = await startLiveServer(repo);
    try {
      const url = `${base}/api/live?p=${encodeURIComponent(repo)}`;
      const promise = readSseOnce(url, (b) => b.includes('event: dispatch'));
      await wait(50);
      await appendFile(dispatchLogPath(repo), JSON.stringify({ event: 'closed', dispatchId: 'd-1' }) + '\n');
      const chunk = await promise;
      expect(chunk).toContain('event: dispatch');
      expect(chunk).toContain('"fragments":');
    } finally {
      await stop();
    }
  });

  // The glance page subscribes to the live stream but rendered whatever it was
  // built with, so it went green, hid its "showing the page as it loaded"
  // notices, and stayed frozen. Its body is served on its own so the client can
  // replace it — through the same parse-and-rebuild every other fragment uses.
  it('serves the glance body on its own, without a document shell', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startLiveServer(repo);
    try {
      const response = await fetch(`${base}/api/glance?p=${encodeURIComponent(repo)}`);
      expect(response.status).toBe(200);

      const body = await response.text();
      expect(body).not.toContain('<!doctype html>');
      expect(body).toContain('gl-tiles');
      expect(body).not.toContain('{"error"');

      // And the page it replaces carries the element to replace.
      const page = await fetch(`${base}/?p=${encodeURIComponent(repo)}`);
      expect((await page.text()).includes('id="gl-body"')).toBe(true);
    } finally {
      await stop();
    }
  });

  it('serves a board fragment without a document shell', async () => {
    const repo = await makeRepo();
    const { base, stop } = await startLiveServer(repo);
    try {
      const response = await fetch(`${base}/api/fragment?region=status&p=${encodeURIComponent(repo)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const body = await response.text();
      // An empty repository has no session firing hooks, so the strip says so
      // rather than asserting the orchestrator is running.
      expect(body).toContain('nothing has fired a hook');
      expect(body).not.toContain('Orchestrator running');
      expect(body).not.toContain('<!doctype html>');
    } finally {
      await stop();
    }
  });
});

/**
 * The port a dashboard binds can already be held by a listener bound to a
 * different address of the same machine: `0.0.0.0` and `127.0.0.1` do not
 * collide at bind time on Windows, so the second instance used to start
 * silently and split requests with the first. These tests hold the port with a
 * plain TCP listener — the occupant does not have to be a dashboard for the
 * refusal to be correct — and start the command the way a user would.
 */
describe('cyv dashboard refuses a port that is already held', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface HeldPort {
    port: number;
    release: () => Promise<void>;
  }

  async function holdPort(host: string): Promise<HeldPort> {
    const listener = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(err);
      };
      listener.once('error', onError);
      listener.listen(0, host, () => {
        listener.removeListener('error', onError);
        resolve();
      });
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the port holder did not bind a TCP port');
    }
    return {
      port: address.port,
      release: () =>
        new Promise<void>((resolve) => {
          listener.close(() => {
            resolve();
          });
        }),
    };
  }

  /**
   * What `run` wrote on stderr, captured with `vi.spyOn` so the overloaded
   * `write` signature stays typed — a hand-rolled stub needs an `as` cast.
   */
  function captureStderr(): () => string {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk, encodingOrCb, maybeCb) => {
      chunks.push(String(chunk));
      const done = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
      done?.(null);
      return true;
    });
    return () => chunks.join('');
  }

  it('refuses a loopback start when a wildcard listener holds the port', async () => {
    const repo = await makeRepo();
    const held = await holdPort('0.0.0.0');
    const stderr = captureStderr();
    try {
      const code = await command.run({
        cwd: repo,
        argv: ['--port', String(held.port)],
        env: process.env,
      });
      expect(code).not.toBe(0);
      expect(stderr()).toContain(String(held.port));
      expect(stderr()).toContain('Stop the other one');
    } finally {
      await held.release();
    }
  });

  it('refuses a --host start when a loopback listener holds the port', async () => {
    const repo = await makeRepo();
    const held = await holdPort('127.0.0.1');
    const stderr = captureStderr();
    try {
      const code = await command.run({
        cwd: repo,
        argv: ['--host', '--port', String(held.port)],
        env: process.env,
      });
      expect(code).not.toBe(0);
      expect(stderr()).toContain(String(held.port));
      // A refused start touches nothing: no token is minted or stored.
      await expect(stat(join(repo, '.cyv-review', 'dashboard-token'))).rejects.toThrow();
    } finally {
      await held.release();
    }
  });

  it('reports EADDRINUSE from the bind itself instead of hanging', async () => {
    const repo = await makeRepo();
    const held = await holdPort('127.0.0.1');
    try {
      const { server } = await createDashboardServer({ root: repo, registry: [repo] });
      const outcome = await listenDashboard(server, held.port, '127.0.0.1');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain(String(held.port));
        expect(outcome.error).toContain('Stop the other one');
      }
    } finally {
      await held.release();
    }
  });

  it('reports a bind failure that is not EADDRINUSE with what the OS said', async () => {
    const repo = await makeRepo();
    const { server } = await createDashboardServer({ root: repo, registry: [repo] });
    // A documentation-range address is never assigned to this machine, so the
    // bind fails for a reason that is not "port in use".
    const outcome = await listenDashboard(server, 4300, '192.0.2.1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('192.0.2.1');
    }
  });
});

describe('the dashboard access token survives a restart', () => {
  const tokenFile = (repo: string): string => join(repo, '.cyv-review', 'dashboard-token');

  it('hands back the stored token on the next start instead of minting a new one', async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, '.cyv-review'), { recursive: true });
    await writeFile(tokenFile(repo), 'a-stored-token-0123456789\n', 'utf-8');

    const token = await resolveAccessToken(repo, { exposed: true, regenerate: false });
    expect(token).toBe('a-stored-token-0123456789');
  });

  it('stores the token it mints and reuses it across restarts', async () => {
    const repo = await makeRepo();
    const first = await resolveAccessToken(repo, { exposed: true, regenerate: false });
    const second = await resolveAccessToken(repo, { exposed: true, regenerate: false });

    expect(first).toBeDefined();
    expect(second).toBe(first);
    const stored = (await readFile(tokenFile(repo), 'utf-8')).trim();
    expect(stored).toBe(first);
  });

  it('replaces the stored token when --new-token asks for a fresh one', async () => {
    const repo = await makeRepo();
    const first = await resolveAccessToken(repo, { exposed: true, regenerate: false });
    const rotated = await resolveAccessToken(repo, { exposed: true, regenerate: true });

    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(first);
    const stored = (await readFile(tokenFile(repo), 'utf-8')).trim();
    expect(stored).toBe(rotated);

    const afterRestart = await resolveAccessToken(repo, { exposed: true, regenerate: false });
    expect(afterRestart).toBe(rotated);
  });

  it('mints and stores nothing for a loopback bind', async () => {
    const repo = await makeRepo();
    const token = await resolveAccessToken(repo, { exposed: false, regenerate: false });
    expect(token).toBeUndefined();
    await expect(stat(tokenFile(repo))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'stores the token in a file only its owner can read',
    async () => {
      const repo = await makeRepo();
      await resolveAccessToken(repo, { exposed: true, regenerate: false });
      const mode = (await stat(tokenFile(repo))).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );
});

