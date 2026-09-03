/**
 * `cyv baseline` — take (or refresh) the baseline, and report on it.
 *
 * This command is the explicit path for taking or refreshing a baseline.
 * `cyv init` may also write an initial baseline after its own confirmation
 * during adoption (see `cli/init.ts`), but it reuses the same `writeBaseline`
 * helper and the same `confirm` logic. `cyv check` never touches this file's
 * exports for writing (Requirement 1.6): writing a baseline is always a
 * deliberate, confirmed act, never a side effect of a check run.
 */
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import type { Command, CommandContext } from './types.js';
import { repoRoot as findRepoRoot } from '../run/discover.js';
import { runCheck } from '../run/check.js';
import { loadConfig } from '../config/load.js';
import { resolveRules } from '../config/resolve.js';
import { allRules, loadAnalyzers } from '../registry/load.js';
import type { Suppression } from '../config/types.js';
import {
  buildStatusReport,
  formatStatusReport,
  loadSuppressions,
  partitionViolations,
  readBaseline,
  validateSuppressionRules,
  writeBaseline,
} from '../baseline/index.js';

const execFileAsync = promisify(execFile);

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ParsedBaselineArgs {
  status: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedBaselineArgs {
  let status = false;
  let yes = false;

  for (const arg of argv) {
    if (arg === '--status') {
      status = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else {
      throw new Error(`Unknown argument "${arg}" for cyv baseline.`);
    }
  }

  return { status, yes };
}

async function currentCommit(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  return stdout.trim();
}

/**
 * Every rule id the currently-configured analyzers know about, and the
 * subset actually enabled by `checkyourvibe.json`. `--status` needs both:
 * the full set to validate suppressions against (Requirement 3.5 applies to
 * any known rule, not just an enabled one), the enabled set to spot baseline
 * entries whose rule has since been turned off (Requirement 5.3).
 */
async function loadRuleIds(root: string): Promise<{ known: Set<string>; enabled: Set<string> }> {
  const config = await loadConfig(root);
  const manifests = await loadAnalyzers(config.analyzers, root);
  const catalog = allRules(manifests);
  const known = new Set(catalog.map((rule) => rule.id));
  const enabled = new Set(resolveRules(config, catalog).keys());
  return { known, enabled };
}

const PROMPT_TIMEOUT_SENTINEL = '__CYV_CONFIRM_TIMEOUT__';

/**
 * Confirmation is read from stdin rather than assumed, matching `cyv init`'s
 * convention: `--yes` skips the prompt outright, and a non-interactive
 * invocation without it refuses rather than guessing, because there is no
 * other way for it to signal consent.
 *
 * The prompt is guarded by a timeout so a TTY that is present but will never
 * supply input (for example, a test runner that inherited a terminal) does not
 * leave the readline interface open forever. The interface is closed on every
 * path: success, timeout, or rejection.
 */
export async function confirm(yes: boolean, prompt: string, refusalMessage?: string): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (process.stdin.isTTY !== true) {
    console.error(
      refusalMessage ??
        'Refusing to write the baseline without confirmation: stdin is not a TTY and --yes was not passed. ' +
          'Re-run with --yes to apply non-interactively, or run this interactively to confirm.',
    );
    return false;
  }

  const promptTimeoutMs = Number(process.env.CYV_CONFIRM_TIMEOUT_MS) || 60_000;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await Promise.race([
      rl.question(`${prompt} [y/N] `).catch(() => PROMPT_TIMEOUT_SENTINEL),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          rl.close();
          resolve(PROMPT_TIMEOUT_SENTINEL);
        }, promptTimeoutMs);
      }),
    ]);
    if (answer === PROMPT_TIMEOUT_SENTINEL) {
      console.error('No confirmation received; aborting.');
      return false;
    }
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function runTakeBaseline(root: string, yes: boolean): Promise<number> {
  const existing = await readBaseline(root);
  const { report } = await runCheck({ cwd: root, mode: 'all' });

  const currentCount = report.violations.length;
  console.log(`This run found ${currentCount} violation(s) across the repository.`);

  if (existing !== null) {
    const { fresh, stale } = partitionViolations(report.violations, existing);
    console.log(
      `Replacing the existing baseline (${existing.entries.length} entries, taken ${existing.header.takenAt} ` +
        `against ${existing.header.commit}): ${fresh.length} newly-recorded, ${stale.length} no longer present.`,
    );
  } else {
    console.log('No baseline exists yet; this will create one.');
  }

  // Withheld findings are absent from `report.violations`, so a baseline taken
  // while type resolution is degraded omits them. They are reported as new once
  // the configuration is fixed.
  const withheld = report.withheldFindings ?? 0;
  if (withheld > 0) {
    console.error(
      `Refusing to write the baseline: ${withheld} finding(s) across ${report.withheldFiles ?? 0} file(s) ` +
        'were withheld because type resolution was degraded.',
    );
    for (const reason of report.withheldReasons ?? []) {
      console.error(`  ${reason}`);
    }
    console.error(
      '  Fix the configuration above and run `cyv baseline` again. A baseline taken now would omit ' +
        'these findings, and they would surface as new work once the configuration is fixed.',
    );
    return 2;
  }

  const proceed = await confirm(yes, 'Write the baseline?');
  if (!proceed) {
    console.error('Aborted: not confirmed.');
    return 1;
  }

  const commit = await currentCommit(root);
  await writeBaseline(root, report, commit);
  console.log(`Baseline written: ${currentCount} violation(s) recorded against commit ${commit}.`);
  console.log(
    'These are now deferred, not fixed. They still exist, and every run of `cyv check` continues to know ' +
      'about them; use `cyv baseline --status` to track burn-down.',
  );
  return 0;
}

async function runStatus(root: string): Promise<number> {
  const baseline = await readBaseline(root);
  if (baseline === null) {
    console.log('No baseline recorded. Run `cyv baseline` to take one.');
    return 0;
  }

  const { report } = await runCheck({ cwd: root, mode: 'all' });
  const { known, enabled } = await loadRuleIds(root);

  // Annotated deliberately: a `let` with neither initialiser nor annotation
  // infers `any`, and nothing in the source says `any` — which is precisely the
  // invisible case no-any exists to catch, and did catch here.
  let suppressions: Suppression[];
  try {
    suppressions = await loadSuppressions(root);
    validateSuppressionRules(suppressions, known);
  } catch (err) {
    console.error(messageFor(err));
    return 2;
  }

  const statusReport = buildStatusReport(
    baseline,
    report.violations,
    enabled,
    suppressions,
    root,
    new Date(),
  );
  console.log(formatStatusReport(statusReport).join('\n'));
  return 0;
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const { status, yes } = parseArgs(ctx.argv);
      const root = await findRepoRoot(ctx.cwd);

      return status ? await runStatus(root) : await runTakeBaseline(root, yes);
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
