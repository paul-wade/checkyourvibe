/**
 * `cyv hook <agent-id>` — the advisory layer that runs inside an editor's
 * save loop, invoked by an agent's own hook mechanism after every edit.
 *
 * The one rule everything below obeys: never turn an unexpected failure into
 * a blocked edit. A vendor changing its hook payload schema, a plugin that
 * won't load, a missing or invalid config, an analyzer that crashes — every
 * one of those degrades to "no feedback this time" (exit 0), never to a
 * wedged editor. The only non-zero exit this command ever produces is the one
 * the resolved agent plugin's `formatResult` may return for real violations. The
 * git backstop (a pre-commit `cyv check --staged --strict`) is the layer
 * allowed to block; this one is not.
 */
import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import type { Command, CommandContext } from './types.js';
import { findConfig } from '../config/load.js';
import { isUnknownArray } from '../guards.js';
import { runCheck } from '../run/check.js';
import { partitionViolations, readBaseline } from '../baseline/index.js';
import type { AgentPlugin, AgentSurface, HookPayload, Violation } from '../protocol/index.js';

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
  };

  await mkdir(dir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

async function runPipeline(
  ctx: CommandContext,
  plugin: AgentPlugin,
  payload: HookPayload,
  observe: boolean,
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
    await recordObservation(repoRoot, payload, violations);
    return 0;
  }

  if (violations.length === 0) {
    return 0;
  }

  const result = plugin.formatResult(violations, { files: payload.files });

  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }

  return result.exitCode;
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

  // `--observe` turns the hook into an instrument: it checks exactly as it
  // would otherwise, records what it found, and reports nothing.
  const observe = ctx.argv.includes('--observe');

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

    const payload = plugin.parseHookPayload(rawStdin);
    return await runPipeline(ctx, plugin, payload, observe);
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

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
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
