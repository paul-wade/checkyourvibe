import { describe, expect, it } from 'vitest';

import { summarizeGate } from '../../src/dashboard/gate-health.js';
import type { HookDecisionRecord } from '../../src/cli/hook.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

function decision(overrides: Partial<HookDecisionRecord>): HookDecisionRecord {
  return {
    at: new Date(NOW - 60_000).toISOString(),
    event: 'PreToolUse',
    tool: 'Write',
    decision: 'allow',
    enforced: false,
    reason: 'the proposed content introduces no new violation',
    ...overrides,
  };
}

describe('gate health', () => {
  it('counts an allow the gate could not judge', () => {
    const health = summarizeGate(
      [
        decision({}),
        decision({ reason: "internal error: Rule x: notFix references unknown rule 'y'." }),
      ],
      NOW,
    );

    expect(health.considered).toBe(2);
    expect(health.unjudged).toBe(1);
    expect(health.latestReason).toContain('notFix references unknown rule');
  });

  // A gate that judged every edit and found nothing wrong is the healthy case,
  // and must not read as one that could not check.
  it('reports nothing when every decision was judged', () => {
    const health = summarizeGate(
      [decision({}), decision({ decision: 'deny', enforced: true, reason: 'violates configured rules' })],
      NOW,
    );

    expect(health.unjudged).toBe(0);
    expect(health.latestReason).toBeUndefined();
  });

  // An old failure describes a configuration that may since have been repaired.
  it('ignores a failure older than the window', () => {
    const stale = new Date(NOW - 12 * 60 * 60 * 1000).toISOString();
    const health = summarizeGate([decision({ at: stale, reason: 'internal error: something' })], NOW);

    expect(health.considered).toBe(0);
    expect(health.unjudged).toBe(0);
  });
});
