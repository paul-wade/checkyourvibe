/**
 * The mapping from an agent id to the command line that runs it once and exits
 * (spec 0011 Requirements 1.1, 1.2, 9.1).
 *
 * A `LaneDeclaration` names an `agentId` and, per task kind, an ordering of
 * model names. Neither is a command: the scheduler chooses a lane and a model
 * and has nothing to spawn. This module is that missing step, and it is a table
 * so that adding an executor is one entry here — the scheduler, the dispatch
 * record, and the localhost view are untouched by it.
 *
 * Three properties every entry holds to:
 *
 * - The invocation is non-interactive and ends by itself. Each was read from
 *   that CLI's own `--help` rather than assumed.
 * - The model reaches the CLI verbatim, as the lane's author wrote it in the
 *   ordering. The core does not translate, alias, or rank a model name
 *   (Requirement 8.3).
 * - The prompt travels either in a file the core wrote or on standard input.
 *   It is never an argument, because a batch-shimmed CLI on Windows is launched
 *   through the command interpreter (`program.ts`), which would re-parse any
 *   text placed in the argument list.
 *
 * `detectsRateLimit` lives here for the reason `child.ts` gives for not
 * implementing it: a vendor's rate-limit wording is that vendor's, so it
 * belongs beside that vendor's command line and nowhere else.
 */
import type { ChildObservation } from './child.js';

/** What one attempt needs to know to build a command line. */
export interface ExecutorInvocation {
  /** The directory the executor runs in, which is the repository root. */
  cwd: string;
  /** The model requested, from the lane's own ordering for the task kind. */
  model: string;
  /** Absolute path of the file holding this dispatch's prompt. */
  promptPath: string;
  /** The prompt itself, for a CLI that reads it from standard input. */
  prompt: string;
  /**
   * How long the dispatch allows this attempt, when it bounds it at all.
   *
   * A CLI with a wait of its own needs telling, or its default decides the
   * run: every antigravity dispatch this repository made ended at five
   * minutes and four seconds with "timeout waiting for response", against
   * briefs written for an hour's work.
   */
  timeoutMs?: number;
}

/** One CLI's arguments and standard input for one attempt. */
export interface AgentLaunch {
  args: readonly string[];
  /** Written to the child's standard input, where the CLI takes its prompt there. */
  stdin?: string;
}

export interface AgentCommandSpec {
  /** The `AgentPlugin.id` a lane names in `agentId`. */
  agentId: string;
  /** The program name, looked up on `PATH`. */
  program: string;
  /** One line naming the non-interactive invocation, for `cyv dispatch --agents`. */
  invocation: string;
  build: (invocation: ExecutorInvocation) => AgentLaunch;
  /** Whether this executor surfaced an explicit rate-limit error (Requirement 3.3). */
  detectsRateLimit: (observation: ChildObservation) => boolean;
}

/**
 * Wording that names a limit the vendor imposed, as distinct from a limit the
 * core imposed. Matched case-insensitively against both output streams.
 */
function mentions(observation: ChildObservation, phrases: readonly string[]): boolean {
  const text = `${observation.stdout}\n${observation.stderr}`.toLowerCase();
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * Phrases shared by the CLIs here. Each vendor keeps its own list so a wording
 * one of them changes does not silently alter what another is judged by.
 */
const COMMON_RATE_LIMIT_PHRASES: readonly string[] = [
  'rate limit',
  'rate-limited',
  'too many requests',
  'usage limit',
  'quota exceeded',
  // Observed from `agy` on 2026-09-08: "Individual quota reached. Please
  // upgrade your subscription to increase your limits. Resets in 25m25s."
  // Matched nothing here, so two dispatches into an exhausted lane were
  // recorded as ordinary failures and the lane was never marked.
  'quota reached',
  '429',
];

const CLAUDE_CODE: AgentCommandSpec = {
  agentId: 'claude-code',
  program: 'claude',
  invocation:
    'claude --model <model> --permission-mode acceptEdits --permission-prompts none -p, with the prompt on stdin',
  build: ({ model, prompt }) => ({
    args: [
      '--model',
      model,
      // `bypassPermissions` skips PreToolUse hooks entirely, which disables cyv's
      // own gate inside the agents cyv spawns. Probed 2026-09-07: under
      // `acceptEdits` the hook fires and a deny blocks the write; under
      // `bypassPermissions` it never runs. `--permission-prompts none` keeps the
      // session unattended, so nothing stalls waiting for an approval.
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '-p',
    ],
    stdin: prompt,
  }),
  detectsRateLimit: (observation) =>
    mentions(observation, [...COMMON_RATE_LIMIT_PHRASES, 'limit reached']),
};

const CODEX: AgentCommandSpec = {
  agentId: 'codex',
  program: 'codex',
  invocation:
    'codex exec --model <model> --sandbox danger-full-access --skip-git-repo-check -, ' +
    'with the prompt on stdin',
  build: ({ cwd, model, prompt }) => ({
    args: [
      'exec',
      '--model',
      model,
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-C',
      cwd,
      '-',
    ],
    stdin: prompt,
  }),
  detectsRateLimit: (observation) =>
    mentions(observation, [...COMMON_RATE_LIMIT_PHRASES, 'you have hit your usage limit']),
};

/**
 * `-p` is what puts this CLI in headless mode and it requires a value, which
 * its own help describes as appended to whatever arrived on standard input.
 * The value is this fixed sentence and never the dispatch's own text, so the
 * prompt stays out of the argument list.
 */
const GEMINI_HEADLESS_DIRECTIVE = 'Carry out the instructions supplied on standard input.';

const GEMINI: AgentCommandSpec = {
  agentId: 'gemini',
  program: 'gemini',
  invocation:
    'gemini --model <model> --skip-trust --approval-mode yolo -p <directive>, ' +
    'with the prompt on stdin',
  build: ({ model, prompt }) => ({
    args: [
      '--model',
      model,
      '--skip-trust',
      '--approval-mode',
      'yolo',
      '-p',
      GEMINI_HEADLESS_DIRECTIVE,
    ],
    stdin: prompt,
  }),
  detectsRateLimit: (observation) =>
    mentions(observation, [...COMMON_RATE_LIMIT_PHRASES, 'resource_exhausted']),
};

/**
 * `--print` puts this CLI in headless mode and its value is the prompt. Its
 * own help gives no flag that reads the prompt from a file or from standard
 * input, and a run given the text on standard input replies that no
 * instructions were detected. So the value is this sentence with the path of
 * the file the core wrote appended, and the dispatch's own text stays in that
 * file rather than reaching the argument list.
 */
function antigravityDirective(promptPath: string): string {
  return `Read the file ${promptPath} and carry out the instructions it contains.`;
}

/**
 * The share of a dispatch's own deadline a CLI's internal wait is given.
 *
 * Below it, so the CLI reaches its own timeout and exits with whatever it
 * produced, rather than being killed mid-write by the executor's deadline.
 */
const CLI_WAIT_SHARE = 0.9;

/** A Go duration, which is what `agy --print-timeout` parses. */
function goDuration(ms: number): string {
  const seconds = Math.max(1, Math.round((ms * CLI_WAIT_SHARE) / 1000));
  return `${seconds}s`;
}

/**
 * `--print-timeout` defaults to five minutes, which bounded every dispatch
 * this repository ran on this lane regardless of the deadline the dispatch
 * declared. It is now derived from that deadline.
 */
const ANTIGRAVITY: AgentCommandSpec = {
  agentId: 'antigravity',
  program: 'agy',
  invocation:
    'agy --model <model> --dangerously-skip-permissions --add-dir <repo root> ' +
    '[--print-timeout <90% of the dispatch deadline>] --print <directive naming the prompt file>',
  build: ({ cwd, model, promptPath, timeoutMs }) => ({
    args: [
      '--model',
      model,
      '--dangerously-skip-permissions',
      '--add-dir',
      cwd,
      ...(timeoutMs === undefined ? [] : ['--print-timeout', goDuration(timeoutMs)]),
      '--print',
      antigravityDirective(promptPath),
    ],
  }),
  detectsRateLimit: (observation) =>
    mentions(observation, [...COMMON_RATE_LIMIT_PHRASES, 'resource_exhausted']),
};

const DEVIN: AgentCommandSpec = {
  agentId: 'devin',
  program: 'devin',
  invocation:
    'devin --model <model> --permission-mode dangerous --respect-workspace-trust false ' +
    '--prompt-file <file> -p',
  build: ({ model, promptPath }) => ({
    args: [
      '--model',
      model,
      '--permission-mode',
      'dangerous',
      '--respect-workspace-trust',
      'false',
      '--prompt-file',
      promptPath,
      '-p',
    ],
  }),
  detectsRateLimit: (observation) =>
    mentions(observation, [...COMMON_RATE_LIMIT_PHRASES, 'out of credits']),
};

/**
 * Every agent this build knows how to invoke.
 *
 * A lane whose `agentId` is absent from this list has no command line, and
 * `cyv dispatch` refuses before scheduling rather than discovering it with a
 * dispatch record already open.
 */
export const AGENT_COMMANDS: readonly AgentCommandSpec[] = [
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  DEVIN,
  GEMINI,
];

export function agentCommandFor(agentId: string): AgentCommandSpec | undefined {
  return AGENT_COMMANDS.find((spec) => spec.agentId === agentId);
}

export function knownAgentIds(): string[] {
  return AGENT_COMMANDS.map((spec) => spec.agentId);
}
