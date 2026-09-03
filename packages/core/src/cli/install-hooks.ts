import { repoRoot } from '../run/discover.js';
import { DRIFT_SKIP_ENV, applyInstall, planInstall } from '../backstop/install.js';
import { assertCyvCommandResolvable, resolveCyvCommand } from './init.js';
import type { Command, CommandContext } from './types.js';

/**
 * `cyv install-hooks` — install the git pre-commit backstop.
 *
 * This is the only enforcement layer that does not depend on an agent choosing
 * to cooperate: it runs whoever or whatever wrote the code. Agent hooks are the
 * fast feedback loop and are allowed to degrade; this one is the guarantee.
 *
 * It refuses to replace a pre-commit hook it does not own unless `--force` is
 * given, because silently clobbering a team's existing hook is how a tool gets
 * uninstalled.
 *
 * `--with-drift-check` adds a second gate to the generated hook: `cyv doctor`,
 * whose non-zero exit means the applied agent glue no longer matches what
 * `cyv init` would write. It is off unless asked for, and the generated script
 * carries its own escapes — see `driftCheckScript` in `backstop/install.ts`.
 */
async function run(ctx: CommandContext): Promise<number> {
  // ctx.argv is already the arguments after the command name — the dispatcher
  // strips it. Slicing again here silently discarded every flag.
  const force = ctx.argv.includes('--force');
  const dryRun = ctx.argv.includes('--dry-run');
  const driftCheck = ctx.argv.includes('--with-drift-check');

  const root = await repoRoot(ctx.cwd);
  const cyvCommand = await resolveCyvCommand();
  await assertCyvCommandResolvable(cyvCommand);
  const plan = await planInstall(root, cyvCommand);

  const label =
    plan.manager === 'raw'
      ? 'git hooks'
      : plan.manager === 'husky'
        ? 'husky'
        : 'lefthook';

  process.stdout.write(`checkyourvibe pre-commit hook (${label})\n`);
  process.stdout.write(`  target: ${plan.path}\n`);
  process.stdout.write(
    driftCheck
      ? '  drift check: on. The hook runs `cyv doctor` first and refuses the commit when the applied agent glue has drifted.\n'
      : '  drift check: off. Pass --with-drift-check to have the hook also run `cyv doctor` and refuse the commit on drift.\n',
  );

  if (plan.action === 'conflict' && !force) {
    process.stderr.write(
      `\n  A pre-commit hook already exists there and was not created by checkyourvibe.\n` +
        `  Nothing was written. Inspect it, then re-run with --force to replace it,\n` +
        `  or add the check to your existing hook by hand:\n\n` +
        `      ${cyvCommand} check --staged --strict\n\n`,
    );
    return 1;
  }

  if (dryRun) {
    const verb = plan.action === 'update' ? 'update' : 'create';
    process.stdout.write(`  would ${verb} it (--dry-run, nothing written)\n`);
    return 0;
  }

  await applyInstall(plan, cyvCommand, { force, driftCheck });

  process.stdout.write(
    plan.action === 'update'
      ? '  updated.\n'
      : plan.action === 'conflict'
        ? '  replaced (--force).\n'
        : '  created.\n',
  );
  process.stdout.write(
    `\n  Commits now run: cyv check --staged --strict\n` +
      `  (with --since-baseline when a baseline is present, so existing debt does not block every commit)\n`,
  );

  if (driftCheck) {
    process.stdout.write(
      `  Before that, cyv doctor. A commit is refused when the applied agent glue has drifted\n` +
        `  from what \`cyv init\` would write. Three ways past it, in order of how much they skip:\n` +
        `    ${DRIFT_SKIP_ENV}=1 git commit    — skips the drift check for one commit\n` +
        `    it is skipped by itself         — mid-rebase, mid-merge, mid-cherry-pick, mid-revert, mid-bisect\n` +
        `    cyv install-hooks               — re-run without --with-drift-check to remove it entirely\n`,
    );
  }

  process.stdout.write(
    `  git commit --no-verify bypasses all of it. CI is the layer that cannot be bypassed —\n` +
      `  run \`cyv install-ci\` to see whether this repository has one and what gate it would get.\n`,
  );

  return 0;
}

export const command: Command = { run };
