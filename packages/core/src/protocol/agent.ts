import { statSync } from 'node:fs';
import type { Violation } from './violation.js';

/**
 * What an agent integration can do.
 *
 * An agent declares only what it supports and the core assumes nothing. A
 * cloud agent with no local edit loop can still declare `executor` and be
 * useful; an editor agent with no dispatch API declares the other four.
 *
 * `executor` is declarable in v1 but not implemented — reserving the value now
 * means adding the lane later is not a repaint of the manifest.
 */
export type AgentSurface = 'hook' | 'instructions' | 'guidance' | 'mcp' | 'executor';

/**
 * A surface the plugin claims but implements against undocumented or inferred
 * vendor behaviour.
 *
 * This is not the same as an absent surface: `absent` means the agent has no
 * such capability, `unverified` means the plugin implemented one anyway and it
 * may silently do nothing if the inference is wrong. The distinction matters
 * because a silent no-op looks identical to a working integration from the
 * outside.
 */
export interface UnverifiedSurface {
  surface: AgentSurface;
  /** The source comment or observation that makes this a guess, not a fact. */
  reason: string;
}

/**
 * How a planned write combines with what is already on disk.
 *
 * Every target here is a file the user owns and has opinions about — their
 * agent settings, their instructions file. Nothing is ever blind-overwritten.
 */
export type MergeStrategy =
  /** Write only if nothing is there. Never touches an existing file. */
  | 'create-if-absent'
  /** Set only our own keys; every other key and its position survives. */
  | 'json-merge'
  /** Replace only the delimited region; surrounding prose survives byte-for-byte. */
  | 'managed-block'
  /**
   * Insert or update one entry in one TOML array-of-tables; every other key,
   * table, comment, and entry survives byte-for-byte.
   *
   * Codex stores its configuration as `config.toml`, not JSON — the one
   * assumption every other agent so far let `json-merge` get away with.
   * Without this strategy Codex has nowhere for the merge layer to write, and
   * the plugin would have to reach around the shared contract to hand-edit
   * the file itself. See `mergeToml` in `merge/toml.ts` for the narrow
   * read-modify-write this performs and what it deliberately does not parse.
   */
  | 'toml-merge';

export interface PlannedWrite {
  /** Absolute path. */
  path: string;
  strategy: MergeStrategy;
  /** Full file content, or — for `managed-block` — the block body alone. */
  content: string;
  /**
   * Required when strategy is `managed-block`. Identifies the region to replace.
   *
   * MUST be namespaced by the plugin's own `id` — `codex-workflow`, not
   * `workflow`. Several agents read the same shared instruction file
   * (`AGENTS.md` in particular), and an unqualified id means whichever plugin
   * applies second silently replaces the first plugin's block with its own.
   * That was a real defect: two plugins both chose `checkyourvibe-workflow`,
   * and installing both agents would have left only one working.
   */
  blockId?: string;
  /**
   * Which comment syntax the `managed-block` delimiters are written in.
   *
   * Defaults to `html`, which is what every agent adapter needs and what the
   * strategy was written for. A generated CI pipeline file is YAML or Groovy,
   * where an HTML comment is a parse error rather than a comment, so those
   * writes name `hash` or `slash` instead.
   */
  blockComment?: ManagedBlockComment;
  /**
   * A substring identifying array entries this plugin owns, for `json-merge`.
   *
   * Without it, merging an array replaces it wholesale — which keeps re-runs
   * from duplicating our own entry, but destroys entries belonging to other
   * tools. An agent's settings file is shared ground: another tool's hook must
   * survive our install. With a marker, existing entries containing it are
   * treated as ours and replaced, and everything else is preserved.
   *
   * Choose something stable across installs and unique to the plugin — the
   * invoked subcommand rather than an absolute path, which changes if the
   * checkout moves.
   */
  ownershipMarker?: string;
  /**
   * Required when strategy is `toml-merge`. The dotted path as it appears
   * inside `[[...]]`, e.g. `'hooks.PostToolUse.hooks'`. `content` is split on
   * newlines to become that entry's key = value lines.
   */
  tomlTableArrayPath?: string;
  /** One line, shown in the `cyv init` diff. */
  description: string;
}

/**
 * What a hook run should examine.
 *
 * `files` means the payload named them. `working-tree` means it did not, and the
 * uncommitted changes should be checked instead.
 *
 * The second case is not a fallback for sloppiness — it is the documented
 * reality of several agents. Codex's post-edit payload has no path field at all
 * (for patch application the path is inside the patch body), and Gemini and
 * Antigravity bury it somewhere their docs do not specify. Recovering a filename
 * by parsing a patch or a command string would be a guess dressed as a fact, and
 * it would fail silently the first time that format changed. Checking the working
 * tree is slower and completely honest.
 */
export type HookScope = 'files' | 'working-tree';

/** Extracted from an agent's hook invocation. */
export interface HookPayload {
  /** Absolute paths the agent just touched. Empty when scope is `working-tree`. */
  files: string[];
  /** The agent's own event name, retained for reporting. */
  event: string;
  /** Defaults to `files` when absent, for plugins written before this existed. */
  scope?: HookScope;
}

/**
 * What the hook shim returns to the agent.
 *
 * Exit codes are agent-specific — some treat a particular non-zero code as
 * "feed stderr back to the model", others as a hard block — so the plugin
 * decides rather than the core.
 */
export interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DetectContext {
  repoRoot: string;
  homeDir: string;
}

export interface PlanContext {
  repoRoot: string;
  homeDir: string;
  /** Absolute path to the `cyv` entry point the generated glue should invoke. */
  cyvCommand: string;
  /** Rule manifests to render into agent-consumable guidance files. */
  rules: import('./rule-manifest.js').RuleManifest[];
  /**
   * The run's shape, for the adapter whose agent is named by the orchestrating
   * lane (spec 0041 Requirement 1.1).
   *
   * Optional so that a plugin written before this existed, or a caller that has
   * no configuration to hand, still type-checks. An adapter writes the
   * orchestration block only when this is present *and* a lane naming its own
   * agent declares `orchestrator: true` — so an agent with no orchestrating
   * lane gets no block, which is the requirement.
   */
  orchestration?: import('../executor/brief.js').BriefInput;
}

export interface FormatContext {
  /** Files the hook checked, for reporting when there are no violations. */
  files: string[];
}

export interface AgentPlugin {
  id: string;
  name: string;
  surfaces: AgentSurface[];

  /**
   * Surfaces implemented on an educated guess. The plugin degrades cleanly if
   * the guess is wrong, but the user deserves to know the integration is
   * best-effort rather than vendor-confirmed.
   */
  unverifiedSurfaces?: UnverifiedSurface[];

  /** Is this agent present on this machine or wired into this repo? */
  detect(ctx: DetectContext): Promise<boolean>;

  /** Propose writes. MUST NOT touch the filesystem. */
  plan(ctx: PlanContext): Promise<PlannedWrite[]>;

  /**
   * Parse the agent's hook payload.
   *
   * Two failures look alike and must not be treated alike:
   *
   * - **Malformed** — the input is not valid JSON, or violates a shape the
   *   vendor documents as guaranteed. Something is broken: THROW. The CLI shim
   *   catches, warns, and exits 0, so a vendor schema change degrades to no
   *   feedback rather than a wedged editor.
   * - **Well-formed but unresolvable** — the payload is exactly what the vendor
   *   documents, and simply does not name the edited file, because that agent
   *   never promised to. Nothing is broken: return `scope: 'working-tree'` with
   *   an empty `files` array.
   *
   * The line falls in a different place for each agent, and it falls there for
   * a documented reason. Cursor guarantees an absolute `file_path` on
   * `afterFileEdit`, so its absence is malformed and throws. Gemini documents no
   * path field at all, so its absence is normal and yields working-tree scope.
   * Getting this backwards means either crying wolf on every edit, or silently
   * checking the whole tree when one file was wanted.
   *
   * A plugin MUST NOT recover a path by parsing a patch body, diff, or command
   * string. That is a guess dressed as a fact and it fails silently the first
   * time the format changes.
   */
  parseHookPayload(raw: string): HookPayload;

  formatResult(violations: Violation[], ctx: FormatContext): HookResult;
}

/**
 * The comment syntax a managed block's delimiters are written in.
 *
 * The delimiters have to be a comment in the host file's own language, or the
 * file stops parsing the moment the block is inserted. `html` is the original
 * and remains the default, because every file the agent adapters write into is
 * Markdown-like. A CI pipeline file is not: `<!-- ... -->` at the top level of
 * `.gitlab-ci.yml` is a YAML parse error, and in a `Jenkinsfile` it is a Groovy
 * one. Those two formats are what `hash` and `slash` exist for.
 *
 * The delimiter text inside the comment is identical in all three, so a block
 * is still located by the same `checkyourvibe:start:<id>` string regardless of
 * which wrapper it wears.
 */
export type ManagedBlockComment = 'html' | 'hash' | 'slash';

function wrapDelimiter(text: string, comment: ManagedBlockComment): string {
  switch (comment) {
    case 'html':
      return `<!-- ${text} -->`;
    case 'hash':
      return `# ${text}`;
    case 'slash':
      return `// ${text}`;
  }
}

export const MANAGED_BLOCK_START = (id: string, comment: ManagedBlockComment = 'html'): string =>
  wrapDelimiter(`checkyourvibe:start:${id}`, comment);
export const MANAGED_BLOCK_END = (id: string, comment: ManagedBlockComment = 'html'): string =>
  wrapDelimiter(`checkyourvibe:end:${id}`, comment);

/**
 * Turn a `PlanContext.cyvCommand` into something a shell will actually execute.
 *
 * `cyvCommand` may be an absolute path to a `.js` entry point — that is the
 * normal case while nothing is published to a registry. Writing that path into
 * a hook config verbatim produces a command the shell cannot run, and the hook
 * then fails silently on every edit: no output, no error the user ever sees,
 * and the appearance of a working installation. So a `.js` target is invoked
 * through the current Node executable, and any path containing a space or a
 * backslash is quoted so a Windows path is not mangled by a shell.
 *
 * Every adapter has to do this to whatever `cyvCommand` it is handed, so it is
 * part of the plugin contract rather than each plugin's own business.
 */
export function toRunnableCommand(cyvCommand: string): string {
  const quote = (value: string): string => (value.includes(' ') || value.includes('\\') ? `"${value}"` : value);

  if (!cyvCommand.endsWith('.js') && !cyvCommand.endsWith('.mjs')) {
    return quote(cyvCommand);
  }

  // An executable entry carries `#!/usr/bin/env node`, which resolves Node from
  // PATH when the hook runs. `process.execPath` resolves it now and writes the
  // result into the config: it is the absolute path of the Node running `init`,
  // realpathed, so a version-managed install bakes in a version number and the
  // hook stops working at the next upgrade. The build marks the entry
  // executable (tools/mark-bin-executable.mjs); this is the fallback for a
  // target that is not, and for Windows, where a shebang is not consulted.
  if (process.platform !== 'win32' && isExecutableFile(cyvCommand)) {
    return quote(cyvCommand);
  }

  return `${quote(process.execPath)} ${quote(cyvCommand)}`;
}

function isExecutableFile(path: string): boolean {
  const info = statSync(path, { throwIfNoEntry: false });
  return info !== undefined && info.isFile() && (info.mode & 0o111) !== 0;
}
