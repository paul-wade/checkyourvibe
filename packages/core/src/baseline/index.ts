export type { Baseline, BaselineEntry, BaselineHeader } from './types.js';
export { BASELINE_VERSION } from './types.js';

export {
  BASELINE_FILENAME,
  BaselineFormatError,
  baselinePath,
  parseBaseline,
  serializeBaseline,
  serialize,
  sortEntries,
} from './format.js';

export { writeBaseline } from './write.js';
export { readBaseline } from './read.js';

export { partitionViolations } from './partition.js';
export type { PartitionResult } from './partition.js';

export { buildStatusReport, formatStatusReport, renderStatus } from './status.js';
export type { StatusReport } from './status.js';

export { computeEntries, entryKey, toRepoRelative } from './identity.js';
export type { EntryWithSource } from './identity.js';

export {
  SuppressionConfigError,
  evaluateSuppressions,
  isPinnedSuppression,
  loadSuppressions,
  suppressionCoverage,
  suppressionNotice,
  validateSuppressionRules,
} from './suppressions.js';
export type {
  BroadSuppression,
  PinnedSuppression,
  Suppression,
  SuppressionCoverage,
  SuppressionEvaluation,
} from './suppressions.js';
