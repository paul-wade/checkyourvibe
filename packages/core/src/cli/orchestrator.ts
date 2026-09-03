/**
 * `cyv orchestrator`: the orchestrating session records its own condition, or
 * reads back what was last recorded (spec 0036 Requirement 3).
 *
 * The record is a claim. cyv is invoked by the orchestrator and cannot watch
 * it, so nothing printed here is described as measured; every line says
 * self-reported, and no report at all prints as unknown rather than as either
 * healthy or exhausted (Requirements 3.3, 3.4).
 */
import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { asOrchestratorState } from '../executor/parse.js';
import { readDispatchLog, recordOrchestratorState } from '../executor/store.js';
import type { OrchestratorReported, OrchestratorState } from '../executor/dispatch.js';

const STATES = 'healthy, degraded or exhausted';

const USAGE = [
  'Usage: cyv orchestrator [--state <state>] [--reason <text>] [--model <name>] [--json]',
  '',
  'Records the orchestrating session\'s own account of its condition in the',
  'dispatch log, or prints the last one recorded. The record is a self-report:',
  'cyv is invoked by the orchestrator and cannot measure it.',
  '',
  'Options:',
  `  --state <state>   Record a report. One of ${STATES}.`,
  '  --reason <text>   Free text to record with it, such as a vendor\'s limit message.',
  '  --model <name>    The model or plan the session believes it is running under.',
  '  --json            Print the report as JSON.',
  '  --help            Print this message.',
].join('\n');

interface ParsedArgs {
  state?: OrchestratorState;
  reason?: string;
  model?: string;
  json: boolean;
  help: boolean;
}

class UsageError extends Error {}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} needs a value.`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--state': {
        const raw = valueAfter(argv, index, arg);
        const state = asOrchestratorState(raw);
        if (state === undefined) {
          throw new UsageError(`--state "${raw}" is not a state this command records. Use ${STATES}.`);
        }
        parsed.state = state;
        index += 1;
        break;
      }
      case '--reason':
        parsed.reason = valueAfter(argv, index, arg);
        index += 1;
        break;
      case '--model':
        parsed.model = valueAfter(argv, index, arg);
        index += 1;
        break;
      default:
        throw new UsageError(`Unknown argument "${arg}" for cyv orchestrator.`);
    }
  }
  if (parsed.state === undefined && (parsed.reason !== undefined || parsed.model !== undefined)) {
    throw new UsageError('--reason and --model record with a report; pass --state as well.');
  }
  return parsed;
}

/** The self-report as JSON, or the unknown state when nothing was recorded. */
interface ReportJson {
  attribution: 'self-reported';
  state: OrchestratorState | 'unknown';
  report: OrchestratorReported | null;
}

function describe(report: OrchestratorReported): string {
  const reason = report.reason === undefined ? '' : ` — ${report.reason}`;
  const model = report.model === undefined ? '' : ` (model: ${report.model})`;
  return `${report.state}${model}${reason}`;
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    let args: ParsedArgs;
    try {
      args = parseArgs(ctx.argv);
    } catch (err) {
      if (err instanceof UsageError) {
        console.error(err.message);
        console.error('');
        console.error(USAGE);
        return 2;
      }
      throw err;
    }
    if (args.help) {
      console.log(USAGE);
      return 0;
    }

    let root: string;
    try {
      root = await repoRoot(ctx.cwd);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }

    if (args.state !== undefined) {
      const report = await recordOrchestratorState(root, {
        state: args.state,
        reportedAt: new Date().toISOString(),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(args.model === undefined ? {} : { model: args.model }),
      });
      if (args.json) {
        const json: ReportJson = { attribution: 'self-reported', state: report.state, report };
        console.log(JSON.stringify(json, null, 2));
      } else {
        console.log(`Recorded self-reported state at ${report.reportedAt}: ${describe(report)}`);
      }
      return 0;
    }

    const log = await readDispatchLog(root);
    const last = log.orchestrator;
    if (args.json) {
      const json: ReportJson =
        last === undefined
          ? { attribution: 'self-reported', state: 'unknown', report: null }
          : { attribution: 'self-reported', state: last.state, report: last };
      console.log(JSON.stringify(json, null, 2));
      return 0;
    }
    if (last === undefined) {
      console.log('no self-report recorded — unknown');
      return 0;
    }
    console.log(`self-reported at ${last.reportedAt}: ${describe(last)}`);
    return 0;
  },
};
