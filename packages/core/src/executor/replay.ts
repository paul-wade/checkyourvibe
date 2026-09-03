/**
 * Rebuilding lane state from the dispatch log (spec 0011 Requirements 6.4,
 * 7.4, 7.5).
 *
 * The scheduler in `schedule.ts` takes a `LaneRuntime` per lane. This produces
 * that list from the declared lanes and the records on disk, so an orchestrating
 * session that did not create those records can schedule against the same state
 * the previous one saw.
 *
 * Cooldown is derived rather than stored: each lane's closed dispatches are
 * walked in order, an outcome consistent with rate exhaustion sets cooldown
 * (Requirement 7.4) and an observed-effect success clears it (Requirement 7.5).
 * No elapsed-time rule takes part; Requirement 7.5 states cooldown is cleared by
 * a later observed success alone.
 */
import { isObservedEffectSuccess, indicatesRateExhaustion } from './outcome.js';
import { isInFlight, type DispatchRecord } from './dispatch.js';
import type { LaneCooldown, LaneDeclaration } from './lane.js';
import type { InFlightDispatch, LaneRuntime } from './schedule.js';

/** Dispatches still open on `laneId`, in the order they were opened. */
export function inFlightOn(
  records: readonly DispatchRecord[],
  laneId: string,
): InFlightDispatch[] {
  return records
    .filter((record) => record.assignment.laneId === laneId && isInFlight(record))
    .map((record) => ({
      dispatchId: record.dispatchId,
      ownedPaths: record.declaration.ownedPaths,
    }));
}

/**
 * The lane's cooldown after replaying its closed dispatches, or `undefined`
 * when it is not in cooldown.
 */
export function cooldownOn(
  records: readonly DispatchRecord[],
  laneId: string,
): LaneCooldown | undefined {
  let cooldown: LaneCooldown | undefined;
  for (const record of records) {
    if (record.assignment.laneId !== laneId) continue;
    const closed = record.closed;
    if (closed === undefined) continue;

    if (indicatesRateExhaustion(closed.outcome)) {
      cooldown = {
        reason: closed.outcome.kind === 'rate-limited' ? 'rate-limited' : 'produced-nothing',
        dispatchId: record.dispatchId,
        since: closed.closedAt,
      };
      continue;
    }
    if (isObservedEffectSuccess(closed.outcome)) {
      cooldown = undefined;
    }
  }
  return cooldown;
}

/**
 * A `LaneRuntime` per declared lane, built from records read off disk. Lanes
 * with no records appear with nothing in flight and no cooldown.
 */
export function replayLaneRuntimes(
  lanes: readonly LaneDeclaration[],
  records: readonly DispatchRecord[],
): LaneRuntime[] {
  return lanes.map((lane) => {
    const cooldown = cooldownOn(records, lane.id);
    return {
      lane,
      inFlight: inFlightOn(records, lane.id),
      ...(cooldown === undefined ? {} : { cooldown }),
    };
  });
}
