import { describe, expect, it } from 'vitest';

import {
  orchestrationBrief,
  orchestrationWrite,
  type BriefInput,
  type LaneAvailability,
} from '../../src/executor/brief.js';
import type { ResolvedLaneDeclaration } from '../../src/executor/lane.js';

function lane(overrides: Partial<ResolvedLaneDeclaration> & { id: string }): ResolvedLaneDeclaration {
  return {
    agentId: `${overrides.id}-agent`,
    concurrencyCap: 2,
    orchestrator: false,
    acceptsDispatch: true,
    executes: 'cli',
    billing: { kind: 'subscription', permitsBilledOverage: false },
    models: [{ kind: 'mechanical-transformation', ordering: ['strong', 'weak'] }],
    ...overrides,
  };
}

function input(lanes: LaneAvailability[], cap = 4): BriefInput {
  return { lanes, maxConcurrentDispatches: cap };
}

describe('the orchestration brief (spec 0041 Requirement 1)', () => {
  it('names the lane the session is', () => {
    const body = orchestrationBrief(
      input([
        { lane: lane({ id: 'session', orchestrator: true, acceptsDispatch: false }) },
        { lane: lane({ id: 'worker' }), program: 'worker-cli', onPath: true },
      ]),
    );

    expect(body).toContain('`session`');
    expect(body).toContain('and that is you');
  });

  it('states the global cap and says whose number it is', () => {
    const body = orchestrationBrief(
      input([{ lane: lane({ id: 'session', orchestrator: true }) }], 7),
    );

    expect(body).toContain('At most 7 dispatch(es)');
    expect(body).toContain('self-imposed configuration, not a reading of any account');
  });

  it('distinguishes a program that is absent from one with no mapping', () => {
    const body = orchestrationBrief(
      input([
        { lane: lane({ id: 'session', orchestrator: true }) },
        { lane: lane({ id: 'missing' }), program: 'missing-cli', onPath: false },
        { lane: lane({ id: 'unmapped' }) },
      ]),
    );

    expect(body).toContain('`missing-cli` NOT on PATH');
    expect(body).toContain('no program mapping in this build');
  });

  it('tells a sole orchestrating lane that it executes its own work', () => {
    const body = orchestrationBrief(
      input([
        {
          lane: lane({
            id: 'session',
            orchestrator: true,
            acceptsDispatch: true,
            executes: 'subagent',
          }),
        },
      ]),
    );

    expect(body).toContain('you execute dispatched work yourself');
    expect(body).toContain('cyv dispatch --close');
    expect(body).toContain('No other lane accepts dispatched work.');
  });

  it('tells a reserved orchestrating lane that work runs elsewhere', () => {
    const body = orchestrationBrief(
      input([
        { lane: lane({ id: 'session', orchestrator: true, acceptsDispatch: false }) },
        { lane: lane({ id: 'worker' }), program: 'worker-cli', onPath: true },
      ]),
    );

    expect(body).toContain('Dispatched work runs on the lanes below, not here.');
  });

  it('says not to edit the repository while a dispatch runs, and why', () => {
    const body = orchestrationBrief(input([{ lane: lane({ id: 'session', orchestrator: true }) }]));

    expect(body).toContain('Do not edit the repository while a dispatch is running');
    expect(body).toContain('attributed to the executor');
  });

  it('points at reading notes, self-reporting, and resuming a dead run', () => {
    const body = orchestrationBrief(input([{ lane: lane({ id: 'session', orchestrator: true }) }]));

    expect(body).toContain('cyv comments');
    expect(body).toContain('cyv orchestrator');
    expect(body).toContain('readable from disk alone');
  });

  it('ranks no models and claims no remaining capacity (Requirement 1.4)', () => {
    const body = orchestrationBrief(
      input([
        { lane: lane({ id: 'session', orchestrator: true }) },
        { lane: lane({ id: 'worker' }), program: 'worker-cli', onPath: true },
      ]),
    );

    // The lane's ordering is the plugin author's and opaque to the core, so no
    // model name belongs in a brief generated from it (0011 Requirement 8.3).
    expect(body).not.toContain('strong');
    expect(body).not.toContain('weak');

    // What Requirement 1.4 forbids is a *claim* about an account, not the word
    // "capacity" — the brief's own disclaimer necessarily says "remaining
    // capacity" in order to deny having any view of it. So this looks for the
    // shape a claim would take: a number attached to a quantity of account.
    expect(body).not.toMatch(
      /\d+\s*(?:%|percent)?\s*(?:tokens?|credits?|requests?|messages?)\s*(?:left|remaining|available)/i,
    );

    // And the denial itself must survive, since it is the honest half.
    expect(body).toContain('never claims one');
  });

  it('says so rather than rendering a confident blank with no orchestrator', () => {
    const body = orchestrationBrief(input([{ lane: lane({ id: 'worker' }) }]));

    expect(body).toContain('should not have been written');
  });
});

describe('orchestrationWrite (Requirement 1.1)', () => {
  const orchestration = input([
    { lane: lane({ id: 'session', agentId: 'claude-code', orchestrator: true }) },
    { lane: lane({ id: 'worker', agentId: 'codex' }), program: 'codex', onPath: true },
  ]);

  it('writes a block for the agent the orchestrating lane names', () => {
    const write = orchestrationWrite('claude-code', '/repo/CLAUDE.md', orchestration);

    expect(write?.blockId).toBe('claude-code-orchestration');
    expect(write?.strategy).toBe('managed-block');
    expect(write?.path).toBe('/repo/CLAUDE.md');
  });

  it('writes nothing for any other agent', () => {
    expect(orchestrationWrite('codex', '/repo/AGENTS.md', orchestration)).toBeUndefined();
    expect(orchestrationWrite('gemini', '/repo/GEMINI.md', orchestration)).toBeUndefined();
  });

  it('writes nothing when there is no orchestration to describe', () => {
    expect(orchestrationWrite('claude-code', '/repo/CLAUDE.md', undefined)).toBeUndefined();
  });

  it('namespaces the block id by agent, so two agents sharing AGENTS.md do not collide', () => {
    const codexOrchestration = input([
      { lane: lane({ id: 'session', agentId: 'codex', orchestrator: true }) },
    ]);
    const write = orchestrationWrite('codex', '/repo/AGENTS.md', codexOrchestration);

    expect(write?.blockId).toBe('codex-orchestration');
  });
});
