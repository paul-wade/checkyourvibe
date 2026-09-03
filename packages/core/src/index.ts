/**
 * Public API of @checkyourvibe/core.
 *
 * This is the surface an analyzer or agent plugin codes against: the protocol
 * both sides must agree on, plus the merge helpers a plugin needs to describe a
 * write correctly.
 *
 * It deliberately does not export the core's internals — config loading,
 * routing, execution, reporting. A plugin that reached into those would be
 * coupled to a version of the runner rather than to the contract.
 *
 * The merge helpers are here because leaving them out was a real defect: the
 * Codex plugin needs `quoteTomlString` to escape a Windows path into valid TOML,
 * and with no public export it had to import from a source path inside another
 * package. A helper that every plugin targeting a format needs is part of the
 * contract, not an implementation detail.
 */
export * from './protocol/index.js';
export {
  mergeCreateIfAbsent,
  mergeJson,
  mergeManagedBlock,
  mergeToml,
  quoteTomlString,
  MergeError,
  TomlMergeError,
} from './merge/index.js';

/**
 * The orchestration brief (spec 0041 Requirement 1). Exported because every
 * agent adapter writes the same block from it; see `orchestrationWrite`.
 */
export {
  orchestrationBrief,
  orchestrationWrite,
  type BriefInput,
  type LaneAvailability,
} from './executor/brief.js';
