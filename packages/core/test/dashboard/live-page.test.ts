import { describe, expect, it } from 'vitest';
import { buildLivePage, renderLivePage, type LivePageInput } from '../../src/dashboard/live-page.js';
import type { DispatchRecord } from '../../src/executor/dispatch.js';
import type { ResolvedLaneDeclaration } from '../../src/executor/lane.js';

/**
 * Whole fixtures rather than partial ones cast into place. The first version of
 * this test built a dispatch record and a lane with `as any`, which is how a
 * fixture comes to assert against a shape the code no longer has.
 */
function openDispatch(dispatchId: string, laneId: string): DispatchRecord {
  return {
    dispatchId,
    workId: `w-${dispatchId}`,
    attempt: 1,
    openedAt: '2026-09-01T11:58:00.000Z',
    declaration: {
      task: 'do it',
      taskKind: 'mechanical-transformation',
      ownedPaths: ['src/a.ts'],
      expectsFileChanges: true,
      gates: [],
      deadlineMs: 10_000,
    },
    assignment: {
      laneId,
      agentId: 'a1',
      model: 'weak',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
}

function lane(id: string): ResolvedLaneDeclaration {
  return {
    id,
    agentId: 'a1',
    concurrencyCap: 1,
    models: [],
    billing: { kind: 'subscription', permitsBilledOverage: false },
    acceptsDispatch: true,
    executes: 'cli',
    orchestrator: false,
  };
}

describe('Live Page', () => {
  const defaultInput: LivePageInput = {
    project: '/project',
    projectName: 'Test Project',
    now: Date.parse('2026-09-01T12:00:00.000Z'),
    decisions: [],
    lifecycleEvents: [],
    log: { records: [], refusals: [], acknowledged: [] },
    comments: { version: 1, nextId: 1, comments: [] },
    sessions: [],
    lanes: [],
    specs: [],
  };

  it('renders with no evidence', async () => {
    const page = await buildLivePage(defaultInput);
    const html = renderLivePage(page);
    expect(html).toContain('no evidence yet');
    expect(html).toContain('NO EDITS JUDGED YET');
    expect(html).toContain('No live session — nothing has fired a hook');
    expect(html).toContain('0 free / 0 total lanes');
    expect(html).toContain('0 executing, 0 waiting for review');
  });

  it('renders all signals with evidence', async () => {
    const page = await buildLivePage({
      ...defaultInput,
      decisions: [{
        at: '2026-09-01T11:59:00.000Z',
        event: 'PreToolUse',
        tool: 'write',
        decision: 'allow',
        enforced: true,
        reason: 'looks good',
      }],
      lifecycleEvents: [{
        at: '2026-09-01T11:59:30.000Z',
        event: 'SessionStart',
        sessionId: 's1',
      }],
      sessions: [{
        sessionId: 's1',
        projectRoot: '/project',
        agentId: 'a1',
        state: 'running',
        pid: 1,
        startedAt: '2026-09-01T11:59:30.000Z',
        uptimeMs: 30000,
        alive: true,
        statusSource: 'hook',
        activeTurns: 1,
      }],
      log: { records: [openDispatch('d1', 'l1')], refusals: [], acknowledged: [] },
      lanes: [lane('l1')],
    });
    
    const html = renderLivePage(page);
    expect(html).toContain('gate judged 1 edits');
    expect(html).toContain('EDITING NOW');
    expect(html).toContain('1 live session');
    expect(html).toContain('0 free / 1 total lanes');
    expect(html).toContain('1 executing, 0 waiting for review');
  });

  it('renders stale evidence (stalled orchestrator)', async () => {
    const page = await buildLivePage({
      ...defaultInput,
      // An hour old, so the stall detector has something to be stale about.
      log: {
        records: [{ ...openDispatch('d1', 'l1'), openedAt: '2026-09-01T11:00:00.000Z' }],
        refusals: [],
        acknowledged: [],
      },
      lanes: [{ ...lane('l1'), concurrencyCap: 2 }],
    });
    
    const html = renderLivePage(page);
    expect(html).toContain('ORCHESTRATOR STALLED');
  });
});
