import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBoardModel, type BoardModel, type BoardCard } from '../../src/dashboard/board-model.js';
import { renderBoard, renderBoardFragment } from '../../src/dashboard/board-render.js';
import { buildGlancePage, renderGlancePage } from '../../src/dashboard/glance-page.js';
import { buildLanesPage, renderLanesPage, type LanesPage, type LanePageRow } from '../../src/dashboard/lanes-page.js';
import { renderLivePage } from '../../src/dashboard/live-page.js';
import type { ResolvedLaneDeclaration } from '../../src/executor/lane.js';
import type { DispatchRecord } from '../../src/executor/dispatch.js';
import type { DispatchLog } from '../../src/executor/store.js';
import type { CheckYourVibeConfig } from '../../src/config/types.js';

describe('Dashboard Surfaces Agreement', () => {
  it('agrees on the facts across all surfaces when rendered from a single BoardModel', () => {
    const now = Date.parse('2026-09-08T10:00:00.000Z');
    
    // We have 2 lanes. lane1 cap 2. lane2 cap 1.
    const lanes: ResolvedLaneDeclaration[] = [
      { id: 'lane1', acceptsDispatch: true, concurrencyCap: 2, models: [], billing: { kind: 'subscription', permitsBilledOverage: false }, agentId: 'a1', executes: 'cli', orchestrator: false },
      { id: 'lane2', acceptsDispatch: true, concurrencyCap: 1, models: [], billing: { kind: 'subscription', permitsBilledOverage: false }, agentId: 'a2', executes: 'cli', orchestrator: false },
    ];
    
    const d1: BoardCard = { kind: 'card', dispatchId: 'd1', laneId: 'lane1', phase: 'running', openNotes: 0, description: 'Task 1', timestamp: new Date(now - 1000).toISOString(), changedPaths: [] };
    const d2: BoardCard = { kind: 'card', dispatchId: 'd2', laneId: 'lane1', phase: 'running', openNotes: 0, description: 'Task 2', timestamp: new Date(now - 2000).toISOString(), changedPaths: [] };
    const d3: BoardCard = { kind: 'card', dispatchId: 'd3', laneId: 'lane1', phase: 'ready-for-review', outcome: 'succeeded', summary: 'Done', openNotes: 0, description: 'Task 3', timestamp: new Date(now - 3000).toISOString(), changedPaths: [] };
    const d4: BoardCard = { kind: 'card', dispatchId: 'd4', laneId: 'lane2', phase: 'ready-for-review', outcome: 'succeeded', summary: 'Done', openNotes: 0, description: 'Task 4', timestamp: new Date(now - 4000).toISOString(), changedPaths: [] };
    const d5: BoardCard = { kind: 'card', dispatchId: 'd5', laneId: 'lane2', phase: 'ready-for-review', outcome: 'failed', summary: 'Fail', openNotes: 0, description: 'Task 5', timestamp: new Date(now - 5000).toISOString(), changedPaths: [] };
    
    const model: BoardModel = {
      projects: [],
      notes: [],
      todo: [],
      done: [],
      review: [],
      inMotion: [d1, d2, d3, d4],
      needsYou: [d5],
      alerts: [],
      status: {
        needsYouCount: 1,
        idle: 1,
        idleLaneIds: ['lane2'],
        totalLanes: 2,
        running: 2, // d1 and d2
        stalled: false,
      },
    };

    const boardHtml = renderBoard({ model, lanes, now });
    const fragmentHtml = renderBoardFragment({ model, lanes, now }, 'status') ?? '';
    
    // Glance Page
    const glancePage = buildGlancePage({
      project: 'test', projectName: 'test', projects: [],
      log: { records: [], refusals: [], acknowledged: [] },
      comments: { version: 1, nextId: 1, comments: [] },
      lanes, quotas: {},
      specs: { total: 0, done: 0, specs: [] },
      tree: { count: 0, added: 0, removed: 0, named: [], moreCount: 0 },
      latest: null,
      now,
      model,
    });
    const glanceHtml = renderGlancePage(glancePage);
    
    // Lanes Page
    const laneRows: LanePageRow[] = lanes.map(lane => {
      const executing = model.inMotion.filter(c => c.laneId === lane.id && c.outcome === undefined).length;
      return {
        id: lane.id,
        agentId: lane.agentId,
        availability: { kind: 'found', program: 'a', programPath: '/a' },
        status: executing >= lane.concurrencyCap ? 'capped' : 'free',
        orchestrator: false,
        acceptsDispatch: lane.acceptsDispatch,
        running: executing,
        cap: lane.concurrencyCap,
        inFlight: [],
        billing: 'subscription',
        models: [],
        quota: { exhausted: false },
        stats: { ran: 0, succeeded: 0, failedGates: 0, abandoned: 0, medianTimeMs: 0 },
        recent: [],
      };
    });
    const lanesPage: LanesPage = {
      project: 'test', projectName: 'test', lanes: laneRows, undeclared: [], none: false, now
    };
    const lanesHtml = renderLanesPage(lanesPage);
    
    // The live page, which answers "is any of this current" and so must not
    // answer it differently. Its first version counted every succeeded
    // dispatch ever and said 41 waiting for review beside a board showing 6.
    const liveHtml = renderLivePage({
      project: 'test',
      projectName: 'test',
      now,
      decisions: [],
      lifecycleEvents: [],
      log: { records: [], refusals: [], acknowledged: [] },
      comments: { version: 1, nextId: 1, comments: [] },
      sessions: [],
      lanes,
      specs: [],
      model,
    });

    // 1. Executing dispatches: 2 total (2 on lane1, 0 on lane2)
    // Board
    expect(boardHtml).toMatch(/2 of 2 running/); // lane1 strip
    expect(boardHtml).toMatch(/0 of 1 running/); // lane2 strip
    expect(boardHtml).toMatch(/<span[^>]*>2 running<\/span>/); // status line
    expect(fragmentHtml).toMatch(/<span[^>]*>2 running<\/span>/); // status line in fragment
    // Glance
    expect(glanceHtml).toMatch(/2 in flight.*2 waiting for your review/);
    // Lanes
    expect(lanesHtml).toMatch(/Running \S 2 of 2/); // lane1
    expect(lanesHtml).toMatch(/Running \S 0 of 1/); // lane2

    // 2. Waiting for review: 2 (d3 on lane1, d4 on lane2)
    expect(boardHtml).toMatch(/2 of 2 running.*1 waiting for review/);
    expect(boardHtml).toMatch(/0 of 1 running.*1 waiting for review/);

    // 3. Free lanes: 1 free, 1 capped
    expect(boardHtml).toMatch(/<span[^>]*>1 of 2 lanes free<\/span>/);
    expect(glanceHtml).toMatch(/1 of 2 free.*1 lane at capacity/);
    expect(lanesHtml).toMatch(/<section class="ln-lane" data-status="capped" data-lane="lane1">/);
    expect(lanesHtml).toMatch(/<section class="ln-lane" data-status="free" data-lane="lane2">/);

    // The live page tells the same story about the same model.
    expect(liveHtml).toContain('2 executing, 2 waiting for review');
    expect(liveHtml).toContain('1 free / 2 total lanes');

    // 4. Things wanting a person: 1 (d5)
    // The bell is the only place the board states this count now; the KPI
    // beside it said the same number a second time.
    expect(boardHtml).toMatch(/<span class="board-bell-count" id="board-bell-count">1<\/span>/);
    expect(glanceHtml).toMatch(/1 item wants a person/);

    // 5. The board agrees with itself. Every place it states how many lanes
    // are free must resolve to the same number: the status line and the fold's
    // own summary sit four rows apart, and for an hour they disagreed because
    // the summary recomputed the count instead of reading the one the line
    // above had already rendered.
    const laneClaims = [...boardHtml.matchAll(/(\d+) of (\d+) lanes? free|(\d+) lanes?, (\d+) free/g)].map(
      (match) =>
        match[1] === undefined ? `${match[4] ?? ''}/${match[3] ?? ''}` : `${match[1]}/${match[2] ?? ''}`,
    );
    expect(laneClaims.length).toBeGreaterThanOrEqual(2);
    expect(new Set(laneClaims).size).toBe(1);
  });

  // The fixture above cannot catch the bug it guards against: its two sources
  // happen to agree. This one makes them disagree. `effectiveStatus` returns a
  // model's own status untouched when it has one, so a stored status that has
  // drifted from what the lanes now imply is exactly the state in which the
  // board rendered "0 of 3 lanes free" and "3 lanes, 1 free" four rows apart.
  it('speaks with one voice about free lanes when the stored status has drifted', () => {
    const now = Date.parse('2026-09-08T10:00:00.000Z');
    const lanes: ResolvedLaneDeclaration[] = [
      { id: 'lane1', acceptsDispatch: true, concurrencyCap: 1, models: [], billing: { kind: 'subscription', permitsBilledOverage: false }, agentId: 'a1', executes: 'cli', orchestrator: false },
      { id: 'lane2', acceptsDispatch: true, concurrencyCap: 1, models: [], billing: { kind: 'subscription', permitsBilledOverage: false }, agentId: 'a2', executes: 'cli', orchestrator: false },
      { id: 'lane3', acceptsDispatch: true, concurrencyCap: 1, models: [], billing: { kind: 'subscription', permitsBilledOverage: false }, agentId: 'a3', executes: 'cli', orchestrator: false },
    ];

    const model: BoardModel = {
      projects: [],
      notes: [],
      todo: [],
      done: [],
      review: [],
      // No card is in motion, so counting the lanes would say all three are
      // free. The stored status says none is.
      inMotion: [],
      needsYou: [],
      alerts: [],
      status: {
        needsYouCount: 0,
        idle: 0,
        idleLaneIds: [],
        totalLanes: 3,
        running: 2,
        stalled: false,
        stalledFor: '',
      },
    };

    const html = renderBoard({ model, lanes, now });
    const claims = [...html.matchAll(/(\d+) of (\d+) lanes? free|(\d+) lanes?, (\d+) free/g)].map((match) =>
      match[1] === undefined ? `${match[4] ?? ''}/${match[3] ?? ''}` : `${match[1]}/${match[2] ?? ''}`,
    );

    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(new Set(claims).size).toBe(1);
    // Both claims are the stored status, not the count the lanes imply.
    expect(claims).toContain('0/3');
    expect(claims).not.toContain('3/3');
  });

  // A lane stopped by a rate limit is one state, and every surface has to
  // call it by the same name. The board said "out of quota" while /lanes
  // alone said "cooling" — a word no other surface uses, which is exactly the
  // class of disagreement this file exists to catch.
  it('calls a lane stopped by a rate limit out of quota on the board and on /lanes', async () => {
    const now = Date.parse('2026-09-08T10:00:00.000Z');
    const lanes: ResolvedLaneDeclaration[] = [
      { id: 'antigravity-cli', acceptsDispatch: true, concurrencyCap: 1, models: [], billing: { kind: 'subscription', permitsBilledOverage: false }, agentId: 'antigravity', executes: 'cli', orchestrator: false },
    ];
    const limited: DispatchRecord = {
      dispatchId: 'd-rate',
      workId: 'w-d-rate',
      attempt: 1,
      openedAt: '2026-09-08T09:00:00.000Z',
      declaration: {
        task: 'the task that hit the lane limit',
        taskKind: 'mechanical-transformation',
        ownedPaths: ['src/x.ts'],
        expectsFileChanges: true,
        gates: ['cyv-check'],
      },
      assignment: {
        laneId: 'antigravity-cli',
        agentId: 'antigravity',
        model: 'm',
        billing: 'subscription',
        permitsBilledOverage: false,
        orchestrator: false,
        declaredHeadroomAtSchedule: 1,
      },
      closed: {
        closedAt: '2026-09-08T09:30:00.000Z',
        report: { status: 'failure', exitCode: 1, rateLimited: true },
        gateResults: [],
        outcome: {
          kind: 'rate-limited',
          summary: 'the lane reported its limit',
          changedPaths: [],
          outOfScopePaths: [],
          failedGates: [],
        },
      },
    };
    const log: DispatchLog = { records: [limited], refusals: [], acknowledged: [] };
    const comments = { version: 1, nextId: 1, comments: [] };

    const boardHtml = renderBoard({ model: buildBoardModel({ log, comments, lanes, now }), lanes, now });

    // A stub program stands in for an installed CLI so the row is read as the
    // lane's state rather than as unavailable.
    const dir = await mkdtemp(join(tmpdir(), 'cyv-sa-'));
    await writeFile(join(dir, 'agy'), '', 'utf-8');
    await writeFile(join(dir, 'agy.EXE'), '', 'utf-8');
    const config: CheckYourVibeConfig = {
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: { lanes },
    };
    const lanesHtml = renderLanesPage(
      await buildLanesPage({
        project: '/repo',
        projectName: 'repo',
        config,
        log,
        quotas: {},
        env: { PATH: dir, PATHEXT: '.EXE;.CMD' },
        cwd: dir,
        now,
      }),
    );

    expect(boardHtml).toContain('out of quota');
    expect(lanesHtml).toContain('data-status="cooling"');
    expect(lanesHtml).toContain('ln-st-cooling">out of quota');
    expect(lanesHtml).not.toContain('>cooling</span>');
  });
});
