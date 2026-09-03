/**
 * The gates a dispatch is judged by (spec 0011 Requirement 4.1).
 *
 * Spec 0011 leaves where gate names are authored open, and records it as an
 * open question. `cyv dispatch` is where they are authored here: a gate is a
 * string on the command line, it is recorded verbatim in the dispatch record,
 * and this module is what turns it back into something that runs. A record
 * therefore names exactly what judged it, which is what Requirement 4.5 needs
 * a later failure to be traceable to.
 *
 * Two forms exist:
 *
 * - `cyv-check` runs this repository's own configured analyzers over the paths
 *   the dispatch was observed to change, and passes when none of them reports
 *   an error.
 * - `run:<program> [args...]` runs a command in the repository root and passes
 *   on exit code zero. This is the one place a dispatch's success may rest on
 *   an exit code, and it rests on the gate's, never on the executor's:
 *   Requirement 2.1 refuses the executor's own code as evidence, and a gate is
 *   a check the user chose and the core ran.
 *
 * A gate that names neither form fails with a detail saying so, because a gate
 * the harness cannot run has not passed.
 */
import { runChild, type ChildObservation } from './child.js';
import { findProgram, launchArguments } from './program.js';
import { runCheck } from '../run/check.js';
import type { GateResult } from './outcome.js';
import type { GateContext, GateRunner } from './run.js';

/** The gate that runs this repository's own analyzers. */
export const CYV_CHECK_GATE = 'cyv-check';

/** The prefix that makes a gate an arbitrary command. */
export const RUN_GATE_PREFIX = 'run:';

export type GateSpec =
  | { kind: 'cyv-check' }
  | { kind: 'command'; program: string; args: readonly string[] };

/**
 * Read a gate name as something runnable, or `undefined` when it is neither
 * form.
 *
 * A `run:` gate is split on whitespace and nothing else: there is no quoting
 * and no shell. A command that needs either belongs in a script the gate names.
 */
export function parseGate(gate: string): GateSpec | undefined {
  if (gate === CYV_CHECK_GATE) return { kind: 'cyv-check' };

  if (gate.startsWith(RUN_GATE_PREFIX)) {
    const words = gate.slice(RUN_GATE_PREFIX.length).trim().split(/\s+/);
    const program = words[0];
    if (program === undefined || program.length === 0) return undefined;
    return { kind: 'command', program, args: words.slice(1) };
  }

  return undefined;
}

/** The wording a gate name that names neither form is failed with. */
export function unknownGateDetail(gate: string): string {
  return (
    `"${gate}" names no gate this build can run. Use "${CYV_CHECK_GATE}", or ` +
    `"${RUN_GATE_PREFIX}<program> [args...]" to run a command that passes on exit code 0.`
  );
}

function countBySeverity(severities: readonly string[], wanted: string): number {
  return severities.filter((severity) => severity === wanted).length;
}

/**
 * Run the configured analyzers over the paths the dispatch changed.
 *
 * `strict` is turned off for this run: strictness makes a skipped file fail the
 * whole check, and a dispatch that also touched a file no analyzer claims — a
 * markdown note beside the code — would then fail a gate for a reason that has
 * nothing to do with what it wrote.
 */
async function runCyvCheck(context: GateContext, gate: string): Promise<GateResult> {
  if (context.changedPaths.length === 0) {
    return {
      gate,
      passed: true,
      detail: 'no file changed, so the analyzers had nothing from this dispatch to check',
    };
  }

  const { report } = await runCheck({
    cwd: context.repoRoot,
    mode: 'files',
    paths: [...context.changedPaths],
    strict: false,
  });

  const severities = report.violations.map((violation) => violation.severity);
  const errors = countBySeverity(severities, 'error');
  const warnings = countBySeverity(severities, 'warning');
  const detail =
    `${errors} error(s), ${warnings} warning(s) across ${report.filesChecked} file(s) ` +
    'the dispatch changed';

  return { gate, passed: errors === 0, detail };
}

async function runCommandGate(
  spec: { program: string; args: readonly string[] },
  context: GateContext,
  gate: string,
  env: NodeJS.ProcessEnv,
): Promise<GateResult> {
  const launcher = await findProgram(spec.program, env, context.repoRoot);
  if (launcher === undefined) {
    return {
      gate,
      passed: false,
      detail: `"${spec.program}" was not found on PATH, so this gate did not run`,
    };
  }

  const launch = launchArguments(launcher, spec.args);
  const observation = await runChild({
    command: launcher.command,
    args: launch.args,
    cwd: context.repoRoot,
    env,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
  });

  if (observation.spawnError !== undefined) {
    return { gate, passed: false, detail: `the gate could not start: ${observation.spawnError}` };
  }
  if (observation.exitCode === undefined) {
    const ended = observation.signal ?? 'a signal that was not recorded';
    return { gate, passed: false, detail: `the gate was ended by ${ended}` };
  }
  if (observation.exitCode === 0) {
    return { gate, passed: true, detail: 'the gate exited with code 0' };
  }
  return {
    gate,
    passed: false,
    detail: `the gate exited with code ${observation.exitCode}${failureTail(observation)}`,
  };
}

/** Characters of a failed gate's output kept on its result. */
const GATE_OUTPUT_TAIL = 600;

/**
 * The end of what a failed gate wrote, so its result says why and not only
 * that it failed. The tail, because a process explains itself as it ends
 * (spec 0036 Requirement 11.4).
 */
function failureTail(observation: ChildObservation): string {
  const text = `${observation.stdout}\n${observation.stderr}`.trim();
  if (text.length === 0) return '';
  const tail = text.length > GATE_OUTPUT_TAIL ? `…${text.slice(-GATE_OUTPUT_TAIL)}` : text;
  return `; it wrote: ${tail}`;
}

/**
 * A `GateRunner` over the two forms above.
 *
 * `runDispatch` already records a gate whose runner throws as failed, so
 * nothing here catches on the runner's behalf.
 */
export function createGateRunner(env: NodeJS.ProcessEnv): GateRunner {
  return async (gate: string, context: GateContext): Promise<GateResult> => {
    const spec = parseGate(gate);
    if (spec === undefined) {
      return { gate, passed: false, detail: unknownGateDetail(gate) };
    }
    if (spec.kind === 'cyv-check') {
      return runCyvCheck(context, gate);
    }
    return runCommandGate(spec, context, gate, env);
  };
}
