import type { MergedComment } from './comments.d.mts';

/** One finding: where the comment starts, its first line, and what to do. */
export interface EditorialFinding {
  line: number;
  column: number;
  snippet: string;
  message: string;
}

/** Extra phrases a repository treats as editorial, matched case-insensitively. */
export interface EditorialOptions {
  phrases?: string[];
}

export const EDITORIAL_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; why: string }>;

export function findEditorialComments(
  comments: readonly MergedComment[],
  options?: EditorialOptions,
): EditorialFinding[];
