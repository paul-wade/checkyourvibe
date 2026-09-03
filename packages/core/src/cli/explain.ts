import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { loadConfig } from '../config/load.js';
import { resolveRules } from '../config/resolve.js';
import { loadAnalyzers, allRules } from '../registry/load.js';
import { validateRules } from '../guidance/validate.js';
import { renderTerminal } from '../guidance/render.js';
import { evidenceLabel } from '../guidance/templates.js';
import type { AnalyzerManifest, RuleManifest } from '../protocol/index.js';

interface ParsedExplainArgs {
  ruleId?: string;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedExplainArgs {
  let ruleId: string | undefined;
  let json = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag "${arg}" for cyv explain.`);
    } else if (ruleId === undefined) {
      ruleId = arg;
    } else {
      throw new Error(`cyv explain takes at most one rule id, got an extra argument "${arg}".`);
    }
  }

  return ruleId !== undefined ? { ruleId, json } : { json };
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listAvailable(catalog: RuleManifest[]): string {
  const ids = catalog.map((rule) => rule.id).sort();
  if (ids.length === 0) {
    return 'No rules are available.';
  }
  return ['Available rules:', ...ids.map((id) => `  ${id}`)].join('\n');
}

/**
 * Which analyzer owns each rule.
 *
 * `allRules(manifests)` flattens this away — it exists only to build the flat
 * catalog `explain` looks rule ids up in — so it has to be rebuilt here the
 * same way `run/check.ts` and `cli/dashboard.ts` each already do, rather than
 * losing the association a third time.
 */
function ruleAnalyzerMap(manifests: AnalyzerManifest[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const manifest of manifests) {
    for (const rule of manifest.rules) {
      map.set(rule.id, manifest.id);
    }
  }
  return map;
}

interface InboundNotFix {
  /** The id of the rule that names `ruleId` as a dead end. */
  from: string;
  pattern: string;
  because: string;
}

/**
 * Every OTHER rule in the catalog whose `notFixes` names `ruleId` as its
 * target — the inbound half of the interlock. `cyv explain <id>` already
 * prints its own outbound `notFixes`; never showing which rules point back AT
 * it understates how constrained the rule actually is (spec 0032,
 * Requirement 2.5).
 */
function inboundNotFixes(ruleId: string, catalog: RuleManifest[]): InboundNotFix[] {
  const inbound: InboundNotFix[] = [];
  for (const candidate of catalog) {
    for (const notFix of candidate.notFixes) {
      if (notFix.rule === ruleId) {
        inbound.push({ from: candidate.id, pattern: notFix.pattern, because: notFix.because });
      }
    }
  }
  return inbound.sort((a, b) => a.from.localeCompare(b.from));
}

function metaLines(rule: RuleManifest, analyzerId: string | undefined, enabled: boolean): string[] {
  const enabledLine = enabled
    ? 'Enabled: yes'
    : "Enabled: no — not active in this repository's configuration";
  return [
    `Pack: ${rule.pack ?? 'none'}`,
    `Category: ${rule.category}`,
    `Severity: ${rule.severity}`,
    `Scope: ${rule.scope}`,
    `Evidence: ${evidenceLabel(rule)}`,
    `Analyzer: ${analyzerId ?? 'unknown — not owned by any configured analyzer'}`,
    enabledLine,
  ];
}

function inboundLines(inbound: InboundNotFix[]): string[] {
  if (inbound.length === 0) {
    return ['None recorded.'];
  }
  return inbound.map((n) => `${n.from}: ${n.pattern} — ${n.because}`);
}

/**
 * The full human-readable view of a rule: id, the metadata `guidanceSections`
 * does not carry (pack/category/severity/scope/evidence/analyzer/enabled),
 * its guidance sections (from the one shared renderer every surface uses),
 * and its inbound `notFixes`.
 *
 * This builds around `renderTerminal(rule)` rather than re-deriving the
 * guidance text: only the rule id line it prints is dropped (this function
 * prints its own, ahead of the metadata block), everything else — Summary,
 * Why, Allowed fixes, Not fixes, Example — comes from the same call every
 * other surface makes.
 */
function renderExplain(
  rule: RuleManifest,
  analyzerId: string | undefined,
  enabled: boolean,
  inbound: InboundNotFix[],
): string {
  const guidanceLines = renderTerminal(rule).split('\n').slice(1);
  return [
    rule.id,
    '',
    ...metaLines(rule, analyzerId, enabled),
    ...guidanceLines,
    '',
    'Inbound notFixes (other rules that would trip this one)',
    ...inboundLines(inbound),
  ].join('\n');
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const { ruleId, json } = parseArgs(ctx.argv);

      const root = await repoRoot(ctx.cwd);
      const config = await loadConfig(root);
      const manifests = await loadAnalyzers(config.analyzers, root);
      const catalog = allRules(manifests);
      validateRules(catalog);

      const resolved = resolveRules(config, catalog);
      const enabledIds = new Set(resolved.keys());

      if (ruleId === undefined) {
        const sorted = [...catalog].sort((a, b) => a.id.localeCompare(b.id));

        if (json) {
          // Unchanged: the enabled set only, as full manifests. `--json` is a
          // programmatic surface an existing caller may already depend on to
          // mean "what this repository's configuration turns on"; the
          // no-argument gap this fixes (Requirement 2.4) is specifically that
          // a disabled rule's id was undiscoverable from the *human-readable*
          // listing.
          const rules = sorted.filter((rule) => enabledIds.has(rule.id));
          console.log(JSON.stringify(rules, null, 2));
          return 0;
        }

        if (sorted.length === 0) {
          console.log('No rules are available.');
          return 0;
        }

        console.log(
          `${enabledIds.size} of ${sorted.length} rule(s) enabled in this repository's configuration:`,
        );
        for (const rule of sorted) {
          const marker = enabledIds.has(rule.id) ? '[enabled] ' : '[disabled]';
          console.log(`${marker} ${rule.id}  —  ${rule.summary}`);
        }
        return 0;
      }

      const rule = catalog.find((candidate) => candidate.id === ruleId);
      if (rule === undefined) {
        console.error(`Unknown rule "${ruleId}".`);
        console.error(listAvailable(catalog));
        return 2;
      }

      if (json) {
        console.log(JSON.stringify(rule, null, 2));
        return 0;
      }

      const analyzerId = ruleAnalyzerMap(manifests).get(rule.id);
      const inbound = inboundNotFixes(rule.id, catalog);
      console.log(renderExplain(rule, analyzerId, enabledIds.has(rule.id), inbound));
      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
