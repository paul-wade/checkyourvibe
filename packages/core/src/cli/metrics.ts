import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { loadConfig } from '../config/load.js';
import { loadAnalyzers, allRules } from '../registry/load.js';
import { resolveRules } from '../config/resolve.js';
import { readHistory } from '../dashboard/history.js';
import { readBaseline, loadSuppressions } from '../baseline/index.js';
import { buildMetricsReport, formatMetricsReport } from '../metrics/index.js';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseArgs(argv: string[]): { json: boolean } {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else {
      throw new Error(`Unknown argument "${arg}" for cyv metrics.`);
    }
  }
  return { json };
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const { json } = parseArgs(ctx.argv);
      const root = await repoRoot(ctx.cwd);
      const config = await loadConfig(root);
      const manifests = await loadAnalyzers(config.analyzers, root);
      const catalog = allRules(manifests);
      const enabled = resolveRules(config, catalog);
      const enabledRules = catalog.filter((rule) => enabled.has(rule.id));
      const history = await readHistory(root);
      const baseline = await readBaseline(root);
      const suppressions = await loadSuppressions(root);
      const report = buildMetricsReport(enabledRules, catalog, history, baseline, suppressions, new Date());

      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatMetricsReport(report));
      }

      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
