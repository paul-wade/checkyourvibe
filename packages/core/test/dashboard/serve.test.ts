import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createDashboardServer } from '../../src/cli/dashboard.js';

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

function config(): unknown {
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
  /** The home page, `/`: what needs a person, what is in motion, the lanes. */
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
