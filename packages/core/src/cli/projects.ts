import {
  addProject,
  defaultRegistryPath,
  listProjects,
  removeProject,
} from '../dashboard/projects.js';
import type { Command, CommandContext } from './types.js';

const USAGE = `Usage: cyv projects [--add <path> | --remove <path>] [--json]

The projects \`cyv dashboard\` serves, kept in ${defaultRegistryPath()}.

  (no flags)          List every registered project and whether it is still there.
  --add <path>        Register a directory. It must hold a checkyourvibe.json.
  --remove <path>     Forget a directory. Nothing in it is touched.
  --json              Print the list as JSON.

Registration is explicit: nothing scans a disk and nothing infers a project
from activity. A registered path that has moved is reported, not dropped.`;

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined ? undefined : value;
}

/**
 * `cyv projects` — the registry behind the dashboard's project selector
 * (spec 0040 Requirement 8.1, spec 0035 Requirement 2).
 */
async function run(ctx: CommandContext): Promise<number> {
  const { argv } = ctx;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  if (argv.includes('--add')) {
    const target = valueAfter(argv, '--add');
    if (target === undefined) {
      console.error('--add needs a path.\n\n' + USAGE);
      return 2;
    }
    const result = await addProject(target);
    console.log(result.added ? `Registered ${result.path}` : `${result.path} was already registered.`);
    return 0;
  }

  if (argv.includes('--remove')) {
    const target = valueAfter(argv, '--remove');
    if (target === undefined) {
      console.error('--remove needs a path.\n\n' + USAGE);
      return 2;
    }
    const result = await removeProject(target);
    console.log(result.removed ? `Removed ${result.path}` : `${result.path} was not registered.`);
    return 0;
  }

  const projects = await listProjects();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(projects, null, 2));
    return 0;
  }

  if (projects.length === 0) {
    console.log('No project is registered. Register one with `cyv projects --add <path>`.');
    return 0;
  }

  for (const project of projects) {
    if (project.status === 'ok') {
      console.log(`[ok]       ${project.path}`);
      continue;
    }
    const why = project.exists ? 'present, but has no checkyourvibe.json' : 'directory is missing';
    console.log(`[missing]  ${project.path} — ${why}`);
  }
  return 0;
}

export const command: Command = { run };
