/**
 * The dispatch record (spec 0011 Requirement 4).
 *
 * A record captures the task handed to the executor, which lane and model ran
 * it, the paths it was permitted to own, which gates ran and their result, and
 * the observed effect. The store in `store.ts` writes it as two append-only
 * entries — one when the dispatch opens, one when it closes — so a dispatch
 * that is still running is on disk too. Requirement 6.4 requires a second
 * orchestrating session to read the full state of in-flight and completed
 * dispatches from disk alone.
 *
 * Each attempt at a unit of work is its own record, sharing a `workId`
 * (Requirement 9.4).
 */
import type { DispatchOutcome, ExecutorReport, GateResult } from './outcome.js';
import type { LaneBillingKind } from './lane.js';
import type { TaskKind } from './task-kind.js';

/**
 * Everything a dispatch declares before it runs. Ownership and the
 * expected-file-change flag are declared here rather than inferred afterwards
 * (Requirements 4.4 and 2.7).
 */
export interface DispatchDeclaration {
  /** The task handed to the executor. */
  task: string;
  taskKind: TaskKind;
  /** Repo-relative paths this dispatch is permitted to write (Requirement 4.2). */
  ownedPaths: readonly string[];
  /** Whether this dispatch is expected to change files (Requirement 2.7). */
  expectsFileChanges: boolean;
  /** Names of the gates to run against the result (Requirement 4.1). */
  gates: readonly string[];
}

/** Which lane and model ran the dispatch (Requirements 4.1, 9.6, 6.1). */
export interface DispatchAssignment {
  laneId: string;
  agentId: string;
  /** The model requested, from that lane's own ordering for the task kind. */
  model: string;
  /** Labelled at every point the lane is named to the user (Requirement 1.4). */
  billing: LaneBillingKind;
  /** A configuration fact the user supplied, not a reading of the account (Requirement 9.6). */
  permitsBilledOverage: boolean;
  /** True when the lane is the orchestrating session itself (Requirement 6.1). */
  orchestrator: boolean;
  /** Declared headroom on the lane when the dispatch was scheduled (Requirement 7.2). */
  declaredHeadroomAtSchedule: number;
}

/** Why this attempt exists and where the work came from (Requirements 3.4, 9.4). */
export interface Escalation {
  fromLaneId: string;
  fromModel: string;
  /**
   * `rate-exhaustion` moves the work to a second lane (Requirement 3.3).
   * `gate-failure` moves it to the next-stronger model on the same lane
   * (Requirement 9.3).
   */
  reason: 'rate-exhaustion' | 'gate-failure';
  /** The observed outcome that caused the move. */
  detail: string;
  /** The dispatch this attempt follows. */
  priorDispatchId: string;
}

/** Why the core declined to schedule a dispatch. */
export type SchedulingRefusal =
  | {
      /** Two dispatches the core would run concurrently declare overlapping paths (Requirement 4.3). */
      reason: 'overlapping-ownership';
      conflicts: readonly OwnershipConflict[];
    }
  | {
      /** No lane was a candidate; each lane's reason is listed (Requirements 7.3, 8.4). */
      reason: 'no-eligible-lane';
      rejections: readonly LaneRejection[];
    };

export interface OwnershipConflict {
  /** The in-flight dispatch whose declared paths overlap. */
  withDispatchId: string;
  /** The lane that dispatch is running on. */
  laneId: string;
  /** The overlapping paths, from the requesting dispatch's declaration. */
  paths: readonly string[];
}

/** Why one lane was not a candidate for one dispatch. */
export interface LaneRejection {
  laneId: string;
  reason: LaneIneligibility;
}

/**
 * Requirement 7.3 and 8.4 put all of these out of consideration for a unit of
 * work without marking the lane unusable in general. Requirement 10.3 requires
 * cooldown and at-cap to stay distinct, so they are separate values here.
 */
export type LaneIneligibility =
  /** No lane with this id is declared. */
  | { reason: 'lane-not-declared' }
  /** A dispatch named another lane, so this one was not considered. */
  | { reason: 'not-the-named-lane'; namedLaneId: string }
  /** A metered lane is never selected by the core on its own (Requirement 1.5). */
  | { reason: 'metered-not-named' }
  /** The lane declares no model for this task kind (Requirement 8.4). */
  | { reason: 'no-model-for-kind'; taskKind: TaskKind }
  | { reason: 'does-not-accept-dispatch'; orchestrator: boolean }
  /** The lane stopped producing observed effect (Requirement 7.4). */
  | { reason: 'in-cooldown'; since: string; cause: 'produced-nothing' | 'rate-limited' }
  /** The lane is already running its declared cap (Requirement 3.2). */
  | { reason: 'at-concurrency-cap'; concurrencyCap: number; inFlight: number }
  /**
   * Every lane is refused because the number of dispatches open across all of
   * them has reached `executor.maxConcurrentDispatches` (spec 0041 Requirement
   * 3.2).
   *
   * Deliberately distinct from `at-concurrency-cap`, which is one lane being
   * full while others may have room. This one says the run as a whole is at its
   * limit, so no lane can help — and it is reported on every lane rather than
   * as a single refusal so that a reader sees the same reason wherever they
   * look, instead of inferring a global condition from every lane happening to
   * refuse at once.
   */
  | { reason: 'at-global-cap'; maxConcurrentDispatches: number; openDispatches: number };

export const DISPATCH_SCHEMA_VERSION = 1;

/** Written when a dispatch is scheduled, before the executor is invoked. */
export interface DispatchOpened {
  event: 'opened';
  schemaVersion: number;
  dispatchId: string;
  /** Shared by every attempt at one unit of work (Requirement 9.4). */
  workId: string;
  /** 1 for the first attempt. */
  attempt: number;
  openedAt: string;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  /** The machine that opened the dispatch. */
  host?: string;
  /** The cyv process that opened the dispatch. */
  pid?: number;
  /** When that cyv process began, as an ISO 8601 string. */
  processStartedAt?: string;
  escalation?: Escalation;
}

/** Written when a dispatch finishes, whatever the outcome. */
export interface DispatchClosed {
  event: 'closed';
  schemaVersion: number;
  dispatchId: string;
  closedAt: string;
  report: ExecutorReport;
  gateResults: readonly GateResult[];
  outcome: DispatchOutcome;
}

/** Written when the core declines to schedule a dispatch at all. */
export interface DispatchRefused {
  event: 'refused';
  schemaVersion: number;
  dispatchId: string;
  workId: string;
  refusedAt: string;
  declaration: DispatchDeclaration;
  refusal: SchedulingRefusal;
}

/** What the orchestrating session may say about its own condition (spec 0036 Requirement 3.1). */
export type OrchestratorState = 'healthy' | 'degraded' | 'exhausted';

/**
 * The orchestrating session's own account of itself, kept with the dispatch
 * log so it outlives the session that wrote it (spec 0036 Requirements 3.1,
 * 3.2; Decision 3).
 *
 * It is a claim, not a measurement: cyv is invoked by the orchestrator and has
 * no subprocess to watch, so this is the only evidence about the orchestrator's
 * condition the log can hold. Every reader labels it self-reported, and the
 * absence of one means unknown rather than healthy (Requirements 3.3, 3.4).
 * The record folder keeps the most recent report and readers written before
 * this event ignore it.
 */
export interface OrchestratorReported {
  event: 'orchestrator';
  schemaVersion: number;
  reportedAt: string;
  state: OrchestratorState;
  /** Free text the session offered, such as the vendor's own limit message. */
  reason?: string;
  /** The model or plan the session believes it is running under. */
  model?: string;
  /** The machine the report was written on. */
  host?: string;
  /** The cyv process that wrote the report. */
  pid?: number;
}

/**
 * Written when a person has seen a closed dispatch or a refusal that needed
 * them and decided it needs nothing more (spec 0040 Requirement 2). The record
 * itself is unchanged; this only takes it off the list.
 */
export interface DispatchAcknowledged {
  event: 'acknowledged';
  schemaVersion: number;
  /**
   * The needs-you item a person dismissed: a dispatch id, a task id such as
   * `T5010`, a spec number, or a note id such as `#12`. The page and `cyv
   * acknowledge` agree on these forms.
   */
  itemId: string;
  acknowledgedAt: string;
  note?: string;
}

export type DispatchEntry = DispatchOpened | DispatchClosed | DispatchRefused | OrchestratorReported | DispatchAcknowledged;

/** An opened dispatch folded together with its close entry, if it has one. */
export interface DispatchRecord {
  dispatchId: string;
  workId: string;
  attempt: number;
  openedAt: string;
  declaration: DispatchDeclaration;
  assignment: DispatchAssignment;
  escalation?: Escalation;
  /** The machine that opened the dispatch. */
  host?: string;
  /** The cyv process that opened the dispatch. */
  pid?: number;
  /** When that cyv process began, as an ISO 8601 string. */
  processStartedAt?: string;
  /** Absent while the dispatch is still in flight. */
  closed?: {
    closedAt: string;
    report: ExecutorReport;
    gateResults: readonly GateResult[];
    outcome: DispatchOutcome;
  };
}

/** Checks if a dispatch record is still in flight (has not yet closed). */
export function isInFlight(record: DispatchRecord): boolean {
  return record.closed === undefined;
}
