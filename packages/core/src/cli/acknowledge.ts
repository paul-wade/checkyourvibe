import { acknowledgeItem } from '../executor/store.js';
import { repoRoot } from '../run/discover.js';
import type { Command, CommandContext } from './types.js';

const USAGE = `Usage: cyv acknowledge <item-id> [--note <text>]

Take one needs-you item off the dashboard because it needs nothing more. The
id is what the page shows beside the item: a dispatch id, a task id such as
T5010, or a spec number such as 0021. A note is cleared by answering it
(\`cyv comments --record --reply-to <n>\`) rather than here.

The record behind the item is untouched; this appends an acknowledgement to
the dispatch log so the decision survives the session that made it.`;

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined ? undefined : value;
}

/**
 * `cyv acknowledge` — the terminal form of the page's "needs nothing" button
 * (spec 0040 Requirement 2), so an orchestrator clears the list as it goes
 * rather than leaving the owner to.
 */
async function run(ctx: CommandContext): Promise<number> {
  const { argv } = ctx;
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  const itemId = argv.find((arg) => !arg.startsWith('--') && arg !== valueAfter(argv, '--note'));
  if (itemId === undefined) {
    console.error('An item id is required.\n\n' + USAGE);
    return 2;
  }
  const note = valueAfter(argv, '--note');
  const root = await repoRoot(ctx.cwd);
  const entry = await acknowledgeItem(root, {
    itemId,
    acknowledgedAt: new Date().toISOString(),
    ...(note === undefined ? {} : { note }),
  });
  console.log(`Acknowledged ${entry.itemId}; it leaves the needs-you list.`);
  return 0;
}

export const command: Command = { run };
