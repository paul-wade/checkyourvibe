import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STALL_INTERVAL_MINUTES,
  detectStall,
  idleLanes,
  lastOpenedAt,
  stallIntervalMinutes,
} from '../../src/executor/stall.js';
import type { DispatchRecord } from '../../src/executor/dispatch.js';
import type { CheckYourVibeConfig } from '../../src/config/types.js';
import { declaration, lane, running, runtime } from './fixtures.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function minutesBefore(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function record(dispatchId: string, openedAt: string, laneId = 'alpha'): DispatchRecord {
  return {
    dispatchId,
    workId: `w-${dispatchId}`,
    attempt: 1,
    openedAt,
    declaration: declaration(),
    assignment: {
      laneId,
      agentId: `${laneId}-agent`,
      model: 'weak',
      billing: 'subscription',
      permitsBilledOverage: false,
      orchestrator: false,
      declaredHeadroomAtSchedule: 1,
    },
  };
}

function config(executor?: CheckYourVibeConfig['executor']): CheckYourVibeConfig {
  return {
    packs: [],
    analyzers: [],
    rules: {},
    strict: false,
    exclude: [],
    ...(executor === undefined ? {} : { executor }),
  };
}

describe('idle lanes (spec 0036 Requirement 4.3)', () => {
  it('names a lane that is free, below cap and not cooling', () => {
    expect(idleLanes([runtime(lane({ id: 'alpha' }))])).toEqual(['alpha']);
  });

  it('leaves out a lane at its cap', () => {
    const full = runtime(lane({ id: 'alpha', concurrencyCap: 1 }), [running('d1', ['src/a.ts'])]);
    expect(idleLanes([full])).toEqual([]);
  });

  it('leaves out a lane in cooldown', () => {
    expect(idleLanes([runtime(lane({ id: 'alpha' }), [], minutesBefore(5))])).toEqual([]);
  });

  it('leaves out the orchestrating lane unless it accepts dispatch', () => {
    const reserved = runtime(lane({ id: 'orch', orchestrator: true }));
    expect(idleLanes([reserved])).toEqual([]);

    const optedIn = runtime({ ...lane({ id: 'orch', orchestrator: true }), acceptsDispatch: true });
    expect(idleLanes([optedIn])).toEqual(['orch']);
  });
});

describe('detectStall (spec 0036 Requirement 4.1)', () => {
  it('reports a stall when work is open, a lane is idle, and nothing opened within the interval', () => {
    const stall = detectStall({
      runtimes: [runtime(lane({ id: 'alpha' })), runtime(lane({ id: 'beta' }))],
      records: [record('d1', minutesBefore(45))],
      openWorkExists: true,
      now: NOW,
    });
    expect(stall).toEqual({
      idleLanes: ['alpha', 'beta'],
      lastOpenedAt: minutesBefore(45),
      intervalMinutes: DEFAULT_STALL_INTERVAL_MINUTES,
    });
  });

  it('is not a stall while a dispatch opened within the interval', () => {
    const stall = detectStall({
      runtimes: [runtime(lane({ id: 'alpha' }))],
      records: [record('d1', minutesBefore(45)), record('d2', minutesBefore(10))],
      openWorkExists: true,
      now: NOW,
    });
    expect(stall).toBeUndefined();
  });

  it('is not a stall without open work, whatever the lanes are doing', () => {
    const stall = detectStall({
      runtimes: [runtime(lane({ id: 'alpha' }))],
      records: [],
      openWorkExists: false,
      now: NOW,
    });
    expect(stall).toBeUndefined();
  });

  it('is not a stall when no lane could take the work', () => {
    const stall = detectStall({
      runtimes: [
        runtime(lane({ id: 'alpha', concurrencyCap: 1 }), [running('d1', ['src/a.ts'])]),
        runtime(lane({ id: 'beta' }), [], minutesBefore(60)),
      ],
      records: [record('d1', minutesBefore(90))],
      openWorkExists: true,
      now: NOW,
    });
    expect(stall).toBeUndefined();
  });

  it('a run that never opened a dispatch is stalled with no lastOpenedAt', () => {
    const stall = detectStall({
      runtimes: [runtime(lane({ id: 'alpha' }))],
      records: [],
      openWorkExists: true,
      now: NOW,
    });
    expect(stall).toEqual({ idleLanes: ['alpha'], intervalMinutes: DEFAULT_STALL_INTERVAL_MINUTES });
    expect(stall).not.toHaveProperty('lastOpenedAt');
  });

  it('honours a configured interval', () => {
    const input = {
      runtimes: [runtime(lane({ id: 'alpha' }))],
      records: [record('d1', minutesBefore(20))],
      openWorkExists: true,
      now: NOW,
    };
    expect(detectStall({ ...input, intervalMinutes: 15 })?.intervalMinutes).toBe(15);
    expect(detectStall({ ...input, intervalMinutes: 25 })).toBeUndefined();
  });

  it('exactly the interval counts as stalled; a record from the future counts as recent', () => {
    const runtimes = [runtime(lane({ id: 'alpha' }))];
    const onTheBoundary = detectStall({
      runtimes,
      records: [record('d1', minutesBefore(DEFAULT_STALL_INTERVAL_MINUTES))],
      openWorkExists: true,
      now: NOW,
    });
    expect(onTheBoundary).toBeDefined();

    const fromTheFuture = detectStall({
      runtimes,
      records: [record('d1', minutesBefore(-5))],
      openWorkExists: true,
      now: NOW,
    });
    expect(fromTheFuture).toBeUndefined();
  });

  it('the signal names idle lanes and says nothing about a cause', () => {
    const stall = detectStall({
      runtimes: [runtime(lane({ id: 'alpha' }))],
      records: [],
      openWorkExists: true,
      now: NOW,
    });
    expect(Object.keys(stall ?? {}).sort()).toEqual(['idleLanes', 'intervalMinutes']);
  });
});

describe('lastOpenedAt', () => {
  it('takes the latest parseable openedAt regardless of order', () => {
    expect(
      lastOpenedAt([
        record('d1', minutesBefore(10)),
        record('d2', minutesBefore(1)),
        record('d3', minutesBefore(30)),
      ]),
    ).toBe(minutesBefore(1));
  });

  it('ignores an openedAt that is not a date', () => {
    expect(lastOpenedAt([record('d1', 'not a date')])).toBeUndefined();
  });
});

describe('stallIntervalMinutes (spec 0036 Requirement 4.4)', () => {
  it('defaults to thirty minutes', () => {
    expect(DEFAULT_STALL_INTERVAL_MINUTES).toBe(30);
    expect(stallIntervalMinutes(config())).toBe(30);
    expect(stallIntervalMinutes(config({ lanes: [] }))).toBe(30);
  });

  it('reads executor.stallAfterMinutes when it is set', () => {
    expect(stallIntervalMinutes(config({ lanes: [], stallAfterMinutes: 12 }))).toBe(12);
  });

  it('falls back to the default for a value that is not a positive number', () => {
    expect(stallIntervalMinutes(config({ lanes: [], stallAfterMinutes: 0 }))).toBe(30);
    expect(stallIntervalMinutes(config({ lanes: [], stallAfterMinutes: Number.NaN }))).toBe(30);
  });
});
