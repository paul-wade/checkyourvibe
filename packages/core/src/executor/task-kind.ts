/**
 * What kind of work a dispatch is (spec 0011 Requirement 8.1).
 *
 * The set is small, fixed, and describes the work rather than a model. No
 * vendor's model names appear here and no ranking between vendors is implied;
 * a lane maps a kind onto its own models in `lane.ts`.
 *
 * Requirement 8.1 does not enumerate the set, and spec 0011's open questions
 * record that what it finally contains, and who may extend it, is undecided.
 * These two values are the two the requirement names in its own text.
 */
export type TaskKind =
  /** Work whose finished state a gate can check completely. */
  | 'mechanical-transformation'
  /** Work whose finished state the gates cannot fully verify. */
  | 'judgment-required';

export const TASK_KINDS: readonly TaskKind[] = ['mechanical-transformation', 'judgment-required'];

/** Returns whether an unknown value is one of the supported task kinds. */
export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && TASK_KINDS.some((kind) => kind === value);
}
