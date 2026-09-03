/** One finding, positioned at the member that raised it (1-based). */
export interface UnrealFinding {
  ruleId: string;
  line: number;
  column: number;
  message: string;
  snippet: string;
}

export const RULE_UNTRACKED: string;
export const RULE_UNREFLECTED_OWNER: string;
export const RULE_RAW_UPROPERTY: string;

/**
 * Findings for the garbage-collection family. `enabled` names the rule ids the
 * request switched on; a rule absent from it produces nothing.
 */
export function findGarbageCollectionIssues(
  text: string,
  enabled: ReadonlySet<string> | readonly string[],
): UnrealFinding[];
