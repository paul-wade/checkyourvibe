import { isAbsolute, resolve } from 'node:path';
import type { Command, CommandContext } from './types.js';
import { verifyAnalyzer } from '../conformance/suite.js';
import type { ConformanceCheck, ConformanceResult } from '../conformance/suite.js';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseManifestPath(argv: string[]): string {
  const positional = argv.filter((arg) => !arg.startsWith('-'));

  const manifestPath = positional[0];
  if (manifestPath === undefined) {
    throw new Error('Usage: cyv verify-analyzer <path-to-analyzer.manifest.json>');
  }
  if (positional.length > 1) {
    const extra: string | undefined = positional[1];
    if (extra === undefined) {
      throw new Error('cyv verify-analyzer takes exactly one path, got an extra argument without a value.');
    }
    throw new Error(`cyv verify-analyzer takes exactly one path, got an extra argument "${extra}".`);
  }

  return manifestPath;
}

function marker(passed: boolean): string {
  return passed ? '[PASS]' : '[FAIL]';
}

function summarize(checks: ConformanceCheck[]): string {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0) {
    return `All ${checks.length} checks passed.`;
  }
  return `${failed.length} of ${checks.length} checks failed: ${failed.map((check) => check.name).join(', ')}`;
}

function renderChecklist(result: ConformanceResult): string {
  const lines: string[] = [`Conformance report for analyzer "${result.analyzerId}"`, ''];

  for (const check of result.checks) {
    lines.push(`  ${marker(check.passed)} ${check.name}`);
    if (check.detail !== '') {
      lines.push(`         ${check.detail}`);
    }
  }

  lines.push('');
  lines.push(summarize(result.checks));

  return lines.join('\n');
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    let manifestPath: string;
    try {
      manifestPath = parseManifestPath(ctx.argv);
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }

    const resolvedPath = isAbsolute(manifestPath) ? manifestPath : resolve(ctx.cwd, manifestPath);

    let result: ConformanceResult;
    try {
      result = await verifyAnalyzer(resolvedPath);
    } catch (err) {
      console.error(`Could not verify analyzer at "${resolvedPath}": ${messageFor(err)}`);
      return 2;
    }

    console.log(renderChecklist(result));
    return result.passed ? 0 : 1;
  },
};
