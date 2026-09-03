/**
 * Rule-catalog lookups shared by `list_rules` and `explain_rule`.
 *
 * Reuses the same config/registry pieces `cyv explain` is built from, so an
 * MCP client sees the identical catalog and enabled set a terminal user would.
 */
import { repoRoot } from '../run/discover.js';
import { loadConfig } from '../config/load.js';
import { resolveRules } from '../config/resolve.js';
import { loadAnalyzers, allRules } from '../registry/load.js';
import { validateRules } from '../guidance/validate.js';
import type { RuleManifest, RuleSettings } from '../protocol/index.js';

export interface RuleSummary {
  id: string;
  category: string;
  severity: string;
  summary: string;
}

interface Catalog {
  all: RuleManifest[];
  resolved: Map<string, RuleSettings>;
}

async function loadCatalog(cwd: string): Promise<Catalog> {
  const root = await repoRoot(cwd);
  const config = await loadConfig(root);
  const manifests = await loadAnalyzers(config.analyzers, root);
  const catalog = allRules(manifests);
  validateRules(catalog);

  const resolved = resolveRules(config, catalog);
  return { all: catalog, resolved };
}

/** Every enabled rule, summarized. */
export async function listEnabledRules(cwd: string): Promise<RuleSummary[]> {
  const { all, resolved } = await loadCatalog(cwd);
  const byId = new Map(all.map((rule) => [rule.id, rule]));

  const summaries: RuleSummary[] = [];
  for (const id of [...resolved.keys()].sort()) {
    const rule = byId.get(id);
    const settings = resolved.get(id);
    if (rule === undefined || settings === undefined) {
      continue;
    }
    summaries.push({
      id: rule.id,
      category: rule.category,
      severity: settings.severity,
      summary: rule.summary,
    });
  }
  return summaries;
}

/**
 * Find a rule's full manifest (guidance included) by id.
 *
 * Looks across the whole catalog, not just the enabled set — matching
 * `cyv explain <rule>`, which is useful for a rule an agent is curious about
 * even if the current configuration has it turned off.
 */
export async function findRule(cwd: string, ruleId: string): Promise<RuleManifest | undefined> {
  const { all } = await loadCatalog(cwd);
  return all.find((rule) => rule.id === ruleId);
}
