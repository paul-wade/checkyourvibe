/**
 * `cyv plan <spec>` — the waves a spec's open tasks fall into (spec 0041
 * Requirement 3.3).
 *
 * This dispatches nothing and writes nothing. It answers one question the
 * orchestrating session could previously only answer by reading `tasks.md` and
 * comparing `files=` lines by eye: which of these can run at the same time.
 *
 * The grouping is `planWaves`, the same function the dashboard's "next up"
 * renders (spec 0040 Decision 4), so the page and the terminal cannot disagree
 * about what is ready. A task is blocked when a dependency it names is still
 * open; unblocked tasks are packed into the first wave whose members' file
 * scopes do not overlap, which is the rule the scheduler will actually enforce
 * when the dispatches are opened.
 */
import {
  findSpecs,
  parseTasks,
  planWaves,
  specDisplayName,
  type SpecTask,
} from '../dashboard/review/specs.js';
import type { NextTask } from '../dashboard/view-model.js';
import { repoRoot } from '../run/discover.js';
import type { Command, CommandContext } from './types.js';

const USAGE = `Usage: cyv plan <spec> [--json]

The waves a spec's open tasks fall into: which can run at once, and which are
waiting on another task.

  <spec>     A spec id or any unambiguous part of one — 0041, or orchestrator.
  --json     Print the plan as JSON.

Nothing is dispatched and nothing is written. A wave is a set of open tasks
whose declared file scopes do not overlap and whose named dependencies are all
closed, so every task in one wave can be dispatched together. Wave 0 is the
blocked ones, listed with what they are waiting for.`;

interface PlannedSpec {
  specId: string;
  displayName: string;
  tasksPath: string;
  tasks: NextTask[];
}

/**
 * Resolve a user's argument to one spec.
 *
 * An exact id wins outright, so `0041` is never ambiguous with a spec whose
 * name happens to contain it. Otherwise the argument is matched as a substring
 * and an ambiguous match is refused by naming every candidate — guessing which
 * of two specs was meant is the kind of silent choice this project treats as a
 * defect.
 */
function resolveSpecId(query: string, ids: readonly string[]): string[] {
  const needle = query.toLowerCase();
  const exact = ids.filter((id) => id.toLowerCase() === needle || id.slice(0, 4) === needle);
  if (exact.length > 0) return exact;
  return ids.filter((id) => id.toLowerCase().includes(needle));
}

async function planFor(repo: string, query: string): Promise<PlannedSpec | string> {
  const specs = await findSpecs(repo);
  if (specs.length === 0) {
    return 'No spec folders were found under docs/specs.';
  }

  const matches = resolveSpecId(query, specs.map((spec) => spec.id));
  if (matches.length === 0) {
    return `No spec matches "${query}". Known specs: ${specs.map((s) => s.id).join(', ')}`;
  }
  if (matches.length > 1) {
    return `"${query}" matches ${matches.length} specs: ${matches.join(', ')}. Name one.`;
  }

  const specId = matches[0] ?? '';
  const location = specs.find((spec) => spec.id === specId);
  if (location === undefined || location.tasksPath === null) {
    return (
      `${specId} has no tasks.md, so there is nothing to plan. ` +
      'Requirements, then design, then tasks — see AGENTS.md.'
    );
  }

  const parsed = await parseTasks(repo, location.tasksPath, specId);
  const all: SpecTask[] = parsed.sections.flatMap((section) => section.tasks);
  const open = all.filter((task) => !task.done);

  return {
    specId,
    displayName: specDisplayName(specId),
    tasksPath: location.tasksPath,
    tasks: planWaves(open, all),
  };
}

function renderHuman(plan: PlannedSpec): string[] {
  if (plan.tasks.length === 0) {
    return [`  ${plan.displayName} — every task is done. Nothing to plan.`];
  }

  const lines: string[] = [`  ${plan.displayName} — ${plan.tasks.length} open task(s)`, ''];
  const waves = [...new Set(plan.tasks.map((task) => task.wave))].sort((a, b) => a - b);

  for (const wave of waves) {
    const inWave = plan.tasks.filter((task) => task.wave === wave);
    if (wave === 0) {
      lines.push(`  blocked — ${inWave.length} task(s), waiting on work that is still open`);
    } else {
      const together = inWave.length === 1 ? 'on its own' : `${inWave.length} at once`;
      lines.push(`  wave ${wave} — ${together}`);
    }

    for (const task of inWave) {
      lines.push(`    ${task.id}  ${task.title}`);
      // A task whose `_Exec:` line omits `kind=` renders as "lane self" rather
      // than "lane self, " — an empty field should look absent, not blank.
      const kind = task.kind.trim();
      lines.push(kind === '' ? `      lane ${task.executor}` : `      lane ${task.executor}, ${kind}`);
      if (task.blockedBy.length > 0) {
        lines.push(`      waiting on ${task.blockedBy.join(', ')}`);
      }
      lines.push(`      ${task.files.length === 0 ? 'declares no files — shares a wave with nothing' : task.files.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('  Nothing was dispatched. `cyv dispatch` opens one of these.');
  return lines;
}

/** `cyv plan` — spec 0041 Requirement 3.3. */
async function run(ctx: CommandContext): Promise<number> {
  const { argv } = ctx;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const query = argv.find((arg) => !arg.startsWith('-'));
  if (query === undefined) {
    console.error('plan needs a spec to plan.\n\n' + USAGE);
    return 2;
  }

  const root = await repoRoot(ctx.cwd);
  const plan = await planFor(root, query);

  if (typeof plan === 'string') {
    console.error(plan);
    return 1;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  console.log(['', ...renderHuman(plan)].join('\n'));
  return 0;
}

export const command: Command = { run };
