import picomatch from 'picomatch';
import type { RuleManifest, RuleSettings, Severity } from '../protocol/index.js';
import type { CheckYourVibeConfig, RuleOverride } from './types.js';
import { ConfigError } from './load.js';

/** Return the pack tags a rule manifest carries, currently a single optional `pack`. */
function rulePacks(rule: RuleManifest): string[] {
  return typeof rule.pack === 'string' ? [rule.pack] : [];
}

function isValidSeverity(value: unknown): value is Severity {
  return value === 'error' || value === 'warning';
}

/**
 * Merge a sequence of `rules`-shaped layers into one, later layers replacing
 * earlier ones' entries for the same rule id outright.
 *
 * This is a full replacement per rule id rather than a merge of `severity` and
 * options across layers: a later override "wins" the same way a single
 * `rules` block's last-written key would. Layer order is base `rules` first,
 * then each matching `overrides` entry in array order, so the last matching
 * override for a rule id determines its final settings.
 */
function mergeRuleLayers(layers: Record<string, RuleOverride>[]): Record<string, RuleOverride> {
  const merged: Record<string, RuleOverride> = {};

  for (const layer of layers) {
    for (const [ruleId, override] of Object.entries(layer)) {
      merged[ruleId] = override;
    }
  }

  return merged;
}

/**
 * Resolve the effective set of rules from an already-merged rules record.
 *
 * Pack membership starts the active set; `mergedRules` then disables,
 * overrides severity, or passes rule options through. Any rule id that
 * appears in `mergedRules` but not in `availableRules` is a configuration
 * error.
 */
function resolveFromMergedRules(
  availableRules: RuleManifest[],
  requestedPacks: Set<string>,
  mergedRules: Record<string, RuleOverride>,
): Map<string, RuleSettings> {
  const availableById = new Map(availableRules.map((rule) => [rule.id, rule]));

  const active = new Set<string>();

  for (const rule of availableRules) {
    if (rulePacks(rule).some((pack) => requestedPacks.has(pack))) {
      active.add(rule.id);
    }
  }

  for (const [ruleId, override] of Object.entries(mergedRules)) {
    if (!availableById.has(ruleId)) {
      throw new ConfigError('UNKNOWN_RULE', `Unknown rule "${ruleId}" in configuration.`);
    }

    if (override === false) {
      active.delete(ruleId);
    } else {
      active.add(ruleId);
    }
  }

  const resolved = new Map<string, RuleSettings>();

  for (const ruleId of active) {
    const rule = availableById.get(ruleId);
    if (rule === undefined) {
      throw new ConfigError('UNKNOWN_RULE', `Rule "${ruleId}" disappeared while resolving.`);
    }

    const override = mergedRules[ruleId];
    let severity = rule.severity;
    let options: Record<string, unknown> = {};

    if (override !== undefined && override !== false) {
      const { severity: overrideSeverity, ...rest } = override;

      if (overrideSeverity !== undefined) {
        if (!isValidSeverity(overrideSeverity)) {
          throw new ConfigError(
            'INVALID',
            `Rule "${ruleId}" has an invalid severity: ${String(overrideSeverity)}.`,
          );
        }
        severity = overrideSeverity;
      }

      options = rest;
    }

    resolved.set(ruleId, { severity, ...options });
  }

  return resolved;
}

/**
 * Resolve the effective set of rules for an analyzer request, ignoring
 * per-path `overrides`.
 *
 * This is the base rule set — the same for every file in the run. Callers
 * that need to honor `config.overrides` for a specific file must use
 * {@link resolveRulesForFile} instead; this function only exists so callers
 * that resolve once per run (rather than once per file) keep working.
 */
export function resolveRules(
  config: CheckYourVibeConfig,
  availableRules: RuleManifest[],
): Map<string, RuleSettings> {
  return resolveFromMergedRules(availableRules, new Set(config.packs), config.rules);
}

/**
 * Resolve the effective set of rules for one specific file, honoring
 * `config.overrides`.
 *
 * `repoRelativePath` must be repo-relative with forward slashes, matching the
 * convention `packages/core/src/run/route.ts` uses for analyzer routing.
 * Overrides are applied in array order after the base `rules`; an override
 * whose `files` globs do not match `repoRelativePath` contributes nothing, and
 * a later matching override wins over an earlier one for the same rule id.
 *
 * Prefer this over {@link resolveRules} for any caller that analyzes a
 * specific file — it is the only variant that reflects a per-path posture
 * such as disabling `no-console` under a CLI's `src/cli/**`.
 */
export function resolveRulesForFile(
  config: CheckYourVibeConfig,
  availableRules: RuleManifest[],
  repoRelativePath: string,
): Map<string, RuleSettings> {
  const layers: Record<string, RuleOverride>[] = [config.rules];

  for (const override of config.overrides ?? []) {
    const isMatch = picomatch(override.files, { dot: true });
    if (isMatch(repoRelativePath)) {
      layers.push(override.rules);
    }
  }

  const mergedRules = mergeRuleLayers(layers);
  return resolveFromMergedRules(availableRules, new Set(config.packs), mergedRules);
}
