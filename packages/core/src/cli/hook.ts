/**
 * `cyv hook <agent-id>` — the layer that runs inside an agent's tool loop.
 * Two hook events arrive here, and they are different jobs:
 *
 * - `PreToolUse` is the gate. It fires before the tool runs, so the proposed
 *   change lives in the payload rather than on disk. For an edit tool the
 *   intended file content is reproduced — read from `tool_input.content` for
 *   a write, computed by applying the proposed edits to the current file for
 *   an edit — and materialized to a temporary file inside the repository so
 *   the one check pipeline can judge it. A violation is answered with the
 *   structured decision protocol on stdout (`permissionDecision: "deny"`,
 *   the remediation guidance as the reason), which is what actually stops
 *   the call. A `Bash` command is never content-checked — the content is
 *   unknowable until the command runs — so its write targets are extracted
 *   instead, and one that a configured analyzer claims is denied with a
 *   pointer back to the edit tools.
 * - `PostToolUse` (and `Stop`) stay advisory: the write already landed and
 *   nothing can be denied, so the plugin's `formatResult` reports what was
 *   found. Enforcement and evidence are different jobs and both are wanted.
 *
 * The one rule everything below obeys: never turn an unexpected failure into
 * a blocked call. A vendor changing its hook payload schema, a plugin that
 * won't load, a missing or invalid config, an analyzer that crashes, a shell
 * command too tangled to classify — every one of those degrades to "allow,
 * and record why" (exit 0), never to a denial the hook could not justify.
 * The only non-zero exit this command ever produces is the one the resolved
 * agent plugin's `formatResult` may return for real violations on the
 * post-tool path.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Command, CommandContext } from './types.js';
import { findConfig, loadConfig } from '../config/load.js';
import { isUnknownArray } from '../guards.js';
import { runCheck } from '../run/check.js';
import { repoRoot } from '../run/discover.js';
import { routeFiles } from '../run/route.js';
import { loadAnalyzers } from '../registry/load.js';
import { partitionViolations, readBaseline } from '../baseline/index.js';
import { ownsPath, nearestDeclaredPath, claimsWholeRepository } from '../executor/ownership.js';
import type { AgentPlugin, AgentSurface, HookPayload, SkippedFile, Violation } from '../protocol/index.js';
import { tmpdir } from 'node:os';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(message: string): void {
  process.stderr.write(`cyv hook: ${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isAgentSurface(value: unknown): value is AgentSurface {
  return (
    value === 'hook' ||
    value === 'instructions' ||
    value === 'guidance' ||
    value === 'mcp' ||
    value === 'executor'
  );
}

function isAgentPlugin(value: unknown): value is AgentPlugin {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.detect !== 'function' ||
    typeof value.plan !== 'function' ||
    typeof value.parseHookPayload !== 'function' ||
    typeof value.formatResult !== 'function'
  ) {
    return false;
  }

  if (!isUnknownArray(value.surfaces)) {
    return false;
  }

  for (let i = 0; i < value.surfaces.length; i++) {
    const surface: unknown = value.surfaces[i];
    if (!isAgentSurface(surface)) {
      return false;
    }
  }

  return true;
}

/**
 * Dynamic import via a variable (rather than a string literal) so TypeScript
 * treats the specifier as opaque instead of trying to resolve it at compile
 * time — the same technique `registry/load.ts` and `run/execute.ts` use to
 * load analyzer modules that aren't declared dependencies of this package.
 */
async function importModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

/**
 * `@checkyourvibe/adapter-claude-code` is a sibling package, not a dependency
 * of core (that direction would be backwards — adapters depend on core, not
 * the reverse). The bare specifier resolves once the workspace has it linked
 * into `node_modules`; until then, or in any environment where that lookup fails
 * for some other reason, fall back to the sibling package's own build
 * output, located relative to this file. `packages/core/{src,dist}/cli/` and
 * `packages/adapter-claude-code/dist/` sit at the same depth under
 * `packages/`, so the same relative path resolves correctly whether this
 * module is running from source (test runs) or from `dist` (the shipped CLI).
 */
async function loadClaudeCodePlugin(): Promise<AgentPlugin> {
  const packageSpecifier = '@checkyourvibe/adapter-claude-code';

  let mod: unknown;
  try {
    mod = await importModule(packageSpecifier);
  } catch {
    const fallbackUrl = new URL('../../../adapter-claude-code/dist/index.js', import.meta.url);
    mod = await importModule(fallbackUrl.href);
  }

  if (!isRecord(mod) || !('default' in mod) || !isAgentPlugin(mod.default)) {
    throw new Error('@checkyourvibe/adapter-claude-code has no valid default AgentPlugin export.');
  }

  return mod.default;
}

async function resolvePlugin(agentId: string): Promise<AgentPlugin | undefined> {
  if (agentId === 'claude-code') {
    return loadClaudeCodePlugin();
  }
  return undefined;
}

/**
 * Run the one check pipeline (`run/check.ts`), scoped to what the agent's
 * hook payload named.
 *
 * `scope: 'files'` (or absent, for plugins written before `scope` existed)
 * means the payload named exact files, so this runs `files` mode against
 * them. `scope: 'working-tree'` means it did not — some agents' hook
 * payloads carry no path at all — so this runs `working` mode instead,
 * which diffs the working tree via git the same way `cyv check --working`
 * does. See `protocol/agent.ts` for why both cases exist.
 */
/**
 * Append one edit's outcome to the observation log.
 *
 * Observing exists to measure how often an edit introduces a violation without
 * changing what the agent does. Clean edits are recorded too: a rate needs a
 * denominator, and a log holding only failures cannot say whether one violation
 * came from three edits or three hundred.
 *
 * The sequence number is the count of edits observed so far in this repository,
 * so findings can be binned by how far into a session they happened — the
 * question of whether a rule read once at the start still holds at edit fifty.
 */
async function recordObservation(
  repoRoot: string,
  payload: HookPayload,
  violations: Violation[],
  report: { filesChecked: number; skipped: readonly SkippedFile[] },
): Promise<void> {
  const dir = path.join(repoRoot, '.cyv-review');
  const logPath = path.join(dir, 'observations.jsonl');

  let sequence = 1;
  try {
    const existing = await readFile(logPath, 'utf-8');
    sequence = existing.split('\n').filter((line) => line.trim().length > 0).length + 1;
  } catch {
    sequence = 1;
  }

  const entry = {
    at: new Date().toISOString(),
    sequence,
    event: payload.event,
    scope: payload.scope ?? 'files',
    files: payload.files,
    violationCount: violations.length,
    violations: violations.map((v) => ({ ruleId: v.ruleId, file: v.file, line: v.line })),
    // `violationCount: 0` on its own says nothing: the file may have been
    // checked and been clean, or no analyzer may have claimed it, or one may
    // have claimed it and failed. A measurement that cannot tell those apart
    // counts unchecked files as clean ones. Spec 0059 Requirement 2.3: a write
    // cyv cannot classify is reported, not ignored.
    filesChecked: report.filesChecked,
    ...(report.skipped.length === 0
      ? {}
      : { skipped: report.skipped.map((entry) => ({ file: entry.file, reason: entry.reason })) }),
  };

  await mkdir(dir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

async function runPipeline(
  ctx: CommandContext,
  plugin: AgentPlugin,
  payload: HookPayload,
  observe: boolean,
  omitNotFixes: boolean,
): Promise<number> {
  const { report, repoRoot } =
    payload.scope === 'working-tree'
      ? await runCheck({ cwd: ctx.cwd, mode: 'working' })
      : await runCheck({ cwd: ctx.cwd, mode: 'files', paths: payload.files });

  // Nothing an enabled analyzer claims — most edits to most files, most of
  // the time. Staying silent here matters as much as returning 0: a hook that
  // prints on every keystroke trains its user to stop reading it.
  if (report.filesChecked === 0) {
    return 0;
  }

  // Deferred debt is not this edit's problem. A repository that adopted
  // checkyourvibe on an existing codebase has a baseline recording what already
  // failed, and the agent is editing files that carry some of it. Reporting all
  // of it back is the every-edit noise the silence above exists to prevent, and
  // it buries the one finding the agent just introduced under guidance for
  // findings it did not. `install-hooks` already runs the git hook with
  // `--since-baseline` for the same reason; this is that rule applied to the
  // agent hook, which had been reporting against the whole file.
  //
  // With no baseline every violation is fresh, so this is a no-op until one is
  // recorded.
  const baseline = await readBaseline(repoRoot);
  const violations =
    baseline === null ? report.violations : partitionViolations(report.violations, baseline).fresh;

  // Observing never speaks and never blocks. Anything written here would reach
  // the agent and make this an intervention rather than a measurement.
  if (observe) {
    await recordObservation(repoRoot, payload, violations, report);
    return 0;
  }

  if (violations.length === 0) {
    return 0;
  }

  const result = plugin.formatResult(omitNotFixes ? withoutNotFixes(violations) : violations, {
    files: payload.files,
  });

  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }

  return result.exitCode;
}

/* -------------------------------------------------------------------------
 * PreToolUse — the gate half of the hook.
 *
 * Everything below answers a different question than `runPipeline`: not
 * "what did the write do" but "may this call run at all". The proposed
 * content lives in `tool_input`, so an edit tool's intended result is
 * reproduced — taken directly for `Write`, computed for `Edit`/`MultiEdit` —
 * and checked before the call is allowed to run. A shell command is never
 * content-checked: its output is unknowable until it runs, so only its
 * write targets are classified, and a write that cannot be classified is
 * recorded rather than silently passed (Requirement 2.3).
 * ---------------------------------------------------------------------- */

/**
 * The paths the dispatch this hook is running inside declared it may write.
 *
 * The executor puts them in the environment, so the hook does not have to know
 * which dispatch it belongs to. A session running no dispatch has no such
 * variable and is unconstrained (spec 0063 Requirement 1.2).
 */
function getDispatchDeclaration(env: NodeJS.ProcessEnv): readonly string[] | undefined {
  const raw = env['CYV_DISPATCH_DECLARATION'];
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseJson(raw);
  if (!isUnknownArray(parsed)) return undefined;
  const paths: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') return undefined;
    paths.push(entry);
  }
  return paths;
}

/**
 * A declaration the executor wrote and something corrupted is not a
 * declaration; the caller reads `undefined` and constrains nothing, which is
 * the same answer as no dispatch being in force.
 */
function parseJson(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    return value;
  } catch (malformed) {
    return { malformed: messageFor(malformed) };
  }
}

type OwnershipVerdict = { allowed: false; reason: string } | { allowed: true; rootNote?: string };

/**
 * Whether the dispatch in force may write `rel`, and why not when it may not
 * (spec 0063 Requirement 2). A declaration claiming the repository root
 * constrains nothing and says so rather than passing silently (2.3).
 */
function checkOwnership(rel: string, declaration: readonly string[] | undefined): OwnershipVerdict {
  if (declaration === undefined) {
    return { allowed: true };
  }
  if (claimsWholeRepository(declaration)) {
    return {
      allowed: true,
      rootNote: ' (ownership unconstrained: this dispatch declares the repository root)',
    };
  }
  if (ownsPath(declaration, rel)) {
    return { allowed: true };
  }
  const nearest = nearestDeclaredPath(declaration, rel);
  const nearestMsg = nearest === undefined ? '' : ` The nearest declared path is "${nearest}".`;
  const declared = declaration.map((entry) => `  - ${entry}`).join('\n');
  return {
    allowed: false,
    reason:
      'cyv: out-of-scope write. This dispatch may only write the paths it declared, and ' +
      `"${rel}" is outside them.${nearestMsg}\n\n` +
      `Paths this dispatch may write:\n${declared}\n\n` +
      `Scratch files belong in the system temp directory (${tmpdir()}), never in the ` +
      'repository, where the analyzer checks them and the dispatch snapshot counts them.',
  };
}

/** The answer a `PreToolUse` inspection reaches. */
interface PreVerdict {
  decision: 'deny' | 'allow';
  /** Recorded with the decision; on a deny it is also the text the agent sees. */
  reason?: string;
  /**
   * True when there is nothing worth recording — a read-only tool, or a
   * shell command that writes nothing. Anything that writes, and anything
   * that could not be judged, is always recorded.
   */
  silent?: boolean;
  /** The path the decision concerned, when there is one. */
  target?: string;
  violationCount?: number;
}

/** One entry in `.cyv-review/decisions.jsonl`. */
export interface HookDecisionRecord {
  at: string;
  event: string;
  tool: string;
  decision: 'deny' | 'allow';
  /** False under `--observe`, where the verdict is measured but not enforced. */
  enforced: boolean;
  reason: string;
  target?: string;
  session?: string;
  violationCount?: number;
}

/** Edit tools whose proposed content can be reproduced before it lands. */
const EDIT_TOOLS = new Set(['write', 'edit', 'multiedit']);

/** Tools whose `tool_input` carries a shell command line. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh']);

/** Tools known not to modify a file — allowed without a record entry. */
const QUIET_TOOLS = new Set([
  'read',
  'ls',
  'grep',
  'glob',
  'webfetch',
  'websearch',
  'todoread',
  'todowrite',
  'task',
  'exitplanmode',
  'slashcommand',
  'bashoutput',
  'killshell',
  'askuserquestion',
  'skill',
  'notebookread',
]);

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The bare-guidance variant behind `--omit-notfixes`: rule id, summary, why
 * and allowed fixes are kept; the notFixes section is removed from every
 * violation before the plugin renders it. Stripping happens here rather than
 * in any one plugin so the flag means the same thing for every adapter —
 * they all render whatever `guidance.notFixes` contains.
 */
function withoutNotFixes(violations: readonly Violation[]): Violation[] {
  return violations.map((violation) =>
    violation.guidance === undefined
      ? violation
      : { ...violation, guidance: { ...violation.guidance, notFixes: [] } },
  );
}

/** Events that describe the session lifecycle and must never fail the turn. */
const LIFECYCLE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);

/**
 * Lifecycle events that carry no analysis duty, so recording one is the whole
 * job. `Stop` is deliberately absent: it is also the turn's last checkpoint,
 * where the working tree is analyzed for files a shell command created or
 * moved. `PostToolUse` never sees those. Recording the event must not cost us
 * that check, so `Stop` records and then goes on to analyze.
 */
const LIFECYCLE_ONLY_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SessionEnd']);

/** One entry in the session lifecycle log. */
export interface LifecycleEvent {
  at: string;
  event: string;
  sessionId: string;
  cwd?: string;
  source?: string;
  reason?: string;
  /** The agent whose hook fired, from the invocation. A session observed only
   *  through its hooks has no other record of which CLI it is. */
  agentId?: string;
}

export function lifecycleLogPath(repoRoot: string): string {
  return path.join(repoRoot, '.cyv-review', 'lifecycle.ndjson');
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

export function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (!isRecord(value)) return false;
  if (typeof value.at !== 'string' || value.at.length === 0) return false;
  if (typeof value.event !== 'string' || value.event.length === 0) return false;
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return false;
  return true;
}

export async function readLifecycleEvents(repoRoot: string): Promise<LifecycleEvent[]> {
  const logPath = lifecycleLogPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const events: LifecycleEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      warn(`skipping malformed lifecycle log line: ${messageFor(err)}`);
      continue;
    }
    if (isLifecycleEvent(parsed)) {
      events.push(parsed);
    }
  }
  return events;
}

/**
 * Record a runtime lifecycle event. A write that fails is reported and
 * swallowed: the hook must not block a turn because a log is unwritable.
 */
async function recordLifecycleEvent(
  repoRoot: string,
  envelope: Record<string, unknown>,
  agentId: string | undefined,
): Promise<void> {
  const event = stringField(envelope, 'hook_event_name') ?? 'unknown';
  const sessionId = stringField(envelope, 'session_id') ?? stringField(envelope, 'sessionId') ?? 'unknown';
  const cwd = stringField(envelope, 'cwd');
  const source = stringField(envelope, 'source');
  const reason = stringField(envelope, 'reason');

  const entry: LifecycleEvent = {
    at: new Date().toISOString(),
    event,
    sessionId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(agentId !== undefined && agentId.length > 0 ? { agentId } : {}),
  };

  const logPath = lifecycleLogPath(repoRoot);
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (err) {
    warn(`could not record the lifecycle event for ${sessionId}: ${messageFor(err)}`);
  }
}

/**
 * Repo-relative, forward-slash path for `abs`, or `undefined` when it falls
 * outside `root`. Used for display and for the "inside the repository" check;
 * routing itself uses `routeFiles`' own copy of this logic.
 */
function repoRelative(abs: string, root: string): string | undefined {
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse just enough of the payload to see which event it is. Everything
 * deeper is re-validated where it is used; an unparseable payload falls
 * through to the plugin's own parser, which reports malformed input the same
 * way it always has.
 */
function tryParseHookEnvelope(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function decisionsLogPath(repoRoot: string): string {
  return path.join(repoRoot, '.cyv-review', 'decisions.jsonl');
}

export function isHookDecisionRecord(value: unknown): value is HookDecisionRecord {
  if (!isRecord(value)) return false;
  if (typeof value.at !== 'string' || value.at.length === 0) return false;
  if (typeof value.event !== 'string' || value.event.length === 0) return false;
  if (typeof value.tool !== 'string') return false;
  if (value.decision !== 'deny' && value.decision !== 'allow') return false;
  if (typeof value.enforced !== 'boolean') return false;
  if (typeof value.reason !== 'string') return false;
  return true;
}

/**
 * Every decision the gate has recorded. The gate fails open on its own errors,
 * so this file is the only place an operator can learn that it allowed an edit
 * it could not judge.
 */
export async function readHookDecisions(repoRoot: string): Promise<HookDecisionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(decisionsLogPath(repoRoot), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const decisions: HookDecisionRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      warn(`skipping malformed decision log line: ${messageFor(err)}`);
      continue;
    }
    if (isHookDecisionRecord(parsed)) decisions.push(parsed);
  }
  return decisions;
}

/**
 * Append one pre-tool decision to `.cyv-review/decisions.jsonl`.
 *
 * A log write that fails cannot be allowed to flip the decision it was
 * recording, so a failure here is a warning, never a throw.
 */
async function recordDecision(root: string, entry: HookDecisionRecord): Promise<void> {
  try {
    const dir = path.join(root, '.cyv-review');
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, 'decisions.jsonl'), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (err) {
    warn(`could not record the pre-tool decision: ${messageFor(err)}`);
  }
}

/**
 * Answer a `PreToolUse` call through the structured decision protocol: a JSON
 * object on stdout, exit 0. `permissionDecision` is what the runtime reads;
 * the exit code stays zero because a crash exit is indistinguishable from a
 * broken hook.
 */
function emitPreDecision(decision: 'deny' | 'allow', reason?: string): void {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason !== undefined && reason.length > 0
        ? { permissionDecisionReason: reason }
        : {}),
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

/* ---- Shell command inspection ---------------------------------------- */

/** A token of a shell command, split just far enough to find file writes. */
interface ShellToken {
  kind: 'word' | 'operator';
  text: string;
  /**
   * True where a command name sits: start of input, or right after `;`,
   * a newline, `|`, `&&`, `&`, or a subshell paren.
   */
  commandStart: boolean;
  /** A `$` or backtick outside single quotes — the real value is unknowable without running the command. */
  expansion: boolean;
}

/** Operators that end one command and begin another. */
const COMMAND_SEPARATORS = new Set([';', '\n', '|', '||', '&', '&&', '(', ')']);

/**
 * Redirect operators that open a path for writing. `>&` and `<&` duplicate
 * descriptors rather than naming a file, and `<`/`<<` read — all absent.
 */
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '<>', '&>', '&>>']);

/**
 * The whole redirect family. Used to recognise a bare descriptor number —
 * the `2` in `2>log` — sitting in front of a redirect, so it is not mistaken
 * for a command operand.
 */
const REDIRECT_FAMILY = new Set([
  '<',
  '<<',
  '<<-',
  '<<<',
  '>',
  '>>',
  '>|',
  '<>',
  '&>',
  '&>>',
  '>&',
  '<&',
]);

/**
 * Shell metacharacters a backslash escapes. Anything else keeps the
 * backslash, so a Windows path (`src\thing.ts`) survives tokenizing.
 */
const ESCAPABLE_CHARS = '\\"\'`$&;|<>(){} \t';

function stripHeredocBodies(command: string): string {
  const delimiters: string[] = [];
  const kept: string[] = [];

  for (const line of command.split('\n')) {
    const delimiter = delimiters.at(0);
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) {
        delimiters.shift();
      }
      continue;
    }

    kept.push(line);
    // `<<TAG` / `<<-TAG` markers, quoted or not. A `<<` inside a quoted
    // string on the line also matches — an accepted approximation, since a
    // false positive only makes the scan see less of the command, never a
    // write that is not there.
    const marker = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let match = marker.exec(line);
    while (match !== null) {
      const tag = match.at(2);
      if (tag !== undefined) {
        delimiters.push(tag);
      }
      match = marker.exec(line);
    }
  }

  return kept.join('\n');
}

/**
 * Split a shell command line into word and operator tokens. Quotes and
 * backslash escapes are honoured so a `>` inside a quoted string is not
 * mistaken for a redirect. This is a scanner, not a parser — it exists to
 * find file writes, and where it cannot be sure it says so rather than
 * guessing.
 */
function tokenizeShell(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  let expectCommand = true;

  const pushOperator = (text: string): void => {
    tokens.push({ kind: 'operator', text, commandStart: false, expansion: false });
    expectCommand = COMMAND_SEPARATORS.has(text);
  };

  while (index < input.length) {
    const c = input.charAt(index);

    if (c === ' ' || c === '\t' || c === '\r') {
      index += 1;
      continue;
    }
    if (c === '\n' || c === ';') {
      pushOperator(c);
      index += 1;
      continue;
    }
    if (c === '#') {
      // `#` begins a comment only at a token boundary — which is the only
      // place this loop can see it, since a `#` inside a word is consumed by
      // the word scan below.
      while (index < input.length && input.charAt(index) !== '\n') {
        index += 1;
      }
      continue;
    }
    if (c === '(' || c === ')') {
      pushOperator(c);
      index += 1;
      continue;
    }
    if (c === '|') {
      const doubled = input.charAt(index + 1) === '|';
      pushOperator(doubled ? '||' : '|');
      index += doubled ? 2 : 1;
      continue;
    }
    if (c === '&') {
      const next = input.charAt(index + 1);
      const after = input.charAt(index + 2);
      if (next === '&') {
        pushOperator('&&');
        index += 2;
      } else if (next === '>') {
        pushOperator(after === '>' ? '&>>' : '&>');
        index += after === '>' ? 3 : 2;
      } else {
        pushOperator('&');
        index += 1;
      }
      continue;
    }
    if (c === '<' || c === '>') {
      if (input.charAt(index + 1) === '(') {
        // `>(cmd)` / `<(cmd)` — process substitution. The parenthesised
        // command runs, but the token it produces is a descriptor, not a
        // file path, so the pair is one opaque operator here.
        pushOperator(`${c}(`);
        index += 2;
        continue;
      }
      let op = c;
      let cursor = index + 1;
      while (cursor < input.length && cursor - index < 3) {
        const d = input.charAt(cursor);
        if (d !== '<' && d !== '>' && d !== '&' && d !== '|' && d !== '-') {
          break;
        }
        op += d;
        cursor += 1;
      }
      pushOperator(op);
      index = cursor;
      continue;
    }

    // A word. Single quotes suppress expansion; double quotes keep `$` and
    // backticks meaningful, so the flag is set in either unquoted or
    // double-quoted context.
    let text = '';
    let expansion = false;
    while (index < input.length) {
      const w = input.charAt(index);
      if (w === '\\' && index + 1 < input.length) {
        const next = input.charAt(index + 1);
        if (next === '\n') {
          index += 2;
        } else if (ESCAPABLE_CHARS.includes(next)) {
          text += next;
          index += 2;
        } else {
          text += w;
          index += 1;
        }
        continue;
      }
      if (w === "'") {
        index += 1;
        while (index < input.length && input.charAt(index) !== "'") {
          text += input.charAt(index);
          index += 1;
        }
        index += 1;
        continue;
      }
      if (w === '"') {
        index += 1;
        while (index < input.length) {
          const d = input.charAt(index);
          if (d === '"') {
            index += 1;
            break;
          }
          if (d === '\\' && index + 1 < input.length && '"\\$`'.includes(input.charAt(index + 1))) {
            text += input.charAt(index + 1);
            index += 2;
            continue;
          }
          if (d === '$' || d === '`') {
            expansion = true;
          }
          text += d;
          index += 1;
        }
        continue;
      }
      if (
        w === ' ' ||
        w === '\t' ||
        w === '\r' ||
        w === '\n' ||
        w === ';' ||
        w === '&' ||
        w === '|' ||
        w === '<' ||
        w === '>' ||
        w === '(' ||
        w === ')'
      ) {
        break;
      }
      if (w === '$' || w === '`') {
        expansion = true;
      }
      text += w;
      index += 1;
    }
    tokens.push({ kind: 'word', text, commandStart: expectCommand, expansion });
    expectCommand = false;
  }

  return tokens;
}

/**
 * The word operands following a command word, stopping at the next operator.
 * A bare digit immediately before a redirect operator (`2` in `2>log`) is a
 * descriptor number, not an operand, and is skipped.
 */
function operandsAfter(tokens: ShellToken[], start: number): ShellToken[] {
  const operands: ShellToken[] = [];
  for (let index = start; index < tokens.length; index++) {
    const token = tokens.at(index);
    if (token === undefined || token.kind === 'operator') {
      break;
    }
    const following = tokens.at(index + 1);
    if (
      /^\d+$/.test(token.text) &&
      following !== undefined &&
      following.kind === 'operator' &&
      REDIRECT_FAMILY.has(following.text)
    ) {
      continue;
    }
    operands.push(token);
  }
  return operands;
}

function isFlagToken(token: ShellToken): boolean {
  return token.text.length > 1 && token.text.startsWith('-') && token.text !== '--';
}

/** The command name of a word token: last path segment, lower-cased, without `.exe`. */
function commandBaseName(word: string): string {
  const last = word.split(/[\\/]/).at(-1) ?? word;
  return last.toLowerCase().replace(/\.exe$/, '');
}

/**
 * The destination operand of `cp`/`mv`: the `-t`/`--target-directory` value
 * when present, else the last of two-or-more bare operands. A single bare
 * operand means the command fails without writing, so it returns `undefined`.
 */
function copyMoveDestination(tokens: ShellToken[], start: number): ShellToken | undefined {
  const operands = operandsAfter(tokens, start);
  const files: ShellToken[] = [];
  let destination: ShellToken | undefined;
  let flagsDone = false;

  for (let index = 0; index < operands.length; index++) {
    const operand = operands.at(index);
    if (operand === undefined) {
      continue;
    }
    if (!flagsDone && operand.text === '--') {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && isFlagToken(operand)) {
      if (operand.text === '-t' || operand.text === '--target-directory') {
        const value = operands.at(index + 1);
        if (value !== undefined && !isFlagToken(value)) {
          destination = value;
          index += 1;
        }
        continue;
      }
      const inlinePrefix = '--target-directory=';
      if (operand.text.startsWith(inlinePrefix)) {
        destination = {
          kind: 'word',
          text: operand.text.slice(inlinePrefix.length),
          commandStart: false,
          expansion: operand.expansion,
        };
      }
      continue;
    }
    files.push(operand);
  }

  if (destination === undefined && files.length >= 2) {
    destination = files.at(-1);
  }
  return destination;
}

/**
 * The file operands of a `sed -i` invocation, or an empty list when `sed`
 * does not edit in place. `-e`/`-f` (and their long forms) consume the
 * following operand as the script; with any of them present every bare
 * operand is a file, and without them the first bare operand is the script.
 */
function sedInPlaceFiles(tokens: ShellToken[], start: number): ShellToken[] {
  const operands = operandsAfter(tokens, start);

  const inPlace = operands.some(
    (operand) =>
      operand.text === '--in-place' ||
      operand.text.startsWith('--in-place=') ||
      (/^-[^-]/.test(operand.text) && /^-[a-zA-Z]*i/.test(operand.text)),
  );
  if (!inPlace) {
    return [];
  }

  const scriptFlags = new Set(['-e', '--expression', '-f', '--file']);
  let sawScriptFlag = false;
  let flagsDone = false;
  const bare: ShellToken[] = [];

  for (let index = 0; index < operands.length; index++) {
    const operand = operands.at(index);
    if (operand === undefined) {
      continue;
    }
    if (!flagsDone && operand.text === '--') {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && isFlagToken(operand)) {
      if (scriptFlags.has(operand.text)) {
        sawScriptFlag = true;
        index += 1;
        continue;
      }
      if (
        operand.text.startsWith('-e') ||
        operand.text.startsWith('--expression=') ||
        operand.text.startsWith('-f') ||
        operand.text.startsWith('--file=')
      ) {
        sawScriptFlag = true;
      }
      continue;
    }
    bare.push(operand);
  }

  return sawScriptFlag ? bare : bare.slice(1);
}

/** What a shell command writes, as far as it can be told without running it. */
interface ShellScan {
  /** Literal write targets found in the command. */
  literals: string[];
  /** Write constructs whose target cannot be determined without running the command. */
  unresolvable: string[];
}

function scanShellCommand(command: string): ShellScan {
  const tokens = tokenizeShell(stripHeredocBodies(command));
  const literals: string[] = [];
  const unresolvable: string[] = [];
  const seenLiteral = new Set<string>();
  const seenUnresolvable = new Set<string>();

  const addLiteral = (target: string): void => {
    if (!seenLiteral.has(target)) {
      seenLiteral.add(target);
      literals.push(target);
    }
  };
  const addUnresolvable = (description: string): void => {
    if (!seenUnresolvable.has(description)) {
      seenUnresolvable.add(description);
      unresolvable.push(description);
    }
  };
  const addTarget = (token: ShellToken, what: string): void => {
    if (token.expansion) {
      addUnresolvable(`${what} "${token.text}" — a shell expansion, not a literal path`);
    } else if (token.text.length === 0) {
      addUnresolvable(`${what} is empty`);
    } else {
      addLiteral(token.text);
    }
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens.at(index);
    if (token === undefined) {
      continue;
    }

    if (token.kind === 'operator') {
      if (WRITE_REDIRECTS.has(token.text)) {
        const next = tokens.at(index + 1);
        if (next === undefined || next.kind !== 'word') {
          addUnresolvable(`a "${token.text}" redirect with no file target`);
        } else if (!next.text.startsWith('&')) {
          // `> &2` duplicates a descriptor rather than naming a file.
          addTarget(next, 'redirect target');
        }
      }
      continue;
    }

    if (!token.commandStart) {
      continue;
    }

    const name = commandBaseName(token.text);
    if (name === 'tee') {
      for (const operand of operandsAfter(tokens, index + 1)) {
        if (!isFlagToken(operand)) {
          addTarget(operand, 'tee target');
        }
      }
    } else if (name === 'cp' || name === 'mv') {
      const destination = copyMoveDestination(tokens, index + 1);
      if (destination !== undefined) {
        addTarget(destination, `${name} destination`);
      }
    } else if (name === 'sed') {
      for (const file of sedInPlaceFiles(tokens, index + 1)) {
        addTarget(file, 'sed -i file');
      }
    }
  }

  return { literals, unresolvable };
}

/**
 * Decide a `PreToolUse` on a shell tool. The command's output cannot be
 * checked, so the question is only where it writes: a literal target that a
 * configured analyzer claims is denied — the edit tools exist precisely so
 * content can be checked before it lands — and anything the scan cannot
 * resolve is allowed and recorded rather than silently ignored.
 */
async function decideShellCommand(
  root: string,
  input: Record<string, unknown>,
  baseCwd: string,
  env: NodeJS.ProcessEnv,
): Promise<PreVerdict> {
  const command = stringField(input, 'command');
  if (command === undefined) {
    return {
      decision: 'allow',
      reason: 'the shell payload has no command string; nothing could be inspected',
    };
  }

  const scan = scanShellCommand(command);
  if (scan.literals.length === 0 && scan.unresolvable.length === 0) {
    return { decision: 'allow', silent: true };
  }

  const config = await loadConfig(root);
  const manifests = await loadAnalyzers(config.analyzers, root);

  const analyzed: string[] = [];
  const unclaimed: string[] = [];
  const declaration = getDispatchDeclaration(env);
  let rootNote = '';

  for (const literal of scan.literals) {
    const absolute = path.isAbsolute(literal)
      ? path.normalize(literal)
      : path.resolve(baseCwd, literal);
    const rel = repoRelative(absolute, root);
    if (rel === undefined) {
      unclaimed.push(literal);
      continue;
    }

    const ownership = checkOwnership(rel, declaration);
    if (!ownership.allowed) {
      return { decision: 'deny', target: rel, reason: ownership.reason };
    }
    rootNote = ownership.rootNote ?? rootNote;

    const { routed, supplemental } = routeFiles([absolute], manifests, root, config.exclude);
    if (routed.size > 0 || supplemental.size > 0) {
      analyzed.push(rel);
    } else {
      unclaimed.push(rel);
    }
  }

  if (analyzed.length > 0) {
    const unresolvedNote =
      scan.unresolvable.length > 0
        ? ` The command also writes to ${scan.unresolvable.length} target(s) that could not be resolved.`
        : '';
    return {
      decision: 'deny',
      target: analyzed.join(', '),
      reason:
        `cyv: this shell command writes to ${analyzed.join(', ')}, which configured analyzers check. ` +
        'A write made through the shell lands before its content can be checked. ' +
        `Use the Write or Edit tool for ${analyzed.join(', ')} so the proposed content is checked first.${unresolvedNote}${rootNote}`,
    };
  }

  const parts: string[] = [];
  if (unclaimed.length > 0) {
    parts.push(`writes to ${unclaimed.join(', ')}, which no configured analyzer claims`);
  }
  for (const entry of scan.unresolvable) {
    parts.push(`has a write target that could not be resolved (${entry})`);
  }
  const firstUnclaimed = unclaimed.at(0);
  return {
    decision: 'allow',
    ...(firstUnclaimed !== undefined ? { target: firstUnclaimed } : {}),
    reason: `the shell command ${parts.join('; ')}; allowed and recorded because the write is outside what cyv checks${rootNote}`,
  };
}

/* ---- Edit-tool proposed content -------------------------------------- */

/** One `old_string`/`new_string` pair from an `Edit` or `MultiEdit` input. */
interface EditSpec {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

function editSpecFrom(input: Record<string, unknown>): EditSpec | undefined {
  const oldText = stringField(input, 'old_string') ?? stringField(input, 'oldString');
  const newText = input['new_string'] ?? input['newString'];
  if (oldText === undefined || typeof newText !== 'string') {
    return undefined;
  }
  return {
    oldText,
    newText,
    replaceAll: input['replace_all'] === true || input['replaceAll'] === true,
  };
}

/**
 * Apply one edit spec to file content. The failure cases mirror the tool's
 * own: an `old_string` that is absent, or ambiguous without `replace_all`,
 * means the edit cannot apply — which is not a judgement failure, it is a
 * call that writes nothing.
 */
function applyEdit(content: string, spec: EditSpec): { applied: string } | { reason: string } {
  if (spec.oldText.length === 0) {
    return { reason: 'empty old_string; the proposed edit cannot be reproduced' };
  }
  // Tool input arrives with LF line endings regardless of what the file holds
  // on disk — the agent read the file through tools that normalize. On a CRLF
  // checkout a byte-exact search finds nothing, which used to read as "the
  // edit would not apply" and allowed every edit to such a file unchecked.
  // Retry the match with the needle on the file's own line ending.
  let needle = spec.oldText;
  let first = content.indexOf(needle);
  if (first < 0) {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normalized = needle.replace(/\r\n|\r|\n/g, eol);
    if (normalized !== needle) {
      needle = normalized;
      first = content.indexOf(needle);
    }
  }
  if (first < 0) {
    return { reason: 'old_string is not present in the file; the edit would not apply' };
  }
  if (!spec.replaceAll && content.indexOf(needle, first + 1) >= 0) {
    return {
      reason: 'old_string matches more than once without replace_all; the edit would be rejected as ambiguous',
    };
  }
  const applied = spec.replaceAll
    ? content.split(needle).join(spec.newText)
    : content.slice(0, first) + spec.newText + content.slice(first + needle.length);
  return { applied };
}

/**
 * The content a file will hold if the proposed edit lands: `tool_input`
 * verbatim for a write, or the current file with each edit applied.
 */
async function proposedContentFor(
  tool: string,
  input: Record<string, unknown>,
  target: string,
  rel: string,
): Promise<{ content: string } | { reason: string }> {
  if (tool === 'write') {
    const content = input['content'];
    return typeof content === 'string'
      ? { content }
      : { reason: 'the Write payload has no content field; the proposed write could not be judged' };
  }

  const specs: EditSpec[] = [];
  if (tool === 'edit') {
    const spec = editSpecFrom(input);
    if (spec === undefined) {
      return {
        reason: 'the Edit payload lacks old_string/new_string; the proposed edit could not be judged',
      };
    }
    specs.push(spec);
  } else {
    const edits = input['edits'];
    if (!isUnknownArray(edits)) {
      return {
        reason: 'the MultiEdit payload has no edits array; the proposed edits could not be judged',
      };
    }
    for (const entry of edits) {
      if (!isRecord(entry)) {
        return { reason: 'a MultiEdit entry is not an object; the proposed edits could not be judged' };
      }
      const spec = editSpecFrom(entry);
      if (spec === undefined) {
        return {
          reason: 'a MultiEdit entry lacks old_string/new_string; the proposed edits could not be judged',
        };
      }
      specs.push(spec);
    }
  }

  let current: string;
  try {
    current = await readFile(target, 'utf-8');
  } catch (err) {
    return {
      reason: `could not read ${rel} to reproduce the edit: ${messageFor(err)}`,
    };
  }

  for (const spec of specs) {
    const result = applyEdit(current, spec);
    if ('reason' in result) {
      return result;
    }
    current = result.applied;
  }
  return { content: current };
}

/**
 * Where the temporary file goes. The proposed content has to sit inside the
 * repository for `runCheck` to route it, and it is placed in the deepest
 * existing ancestor directory of the target so directory-scoped rule
 * overrides (`src/**` and the like) apply to the check the same way they
 * will apply to the real file. The name keeps the target's extension so
 * extension-based match globs claim it, and is deliberately visible rather
 * than dot-prefixed — a `cyv-pending` file left behind by a crash shows up
 * in the next working-tree check instead of hiding in a dot-directory the
 * router never reaches.
 */
async function pendingDirFor(target: string, root: string): Promise<string> {
  let dir = path.dirname(target);
  while (dir !== root && repoRelative(dir, root) !== undefined && !(await isDirectory(dir))) {
    dir = path.dirname(dir);
  }
  return (await isDirectory(dir)) && (dir === root || repoRelative(dir, root) !== undefined)
    ? dir
    : root;
}

/**
 * Materialize the proposed content and run the one check pipeline over it.
 * Violations come back naming the temporary file, so they are remapped to
 * the real target before the baseline partition — baseline identity is
 * keyed on the repo-relative path, and matching it is what keeps a
 * baseline-deferred violation in an edited file from wrongly denying the
 * edit.
 */
async function checkProposedContent(
  ctx: CommandContext,
  plugin: AgentPlugin,
  root: string,
  target: string,
  rel: string,
  content: string,
  omitNotFixes: boolean,
): Promise<PreVerdict> {
  const dir = await pendingDirFor(target, root);
  const tempPath = path.join(
    dir,
    `cyv-pending-${randomBytes(6).toString('hex')}-${path.basename(target)}`,
  );
  await writeFile(tempPath, content, 'utf-8');

  try {
    const { report, repoRoot: checkRoot } = await runCheck({
      cwd: ctx.cwd,
      mode: 'files',
      paths: [tempPath],
    });

    if (report.filesChecked === 0) {
      // Two different not-judged cases: no analyzer claimed the file (it is
      // not source cyv understands), or one claimed it and failed to check
      // it (a skip). Both allow; the record needs to know which.
      const skip = report.skipped.at(0);
      return {
        decision: 'allow',
        target: rel,
        reason:
          skip !== undefined
            ? `the analyzer could not check the proposed content for ${rel}: ${skip.reason}`
            : `no configured analyzer claims ${rel}; the proposed content could not be checked`,
      };
    }

    const violations = report.violations.map((violation) => ({ ...violation, file: target }));
    const baseline = await readBaseline(checkRoot);
    const fresh =
      baseline === null ? violations : partitionViolations(violations, baseline).fresh;

    if (fresh.length === 0) {
      return {
        decision: 'allow',
        target: rel,
        reason: 'the proposed content introduces no new violation',
        violationCount: 0,
      };
    }

    const result = plugin.formatResult(omitNotFixes ? withoutNotFixes(fresh) : fresh, {
      files: [target],
    });
    const detail = result.stderr.length > 0 ? result.stderr : result.stdout;

    // A warning-severity finding is advisory even on the post-tool path —
    // `formatResult` returns 0 for it — so it cannot justify a denial here.
    if (result.exitCode === 0) {
      return {
        decision: 'allow',
        target: rel,
        reason: `the proposed content has ${fresh.length} advisory finding(s), none blocking`,
        violationCount: fresh.length,
      };
    }

    return {
      decision: 'deny',
      target: rel,
      reason:
        `cyv: the proposed content for ${rel} violates configured rules. ` +
        `The edit is denied before it lands.\n${detail}`,
      violationCount: fresh.length,
    };
  } finally {
    try {
      await rm(tempPath, { force: true });
    } catch (err) {
      warn(`could not remove the temporary check file ${tempPath}: ${messageFor(err)}`);
    }
  }
}

async function decideEditTool(
  ctx: CommandContext,
  plugin: AgentPlugin,
  root: string,
  tool: string,
  input: Record<string, unknown>,
  baseCwd: string,
  omitNotFixes: boolean,
): Promise<PreVerdict> {
  const rawPath = stringField(input, 'file_path') ?? stringField(input, 'filePath');
  if (rawPath === undefined) {
    return {
      decision: 'allow',
      reason: `the ${tool} payload names no file path; the proposed content could not be judged`,
    };
  }

  const target = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(baseCwd, rawPath);
  const rel = repoRelative(target, root);
  if (rel === undefined) {
    return {
      decision: 'allow',
      target: rawPath,
      reason: `${rawPath} is outside the repository; nothing here can check it`,
    };
  }

  const ownership = checkOwnership(rel, getDispatchDeclaration(ctx.env));
  if (!ownership.allowed) {
    return { decision: 'deny', target: rel, reason: ownership.reason };
  }

  const rootNote = ownership.rootNote ?? '';
  const proposed = await proposedContentFor(tool, input, target, rel);
  if ('reason' in proposed) {
    return { decision: 'allow', target: rel, reason: proposed.reason + rootNote };
  }

  const verdict = await checkProposedContent(
    ctx,
    plugin,
    root,
    target,
    rel,
    proposed.content,
    omitNotFixes,
  );
  return { ...verdict, reason: verdict.reason + rootNote };
}

async function decidePreToolUse(
  ctx: CommandContext,
  plugin: AgentPlugin,
  root: string,
  envelope: Record<string, unknown>,
  omitNotFixes: boolean,
): Promise<PreVerdict> {
  const toolName = stringField(envelope, 'tool_name');
  if (toolName === undefined) {
    return {
      decision: 'allow',
      reason: 'the pre-tool payload names no tool; nothing about it can be judged',
    };
  }

  const tool = toolName.toLowerCase();
  const input = isRecord(envelope['tool_input']) ? envelope['tool_input'] : undefined;
  const baseCwd = stringField(envelope, 'cwd') ?? ctx.cwd;

  if (EDIT_TOOLS.has(tool)) {
    if (input === undefined) {
      return {
        decision: 'allow',
        reason: `the ${toolName} payload has no tool_input; the proposed content could not be judged`,
      };
    }
    return decideEditTool(ctx, plugin, root, tool, input, baseCwd, omitNotFixes);
  }

  if (SHELL_TOOLS.has(tool)) {
    if (input === undefined) {
      return {
        decision: 'allow',
        reason: `the ${toolName} payload has no tool_input; the command could not be inspected`,
      };
    }
    return decideShellCommand(root, input, baseCwd, ctx.env);
  }

  if (tool === 'notebookedit') {
    return {
      decision: 'allow',
      reason: `${toolName} edits a notebook, which no configured analyzer can check`,
    };
  }

  if (QUIET_TOOLS.has(tool)) {
    return { decision: 'allow', silent: true };
  }

  return {
    decision: 'allow',
    reason: `unrecognized tool "${toolName}"; whether it writes a file cannot be judged`,
  };
}

/**
 * Run the `PreToolUse` half of the hook. Always exits 0: the answer travels
 * in the structured decision on stdout, and an internal failure degrades to
 * "allow, and record why" — a gate that fails closed on its own bug is the
 * worst outcome this command can produce.
 */
async function runPreToolUse(
  ctx: CommandContext,
  plugin: AgentPlugin,
  envelope: Record<string, unknown>,
  observe: boolean,
  omitNotFixes: boolean,
): Promise<number> {
  const tool = stringField(envelope, 'tool_name') ?? 'unknown';
  const session = stringField(envelope, 'session_id');

  let root: string | undefined;
  try {
    root = await repoRoot(ctx.cwd);
    const verdict = await decidePreToolUse(ctx, plugin, root, envelope, omitNotFixes);
    // `--observe` means measure, never intervene: the verdict is recorded
    // exactly as computed, and the call is allowed regardless.
    const deny = verdict.decision === 'deny' && !observe;
    if (verdict.silent !== true) {
      await recordDecision(root, {
        at: new Date().toISOString(),
        event: 'PreToolUse',
        tool,
        decision: verdict.decision,
        enforced: deny,
        reason: verdict.reason ?? (verdict.decision === 'deny' ? 'denied' : 'allowed'),
        ...(verdict.target !== undefined ? { target: verdict.target } : {}),
        ...(session !== undefined ? { session } : {}),
        ...(verdict.violationCount !== undefined ? { violationCount: verdict.violationCount } : {}),
      });
    }
    emitPreDecision(deny ? 'deny' : 'allow', deny ? verdict.reason : undefined);
    return 0;
  } catch (err) {
    warn(`pre-tool check failed; the call was allowed: ${messageFor(err)}`);
    if (root !== undefined) {
      await recordDecision(root, {
        at: new Date().toISOString(),
        event: 'PreToolUse',
        tool,
        decision: 'allow',
        enforced: false,
        reason: `internal error: ${messageFor(err)}`,
        ...(session !== undefined ? { session } : {}),
      });
    }
    emitPreDecision('allow');
    return 0;
  }
}

/**
 * The testable core of the command: takes the raw stdin payload as a plain
 * string, so tests can inject a fixed payload instead of piping into
 * `process.stdin`.
 */
export async function runHook(ctx: CommandContext, rawStdin: string): Promise<number> {
  // A repository that has no `checkyourvibe.json` has not opted in. The hook
  // must degrade quietly (exit 0, no output) in that case, because otherwise
  // an editor with a machine-global hook would advertise this tool on every
  // edit in every project. Errors after this point mean the config exists but
  // could not be used, which is a real problem and must stay loud.
  let configPath: string | null;
  try {
    configPath = await findConfig(ctx.cwd);
  } catch (err) {
    warn(messageFor(err));
    return 0;
  }
  if (configPath === null) {
    return 0;
  }
  const root = path.dirname(configPath);

  // Runtime lifecycle events are facts, not claims, so record every one of
  // them. Only the events with nothing to analyze return here; `Stop` falls
  // through and still checks the working tree.
  const envelope = tryParseHookEnvelope(rawStdin);
  const lifecycleEvent = envelope === undefined ? '' : stringField(envelope, 'hook_event_name') ?? '';
  if (envelope !== undefined && LIFECYCLE_EVENTS.has(lifecycleEvent)) {
    // Destructured rather than indexed: the agent id is genuinely absent when
    // the hook is invoked without one, and the parameter takes `undefined`.
    const [invokedAgentId] = ctx.argv;
    await recordLifecycleEvent(root, envelope, invokedAgentId);

    if (
      (lifecycleEvent === 'UserPromptSubmit' || lifecycleEvent === 'Stop') &&
      invokedAgentId !== undefined
    ) {
      const { deliverOrchestratorNotes } = await import('./comments.js');
      await deliverOrchestratorNotes(root, invokedAgentId).then(
        () => undefined,
        (err: unknown) => {
          warn(`could not deliver orchestrator notes: ${messageFor(err)}`);
        },
      );
    }

    if (LIFECYCLE_ONLY_EVENTS.has(lifecycleEvent)) return 0;
  }

  // `--observe` turns the hook into an instrument: it checks exactly as it
  // would otherwise, records what it found, and reports nothing.
  const observe = ctx.argv.includes('--observe');
  // `--omit-notfixes` drops the notFixes section from whatever the hook would
  // report, including a denial's `permissionDecisionReason`. It exists for the
  // benchmark's bare arms, which must measure the rule text without the
  // not-fix list; a real install has no use for a quieter gate.
  const omitNotFixes = ctx.argv.includes('--omit-notfixes');

  const agentId = ctx.argv[0];
  if (agentId === undefined || agentId.length === 0) {
    warn('missing agent id. Usage: cyv hook <agent-id>. No checks run.');
    return 0;
  }

  try {
    const plugin = await resolvePlugin(agentId);
    if (plugin === undefined) {
      warn(`unknown agent id "${agentId}". No checks run.`);
      return 0;
    }

    // `PreToolUse` carries the proposed change inside the payload — nothing
    // has landed yet — so it cannot go through `parseHookPayload`, which
    // describes what was written. It gets a decision, not a report.
    if (envelope !== undefined && envelope['hook_event_name'] === 'PreToolUse') {
      return await runPreToolUse(ctx, plugin, envelope, observe, omitNotFixes);
    }

    const payload = plugin.parseHookPayload(rawStdin);
    return await runPipeline(ctx, plugin, payload, observe, omitNotFixes);
  } catch (err) {
    warn(messageFor(err));
    return 0;
  }
}

function readStdin(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // A hook invocation with no piped input (e.g. a stray interactive run)
    // must not hang waiting for a stream that will never end.
    if (stream.isTTY === true) {
      resolvePromise('');
      return;
    }

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    });
    stream.on('error', (err: Error) => {
      reject(err);
    });
  });
}

const HOOK_USAGE = `Usage: cyv hook <agent-id> [options]

Reads the agent's hook payload from stdin. A PreToolUse payload is answered
with the structured permission decision on stdout; PostToolUse and Stop are
reported after the fact.

Options:
  --observe         Run the checks and record the outcome, but report nothing
                    and never block. Instrumentation, not enforcement.
  --omit-notfixes   Report violations without the notFixes section — the rule
                    id, summary, why and allowed fixes are still included.
                    This flag exists for the benchmark harness's bare arms,
                    which must measure the rule text without the not-fix
                    list. It is not a feature for real use: stripping the
                    list weakens the gate for the sake of the experiment.
  --help, -h        Show this text.
`;

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    if (ctx.argv.includes('--help') || ctx.argv.includes('-h')) {
      process.stdout.write(HOOK_USAGE);
      return 0;
    }

    let raw: string;
    try {
      raw = await readStdin(process.stdin);
    } catch {
      // Stdin itself is unreadable — treat it the same as "no payload" and
      // let `parseHookPayload` reject it below, rather than special-casing
      // a second failure path for the same "advisory, never block" outcome.
      raw = '';
    }

    return runHook(ctx, raw);
  },
};
