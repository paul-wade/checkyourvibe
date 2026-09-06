/**
 * Every shape the dashboard page renders (spec 0040 Decision 8).
 *
 * Readers under `dashboard/` produce these from disk and git; `home.ts`
 * consumes them and reads nothing. Nothing here is a live reading of any
 * vendor account: a lane's `running` and `cap` are the core's own count against
 * a declared number, and a self-report is exactly that.
 */
import type { LaneCooldown, LaneModelOffering } from '../executor/lane.js';
import type { DispatchOutcomeKind } from '../executor/outcome.js';
import type { TaskKind } from '../executor/task-kind.js';

/** How a number on the page was obtained. Rendered beside it, never inferred by the reader. */
export type Evidence = 'measured' | 'recorded' | 'unknown';

/** The last `cyv check`, from `.cyv-review/latest-run.json`. */
export type CheckIndicator =
  | { state: 'never' }
  | { state: 'running'; startedAt: string; mode: string }
  | {
      state: 'finished';
      findings: number;
      filesChecked: number;
      finishedAt: string;
      mode: string;
      evidence: Evidence;
    };

export type NeedsYouKind =
  /** A closed dispatch whose outcome needs a person (0011 R10.4). */
  | 'dispatch'
  /** An open dispatch judged abandoned or undetermined (0036 R7.4). */
  | 'liveness'
  /** Open work, a free lane, and nothing dispatched for the interval (0036 R4). */
  | 'stall'
  /** An owner-authored note nobody has addressed. */
  | 'note'
  /** An owner note the agent's cursor has not reached (0042 R3.2). */
  | 'unread-note'
  /** A task whose `_Exec:` names `executor=user`. */
  | 'task'
  /** A roadmap entry marked blocked. */
  | 'blocked';

/**
 * One answer a person can give from the page. `tell` prefills the exchange
 * box so the reply reaches the agent through `cyv comments`; `dismiss` records
 * that the item was seen and needs nothing; `close` closes an abandoned
 * record; `addressed` marks the person's own note; `open` goes to the document.
 */
export type NeedsYouAction =
  | { kind: 'tell'; label: string; prefill: string; task?: string }
  | { kind: 'dismiss'; label: string; itemId: string }
  | { kind: 'close'; label: string; dispatchId: string }
  | { kind: 'addressed'; label: string; commentId: number }
  | { kind: 'open'; label: string; href: string };

export interface NeedsYouItem {
  kind: NeedsYouKind;
  /** A task id, a dispatch id, `#12` for a note, or a spec number. */
  id: string;
  /** What happened, in one line. */
  title: string;
  /** The decision being asked for, as a question a person can answer. */
  question: string;
  /** Evidence lines under the question: rejections, the note's text, the task's brief. */
  detail?: readonly string[];
  /** Where it is: the spec, the lane, or `your note, unaddressed`. */
  where: string;
  /** Repo-relative page path, including the project query. */
  href: string;
  /** ISO 8601, where the item has a time; used to pick the newest. */
  at?: string;
  actions: readonly NeedsYouAction[];
}

export type Liveness = 'live' | 'abandoned' | 'undetermined';

export interface RunningDispatch {
  dispatchId: string;
  workId: string;
  attempt: number;
  /** First line of the task text. */
  task: string;
  /** A `T\d+` id found in the task text, where there is one. */
  taskId?: string;
  taskKind: TaskKind;
  laneId: string;
  model: string;
  orchestrator: boolean;
  openedAt: string;
  liveness: Liveness;
  /** One line: what the judgement rests on. */
  livenessReason: string;
  /** Whether the stop control is offered; false carries `stopRefusal`. */
  canStop: boolean;
  stopRefusal?: string;
  ownedPaths: readonly string[];
}

export interface NextTask {
  id: string;
  title: string;
  specId: string;
  /** The lane the `_Exec:` line names, or `unknown`. */
  executor: string;
  kind: string;
  files: readonly string[];
  /** Tasks this one names as dependencies that are still open. Empty means unblocked. */
  blockedBy: readonly string[];
  /** 1 for the first wave; tasks sharing a wave can run at once. 0 when blocked. */
  wave: number;
  /**
   * The latest dispatch naming this task succeeded and the task is still
   * unchecked in tasks.md. It is finished work waiting to be ticked, not work
   * to start.
   */
  landed?: boolean;
}

export interface FinishedDispatch {
  dispatchId: string;
  workId: string;
  attempt: number;
  task: string;
  taskId?: string;
  laneId: string;
  model: string;
  outcome: DispatchOutcomeKind;
  summary: string;
  failedGates: readonly string[];
  closedAt: string;
  /** Whether `needsHumanAttention` holds for the outcome. */
  needsPerson: boolean;
}

export interface ActiveSpec {
  id: string;
  /** `0037-one-dashboard` rendered as `0037 · one dashboard`. */
  name: string;
  done: number;
  total: number;
  /** Repo-relative path to its tasks.md. */
  tasksPath: string;
}

export interface StallSignal {
  /** Lanes free, below cap, not cooling, accepting dispatch. */
  idleLanes: readonly string[];
  /** ISO 8601 of the last opened dispatch, or absent when none was ever opened. */
  lastOpenedAt?: string;
  intervalMinutes: number;
}

export interface TouchedFile {
  name: string;
  /** ISO 8601; absent when the file could not be stat'ed. */
  touchedAt?: string;
}

export interface UncommittedWork {
  count: number;
  added: number;
  removed: number;
  /** Most recently touched first. */
  named: readonly TouchedFile[];
  moreCount: number;
}

export interface MotionRegion {
  spec?: ActiveSpec;
  running: readonly RunningDispatch[];
  next: readonly NextTask[];
  finished: readonly FinishedDispatch[];
  stall?: StallSignal;
  uncommitted: UncommittedWork;
  /** Lines in the dispatch log no entry shape accepted. */
  unparseableLines: number;
}

export type LaneState = 'free' | 'busy' | 'cooling' | 'unavailable' | 'reserved';

export type OrchestratorHealth = 'healthy' | 'degraded' | 'exhausted';

/** What the orchestrating session last said about itself (0036 R3). */
export interface OrchestratorSelfReport {
  state: OrchestratorHealth;
  reason?: string;
  model?: string;
  at: string;
}

export interface LaneRow {
  id: string;
  agentId: string;
  orchestrator: boolean;
  acceptsDispatch: boolean;
  state: LaneState;
  running: number;
  cap: number;
  billing: string;
  cooldown?: LaneCooldown;
  /** Where the program resolved, or absent with `programTried` naming what was looked for. */
  programPath?: string;
  programTried: readonly string[];
  /** Present on the orchestrating lane only. Absent means unknown, and unknown is shown. */
  selfReport?: OrchestratorSelfReport;
  models: readonly LaneModelOffering[];
}

export interface UnusedAgent {
  agentId: string;
  program: string;
  programPath: string;
}

export interface LanesRegion {
  lanes: readonly LaneRow[];
  unused: readonly UnusedAgent[];
  /** True when the configuration declares no lane at all. */
  none: boolean;
}

export interface ExchangeEntry {
  id: number;
  author: string;
  /** From recorded authorship: the entry was written by the tool. */
  isAgent: boolean;
  kind: 'note' | 'turn';
  body: string;
  /** Epoch milliseconds. */
  created: number;
  file?: string;
  anchor?: string;
  task?: string;
  replyTo?: number;
  status: 'open' | 'addressed';
  /**
   * Whether the agent's cursor is past this note (spec 0042 Requirement 3.1).
   *
   * Absent on the tool's own turns, where the question does not arise. Read is
   * established by the cursor and nothing else: a note delivered and then
   * ignored is read, because it was (Requirement 3.3).
   */
  readByAgent?: boolean;
  /** Milliseconds this note has been unread. Absent once it has been read. */
  unreadForMs?: number;
}

export interface ExchangeRegion {
  /** Newest first, at most `shown`. */
  entries: readonly ExchangeEntry[];
  total: number;
  omitted: number;
}

export interface ProjectOption {
  root: string;
  name: string;
  reachable: boolean;
  /** Why it is not reachable: the directory is gone, or it has no configuration. */
  unreachableReason?: string;
  needsCount?: number;
  inFlight?: number;
}

export interface DiffInstanceState {
  id: string;
  label: string;
  port: number;
  up: boolean;
  description: string;
  /** Found running on one of difit's own default ports, started outside the dashboard. */
  external?: boolean;
}

export interface DiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  additions: number;
  deletions: number;
  filesCount: number;
  files: readonly DiffFileSummary[];
}

export interface ExecutionHistoryItem {
  id: string;
  task: string;
  laneId: string;
  model: string;
  durationMs?: number;
  outcome: DispatchOutcomeKind | 'out-of-scope-write' | 'passed';
  finishedAt: string;
}

export interface HomePage {
  project: { root: string; name: string };
  projects: readonly ProjectOption[];
  check: CheckIndicator;
  needsYou: readonly NeedsYouItem[];
  motion: MotionRegion;
  lanes: LanesRegion;
  exchange: ExchangeRegion;
  diffSummary?: DiffSummary;
  executionHistory?: readonly ExecutionHistoryItem[];
  /** Epoch milliseconds the page was built; ages are computed against it. */
  now: number;
}
