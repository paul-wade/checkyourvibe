import { describe, expect, it } from 'vitest';

import {
  declaredHeadroom,
  describeLane,
  laneBillingLabel,
  modelsFor,
  nextStrongerModelFor,
  offersKind,
  weakestModelFor,
} from '../../src/executor/lane.js';
import { isTaskKind, TASK_KINDS } from '../../src/executor/task-kind.js';
import { lane } from './fixtures.js';

describe('a lane model ordering (Requirements 8.2, 8.3)', () => {
  const alpha = lane({ id: 'alpha' });

  it('returns the ordering the lane declared, in the order it declared it', () => {
    expect(modelsFor(alpha, 'mechanical-transformation')).toEqual(['strong', 'middle', 'weak']);
  });

  it('returns an empty ordering for a kind the lane does not offer', () => {
    expect(modelsFor(alpha, 'judgment-required')).toEqual([]);
    expect(offersKind(alpha, 'judgment-required')).toBe(false);
  });

  it('reads the weakest model as the last entry (Requirement 9.1)', () => {
    expect(weakestModelFor(alpha, 'mechanical-transformation')).toBe('weak');
  });

  it('has no weakest model for a kind it does not offer', () => {
    expect(weakestModelFor(alpha, 'judgment-required')).toBeUndefined();
  });

  it('walks one position up the ordering for an escalation (Requirement 9.3)', () => {
    expect(nextStrongerModelFor(alpha, 'mechanical-transformation', 'weak')).toBe('middle');
    expect(nextStrongerModelFor(alpha, 'mechanical-transformation', 'middle')).toBe('strong');
  });

  it('has nothing stronger than the first entry', () => {
    expect(nextStrongerModelFor(alpha, 'mechanical-transformation', 'strong')).toBeUndefined();
  });

  it('has nothing stronger than a model the lane never declared', () => {
    expect(nextStrongerModelFor(alpha, 'mechanical-transformation', 'unlisted')).toBeUndefined();
  });
});

describe('declared headroom (Requirement 7.2)', () => {
  it('is the cap minus what is running', () => {
    expect(declaredHeadroom(lane({ id: 'a', concurrencyCap: 4 }), 1)).toBe(3);
  });

  it('is zero at the cap', () => {
    expect(declaredHeadroom(lane({ id: 'a', concurrencyCap: 4 }), 4)).toBe(0);
  });

  it('does not go negative if more is running than the cap allows', () => {
    expect(declaredHeadroom(lane({ id: 'a', concurrencyCap: 2 }), 5)).toBe(0);
  });
});

describe('labelling a lane (Requirements 1.4, 9.6)', () => {
  it('names a metered lane as billed', () => {
    expect(laneBillingLabel({ kind: 'metered', permitsBilledOverage: false })).toBe(
      'metered — billed per use',
    );
    expect(describeLane(lane({ id: 'billed', metered: true }))).toBe(
      'billed (metered — billed per use)',
    );
  });

  it('names a subscription lane as a subscription', () => {
    expect(describeLane(lane({ id: 'plan' }))).toBe('plan (subscription)');
  });

  it('reports permitted billed overage as the configuration fact it is', () => {
    expect(laneBillingLabel({ kind: 'subscription', permitsBilledOverage: true })).toBe(
      'subscription, configured to permit billed overage',
    );
  });

  it('names the orchestrating lane as a lane like any other (Requirement 6.1)', () => {
    expect(describeLane(lane({ id: 'session', orchestrator: true }))).toBe(
      'session (subscription, orchestrator)',
    );
  });
});

describe('task kinds (Requirement 8.1)', () => {
  it('accepts every declared kind', () => {
    for (const kind of TASK_KINDS) {
      expect(isTaskKind(kind)).toBe(true);
    }
  });

  it('rejects a value that is not a declared kind', () => {
    expect(isTaskKind('opus')).toBe(false);
    expect(isTaskKind(3)).toBe(false);
    expect(isTaskKind(undefined)).toBe(false);
  });
});
