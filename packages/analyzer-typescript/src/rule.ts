import type { SourceFile } from 'ts-morph';
import type { RuleManifest, Violation } from '@checkyourvibe/core';

export interface TsRule {
  manifest: RuleManifest;
  check(sourceFile: SourceFile, options: Record<string, unknown>): Violation[];
}
