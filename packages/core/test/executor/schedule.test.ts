import { describe, expect, it } from 'vitest';

import {
  eligibleLanes,
  laneIneligibility,
  laneRejections,
  ownershipConflicts,
  scheduleDispatch,
  type ScheduleRequest,
} from '../../src/executor/schedule.js';
import { lane, runtime, running } from './fixtures.js';

function request(overrides: Partial<ScheduleRequest> = {}): ScheduleRequest {
  return {
    dispatchId: overrides.dispatchId ?? 'd1',
    taskKind: overrides.taskKind ?? 'mechanical-transformation',
    ownedPaths: overrides.ownedPaths ?? ['src/a.ts'],
    ...(overrides.laneId === undefined ? {} : { laneId: overrides.laneId }),
  };
}

describe('scheduleDispatch — model choice (Requirement 9.1)', () => {
  it('requests the last entry in the lane ordering for the kind, not the first', () => {
    const decision = scheduleDispatch(request(), [runtime(lane({ id: 'alpha' }))]);

    expect(decision).toEqual({
      decision: 'scheduled',
      laneId: 'alpha',
      agentId: 'alpha-agent',
      model: 'weak',
      declaredHeadroom: 2,
    });
  });

  it('requests the sole model when the lane declares only one for the kind', () => {
    const solo = lane({
      id: 'alpha',
      models: [{ kind: 'mechanical-transformation', ordering: ['only-model'] }],
    });
    const decision = scheduleDispatch(request(), [runtime(solo)]);

    expect(decision).toMatchObject({ decision: 'scheduled', model: 'only-model' });
  });

  it('reads the ordering per kind, so a second kind gets the weakest of that kind', () => {
    const both = lane({
      id: 'alpha',
      models: [
        { kind: 'mechanical-transformation', ordering: ['m-strong', 'm-weak'] },
        { kind: 'judgment-required', ordering: ['j-strong', 'j-weak'] },
      ],
    });
    const decision = scheduleDispatch(request({ taskKind: 'judgment-required' }), [
      runtime(both),
    ]);

    expect(decision).toMatchObject({ decision: 'scheduled', model: 'j-weak' });
  });
});

describe('scheduleDispatch — lane choice (Requirement 9.2)', () => {
  it('prefers the lane with the most declared headroom', () => {
    const roomy = lane({ id: 'roomy', concurrencyCap: 4 });
    const busy = lane({ id: 'busy', concurrencyCap: 4 });
    const decision = scheduleDispatch(request(), [
      runtime(busy, [running('x', ['src/x.ts']), running('y', ['src/y.ts'])]),
      runtime(roomy, [running('z', ['src/z.ts'])]),
    ]);

    expect(decision).toMatchObject({ decision: 'scheduled', laneId: 'roomy', declaredHeadroom: 3 });
  });

  it('compares headroom, not the raw concurrency cap', () => {
    const bigCapFull = lane({ id: 'big', concurrencyCap: 8 });
    const smallCapIdle = lane({ id: 'small', concurrencyCap: 3 });
    const sevenRunning = Array.from({ length: 7 }, (_unused, i) =>
      running(`b${i}`, [`src/b${i}.ts`]),
    );

    const decision = scheduleDispatch(request(), [
      runtime(bigCapFull, sevenRunning),
      runtime(smallCapIdle),
    ]);

    expect(decision).toMatchObject({ decision: 'scheduled', laneId: 'small', declaredHeadroom: 3 });
  });

  it('breaks a headroom tie on lane id, so the same inputs always choose the same lane', () => {
    const first = scheduleDispatch(request(), [
      runtime(lane({ id: 'zeta' })),
      runtime(lane({ id: 'alpha' })),
    ]);
    const reordered = scheduleDispatch(request(), [
      runtime(lane({ id: 'alpha' })),
      runtime(lane({ id: 'zeta' })),
    ]);

    expect(first).toMatchObject({ laneId: 'alpha' });
    expect(reordered).toMatchObject({ laneId: 'alpha' });
  });

  it('reports the headroom it chose on, for the dispatch record', () => {
    const decision = scheduleDispatch(request(), [
      runtime(lane({ id: 'alpha', concurrencyCap: 5 }), [running('x', ['src/x.ts'])]),
    ]);

    expect(decision).toMatchObject({ declaredHeadroom: 4 });
  });
});

describe('lane eligibility', () => {
  it('skips a lane in cooldown (Requirement 7.4)', () => {
    const cool = runtime(lane({ id: 'cool', concurrencyCap: 9 }), [], '2026-01-01T00:00:00.000Z');
    const warm = runtime(lane({ id: 'warm', concurrencyCap: 2 }));

    expect(laneIneligibility(request(), cool)).toEqual({
      reason: 'in-cooldown',
      since: '2026-01-01T00:00:00.000Z',
      cause: 'produced-nothing',
    });
    expect(scheduleDispatch(request(), [cool, warm])).toMatchObject({ laneId: 'warm' });
  });

  it('leaves a lane with no model for the kind out of consideration (Requirement 8.4)', () => {
    const mechanicalOnly = lane({ id: 'mech' });
    const judgment = lane({
      id: 'judge',
      models: [{ kind: 'judgment-required', ordering: ['j-strong', 'j-weak'] }],
    });

    const req = request({ taskKind: 'judgment-required' });
    expect(laneIneligibility(req, runtime(mechanicalOnly))).toEqual({
      reason: 'no-model-for-kind',
      taskKind: 'judgment-required',
    });
    expect(scheduleDispatch(req, [runtime(mechanicalOnly), runtime(judgment)])).toMatchObject({
      laneId: 'judge',
      model: 'j-weak',
    });
  });

  it('treats a lane declaring an empty ordering for the kind as offering no model', () => {
    const empty = lane({ id: 'empty', models: [{ kind: 'mechanical-transformation', ordering: [] }] });

    expect(laneIneligibility(request(), runtime(empty))).toEqual({
      reason: 'no-model-for-kind',
      taskKind: 'mechanical-transformation',
    });
  });

  it('skips a lane already running its declared cap (Requirement 3.2)', () => {
    const full = runtime(lane({ id: 'full', concurrencyCap: 2 }), [
      running('x', ['src/x.ts']),
      running('y', ['src/y.ts']),
    ]);

    expect(laneIneligibility(request(), full)).toEqual({
      reason: 'at-concurrency-cap',
      concurrencyCap: 2,
      inFlight: 2,
    });
  });

  it('reports cooldown and at-cap as different reasons (Requirement 10.3)', () => {
    const atCap = runtime(lane({ id: 'a', concurrencyCap: 1 }), [running('x', ['src/x.ts'])]);
    const inCooldown = runtime(lane({ id: 'b', concurrencyCap: 1 }), [], '2026-01-01T00:00:00.000Z');

    const atCapReason = laneIneligibility(request(), atCap);
    const cooldownReason = laneIneligibility(request(), inCooldown);
    expect(atCapReason?.reason).toBe('at-concurrency-cap');
    expect(cooldownReason?.reason).toBe('in-cooldown');
  });

  it('never selects a metered lane on its own (Requirement 1.5)', () => {
    const metered = lane({ id: 'billed', metered: true, concurrencyCap: 20 });
    const subscription = lane({ id: 'plan', concurrencyCap: 1 });

    expect(laneIneligibility(request(), runtime(metered))).toEqual({ reason: 'metered-not-named' });
    expect(scheduleDispatch(request(), [runtime(metered), runtime(subscription)])).toMatchObject({
      laneId: 'plan',
    });
  });

  it('reaches a metered lane only when the dispatch names it', () => {
    const metered = lane({ id: 'billed', metered: true });
    const decision = scheduleDispatch(request({ laneId: 'billed' }), [runtime(metered)]);

    expect(decision).toMatchObject({ decision: 'scheduled', laneId: 'billed', model: 'weak' });
  });

  it('considers only the named lane when a dispatch names one', () => {
    const named = lane({ id: 'named', concurrencyCap: 1 });
    const roomier = lane({ id: 'roomier', concurrencyCap: 9 });

    expect(
      scheduleDispatch(request({ laneId: 'named' }), [runtime(named), runtime(roomier)]),
    ).toMatchObject({ laneId: 'named' });
    expect(laneIneligibility(request({ laneId: 'named' }), runtime(roomier))).toEqual({
      reason: 'not-the-named-lane',
      namedLaneId: 'named',
    });
  });

  it('lists why every lane was rejected when none is eligible', () => {
    const decision = scheduleDispatch(request(), [
      runtime(lane({ id: 'full', concurrencyCap: 1 }), [running('x', ['src/x.ts'])]),
      runtime(lane({ id: 'cool' }), [], '2026-01-01T00:00:00.000Z'),
      runtime(lane({ id: 'metered', metered: true })),
    ]);

    expect(decision).toEqual({
      decision: 'refused',
      refusal: {
        reason: 'no-eligible-lane',
        rejections: [
          { laneId: 'full', reason: { reason: 'at-concurrency-cap', concurrencyCap: 1, inFlight: 1 } },
          {
            laneId: 'cool',
            reason: { reason: 'in-cooldown', since: '2026-01-01T00:00:00.000Z', cause: 'produced-nothing' },
          },
          { laneId: 'metered', reason: { reason: 'metered-not-named' } },
        ],
      },
    });
  });

  it('names a lane that was asked for but never declared', () => {
    const decision = scheduleDispatch(request({ laneId: 'ghost' }), [runtime(lane({ id: 'real' }))]);

    expect(decision).toEqual({
      decision: 'refused',
      refusal: {
        reason: 'no-eligible-lane',
        rejections: [
          { laneId: 'real', reason: { reason: 'not-the-named-lane', namedLaneId: 'ghost' } },
          { laneId: 'ghost', reason: { reason: 'lane-not-declared' } },
        ],
      },
    });
  });

  it('returns no eligible lanes at all when there are no lanes', () => {
    expect(eligibleLanes(request(), [])).toEqual([]);
    expect(scheduleDispatch(request(), [])).toEqual({
      decision: 'refused',
      refusal: { reason: 'no-eligible-lane', rejections: [] },
    });
  });
});

describe('overlapping ownership (Requirement 4.3)', () => {
  it('refuses the second dispatch and names the other dispatch and the paths', () => {
    const busy = runtime(lane({ id: 'alpha', concurrencyCap: 9 }), [
      running('first', ['src/shared.ts']),
    ]);

    const decision = scheduleDispatch(
      request({ dispatchId: 'second', ownedPaths: ['src/shared.ts', 'src/other.ts'] }),
      [busy],
    );

    expect(decision).toEqual({
      decision: 'refused',
      refusal: {
        reason: 'overlapping-ownership',
        conflicts: [{ withDispatchId: 'first', laneId: 'alpha', paths: ['src/shared.ts'] }],
      },
    });
  });

  it('refuses when one declaration is a directory containing the other', () => {
    const busy = runtime(lane({ id: 'alpha', concurrencyCap: 9 }), [running('first', ['src/api'])]);

    const decision = scheduleDispatch(
      request({ dispatchId: 'second', ownedPaths: ['src/api/handler.ts'] }),
      [busy],
    );

    expect(decision).toMatchObject({
      refusal: {
        reason: 'overlapping-ownership',
        conflicts: [{ withDispatchId: 'first', paths: ['src/api/handler.ts'] }],
      },
    });
  });

  it('refuses on an overlap with a dispatch running on a different lane', () => {
    const conflicts = ownershipConflicts(request({ dispatchId: 'second', ownedPaths: ['src/a.ts'] }), [
      runtime(lane({ id: 'alpha' })),
      runtime(lane({ id: 'beta' }), [running('first', ['src/a.ts'])]),
    ]);

    expect(conflicts).toEqual([{ withDispatchId: 'first', laneId: 'beta', paths: ['src/a.ts'] }]);
  });

  it('schedules when the declarations only share a path prefix, not a directory', () => {
    const busy = runtime(lane({ id: 'alpha', concurrencyCap: 9 }), [
      running('first', ['src/api-client.ts']),
    ]);

    expect(scheduleDispatch(request({ ownedPaths: ['src/api.ts'] }), [busy])).toMatchObject({
      decision: 'scheduled',
    });
  });

  it('does not treat a dispatch as overlapping with itself', () => {
    const busy = runtime(lane({ id: 'alpha', concurrencyCap: 9 }), [
      running('d1', ['src/a.ts']),
    ]);

    expect(ownershipConflicts(request({ dispatchId: 'd1' }), [busy])).toEqual([]);
  });

  it('refuses on an overlap before considering whether any lane had room', () => {
    const busyAndCapped = runtime(lane({ id: 'alpha', concurrencyCap: 1 }), [
      running('first', ['src/a.ts']),
    ]);

    expect(scheduleDispatch(request({ dispatchId: 'second' }), [busyAndCapped])).toMatchObject({
      refusal: { reason: 'overlapping-ownership' },
    });
  });
});

describe('the global cap (spec 0041 Requirements 3.1, 3.2)', () => {
  const alpha = runtime(lane({ id: 'alpha' }), [running('d-a', ['src/x.ts'])]);
  const beta = runtime(lane({ id: 'beta' }), [running('d-b', ['src/y.ts'])]);
  const twoLanes = [alpha, beta];

  it('does not bind when the open count is below it', () => {
    const decision = scheduleDispatch(request(), twoLanes, { maxConcurrentDispatches: 3 });
    expect(decision).toMatchObject({ decision: 'scheduled' });
  });

  it('refuses every lane once the count across lanes has reached it', () => {
    const decision = scheduleDispatch(request(), twoLanes, { maxConcurrentDispatches: 2 });
    expect(decision).toMatchObject({ decision: 'refused' });

    const rejections = laneRejections(request(), twoLanes, { maxConcurrentDispatches: 2 });
    expect(rejections).toHaveLength(2);
    for (const rejection of rejections) {
      expect(rejection.reason).toEqual({
        reason: 'at-global-cap',
        maxConcurrentDispatches: 2,
        openDispatches: 2,
      });
    }
  });

  it('counts dispatches across lanes, not within one', () => {
    // Neither lane is at its own cap of 2; together they are at the global cap.
    expect(
      laneIneligibility(request(), alpha, {
        maxConcurrentDispatches: 2,
        openDispatches: 2,
      }),
    ).toEqual({ reason: 'at-global-cap', maxConcurrentDispatches: 2, openDispatches: 2 });

    expect(laneIneligibility(request(), alpha)).toBeUndefined();
  });

  it('stays distinct from a lane that is at its own cap', () => {
    const full = runtime(lane({ id: 'alpha', concurrencyCap: 1 }), [
      running('d-a', ['src/x.ts']),
    ]);
    const reason = laneIneligibility(request(), full, {
      maxConcurrentDispatches: 9,
      openDispatches: 1,
    });
    expect(reason).toEqual({ reason: 'at-concurrency-cap', concurrencyCap: 1, inFlight: 1 });
  });

  it('reports a durable reason ahead of the global cap', () => {
    // A lane offering no model for the kind says so even while everything is
    // capped: the cap lifts on its own, that does not.
    const wrongKind = runtime(
      lane({ id: 'alpha', models: [{ kind: 'judgment-required', ordering: ['j'] }] }),
    );
    expect(
      laneIneligibility(request(), wrongKind, {
        maxConcurrentDispatches: 1,
        openDispatches: 1,
      }),
    ).toMatchObject({ reason: 'no-model-for-kind' });
  });

  it('does not bind when no cap is passed at all', () => {
    expect(scheduleDispatch(request(), twoLanes)).toMatchObject({ decision: 'scheduled' });
  });
});
