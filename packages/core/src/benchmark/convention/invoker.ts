/**
 * @file packages/core/src/benchmark/convention/invoker.ts
 *
 * The live invoker for convention trials — the piece that turns the injected
 * plumbing into a measurement.
 *
 * A convention trial differs from a fixture trial in the two ways that
 * matter to invocation. The file the agent is asked for does not exist when
 * the run starts, so the prompt names where to write it — and nothing else
 * about it, because a prompt that names the convention answers the question
 * the condition exists to ask. And the read-back tolerates the file still
 * being absent: not writing it is a scored outcome, not a failed run.
 *
 * Everything else is the fixture trial's own machinery. The command comes
 * from `buildClaudeTrialCommand`, the event stream is read by
 * `parseClaudeStreamJson`, and `agentOutputFromStream` copies what the
 * stream reported — model, permission mode, tokens, cost, and the hook
 * events that are this condition's headline: an enforcing arm is only
 * enforcing if its gate fired, and a trial whose stream carried none is
 * recorded as having seen none.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type {
  AgentExecutorConfig,
  AgentTrialOutput,
  TrialEnvironment,
} from '../harness.js';
import {
  agentOutputFromStream,
  buildClaudeTrialCommand,
  parseClaudeStreamJson,
  type ClaudeInvokerOptions,
  type ClaudeTrialCommand,
} from '../runner.js';

/** The invoker signature a trial calls. */
export type ConventionInvoker = NonNullable<AgentExecutorConfig['invoker']>;

/**
 * The prompt a convention trial sends: the task text plus the repo-relative
 * path of the file to write, and nothing else. The task says what to test,
 * never how — naming the convention, the container, or the factory here
 * would answer the question the condition exists to ask.
 */
export function buildConventionTrialPrompt(
  prompt: string,
  filePath: string,
  environment: TrialEnvironment,
): string {
  const rel = relative(environment.repoRoot, filePath);
  // Repo-relative and forward-slashed, so the prompt is the same text on
  // every platform — the text is part of the trial, not of the machine it
  // ran on.
  const target =
    rel.length > 0 && !rel.startsWith('..') ? rel.replaceAll(sep, '/') : filePath;
  return `${prompt}\n\nWrite the test to ${target}.`;
}

/**
 * The convention trial's agent command: the fixture trial's command exactly,
 * except for the prompt. `buildClaudeTrialPrompt` says "the file to change …
 * edit it in place", which is wrong here — the trial deleted the target, so
 * the agent must create it. Arguments, working directory, environment and
 * timeout all come from the same builder, so a convention trial runs the
 * same CLI the same way a fixture trial does.
 */
export function buildConventionTrialCommand(
  prompt: string,
  filePath: string,
  environment: TrialEnvironment,
  options: ClaudeInvokerOptions = {},
): ClaudeTrialCommand {
  const command = buildClaudeTrialCommand(prompt, filePath, environment, options);
  return {
    ...command,
    stdin: buildConventionTrialPrompt(prompt, filePath, environment),
  };
}

/** What one agent process yielded once it closed. */
interface ProcessOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The pump that runs one agent process: the prompt goes in on stdin, the
 * event stream comes back on stdout, and a bound on wall time kills a run
 * that stops producing. The runner's own pump is private to it; this is the
 * same discipline — a trial that never returns is a stopped run, not a slow
 * one.
 */
function runAgentProcess(command: ClaudeTrialCommand): Promise<ProcessOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.program, command.args, {
      cwd: command.cwd,
      stdio: 'pipe',
      env: command.env,
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(
        new Error(
          `"${command.program}" was still running after ${Math.round(command.timeoutMs / 1000)}s ` +
            'and was killed; the trial measured nothing and is rejected rather than scored',
        ),
      );
    }, command.timeoutMs);
    deadline.unref?.();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      rejectPromise(
        new Error(`could not start "${command.program}" in ${command.cwd}: ${err.message}`),
      );
    });
    child.stdin.on('error', (err) => {
      // The child can exit before the prompt is written; rejecting here keeps
      // an EPIPE from surfacing as an unhandled error after close.
      rejectPromise(
        new Error(`could not write the trial prompt to "${command.program}": ${err.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
    child.stdin.write(command.stdin);
    child.stdin.end();
  });
}

/**
 * Result subtypes that describe the agent rather than the invocation — the
 * same set the fixture invoker accepts. `error_max_turns` means the agent
 * worked and ran out of turns, which is a result; every other error means
 * the run did not happen.
 */
const SCOREABLE_RESULTS: ReadonlySet<string> = new Set(['success', 'error_max_turns']);

/** True for the "file is absent" error a read can legitimately meet here. */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
  );
}

/**
 * The invoker the sampling tool hands to a convention trial. The agent works
 * inside the arm's scratch repository under the same permission mode and the
 * same event-stream format a fixture trial uses; what the trial records is
 * whatever the stream reported plus whatever is on disk afterwards — and
 * "nothing on disk" is a real answer, because the condition measures whether
 * the convention was followed, which includes it not being followed at all.
 */
export function createConventionInvoker(options: ClaudeInvokerOptions = {}): ConventionInvoker {
  return async (prompt, filePath, environment) => {
    const command = buildConventionTrialCommand(prompt, filePath, environment, options);
    const run = await runAgentProcess(command);
    const parsed = parseClaudeStreamJson(run.stdout, environment.repoRoot);
    if (!parsed.sawResult) {
      throw new Error(
        `"${command.program}" produced no result event for ${filePath} ` +
          `(exit ${run.exitCode}); the run emitted no transcript and cannot be ` +
          `scored. stderr: ${run.stderr.trim().slice(0, 400)}`,
      );
    }
    if (!SCOREABLE_RESULTS.has(parsed.resultSubtype ?? 'success')) {
      throw new Error(
        `"${command.program}" ended with result "${parsed.resultSubtype ?? 'unknown'}" for ` +
          `${filePath} (exit ${run.exitCode}); the invocation failed rather than ` +
          `measuring anything. stderr: ${run.stderr.trim().slice(0, 400)}`,
      );
    }
    // The file may legitimately not exist — the agent never wrote it — and
    // that absence is what `checkDi` scores. Only a genuine read failure is
    // a failed run.
    let code = '';
    try {
      code = await readFile(filePath, 'utf-8');
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
    }
    return agentOutputFromStream(parsed, code);
  };
}
