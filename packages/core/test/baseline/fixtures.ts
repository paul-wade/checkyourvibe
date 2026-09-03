import { join, resolve } from 'node:path';
import type { Violation } from '../../src/protocol/index.js';

/** A repo root shared by tests that only need a stable string, not a real directory. */
export const FIXTURE_REPO_ROOT = resolve('/fixtures/cyv-baseline-repo');

export function makeViolation(
  overrides: Partial<Violation> & { relPath: string; repoRoot?: string },
): Violation {
  const { relPath, repoRoot, ...rest } = overrides;
  return {
    file: join(repoRoot ?? FIXTURE_REPO_ROOT, relPath),
    line: 1,
    column: 1,
    ruleId: 'no-any',
    message: 'Test violation.',
    snippet: 'const x: any = 1;',
    severity: 'warning',
    ...rest,
  };
}
