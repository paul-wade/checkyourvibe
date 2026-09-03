/**
 * Reading dispatch entries back off disk.
 *
 * An entry is accepted only when every field it claims is present and of the
 * right shape; a partially understood entry is rejected rather than filled in,
 * following `dashboard/latest.ts`, so nothing rendered from a record is a
 * guess. The parsers are separate from the store so they can be tested against
 * literal values without touching the file system.
 */
import { isUnknownArray } from '../guards.js';
import type {
  DispatchAcknowledged,
  DispatchAssignment,
  DispatchClosed,
  DispatchDeclaration,
  DispatchEntry,
  DispatchOpened,
  DispatchRefused,
  Escalation,
  LaneIneligibility,
  LaneRejection,
  OrchestratorReported,
  OrchestratorState,
  OwnershipConflict,
  SchedulingRefusal,
} from './dispatch.js';
import { isTaskKind } from './task-kind.js';
import type {
  DispatchOutcome,
  DispatchOutcomeKind,
  ExecutorOutput,
  ExecutorReport,
  GateResult,
} from './outcome.js';
import { readDispatchLiveness } from './liveness.js';
import type { LaneBillingKind } from './lane.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    out.push(entry);
  }
  return out;
}

const OUTCOME_KINDS: readonly DispatchOutcomeKind[] = [
  'succeeded',
  'produced-nothing',
  'changed-files-unexpectedly',
  'out-of-scope-write',
  'gates-failed',
  'rate-limited',
  'failed',
  'did-not-complete',
];

function asOutcomeKind(value: unknown): DispatchOutcomeKind | undefined {
  return OUTCOME_KINDS.find((kind) => kind === value);
}

const REPORT_STATUSES: readonly ExecutorReport['status'][] = [
  'success',
  'failure',
  'did-not-complete',
];

function asReportStatus(value: unknown): ExecutorReport['status'] | undefined {
  return REPORT_STATUSES.find((status) => status === value);
}

const BILLING_KINDS: readonly LaneBillingKind[] = ['subscription', 'metered'];

function asBillingKind(value: unknown): LaneBillingKind | undefined {
  return BILLING_KINDS.find((kind) => kind === value);
}

const ESCALATION_REASONS: readonly Escalation['reason'][] = ['rate-exhaustion', 'gate-failure'];

function asEscalationReason(value: unknown): Escalation['reason'] | undefined {
  return ESCALATION_REASONS.find((reason) => reason === value);
}

const COOLDOWN_CAUSES: readonly ('produced-nothing' | 'rate-limited')[] = [
  'produced-nothing',
  'rate-limited',
];

function asCooldownCause(value: unknown): 'produced-nothing' | 'rate-limited' | undefined {
  return COOLDOWN_CAUSES.find((cause) => cause === value);
}

const ORCHESTRATOR_STATES: readonly OrchestratorState[] = ['healthy', 'degraded', 'exhausted'];

export function asOrchestratorState(value: unknown): OrchestratorState | undefined {
  return ORCHESTRATOR_STATES.find((state) => state === value);
}

export function parseGateResult(value: unknown): GateResult | undefined {
  if (!isRecord(value)) return undefined;
  const gate = asString(value.gate);
  const passed = asBoolean(value.passed);
  if (gate === undefined || passed === undefined) return undefined;
  const detail = asString(value.detail);
  return { gate, passed, ...(detail === undefined ? {} : { detail }) };
}

function parseGateResults(value: unknown): GateResult[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  const out: GateResult[] = [];
  for (const entry of value) {
    const parsed = parseGateResult(entry);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseExecutorOutput(value: unknown): ExecutorOutput | undefined {
  if (!isRecord(value)) return undefined;
  const stdout = asString(value.stdout);
  const stderr = asString(value.stderr);
  if (stdout === undefined && stderr === undefined) return undefined;

  let truncatedFrom: ExecutorOutput['truncatedFrom'] | undefined;
  if (value.truncatedFrom !== undefined) {
    if (!isRecord(value.truncatedFrom)) return undefined;
    const tStdout = asNumber(value.truncatedFrom.stdout);
    const tStderr = asNumber(value.truncatedFrom.stderr);
    if (tStdout === undefined && tStderr === undefined) return undefined;
    truncatedFrom = {
      ...(tStdout === undefined ? {} : { stdout: tStdout }),
      ...(tStderr === undefined ? {} : { stderr: tStderr }),
    };
  }

  return {
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(truncatedFrom === undefined ? {} : { truncatedFrom }),
  };
}

export function parseExecutorReport(value: unknown): ExecutorReport | undefined {
  if (!isRecord(value)) return undefined;
  const status = asReportStatus(value.status);
  const rateLimited = asBoolean(value.rateLimited);
  if (status === undefined || rateLimited === undefined) return undefined;
  const exitCode = asNumber(value.exitCode);
  const detail = asString(value.detail);
  const output = parseExecutorOutput(value.output);
  return {
    status,
    rateLimited,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(detail === undefined ? {} : { detail }),
    ...(output === undefined ? {} : { output }),
  };
}

export function parseOutcome(value: unknown): DispatchOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const kind = asOutcomeKind(value.kind);
  const summary = asString(value.summary);
  const changedPaths = asStringArray(value.changedPaths);
  const outOfScopePaths = asStringArray(value.outOfScopePaths);
  const failedGates = asStringArray(value.failedGates);
  if (
    kind === undefined ||
    summary === undefined ||
    changedPaths === undefined ||
    outOfScopePaths === undefined ||
    failedGates === undefined
  ) {
    return undefined;
  }
  return { kind, summary, changedPaths, outOfScopePaths, failedGates };
}

export function parseDeclaration(value: unknown): DispatchDeclaration | undefined {
  if (!isRecord(value)) return undefined;
  const task = asString(value.task);
  const ownedPaths = asStringArray(value.ownedPaths);
  const gates = asStringArray(value.gates);
  const expectsFileChanges = asBoolean(value.expectsFileChanges);
  if (
    task === undefined ||
    ownedPaths === undefined ||
    gates === undefined ||
    expectsFileChanges === undefined ||
    !isTaskKind(value.taskKind)
  ) {
    return undefined;
  }
  return { task, taskKind: value.taskKind, ownedPaths, expectsFileChanges, gates };
}

export function parseAssignment(value: unknown): DispatchAssignment | undefined {
  if (!isRecord(value)) return undefined;
  const laneId = asString(value.laneId);
  const agentId = asString(value.agentId);
  const model = asString(value.model);
  const billing = asBillingKind(value.billing);
  const permitsBilledOverage = asBoolean(value.permitsBilledOverage);
  const orchestrator = asBoolean(value.orchestrator);
  const declaredHeadroomAtSchedule = asNumber(value.declaredHeadroomAtSchedule);
  if (
    laneId === undefined ||
    agentId === undefined ||
    model === undefined ||
    billing === undefined ||
    permitsBilledOverage === undefined ||
    orchestrator === undefined ||
    declaredHeadroomAtSchedule === undefined
  ) {
    return undefined;
  }
  return {
    laneId,
    agentId,
    model,
    billing,
    permitsBilledOverage,
    orchestrator,
    declaredHeadroomAtSchedule,
  };
}

export function parseEscalation(value: unknown): Escalation | undefined {
  if (!isRecord(value)) return undefined;
  const fromLaneId = asString(value.fromLaneId);
  const fromModel = asString(value.fromModel);
  const reason = asEscalationReason(value.reason);
  const detail = asString(value.detail);
  const priorDispatchId = asString(value.priorDispatchId);
  if (
    fromLaneId === undefined ||
    fromModel === undefined ||
    reason === undefined ||
    detail === undefined ||
    priorDispatchId === undefined
  ) {
    return undefined;
  }
  return { fromLaneId, fromModel, reason, detail, priorDispatchId };
}

function parseIneligibility(value: unknown): LaneIneligibility | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.reason) {
    case 'lane-not-declared':
      return { reason: 'lane-not-declared' };
    case 'metered-not-named':
      return { reason: 'metered-not-named' };
    case 'not-the-named-lane': {
      const namedLaneId = asString(value.namedLaneId);
      return namedLaneId === undefined ? undefined : { reason: 'not-the-named-lane', namedLaneId };
    }
    case 'no-model-for-kind':
      return isTaskKind(value.taskKind)
        ? { reason: 'no-model-for-kind', taskKind: value.taskKind }
        : undefined;
    case 'does-not-accept-dispatch':
      return typeof value.orchestrator === 'boolean'
        ? { reason: 'does-not-accept-dispatch', orchestrator: value.orchestrator }
        : undefined;
    case 'in-cooldown': {
      const since = asString(value.since);
      const cause = asCooldownCause(value.cause);
      return since === undefined || cause === undefined
        ? undefined
        : { reason: 'in-cooldown', since, cause };
    }
    case 'at-concurrency-cap': {
      const concurrencyCap = asNumber(value.concurrencyCap);
      const inFlight = asNumber(value.inFlight);
      return concurrencyCap === undefined || inFlight === undefined
        ? undefined
        : { reason: 'at-concurrency-cap', concurrencyCap, inFlight };
    }
    case 'at-global-cap': {
      const maxConcurrentDispatches = asNumber(value.maxConcurrentDispatches);
      const openDispatches = asNumber(value.openDispatches);
      return maxConcurrentDispatches === undefined || openDispatches === undefined
        ? undefined
        : { reason: 'at-global-cap', maxConcurrentDispatches, openDispatches };
    }
    default:
      return undefined;
  }
}

function parseConflict(value: unknown): OwnershipConflict | undefined {
  if (!isRecord(value)) return undefined;
  const withDispatchId = asString(value.withDispatchId);
  const laneId = asString(value.laneId);
  const paths = asStringArray(value.paths);
  if (withDispatchId === undefined || laneId === undefined || paths === undefined) {
    return undefined;
  }
  return { withDispatchId, laneId, paths };
}

function parseRejection(value: unknown): LaneRejection | undefined {
  if (!isRecord(value)) return undefined;
  const laneId = asString(value.laneId);
  const reason = parseIneligibility(value.reason);
  if (laneId === undefined || reason === undefined) return undefined;
  return { laneId, reason };
}

export function parseRefusal(value: unknown): SchedulingRefusal | undefined {
  if (!isRecord(value)) return undefined;

  if (value.reason === 'overlapping-ownership') {
    if (!isUnknownArray(value.conflicts)) return undefined;
    const conflicts: OwnershipConflict[] = [];
    for (const entry of value.conflicts) {
      const parsed = parseConflict(entry);
      if (parsed === undefined) return undefined;
      conflicts.push(parsed);
    }
    return { reason: 'overlapping-ownership', conflicts };
  }

  if (value.reason === 'no-eligible-lane') {
    if (!isUnknownArray(value.rejections)) return undefined;
    const rejections: LaneRejection[] = [];
    for (const entry of value.rejections) {
      const parsed = parseRejection(entry);
      if (parsed === undefined) return undefined;
      rejections.push(parsed);
    }
    return { reason: 'no-eligible-lane', rejections };
  }

  return undefined;
}

function parseOpened(value: Record<string, unknown>): DispatchOpened | undefined {
  const schemaVersion = asNumber(value.schemaVersion);
  const dispatchId = asString(value.dispatchId);
  const workId = asString(value.workId);
  const attempt = asNumber(value.attempt);
  const openedAt = asString(value.openedAt);
  const declaration = parseDeclaration(value.declaration);
  const assignment = parseAssignment(value.assignment);
  if (
    schemaVersion === undefined ||
    dispatchId === undefined ||
    workId === undefined ||
    attempt === undefined ||
    openedAt === undefined ||
    declaration === undefined ||
    assignment === undefined
  ) {
    return undefined;
  }
  const liveness = readDispatchLiveness(value);

  // An absent `escalation` key means a first attempt. A key that is present but
  // unreadable rejects the entry.
  let escalation: Escalation | undefined;
  if (value.escalation !== undefined) {
    escalation = parseEscalation(value.escalation);
    if (escalation === undefined) return undefined;
  }
  return {
    event: 'opened',
    schemaVersion,
    dispatchId,
    workId,
    attempt,
    openedAt,
    declaration,
    assignment,
    ...(liveness.host === undefined ? {} : { host: liveness.host }),
    ...(liveness.pid === undefined ? {} : { pid: liveness.pid }),
    ...(liveness.processStartedAt === undefined ? {} : { processStartedAt: liveness.processStartedAt }),
    ...(escalation === undefined ? {} : { escalation }),
  };
}

function parseClosed(value: Record<string, unknown>): DispatchClosed | undefined {
  const schemaVersion = asNumber(value.schemaVersion);
  const dispatchId = asString(value.dispatchId);
  const closedAt = asString(value.closedAt);
  const report = parseExecutorReport(value.report);
  const gateResults = parseGateResults(value.gateResults);
  const outcome = parseOutcome(value.outcome);
  if (
    schemaVersion === undefined ||
    dispatchId === undefined ||
    closedAt === undefined ||
    report === undefined ||
    gateResults === undefined ||
    outcome === undefined
  ) {
    return undefined;
  }
  return { event: 'closed', schemaVersion, dispatchId, closedAt, report, gateResults, outcome };
}

function parseRefusedEntry(value: Record<string, unknown>): DispatchRefused | undefined {
  const schemaVersion = asNumber(value.schemaVersion);
  const dispatchId = asString(value.dispatchId);
  const workId = asString(value.workId);
  const refusedAt = asString(value.refusedAt);
  const declaration = parseDeclaration(value.declaration);
  const refusal = parseRefusal(value.refusal);
  if (
    schemaVersion === undefined ||
    dispatchId === undefined ||
    workId === undefined ||
    refusedAt === undefined ||
    declaration === undefined ||
    refusal === undefined
  ) {
    return undefined;
  }
  return { event: 'refused', schemaVersion, dispatchId, workId, refusedAt, declaration, refusal };
}

/**
 * The orchestrator's self-report (spec 0036 Requirement 3). `reason` and
 * `model` are optional, but a key that is present and not a string rejects the
 * entry, the same way an unreadable `escalation` rejects an opened one. Host
 * and pid follow the opened entry's rule instead: they are identity, not
 * content, and a malformed one is left absent rather than losing the report.
 */
function parseOrchestrator(value: Record<string, unknown>): OrchestratorReported | undefined {
  const schemaVersion = asNumber(value.schemaVersion);
  const reportedAt = asString(value.reportedAt);
  const state = asOrchestratorState(value.state);
  if (schemaVersion === undefined || reportedAt === undefined || state === undefined) {
    return undefined;
  }
  const reason = asString(value.reason);
  if (value.reason !== undefined && reason === undefined) return undefined;
  const model = asString(value.model);
  if (value.model !== undefined && model === undefined) return undefined;
  const identity = readDispatchLiveness(value);
  return {
    event: 'orchestrator',
    schemaVersion,
    reportedAt,
    state,
    ...(reason === undefined ? {} : { reason }),
    ...(model === undefined ? {} : { model }),
    ...(identity.host === undefined ? {} : { host: identity.host }),
    ...(identity.pid === undefined ? {} : { pid: identity.pid }),
  };
}

function parseAcknowledged(value: Record<string, unknown>): DispatchAcknowledged | undefined {
  const schemaVersion = asNumber(value.schemaVersion);
  // The first entries written carried the id as `dispatchId`; they stay readable.
  const itemId = asString(value.itemId) ?? asString(value.dispatchId);
  const acknowledgedAt = asString(value.acknowledgedAt);
  if (schemaVersion === undefined || itemId === undefined || acknowledgedAt === undefined) {
    return undefined;
  }
  const note = asString(value.note);
  if (value.note !== undefined && note === undefined) return undefined;
  return {
    event: 'acknowledged',
    schemaVersion,
    itemId,
    acknowledgedAt,
    ...(note === undefined ? {} : { note }),
  };
}

/** Returns `undefined` for anything that does not fully satisfy one entry shape. */
export function parseDispatchEntry(value: unknown): DispatchEntry | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.event) {
    case 'opened':
      return parseOpened(value);
    case 'closed':
      return parseClosed(value);
    case 'refused':
      return parseRefusedEntry(value);
    case 'orchestrator':
      return parseOrchestrator(value);
    case 'acknowledged':
      return parseAcknowledged(value);
    default:
      return undefined;
  }
}
