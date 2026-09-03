import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { watch, type WatchRunResult } from '../run/watch.js';
import { loadConfig } from '../config/load.js';
import { resolveRules } from '../config/resolve.js';
import { loadAnalyzers, allRules } from '../registry/load.js';
import { validateRules } from '../guidance/validate.js';
import { renderText, renderTextPlain } from '../report/text.js';
import type { RunReport } from '../report/types.js';

interface ParsedWatchArgs {
  paths: string[];
  noColor: boolean;
}

function parseArgs(argv: string[]): ParsedWatchArgs {
  const paths: string[] = [];
  let noColor = false;

  for (const arg of argv) {
    if (arg === '--no-color') {
      noColor = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag "${arg}" for cyv watch.`);
    } else {
      paths.push(arg);
    }
  }

  return { paths, noColor };
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toReport(result: WatchRunResult, ruleCategories: Record<string, string>): RunReport {
  return {
    violations: result.violations,
    skipped: result.skipped,
    diagnostics: result.diagnostics,
    filesChecked: result.changedFiles.length,
    mode: 'watch',
    projectRulesSkipped: [],
    strict: false,
    ruleCategories,
  };
}

/**
 * Resolve a friendly, absolute description of what's being watched, defaulting
 * to the whole repository when no paths are given. This is wider than `cyv
 * check`'s own default, which is `working` — the files git reports as changed.
 * A watcher is told which tree to observe, and a file has to be watched before
 * an edit to it can be noticed.
 */
function resolveWatchTargets(root: string, paths: string[]): string[] {
  if (paths.length === 0) {
    return [root];
  }
  return paths.map((p) => (isAbsolute(p) ? p : resolvePath(root, p)));
}

/**
 * Wait until interrupted (Ctrl-C, or the process being asked to terminate),
 * then close the watch handle. This promise is what keeps the process alive
 * between runs; without it the command would return as soon as it started.
 */
function waitForInterrupt(): Promise<void> {
  return new Promise((resolvePromise) => {
    const stop = (): void => resolvePromise();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    let noColor: boolean;

    try {
      const parsed = parseArgs(ctx.argv);
      noColor = parsed.noColor;

      const root = await repoRoot(ctx.cwd);
      const config = await loadConfig(root);
      const manifests = await loadAnalyzers(config.analyzers, root);
      const catalog = allRules(manifests);
      validateRules(catalog);
      const resolved = resolveRules(config, catalog);

      const ruleCategories: Record<string, string> = {};
      for (const rule of catalog) {
        ruleCategories[rule.id] = rule.category;
      }

      const targets = resolveWatchTargets(root, parsed.paths);
      const ruleCount = resolved.size;

      // A watcher that silently watches nothing is the failure mode to avoid:
      // naming the targets and the active rule count up front is the only
      // signal a user gets that this run is actually doing something.
      console.log(
        `cyv watch: watching ${targets.join(', ')} (${ruleCount} rule${ruleCount === 1 ? '' : 's'} active)`,
      );

      const handle = await watch({
        repoRoot: root,
        paths: targets,
        onRun(result: WatchRunResult): void {
          const report = toReport(result, ruleCategories);
          const output = noColor ? renderTextPlain(report) : renderText(report);
          console.log(output);
        },
        onError(error: unknown): void {
          // A failed run must not end the session — an analyzer can fail for a
          // reason that goes away, and a watch that exits on the first bad run
          // is a watch nobody leaves running. It must not be silent either:
          // the whole value of watching is knowing the last run happened.
          console.error(`cyv watch: run failed — ${messageFor(error)}`);
          console.error('cyv watch: still watching; the next change will run again.');
        },
      });

      await waitForInterrupt();
      await handle.close();
      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
