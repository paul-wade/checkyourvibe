/**
 * The executor lanes a repository declares, and the checks JSON Schema cannot
 * make about them (spec 0011 Requirements 1.3, 1.5, 6.1, 8.2).
 *
 * `configuredLanes` is the seam between configuration and the executor surface:
 * the scheduler (`executor/schedule.ts`, `executor/work.ts`) and the localhost
 * view (`dashboard/executor-view.ts`) both take `LaneDeclaration[]`, and this
 * hands them the declarations the config file carries. No lane is discovered,
 * probed, or defaulted, so a repository that declares none passes an empty list
 * and every surface downstream reports that state rather than a guess.
 *
 * `laneConfigProblem` covers the relationships between declarations: JSON
 * Schema validates one lane at a time and cannot say that two lanes share an
 * id, that a metered lane is missing from the by-name opt-in list, or that the
 * opt-in list names a lane that is not metered. Each returns a message naming
 * the JSON pointer of the field at fault, in the wording `loadConfig` uses for
 * a schema failure.
 */
import { resolveAcceptsDispatch, resolveExecutes } from '../executor/lane.js';
import type { LaneDeclaration, ResolvedLaneDeclaration } from '../executor/lane.js';
import type { CheckYourVibeConfig } from './types.js';

const LANES_POINTER = '/executor/lanes';
const METERED_POINTER = '/executor/meteredLanesEnabled';

/**
 * Every lane the repository declares, or an empty list when it declares none.
 *
 * `acceptsDispatch` and `executes` are both resolved here so their defaults
 * stay behind this seam (spec 0036 Requirement 1.2, spec 0041 Requirement 2.2).
 * Both defaults read the whole lane set rather than one lane, because "is this
 * the only lane" is the question they turn on, and only a caller holding the
 * configuration can answer it. A new lane object is returned for each
 * declaration so the configuration value is not modified.
 */
export function configuredLanes(config: CheckYourVibeConfig): readonly ResolvedLaneDeclaration[] {
  const lanes = config.executor?.lanes ?? [];
  return lanes.map((lane): ResolvedLaneDeclaration => ({
    ...lane,
    acceptsDispatch: resolveAcceptsDispatch(lane, lanes),
    executes: resolveExecutes(lane, lanes),
  }));
}

/**
 * The most dispatches that may be open across every lane at once (spec 0041
 * Requirement 3.1).
 *
 * The default is the sum of the caps of the lanes that can actually receive
 * work. Summing every declared lane instead would count a lane reserved for
 * orchestration toward a ceiling it can never contribute to, which would make
 * the default quietly looser than the lanes it describes.
 */
export function maxConcurrentDispatches(config: CheckYourVibeConfig): number {
  const configured = config.executor?.maxConcurrentDispatches;
  if (configured !== undefined) return configured;
  return configuredLanes(config)
    .filter((lane) => lane.acceptsDispatch)
    .reduce((total, lane) => total + lane.concurrencyCap, 0);
}

/** The lane ids this repository has opted into paying per use for. */
export function meteredLanesEnabled(config: CheckYourVibeConfig): readonly string[] {
  return config.executor?.meteredLanesEnabled ?? [];
}

function problem(pointer: string, message: string): string {
  return `Config is invalid at ${pointer}: ${message}`;
}

function duplicateModelKind(lane: LaneDeclaration, pointer: string): string | undefined {
  const seen = new Set<string>();
  for (const [index, offering] of lane.models.entries()) {
    if (seen.has(offering.kind)) {
      return problem(
        `${pointer}/models/${index}/kind`,
        `lane "${lane.id}" declares two model orderings for task kind "${offering.kind}". ` +
          'The core reads one ordering per kind and would use the first, leaving the second ' +
          'with no effect.',
      );
    }
    seen.add(offering.kind);
  }
  return undefined;
}

/**
 * The first problem across the declared lanes, or `undefined` when there is
 * none. Reported one at a time, like a schema failure.
 */
export function laneConfigProblem(config: CheckYourVibeConfig): string | undefined {
  const lanes = configuredLanes(config);
  const enabled = meteredLanesEnabled(config);
  const seenIds = new Set<string>();
  let orchestratorId: string | undefined;

  for (const [index, lane] of lanes.entries()) {
    const pointer = `${LANES_POINTER}/${index}`;

    if (seenIds.has(lane.id)) {
      return problem(
        `${pointer}/id`,
        `lane id "${lane.id}" is declared twice. A lane id names one lane in the dispatch ` +
          'log, in every scheduling refusal, and in a dispatch that names its lane.',
      );
    }
    seenIds.add(lane.id);

    if (lane.orchestrator) {
      if (orchestratorId !== undefined) {
        return problem(
          `${pointer}/orchestrator`,
          `lane "${lane.id}" is marked as the orchestrator, and so is "${orchestratorId}". ` +
            'The orchestrator is the one agent session issuing dispatches (Requirement 6.1).',
        );
      }
      orchestratorId = lane.id;
    }

    const kindProblem = duplicateModelKind(lane, pointer);
    if (kindProblem !== undefined) return kindProblem;

    if (lane.billing.kind === 'metered' && !enabled.includes(lane.id)) {
      return problem(
        `${pointer}/billing/kind`,
        `lane "${lane.id}" is metered — billed per use — and is not named in ` +
          `executor.meteredLanesEnabled. A metered lane is opted into by name: add ` +
          `"${lane.id}" to that list to enable it, or declare this lane's billing kind ` +
          'as "subscription".',
      );
    }
  }

  for (const [index, laneId] of enabled.entries()) {
    const lane = lanes.find((candidate) => candidate.id === laneId);
    if (lane === undefined) {
      return problem(
        `${METERED_POINTER}/${index}`,
        `"${laneId}" names no lane in executor.lanes. This list opts into metered lanes by ` +
          'name, so an id here that no declared lane carries is a typo or a lane that was ' +
          'removed.',
      );
    }
    if (lane.billing.kind !== 'metered') {
      return problem(
        `${METERED_POINTER}/${index}`,
        `lane "${laneId}" declares billing kind "${lane.billing.kind}", so naming it here ` +
          'opts into per-use billing it does not do. Remove it from the list, or declare ' +
          'that lane as metered.',
      );
    }
  }

  return undefined;
}

/**
 * A non-fatal notice when the orchestrating lane will receive dispatched work.
 * Self-dispatch is permitted (spec 0011 Requirement 6.2), but a reader should
 * not have to infer it from two fields in different parts of the file (spec
 * 0036 Requirement 1.3).
 *
 * Two ways to arrive there, and they are not the same fact. Declaring
 * `acceptsDispatch: true` beside other lanes is a choice to spend the
 * orchestrating subscription when others were available. Being the only lane
 * declared is not a choice at all (spec 0041 Requirement 2.2) — so the notice
 * for it states the cost without implying the user asked for it, and does not
 * quote a field they never wrote.
 */
export function laneConfigNotice(config: CheckYourVibeConfig): string | undefined {
  const declared = config.executor?.lanes ?? [];
  for (const lane of configuredLanes(config)) {
    if (!lane.orchestrator || !lane.acceptsDispatch) continue;

    const wasDeclared = declared.find((entry) => entry.id === lane.id)?.acceptsDispatch === true;
    if (wasDeclared) {
      return `lane "${lane.id}" is the orchestrator and declares acceptsDispatch: true; ` +
        'it is accepting dispatched work and therefore spending the capacity the run depends on.';
    }

    return `lane "${lane.id}" is the orchestrator and the only lane declared, so it both ` +
      'plans the run and executes it as a sub-agent of itself. Every dispatch spends the ' +
      'same subscription the run depends on, and there is no second lane to fall back to ' +
      'when it is exhausted. Declare another lane to separate the two.';
  }
  return undefined;
}
