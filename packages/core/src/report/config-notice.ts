import type { RunReport } from './types.js';

/**
 * The configuration summary printed on every run.
 *
 * States the enabled and available rule counts, names any pack the loaded
 * analyzers do not provide, and names any analyzer contributing no enabled
 * rules. Without it, a configuration that resolves to fewer rules than were
 * asked for produces output indistinguishable from a clean run.
 */
export function configNotice(report: RunReport): string {
  const parts: string[] = [];

  if (report.rulesEnabled !== undefined && report.rulesAvailable !== undefined) {
    const lines: string[] = [
      `  ${report.rulesEnabled} of ${report.rulesAvailable} rule${
        report.rulesEnabled === 1 ? '' : 's'
      } enabled`,
    ];

    if (report.unknownPacks !== undefined && report.unknownPacks.length > 0) {
      for (const pack of report.unknownPacks) {
        lines.push(`  Unknown pack "${pack}" — no loaded analyzer provides it.`);
      }
    }

    if (
      report.zeroContributionAnalyzers !== undefined &&
      report.zeroContributionAnalyzers.length > 0
    ) {
      for (const analyzer of report.zeroContributionAnalyzers) {
        lines.push(
          `  Analyzer "${analyzer}" is configured but contributes 0 enabled rules.`,
        );
      }
    }

    if (report.rulesEnabled === 0) {
      // Names the analyzer first because it is the usual cause: the core ships
      // none, so a configuration with no analyzer has nothing to enable rules
      // from, and "check packs and rules" sends the reader to the wrong file.
      lines.push(
        '  No rules are enabled. That is not a clean bill of health — it means ' +
          'configuration resolved to nothing. Analyzers are separate modules: if ' +
          '"analyzers" is empty, install one and run cyv init. Otherwise check ' +
          'packs and rules in checkyourvibe.json.',
      );
    }

    parts.push(lines.join('\n'));
  }

  const degraded = degradedNotice(report);
  if (degraded !== '') {
    parts.push(degraded);
  }

  if (parts.length === 0) {
    return '';
  }

  return parts.join('\n');
}

/**
 * The line that keeps a degraded run honest.
 *
 * Printed whenever semantic findings have been withheld because the analyzer
 * could not resolve types for some files. It states the count, the files, the
 * reason the analyzer gave, and what to fix. A partial run must never read as
 * a clean one.
 */
function degradedNotice(report: RunReport): string {
  if (report.withheldFindings === undefined || report.withheldFindings === 0) {
    return '';
  }

  const findingWord = report.withheldFindings === 1 ? 'finding' : 'findings';
  const fileCount = report.withheldFiles ?? 0;
  const fileWord = fileCount === 1 ? 'file' : 'files';

  const lines: string[] = [
    `  ${report.withheldFindings} ${findingWord} withheld from ${fileCount} ${fileWord} ` +
      'because type resolution was degraded for these files.',
  ];

  if (report.withheldReasons !== undefined && report.withheldReasons.length > 0) {
    for (const reason of report.withheldReasons) {
      lines.push(`  Reason: ${reason}`);
    }
  }

  // No example here, deliberately. This line used to suggest "a tsconfig.json
  // whose `include` reaches them" — which the C# analyzer then printed under a
  // reason correctly explaining that it had not read a .csproj. The core does
  // not know which language it is talking about; the analyzer does, and its
  // `reason` above is where the specific remedy belongs.
  lines.push(
    '  Until the analyzer can resolve their types, their semantic findings are not ' +
      'reported. Fixing the configuration named above restores them.',
  );

  return lines.join('\n');
}
