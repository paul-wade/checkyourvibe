/**
 * Dashboard state store: the persistence layer for facts that belong solely
 * to the dashboard and have no other owner in the system.
 *
 * Stores exactly four things (Requirement 5.2):
 *   1. Session registry — which orchestrator sessions exist, per project.
 *   2. Card-to-session assignment — mutual exclusion so one card cannot be
 *      held by two sessions, and one working tree cannot host two sessions.
 *   3. Spec and task edit locks — mutual exclusion for dashboard editing
 *      (Requirement 4.3).
 *   4. Quota state per lane — whether a lane subscription is exhausted
 *      and when it resets (Requirement 6.1).
 *
 * Nothing else is stored here. Dispatch records, comments, lane declarations,
 * and spec content already have owners (Requirement 5.3).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STATE_DIR = '.cyv-review';
const STATE_FILENAME = 'dashboard-state.json';

export function stateStorePath(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, STATE_FILENAME);
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/** The lifecycle states an orchestrator session can be in. */
export type SessionState = 'idle' | 'running' | 'paused' | 'stopped';

/** One entry in the session registry. */
export interface SessionEntry {
  /** Absolute path to the project root this session operates in. */
  projectRoot: string;
  /** The agentId of the CLI lane this session runs. */
  agentId: string;
  state: SessionState;
  /** ISO 8601 timestamp of the most recent resume. */
  lastResumedAt: string;
}

// ---------------------------------------------------------------------------
// Card-to-session assignment
// ---------------------------------------------------------------------------

/** Tracks which session currently holds a given card. */
export interface CardAssignment {
  /** Session id that holds this card. */
  sessionId: string;
  /** Absolute path to the working tree the session is using. */
  workingTree: string;
}

// ---------------------------------------------------------------------------
// Edit locks
// ---------------------------------------------------------------------------

/** Tracks who holds an edit lock on a spec or task file. */
export interface EditLock {
  /** Opaque string identifying the lock holder (e.g. a session id or user token). */
  holder: string;
  /** ISO 8601 timestamp when the lock was acquired. */
  acquiredAt: string;
}

// ---------------------------------------------------------------------------
// Quota state
// ---------------------------------------------------------------------------

/** Tracks whether a lane quota is currently exhausted. */
export interface QuotaEntry {
  exhausted: boolean;
  /**
   * ISO 8601 timestamp when the quota resets. Present whenever exhausted
   * is true; absent when the lane is not blocked.
   */
  resetsAt?: string;
}

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/**
 * The full contents of the state file. All collections are keyed objects so
 * they serialise to JSON without losing key identity.
 */
export interface DashboardState {
  /** Keyed by session id. */
  sessions: { [sessionId: string]: SessionEntry };
  /** Keyed by card id (task id). */
  cardAssignments: { [cardId: string]: CardAssignment };
  /**
   * Working-tree index: maps an absolute working-tree path to the session
   * that currently occupies it. Kept in sync with cardAssignments so the
   * mutual-exclusion check can be done in one lookup without scanning all
   * assignments.
   */
  workingTrees: { [workingTree: string]: string };
  /** Keyed by file path (repo-relative or absolute). */
  editLocks: { [filePath: string]: EditLock };
  /** Keyed by lane id. */
  quotas: { [laneId: string]: QuotaEntry };
  /** Dockview serialized layout. */
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is { [k: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseSessionState(value: unknown): SessionState | undefined {
  if (
    value === 'idle' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'stopped'
  ) {
    return value;
  }
  return undefined;
}

function parseSessionEntry(value: unknown): SessionEntry | undefined {
  if (!isObject(value)) return undefined;
  const projectRoot = asString(value.projectRoot);
  const agentId = asString(value.agentId);
  const state = parseSessionState(value.state);
  const lastResumedAt = asString(value.lastResumedAt);
  if (
    projectRoot === undefined ||
    agentId === undefined ||
    state === undefined ||
    lastResumedAt === undefined
  ) {
    return undefined;
  }
  return { projectRoot, agentId, state, lastResumedAt };
}

function parseCardAssignment(value: unknown): CardAssignment | undefined {
  if (!isObject(value)) return undefined;
  const sessionId = asString(value.sessionId);
  const workingTree = asString(value.workingTree);
  if (sessionId === undefined || workingTree === undefined) return undefined;
  return { sessionId, workingTree };
}

function parseEditLock(value: unknown): EditLock | undefined {
  if (!isObject(value)) return undefined;
  const holder = asString(value.holder);
  const acquiredAt = asString(value.acquiredAt);
  if (holder === undefined || acquiredAt === undefined) return undefined;
  return { holder, acquiredAt };
}

function parseQuotaEntry(value: unknown): QuotaEntry | undefined {
  if (!isObject(value)) return undefined;
  const exhausted = asBoolean(value.exhausted);
  if (exhausted === undefined) return undefined;
  const resetsAt = asString(value.resetsAt);
  return resetsAt === undefined ? { exhausted } : { exhausted, resetsAt };
}

function parseStringKeyed<T>(
  value: unknown,
  parseEntry: (v: unknown) => T | undefined,
): { [k: string]: T } | undefined {
  if (!isObject(value)) return undefined;
  const result: { [k: string]: T } = {};
  for (const [k, v] of Object.entries(value)) {
    const parsed = parseEntry(v);
    if (parsed === undefined) return undefined;
    result[k] = parsed;
  }
  return result;
}

/**
 * Parse a stored JSON value into a DashboardState. Returns null if any
 * required field is missing or malformed. A missing file returns an empty
 * state (see readState), not null.
 */
export function parseDashboardState(value: unknown): DashboardState | null {
  if (!isObject(value)) return null;

  const sessions = parseStringKeyed(value.sessions, parseSessionEntry);
  if (sessions === undefined) return null;

  const cardAssignments = parseStringKeyed(value.cardAssignments, parseCardAssignment);
  if (cardAssignments === undefined) return null;

  const workingTrees = parseStringKeyed(value.workingTrees, asString);
  if (workingTrees === undefined) return null;

  const editLocks = parseStringKeyed(value.editLocks, parseEditLock);
  if (editLocks === undefined) return null;

  const quotas = parseStringKeyed(value.quotas, parseQuotaEntry);
  if (quotas === undefined) return null;

  return { sessions, cardAssignments, workingTrees, editLocks, quotas };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function emptyState(): DashboardState {
  return {
    sessions: {},
    cardAssignments: {},
    workingTrees: {},
    editLocks: {},
    quotas: {},
  };
}

function hasCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasCode(err) && err.code === 'ENOENT';
}

/**
 * Write the state atomically: write a temp file then rename into place so a
 * crash mid-write never leaves a partially-written record.
 */
async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, contents, 'utf-8');
  await rename(temp, target);
}

/**
 * Read the current state from disk. Returns an empty state when no file has
 * been written yet; throws only for unexpected I/O errors.
 */
export async function readState(repoRoot: string): Promise<DashboardState> {
  const path = stateStorePath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return emptyState();
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }

  return parseDashboardState(parsed) ?? emptyState();
}

/** Persist state to disk. */
export async function writeState(repoRoot: string, state: DashboardState): Promise<void> {
  await writeAtomic(stateStorePath(repoRoot), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Session registry mutations
// ---------------------------------------------------------------------------

/** Register a new session. Replaces any existing entry with the same id. */
export async function registerSession(
  repoRoot: string,
  sessionId: string,
  entry: SessionEntry,
): Promise<void> {
  const state = await readState(repoRoot);
  state.sessions[sessionId] = entry;
  await writeState(repoRoot, state);
}

/** Remove a session from the registry. No-op if the session does not exist. */
export async function unregisterSession(repoRoot: string, sessionId: string): Promise<void> {
  const state = await readState(repoRoot);
  delete state.sessions[sessionId];
  await writeState(repoRoot, state);
}

// ---------------------------------------------------------------------------
// Card-to-session claim
// ---------------------------------------------------------------------------

/** Returned by a successful claim. */
export interface ClaimSuccess {
  claimed: true;
}

/** Returned when a claim fails because the resource is already held. */
export interface ClaimFailure {
  claimed: false;
  /** The current holder of the resource. */
  holder: string;
}

export type ClaimResult = ClaimSuccess | ClaimFailure;

/**
 * Attempt to assign sessionId to cardId.
 *
 * Fails (returns ClaimFailure) if:
 * - cardId is already held by a different session, or
 * - workingTree is already occupied by a different session.
 *
 * Succeeds only when neither is already claimed. Re-claiming the same card
 * by the same session also succeeds, refreshing the working-tree binding.
 */
export async function claimCard(
  repoRoot: string,
  cardId: string,
  sessionId: string,
  workingTree: string,
): Promise<ClaimResult> {
  const state = await readState(repoRoot);

  const existing = state.cardAssignments[cardId];
  if (existing !== undefined && existing.sessionId !== sessionId) {
    return { claimed: false, holder: existing.sessionId };
  }

  const treeOwner = state.workingTrees[workingTree];
  if (treeOwner !== undefined && treeOwner !== sessionId) {
    return { claimed: false, holder: treeOwner };
  }

  state.cardAssignments[cardId] = { sessionId, workingTree };
  state.workingTrees[workingTree] = sessionId;
  await writeState(repoRoot, state);
  return { claimed: true };
}

/**
 * Release a card assignment previously made by sessionId.
 * No-op if cardId is not held or is held by a different session.
 */
export async function releaseCard(
  repoRoot: string,
  cardId: string,
  sessionId: string,
): Promise<void> {
  const state = await readState(repoRoot);
  const existing = state.cardAssignments[cardId];
  if (existing === undefined || existing.sessionId !== sessionId) return;
  delete state.workingTrees[existing.workingTree];
  delete state.cardAssignments[cardId];
  await writeState(repoRoot, state);
}

// ---------------------------------------------------------------------------
// Edit-lock claim
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire an edit lock on filePath for holder.
 *
 * Fails when the lock is already held by a different holder.
 * Re-claiming by the same holder refreshes the acquiredAt timestamp.
 */
export async function claimEditLock(
  repoRoot: string,
  filePath: string,
  holder: string,
): Promise<ClaimResult> {
  const state = await readState(repoRoot);
  const existing = state.editLocks[filePath];
  if (existing !== undefined && existing.holder !== holder) {
    return { claimed: false, holder: existing.holder };
  }
  state.editLocks[filePath] = { holder, acquiredAt: new Date().toISOString() };
  await writeState(repoRoot, state);
  return { claimed: true };
}

/**
 * Release an edit lock previously acquired by holder.
 * No-op if the lock does not exist or is held by someone else.
 */
export async function releaseEditLock(
  repoRoot: string,
  filePath: string,
  holder: string,
): Promise<void> {
  const state = await readState(repoRoot);
  const existing = state.editLocks[filePath];
  if (existing === undefined || existing.holder !== holder) return;
  delete state.editLocks[filePath];
  await writeState(repoRoot, state);
}

// ---------------------------------------------------------------------------
// Quota state
// ---------------------------------------------------------------------------

/**
 * Record that a lane quota is exhausted and note when it resets.
 */
export async function markQuotaExhausted(
  repoRoot: string,
  laneId: string,
  resetsAt: string,
): Promise<void> {
  const state = await readState(repoRoot);
  state.quotas[laneId] = { exhausted: true, resetsAt };
  await writeState(repoRoot, state);
}

/**
 * Record that a lane quota has been restored (e.g. after the reset time has
 * passed and the lane is unblocked).
 */
export async function markQuotaRestored(repoRoot: string, laneId: string): Promise<void> {
  const state = await readState(repoRoot);
  state.quotas[laneId] = { exhausted: false };
  await writeState(repoRoot, state);
}

/**
 * Read the quota state for a lane.
 *
 * Returns { exhausted: false } when no entry exists, because an absent
 * record and a non-exhausted record are equivalent from the callers point of
 * view.
 */
export async function readQuota(repoRoot: string, laneId: string): Promise<QuotaEntry> {
  const state = await readState(repoRoot);
  return state.quotas[laneId] ?? { exhausted: false };
}
