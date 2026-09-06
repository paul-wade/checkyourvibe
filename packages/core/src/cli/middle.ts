import {
  findSpecs,
  parseTasks,
  planWaves,
  specDisplayName,
  type SpecTask,
} from '../dashboard/review/specs.js';
import { repoRoot } from '../run/discover.js';
import type { Command, CommandContext } from './types.js';
import { command as dispatchCommand } from './dispatch.js';

export type Dispatcher = (ctx: CommandContext) => Promise<{ code: number; stdout: string; stderr: string }>;

async function defaultDispatcher(ctx: CommandContext): Promise<{ code: number; stdout: string; stderr: string }> {
  // Capture stdout and stderr
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    stderr += args.map(String).join(' ') + '\n';
  };
  let code = 2;
  try {
    code = await dispatchCommand.run(ctx);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { code, stdout, stderr };
}

interface DispatchOutcome {
  kind?: string;
  summary?: string;
}

interface DispatchJsonResult {
  scheduled: boolean;
  outcome?: DispatchOutcome;
  attempts?: unknown[];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isDispatchOutcome(value: unknown): value is DispatchOutcome {
  if (!isRecord(value)) return false;
  return (
    (value.kind === undefined || typeof value.kind === 'string') &&
    (value.summary === undefined || typeof value.summary === 'string')
  );
}

// The dispatcher's stdout is produced by a subprocess, so the payload is
// checked field by field before anything reads it.
function isDispatchJsonResult(value: unknown): value is DispatchJsonResult {
  if (!isRecord(value)) return false;
  if (typeof value.scheduled !== 'boolean') return false;
  if (value.outcome !== undefined && !isDispatchOutcome(value.outcome)) return false;
  return value.attempts === undefined || isUnknownArray(value.attempts);
}

export async function runMiddle(
  ctx: CommandContext,
  dispatcher: Dispatcher = defaultDispatcher
): Promise<number> {
  const { argv } = ctx;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: cyv middle <spec>

Drive a spec to completion by dispatching its tasks one wave at a time,
re-dispatching once on gate failures, and recording the outcome.`);
    return 0;
  }

  const query = argv.find((arg) => !arg.startsWith('-'));
  if (query === undefined) {
    console.error('middle needs a spec to run.');
    return 2;
  }

  const root = await repoRoot(ctx.cwd);
  const specs = await findSpecs(root);
  
  if (specs.length === 0) {
    console.error('No specs found.');
    return 2;
  }

  const needle = query.toLowerCase();
  const exact = specs.filter((s) => s.id.toLowerCase() === needle || s.id.slice(0, 4) === needle);
  const matches = exact.length > 0 ? exact : specs.filter((s) => s.id.toLowerCase().includes(needle));

  if (matches.length === 0) {
    console.error(`No spec matches "${query}".`);
    return 2;
  }
  if (matches.length > 1) {
    console.error(`Ambiguous spec "${query}".`);
    return 2;
  }

  const spec = matches[0];
  if (spec === undefined) {
    return 2;
  }

  if (spec.tasksPath === null) {
    console.error(`Spec ${spec.id} has no tasks.md.`);
    return 2;
  }

  const parsed = await parseTasks(root, spec.tasksPath, spec.id);
  const allTasks = parsed.sections.flatMap((s) => s.tasks);
  const openTasks = allTasks.filter((t) => !t.done);

  if (openTasks.length === 0) {
    console.log(`Spec ${spec.id} has no open tasks.`);
    return 0;
  }

  const planned = planWaves(openTasks, allTasks);
  const waves = [...new Set(planned.map((t) => t.wave))].sort((a, b) => a - b);
  
  const records: Record<string, { outcome: string, summary: string, attempts: number }> = {};
  let allPassed = true;

  for (const wave of waves) {
    if (wave === 0) {
      console.log(`Wave 0 has blocked tasks. Stopping.`);
      allPassed = false;
      break;
    }

    const tasksInWave = planned.filter((t) => t.wave === wave);
    console.log(`Dispatching wave ${wave}...`);

    for (const task of tasksInWave) {
      // Find the full SpecTask for the gates
      const fullTask = allTasks.find(t => t.id === task.id);
      if (!fullTask) continue;

      const brief = `Implement ${task.id}: ${task.title} for spec ${spec.id}`;
      const dispatchArgs = ['--task', brief, '--json'];
      
      if (task.executor && task.executor !== 'unknown') {
        dispatchArgs.push('--lane', task.executor);
      }
      if (task.kind) {
        dispatchArgs.push('--kind', task.kind);
      }
      for (const file of task.files) {
        dispatchArgs.push('--own', file);
      }
      
      const gatesStr = fullTask.gates || '';
      const gates = gatesStr.split(',').map(g => g.trim()).filter(g => g !== '');
      for (const gate of gates) {
        dispatchArgs.push('--gate', gate);
      }

      dispatchArgs.push('--max-attempts', '2'); // "re-dispatches once on a gate failure"

      const subCtx: CommandContext = {
        cwd: ctx.cwd,
        argv: dispatchArgs,
        env: ctx.env,
      };

      const result = await dispatcher(subCtx);
      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(result.stdout);
      } catch (e) {
        console.error(`Failed to parse dispatch output for ${task.id}: ${result.stdout}`);
        console.error(result.stderr);
        records[task.id] = { outcome: 'error', summary: 'Failed to parse JSON', attempts: 0 };
        allPassed = false;
        continue;
      }

      if (!isDispatchJsonResult(parsedOutput)) {
        console.error(`Invalid dispatch output for ${task.id}: unexpected shape`);
        records[task.id] = { outcome: 'error', summary: 'Invalid JSON', attempts: 0 };
        allPassed = false;
        continue;
      }

      if (!parsedOutput.scheduled) {
        console.error(`Task ${task.id} was refused scheduling: no lane free to dispatch to.`);
        records[task.id] = { outcome: 'refused', summary: 'No free lane', attempts: 0 };
        allPassed = false;
        // Break out of the task loop, then we'll break the wave loop below
        break;
      }

      const kind = parsedOutput.outcome?.kind ?? 'unknown';
      const summary = parsedOutput.outcome?.summary ?? 'no summary';
      const attempts = parsedOutput.attempts?.length ?? 0;
      records[task.id] = {
        outcome: kind,
        summary: summary,
        attempts
      };

      if (kind !== 'succeeded') {
        allPassed = false;
      }
    }
    
    // Check if wave succeeded before moving to next wave
    if (!allPassed) {
      break;
    }
  }

  console.log(`\nRecord for spec ${spec.id}:`);
  for (const [taskId, record] of Object.entries(records)) {
    console.log(`  ${taskId}: ${record.outcome} (${record.attempts} attempt(s)) - ${record.summary}`);
  }
  
  const remaining = openTasks.filter(t => {
    const record = records[t.id];
    return record === undefined || record.outcome !== 'succeeded';
  });
  if (remaining.length > 0) {
    console.log(`\nRemaining unfinished tasks: ${remaining.map(t => t.id).join(', ')}`);
  } else {
    console.log(`\nAll tasks completed successfully.`);
  }

  return allPassed ? 0 : 1;
}

export const command: Command = { run: runMiddle };
