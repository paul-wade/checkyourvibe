/**
 * `cyv init` — detect installed agents and write their glue.
 *
 * Everything here is additive and confirmable: a missing `checkyourvibe.json`
 * is proposed, never assumed; every agent's glue is planned before anything
 * touches disk; and the plan is shown as a diff so the user (or the agent
 * running this on their behalf) can see exactly what changes before it does.
 *
 * `cyvCommand` is resolved from this package's own `package.json` `bin` field
 * rather than guessed from `import.meta.url`'s relative depth, so it resolves
 * correctly whether this module is running from `src` (under a test runner) or
 * from `dist` (the shipped CLI). When the CLI is running from a local clone,
 * the value is the absolute path to the built `.js` entry point. When it is
 * running from an installed package, the value is the bare `cyv` command on
 * PATH, which is the only invocation that survives package moves and upgrades.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { CONFIG_FILENAME, loadConfig } from '../config/load.js';
import type { AnalyzerConfig, CheckYourVibeConfig, RuleOverride, RuleOverrideEnabled } from '../config/types.js';
import type { AgentSurface, AnalyzerManifest, UnverifiedSurface } from '../protocol/index.js';
import type { AnalyzerOrigin } from '../registry/load.js';
import { allRules, loadAnalyzers, loadAnalyzerManifest, resolveAnalyzerManifestPath } from '../registry/load.js';
import { applyPlannedWrite, planDiff } from '../merge/apply.js';
import type { AgentPlugin, PlannedWrite, RuleManifest } from '../protocol/index.js';
import { resolveBriefInput, type BriefInput } from '../executor/brief.js';
import { isUnknownArray } from '../guards.js';
import { runCheck } from '../run/check.js';
import { readBaseline, writeBaseline } from '../baseline/index.js';
import { resolveCommit } from '../dashboard/history.js';
import { confirm } from './baseline.js';

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/*.d.ts', '**/coverage/**'];

const AGENT_PLUGIN_IDS = ['claude-code', 'cursor', 'gemini', 'antigravity', 'codex', 'devin'] as const;

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && isRecord(err) && err.code === code;
}

function isEnoent(err: unknown): boolean {
  return isErrnoException(err, 'ENOENT');
}

/**
 * Prefer the environment's own notion of home over `os.homedir()` so tests
 * can point this at a throwaway directory via `ctx.env` and never touch the
 * real home directory. `os.homedir()` reads `process.env` directly and
 * cannot be redirected this way, so it is only the last-resort fallback.
 */
export function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function findPackageRoot(startDir: string): Promise<string> {
  let dir = startDir;
  while (true) {
    if (await fileExists(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate a package.json walking up from ${startDir}.`);
    }
    dir = parent;
  }
}

function hasBin(value: unknown): value is { bin: string | Record<string, unknown> } {
  return isRecord(value) && (typeof value.bin === 'string' || isRecord(value.bin));
}

/**
 * Distinguish a package installed by a package manager from a local source clone.
 *
 * npm, pnpm, yarn, and npx all place package code under a directory named `node_modules`.
 * A local clone or a workspace source package lives in an arbitrary directory that is not
 * under `node_modules`. A checkout placed inside a `node_modules` directory would mis-detect,
 * but that is pathological and the alternative — always embedding an absolute path into a
 * checkout or cache directory — is the silent failure this task exists to prevent.
 */
function isInstalledPackage(packageRoot: string): boolean {
  const normalized = packageRoot.replace(/\\/g, '/');
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part.toLowerCase() === 'node_modules') {
      return true;
    }
  }
  return false;
}

async function searchPathForCommand(commandName: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  if (pathEnv.length === 0) {
    return undefined;
  }

  const pathExtensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(delimiter) : [];

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }

    const candidates: string[] = [join(dir, commandName)];
    for (const ext of pathExtensions) {
      if (ext.length > 0) {
        candidates.push(join(dir, `${commandName}${ext.toLowerCase()}`));
      }
    }

    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Check whether a `cyvCommand` value can actually be invoked.
 *
 * A `.js`/`.mjs` value or any value containing path separators is treated as a file path
 * and checked with `stat`. A bare name is treated as a shell command and searched on PATH.
 */
export async function commandResolves(cyvCommand: string): Promise<boolean> {
  if (
    cyvCommand.endsWith('.js') ||
    cyvCommand.endsWith('.mjs') ||
    cyvCommand.includes('/') ||
    cyvCommand.includes('\\')
  ) {
    return fileExists(cyvCommand);
  }

  const found = await searchPathForCommand(cyvCommand);
  return found !== undefined;
}

/**
 * Fail with an actionable message when `cyvCommand` cannot be invoked.
 *
 * This is called by `cyv init` and `cyv install-hooks` before writing the value into any
 * hook, so a broken command is reported immediately instead of failing silently at hook time.
 */
export async function assertCyvCommandResolvable(cyvCommand: string): Promise<void> {
  if (await commandResolves(cyvCommand)) {
    return;
  }

  if (
    cyvCommand.endsWith('.js') ||
    cyvCommand.endsWith('.mjs') ||
    cyvCommand.includes('/') ||
    cyvCommand.includes('\\')
  ) {
    throw new Error(`Resolved cyv entry point does not exist: ${cyvCommand}. Build the project before running \`cyv init\`.`);
  }

  throw new Error(
    'The CLI is running from an installed package, but the `cyv` command is not on PATH. ' +
      'Generated hooks would invoke `cyv` and fail. ' +
      'Make `cyv` available on PATH — for example, by installing the package globally, by adding the package\'s `node_modules/.bin` directory to PATH, or by using a package-manager wrapper that keeps binaries on PATH — then re-run `cyv init`.',
  );
}

/**
 * Resolve the `cyv` invocation that generated glue should embed.
 *
 * When running from a local clone, this is the absolute path to the built `.js` entry point.
 * When running from an installed package, it is the bare `cyv` command on PATH, which is the
 * only value that survives package moves and upgrades. The caller must verify the result is
 * resolvable before writing it into a hook.
 */
export async function resolveCyvCommand(): Promise<string> {
  const packageRoot = await resolveCorePackageRoot();
  const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (!hasBin(parsed)) {
    throw new Error(`${packageRoot}/package.json has no "bin" field; cannot resolve the local cyv command.`);
  }

  let binEntry: string | undefined;
  if (typeof parsed.bin === 'string') {
    binEntry = parsed.bin;
  } else {
    const cyv = parsed.bin['cyv'];
    if (typeof cyv === 'string') {
      binEntry = cyv;
    }
  }

  if (binEntry === undefined) {
    throw new Error(`${packageRoot}/package.json has no "cyv" bin entry; cannot resolve the local cyv command.`);
  }

  const resolved = resolvePath(packageRoot, binEntry);

  if (isInstalledPackage(packageRoot)) {
    // Installed from a package manager: a bare `cyv` is the only stable invocation.
    return 'cyv';
  }

  if (!(await fileExists(resolved))) {
    throw new Error(`Resolved cyv entry point does not exist: ${resolved}. Build the project before running \`cyv init\`.`);
  }
  return resolved;
}

/**
 * Read the bundled `config.schema.json` so `cyv init` can place a copy in the
 * target repository. The configuration loader validates `checkyourvibe.json`
 * against this schema on every `cyv check`, so a fresh repository needs it
 * before `init` can run the post-install check that offers a baseline.
 *
 * In a source clone the schema lives in the repository root under
 * `docs/protocol/`. In an installed package it is copied into `dist/schema/`
 * by `tools/copy-schemas.mjs`, so `init` does not have to reach outside the
 * package.
 */
async function resolveSchemaContent(): Promise<string> {
  const coreRoot = await resolveCorePackageRoot();
  if (isInstalledPackage(coreRoot)) {
    return readFile(join(coreRoot, 'dist', 'schema', 'config.schema.json'), 'utf-8');
  }
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  return readFile(fileURLToPath(schemaUrl), 'utf-8');
}

const TYPESCRIPT_ANALYZER_PACKAGE = '@checkyourvibe/analyzer-typescript';
const TYPESCRIPT_ANALYZER_RELATIVE = './packages/analyzer-typescript/analyzer.manifest.json';

/**
 * Locate the root of the `core` package so `init` can decide whether it is
 * running from a source clone or from an installed package.
 */
async function resolveCorePackageRoot(): Promise<string> {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return findPackageRoot(cliDir);
}

/** An analyzer `init` has resolved and will name in the configuration it writes. */
interface AnalyzerChoice {
  /** The reference written into `checkyourvibe.json`. */
  specifier: string;
  /** The analyzer's own id, read from its manifest rather than assumed. */
  id: string;
  /** The packs a fresh configuration enables for this analyzer. */
  packs: string[];
  /** The manifest that specifier resolved to, so the plan can name it. */
  manifestPath: string;
  origin: AnalyzerOrigin;
}

/**
 * The packs a freshly written configuration enables for one analyzer.
 *
 * Each analyzer here declares one `core-*` pack holding the rules that apply to
 * any codebase, and may declare further packs expressing a stricter posture a
 * user opts into. A first run enables the `core-*` packs and leaves the rest to
 * be chosen deliberately. An analyzer that declares no `core-*` pack gets all of
 * its packs, because a configuration that names an analyzer and enables none of
 * its rules reports a clean run over nothing.
 */
function defaultPacksFor(manifest: AnalyzerManifest): string[] {
  const corePacks: string[] = [];
  const allPacks: string[] = [];

  for (const rule of manifest.rules) {
    const pack = rule.pack;
    if (pack === undefined) {
      continue;
    }
    if (!allPacks.includes(pack)) {
      allPacks.push(pack);
    }
    if (pack.startsWith('core-') && !corePacks.includes(pack)) {
      corePacks.push(pack);
    }
  }

  return corePacks.length > 0 ? corePacks : allPacks;
}

/**
 * Resolve one analyzer specifier into everything `init` needs to write it down.
 *
 * The manifest is read and parsed before the specifier is accepted, so a
 * reference is never written into a configuration that `cyv check` would then
 * fail to resolve. Failures propagate: a specifier the user named explicitly is
 * entitled to the reason it did not work.
 */
async function resolveAnalyzerChoice(specifier: string, repoRoot: string): Promise<AnalyzerChoice> {
  const resolved = await resolveAnalyzerManifestPath(specifier, repoRoot);
  const manifest = await loadAnalyzerManifest(specifier, repoRoot);
  return {
    specifier,
    id: manifest.id,
    packs: defaultPacksFor(manifest),
    manifestPath: resolved.path,
    origin: resolved.origin,
  };
}

/**
 * The same resolution, reduced to "this candidate or not this candidate".
 *
 * Probing a list of default candidates is a different question from resolving
 * one the user named: the reason a candidate did not work is not actionable,
 * because the next candidate is about to be tried and the outcome of exhausting
 * the list is what the caller reports.
 */
async function tryResolveAnalyzerChoice(
  specifier: string,
  repoRoot: string,
): Promise<AnalyzerChoice | undefined> {
  try {
    return await resolveAnalyzerChoice(specifier, repoRoot);
  } catch {
    return undefined;
  }
}

/**
 * Choose the default TypeScript analyzer reference and verify it resolves.
 *
 * When the CLI runs from a clone, the repo-relative path is tried first. It
 * matches only when the repository being checked is that clone, and there it is
 * both correct and portable: the analyzer is committed next to the
 * configuration that names it.
 *
 * Everywhere else the value written is the bare package specifier. That
 * specifier resolves from the checked repository when the project installed the
 * analyzer, and otherwise from the checkyourvibe installation running the
 * command — which is how a clone-installed `cyv` can analyse a project that has
 * never heard of checkyourvibe without an absolute path into someone's home
 * directory ending up in their configuration file. Where it resolved from is
 * reported in the plan rather than left for the user to discover.
 *
 * If nothing resolves, no analyzer is added: a config naming a missing package
 * is the silent-skip failure in configuration form.
 */
async function resolveDefaultAnalyzer(repoRoot: string): Promise<AnalyzerChoice | undefined> {
  const coreRoot = await resolveCorePackageRoot();
  const candidates = isInstalledPackage(coreRoot)
    ? [TYPESCRIPT_ANALYZER_PACKAGE]
    : [TYPESCRIPT_ANALYZER_RELATIVE, TYPESCRIPT_ANALYZER_PACKAGE];

  for (const candidate of candidates) {
    const choice = await tryResolveAnalyzerChoice(candidate, repoRoot);
    if (choice !== undefined) {
      return choice;
    }
  }

  return undefined;
}

async function importModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

function isAgentSurface(value: unknown): value is AgentSurface {
  return (
    value === 'hook' ||
    value === 'instructions' ||
    value === 'guidance' ||
    value === 'mcp' ||
    value === 'executor'
  );
}

/**
 * A declared-unverified surface is read straight out of a plugin module and
 * printed by `cyv doctor`, so its shape is checked here rather than trusted.
 * An adapter can be written by anyone; a malformed declaration that reached
 * the report would print `undefined: undefined` next to an agent's name, which
 * says nothing about how far to trust the integration.
 */
function isUnverifiedSurface(value: unknown): value is UnverifiedSurface {
  return (
    isRecord(value) &&
    isAgentSurface(value.surface) &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
  );
}

export function isAgentPlugin(value: unknown): value is AgentPlugin {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.detect !== 'function' ||
    typeof value.plan !== 'function' ||
    typeof value.parseHookPayload !== 'function' ||
    typeof value.formatResult !== 'function'
  ) {
    return false;
  }

  if (!isUnknownArray(value.surfaces)) {
    return false;
  }

  for (let i = 0; i < value.surfaces.length; i++) {
    const surface: unknown = value.surfaces[i];
    if (!isAgentSurface(surface)) {
      return false;
    }
  }

  if (value.unverifiedSurfaces !== undefined) {
    if (!isUnknownArray(value.unverifiedSurfaces)) {
      return false;
    }
    for (let i = 0; i < value.unverifiedSurfaces.length; i++) {
      const entry: unknown = value.unverifiedSurfaces[i];
      if (!isUnverifiedSurface(entry)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Each adapter package is a sibling, not a dependency of core. The bare
 * specifier resolves once the workspace has it linked; the fallback — the
 * sibling package's own build output, addressed by convention rather than
 * resolution — covers every environment where that lookup fails, matching
 * the same pattern `cyv hook` uses to load the plugin.
 */
async function loadOnePlugin(id: string): Promise<AgentPlugin> {
  const packageSpecifier = `@checkyourvibe/adapter-${id}`;

  let mod: unknown;
  try {
    mod = await importModule(packageSpecifier);
  } catch {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    const coreRoot = await findPackageRoot(cliDir);
    const packagesDir = dirname(coreRoot);
    const fallbackPath = join(packagesDir, `adapter-${id}`, 'dist', 'index.js');
    mod = await importModule(pathToFileURL(fallbackPath).href);
  }

  if (!isRecord(mod) || !('default' in mod) || !isAgentPlugin(mod.default)) {
    throw new Error(`@checkyourvibe/adapter-${id} has no valid default AgentPlugin export.`);
  }
  return mod.default;
}

/** Every agent plugin this build knows about. */
export async function loadAllPlugins(): Promise<AgentPlugin[]> {
  const plugins: AgentPlugin[] = [];
  for (const id of AGENT_PLUGIN_IDS) {
    try {
      plugins.push(await loadOnePlugin(id));
    } catch (err) {
      console.error(`Could not load agent plugin "${id}": ${messageFor(err)}`);
    }
  }
  return plugins;
}

/** Test seam: tests can set `plugins` on this object to override the agent list. */
export const agentPluginsOverride: { plugins: AgentPlugin[] | undefined } = { plugins: undefined };

function toStringArray(value: unknown): string[] {
  if (!isUnknownArray(value)) {
    return [];
  }

  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item === 'string') {
      result.push(item);
    }
  }
  return result;
}

function isRuleOverrideEnabled(value: unknown): value is RuleOverrideEnabled {
  return isRecord(value);
}

function isRuleOverride(value: unknown): value is RuleOverride {
  return value === false || isRuleOverrideEnabled(value);
}

function toAnalyzerConfigArray(value: unknown, configPath: string): AnalyzerConfig[] {
  if (!isUnknownArray(value)) {
    throw new Error(`${configPath} is missing an "analyzers" array.`);
  }

  const result: AnalyzerConfig[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.package !== 'string') {
      throw new Error(`${configPath} has a malformed entry in "analyzers"; each entry needs a string "id" and "package".`);
    }
    const analyzer: AnalyzerConfig = { id: entry.id, package: entry.package };
    const options = entry.options;
    if (isRecord(options)) {
      analyzer.options = options;
    }
    result.push(analyzer);
  }
  return result;
}

function toRulesRecord(value: unknown): Record<string, RuleOverride> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, RuleOverride> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isRuleOverride(raw)) {
      result[key] = raw;
    }
  }
  return result;
}

/**
 * A permissive read of an already-present `checkyourvibe.json`, just enough
 * to drive planning (which analyzers to load, which agents were already
 * enabled). Full schema validation is `cyv doctor`'s job, run against a config
 * this command did not just write; requiring the schema file here as well
 * would make `cyv init` unable to run in the one repo state it exists to fix
 * — a repo with no checkyourvibe scaffolding yet.
 */
function parseExistingConfig(raw: string, configPath: string): CheckYourVibeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${messageFor(err)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${configPath} must contain a JSON object.`);
  }

  const analyzers = toAnalyzerConfigArray(parsed.analyzers, configPath);
  const config: CheckYourVibeConfig = {
    packs: toStringArray(parsed.packs),
    analyzers,
    rules: toRulesRecord(parsed.rules),
    strict: parsed.strict === true,
    exclude: toStringArray(parsed.exclude),
  };

  if (isUnknownArray(parsed.agents)) {
    config.agents = toStringArray(parsed.agents);
  }

  return config;
}

function buildDefaultConfig(analyzer: AnalyzerChoice | undefined, detectedAgentIds: string[]): CheckYourVibeConfig {
  return {
    packs: analyzer !== undefined ? [...analyzer.packs] : [],
    analyzers: analyzer !== undefined ? [{ id: analyzer.id, package: analyzer.specifier }] : [],
    agents: detectedAgentIds,
    rules: {},
    strict: false,
    exclude: [...DEFAULT_EXCLUDE],
  };
}

/**
 * Add an explicitly named analyzer to a configuration that already exists.
 *
 * An entry with the same id is replaced rather than duplicated, so re-running
 * `cyv init --analyzer <specifier>` after an analyzer moves repoints the entry
 * instead of leaving two that resolve to different manifests — which
 * `loadAnalyzers` would reject as a duplicate id anyway, after the write.
 */
function withAnalyzer(config: CheckYourVibeConfig, choice: AnalyzerChoice): CheckYourVibeConfig {
  const analyzers: AnalyzerConfig[] = config.analyzers.filter((entry) => entry.id !== choice.id);
  analyzers.push({ id: choice.id, package: choice.specifier });

  const packs = [...config.packs];
  for (const pack of choice.packs) {
    if (!packs.includes(pack)) {
      packs.push(pack);
    }
  }

  return { ...config, analyzers, packs };
}

function configFileContent(config: CheckYourVibeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The keys a re-run merges into an existing `checkyourvibe.json`.
 *
 * `agents` is always present; `analyzers` and `packs` appear only when this run
 * was told to add an analyzer, so a refresh never rewrites analyzer
 * configuration the user maintains by hand.
 */
interface ConfigMergePatch {
  agents: string[];
  analyzers?: AnalyzerConfig[];
  packs?: string[];
}

interface ParsedInitArgs {
  yes: boolean;
  dryRun: boolean;
  adopt: string[];
  allowOutsideRepo: boolean;
  analyzer: string | undefined;
}

/**
 * Adopting a newly detected agent needs its own opt-in, so `--yes` confirms a
 * refresh rather than widening it. `--adopt <agent-id>` is repeatable and
 * takes no input at runtime, so it behaves the same in CI as in a terminal.
 *
 * On a first run, with no `checkyourvibe.json` present, every detected agent is
 * adopted and `--adopt` is ignored: there is no prior configuration for a new
 * agent to be outside of.
 *
 * `--analyzer <path-or-package>` names the analyzer to configure instead of
 * letting `init` pick a default. It is how a user reaches an analyzer this
 * command would not find on its own — one built from a checkout somewhere else,
 * or one of the analyzers in this repository other than TypeScript. The value is
 * written into `checkyourvibe.json` exactly as given, so a relative path stays
 * relative and a package specifier stays a package specifier.
 */
function parseArgs(argv: string[]): ParsedInitArgs {
  let yes = false;
  let dryRun = false;
  let allowOutsideRepo = false;
  let analyzer: string | undefined;
  const adopt: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--allow-outside-repo') {
      allowOutsideRepo = true;
    } else if (arg === '--adopt') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('--adopt requires an agent id (e.g. --adopt codex).');
      }
      adopt.push(next);
      i += 1;
    } else if (arg === '--analyzer') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(
          '--analyzer requires a path to an analyzer manifest or a package specifier ' +
            '(e.g. --analyzer ./tools/my-analyzer/analyzer.manifest.json).',
        );
      }
      analyzer = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument "${arg}" for cyv init.`);
    }
  }

  return { yes, dryRun, adopt, allowOutsideRepo, analyzer };
}

type DiffEntry = { path: string; changed: boolean; preview: string };
type Outcome = { path: string; changed: boolean; before: string | null };

interface PlanGroup {
  name: string;
  entries: { write: PlannedWrite; diff: DiffEntry }[];
}

interface PlanAgent {
  name: string;
  id: string;
}

interface SkippedAgent {
  name: string;
  id: string;
}

interface UnavailableAgent {
  name: string;
  id: string;
  reason: string;
}

interface Plan {
  configuredAgents: PlanAgent[];
  skippedAgents: SkippedAgent[];
  unavailableAgents: UnavailableAgent[];
  /** Lines describing the analyzer this run resolved and where it came from. */
  analyzerNotes: string[];
  insideGroups: PlanGroup[];
  outsideGroups: PlanGroup[];
}

/**
 * Say which analyzer will be configured and where its manifest was found.
 *
 * When the manifest came from the checkyourvibe installation rather than from
 * the repository being checked, that is stated in full, because it is the one
 * thing a reader cannot infer from the configuration file: the written
 * specifier looks like an ordinary dependency and resolves only while this
 * installation exists. Leaving that unsaid would be the plan claiming a
 * portability the repository does not yet have.
 */
function describeAnalyzer(choice: AnalyzerChoice | undefined): string[] {
  if (choice === undefined) {
    return [
      'Analyzer: none. `cyv check` will have no rules to run and will say so rather than reporting a clean pass.',
    ];
  }

  const packs = choice.packs.length > 0 ? choice.packs.join(', ') : '(none)';
  const lines = [
    `Analyzer: "${choice.id}", written into ${CONFIG_FILENAME} as "${choice.specifier}", enabling pack(s): ${packs}.`,
  ];

  if (choice.origin === 'project') {
    lines.push(`  Resolved from this repository: ${choice.manifestPath}`);
    return lines;
  }

  lines.push('  It is not installed in this repository. It resolved from the checkyourvibe installation running this command:');
  lines.push(`    ${choice.manifestPath}`);
  lines.push(
    '  The configuration names the package rather than that path, so nothing machine-specific is written down.',
  );
  lines.push(
    '  On a machine without this checkyourvibe installation, `cyv check` will report the analyzer as unresolvable',
  );
  lines.push(
    '  and exit 2. Install the analyzer in this repository to make the reference stand on its own.',
  );
  return lines;
}

/**
 * A repository-scoped command has no business touching paths outside the
 * repository root. Some agents (Claude Code, Codex) genuinely store hook
 * configuration in the user's home directory, so those writes are allowed but
 * must be called out explicitly before they happen. This helper distinguishes
 * the two groups using `path.relative` and falls back to an absolute-path
 * check when the repository and the target live on different Windows drives.
 */
export function isInsideRepo(writePath: string, repoRoot: string): boolean {
  const resolvedWrite = resolvePath(writePath);
  const resolvedRoot = resolvePath(repoRoot);
  if (resolvedWrite === resolvedRoot) {
    return true;
  }
  const rel = relative(resolvedRoot, resolvedWrite);
  if (rel.length === 0) {
    return true;
  }
  if (rel.startsWith('..')) {
    return false;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  return true;
}

function buildPlan(
  repoRoot: string,
  configWrite: PlannedWrite,
  schemaWrite: PlannedWrite,
  pluginResults: PluginPlanResult[],
  diffs: DiffEntry[],
  adoptedAgentIds: readonly string[],
  detectedButNotAdopted: SkippedAgent[],
  unavailableAgents: UnavailableAgent[],
  analyzerNotes: string[],
): Plan {
  const configuredAgents: PlanAgent[] = [];
  const seenAgentIds = new Set<string>();

  for (const result of pluginResults) {
    if (adoptedAgentIds.includes(result.plugin.id)) {
      configuredAgents.push({ name: result.plugin.name, id: result.plugin.id });
      seenAgentIds.add(result.plugin.id);
    }
  }

  for (const id of adoptedAgentIds) {
    if (seenAgentIds.has(id)) {
      continue;
    }
    for (const result of pluginResults) {
      if (result.plugin.id === id) {
        configuredAgents.push({ name: result.plugin.name, id });
        seenAgentIds.add(id);
        break;
      }
    }
  }

  const insideGroups: PlanGroup[] = [];
  const outsideGroups: PlanGroup[] = [];

  const configDiff = diffs[0];
  if (configDiff !== undefined) {
    insideGroups.push({
      name: 'checkyourvibe.json',
      entries: [{ write: configWrite, diff: configDiff }],
    });
  }

  const schemaDiff = diffs[1];
  if (schemaDiff !== undefined) {
    insideGroups.push({
      name: 'checkyourvibe protocol schema',
      entries: [{ write: schemaWrite, diff: schemaDiff }],
    });
  }

  const pluginDiffs = diffs.slice(2);
  let diffIndex = 0;
  for (const result of pluginResults) {
    // An unavailable plugin planned no writes, so it consumes no diffs and has
    // no group. It is reported through `unavailableAgents` instead.
    if (!result.available) {
      continue;
    }

    const entries: { write: PlannedWrite; diff: DiffEntry }[] = [];
    for (let i = 0; i < result.writes.length; i += 1) {
      const write = result.writes[i];
      const diff = pluginDiffs[diffIndex + i];
      if (write !== undefined && diff !== undefined) {
        entries.push({ write, diff });
      }
    }
    diffIndex += result.writes.length;

    const insideEntries = entries.filter((entry) => isInsideRepo(entry.write.path, repoRoot));
    const outsideEntries = entries.filter((entry) => !isInsideRepo(entry.write.path, repoRoot));

    if (insideEntries.length > 0) {
      insideGroups.push({ name: result.plugin.name, entries: insideEntries });
    }
    if (outsideEntries.length > 0) {
      outsideGroups.push({ name: result.plugin.name, entries: outsideEntries });
    }
  }

  return {
    configuredAgents,
    skippedAgents: detectedButNotAdopted,
    unavailableAgents,
    analyzerNotes,
    insideGroups,
    outsideGroups,
  };
}

function printPlan(plan: Plan): void {
  console.log('cyv init plan:');
  console.log('');

  console.log(
    `Agents that will be configured: ${plan.configuredAgents.map((a) => `${a.name} (${a.id})`).join(', ') || '(none)'}`,
  );

  if (plan.skippedAgents.length > 0) {
    const names = plan.skippedAgents.map((a) => `${a.name} (--adopt ${a.id})`).join(', ');
    console.log(`Agents detected but not adopted: ${names}`);
  }

  if (plan.analyzerNotes.length > 0) {
    console.log('');
    for (const line of plan.analyzerNotes) {
      console.log(line);
    }
  }

  if (plan.unavailableAgents.length > 0) {
    console.log('');
    console.log('Not in plan:');
    for (const agent of plan.unavailableAgents) {
      console.log(`  ${agent.name}: ${agent.reason}`);
    }
  }

  console.log('');
  console.log('Inside this repository:');
  printGroups(plan.insideGroups);

  console.log('');
  console.log('Outside this repository (affects every project on this machine):');
  console.log('  These writes are not covered by --yes. Pass --allow-outside-repo to include them.');
  printGroups(plan.outsideGroups);

  let totalWrites = 0;
  let changedCount = 0;
  for (const group of [...plan.insideGroups, ...plan.outsideGroups]) {
    for (const { diff } of group.entries) {
      totalWrites += 1;
      if (diff.changed) {
        changedCount += 1;
      }
    }
  }
  console.log(`\n${changedCount} of ${totalWrites} file(s) would change.`);
}

function printGroups(groups: PlanGroup[]): void {
  if (groups.length === 0) {
    console.log('  (none)');
    return;
  }

  for (const group of groups) {
    console.log(`\n  ${group.name}:`);

    for (const { write, diff } of group.entries) {
      console.log(`    [${diff.changed ? '~' : '='}] ${write.path}`);
      console.log(`        ${write.description}`);
      if (diff.changed && diff.preview.length > 0) {
        for (const line of diff.preview.split('\n')) {
          console.log(`        ${line}`);
        }
      }
    }
  }
}

function printOutcomes(writes: PlannedWrite[], outcomes: Outcome[]): void {
  console.log('Applied:');
  for (let i = 0; i < writes.length; i += 1) {
    const write = writes[i];
    const outcome = outcomes[i];
    if (write === undefined || outcome === undefined) {
      continue;
    }
    const status = outcome.before === null ? 'created' : outcome.changed ? 'updated' : 'unchanged';
    console.log(`  [${status}] ${outcome.path}`);
  }
}

interface ConfirmDecision {
  proceed: boolean;
  reason: string;
}

/**
 * Confirmation is read from stdin rather than assumed. `--yes` skips the
 * prompt outright; anything else without a TTY attached refuses instead of
 * guessing, because a non-interactive invocation with no `--yes` has no way
 * to signal consent at all — proceeding anyway would be exactly the kind of
 * silent, unconfirmed write this project exists to prevent.
 */
async function decideConfirmation(yes: boolean): Promise<ConfirmDecision> {
  if (yes) {
    return { proceed: true, reason: '' };
  }

  const proceed = await confirm(
    false,
    'Apply these changes?',
    'Refusing to write without confirmation: stdin is not a TTY and --yes was not passed. ' +
      'Re-run with --yes to apply non-interactively, or run this interactively to confirm.',
  );
  return { proceed, reason: proceed ? '' : 'Aborted: not confirmed.' };
}

interface DetectionResult {
  plugin: AgentPlugin;
  detected: boolean;
  reason?: string;
}

interface PluginPlanResult {
  plugin: AgentPlugin;
  available: boolean;
  reason?: string;
  writes: PlannedWrite[];
}

async function runPluginDetection(plugin: AgentPlugin, ctx: { repoRoot: string; homeDir: string }): Promise<DetectionResult> {
  try {
    const detected = await plugin.detect(ctx);
    return { plugin, detected };
  } catch (err) {
    return { plugin, detected: false, reason: messageFor(err) };
  }
}

async function runPluginPlan(
  plugin: AgentPlugin,
  ctx: {
    repoRoot: string;
    homeDir: string;
    cyvCommand: string;
    rules: RuleManifest[];
    orchestration?: BriefInput;
  },
): Promise<PluginPlanResult> {
  try {
    const planned = await plugin.plan(ctx);
    return { plugin, available: true, writes: planned };
  } catch (err) {
    return { plugin, available: false, reason: messageFor(err), writes: [] };
  }
}


/**
 * After `init` has written its glue, run a full check and offer to record the
 * current violations as a baseline. A baseline defers existing debt without
 * fixing it, which is the adoption path described in docs/adoption.md. Nothing
 * is written without its own confirmation, and `init --yes` does not silently
 * mean "also take a baseline".
 */
/**
 * `yes` is not a convenience here, it is what keeps `cyv init --yes` from
 * blocking. Without the early return below, a `--yes` run reached a readline
 * interface nobody was going to type into and sat there until `confirm`'s 60s
 * timeout fired.
 *
 * The `confirm` call is passed `false` rather than `yes` for that reason:
 * `confirm(true, …)` answers yes, and answering yes here would take the
 * baseline. `--yes` has to reach `confirm` as a return, not as an answer.
 *
 * `--yes` used to be given the violation count as well, on the grounds that the
 * count was the useful part of the offer. It is not worth what it costs. The
 * count comes from `runCheck({ mode: 'all' })`, a type-aware analysis of every
 * file in the repository, and it was run before the `yes` branch was reached —
 * so a `--yes` run paid for a whole-repository scan and then declined to use
 * its result for anything but one line of output. On a large repository that
 * scan exhausts the default V8 heap and kills the process with a fatal
 * allocation error, after `init` has already written every file it came to
 * write. A crash that discards a completed run to print a number nobody asked
 * for is a bad trade, so `--yes` now returns before the scan and names the
 * command that computes the count on purpose.
 *
 * What `--yes` still does not get is the baseline itself: recording every
 * existing violation as deferred debt is too large a side effect to infer from
 * a flag that only means "do not ask me".
 */
async function maybeOfferBaseline(repoRoot: string, yes: boolean): Promise<void> {
  if (yes) {
    console.log(
      'A baseline records existing violations as deferred debt, not a fix. ' +
        'See docs/adoption.md for the adoption path.',
    );
    console.log('No baseline written: --yes runs without prompting. Run `cyv baseline` to take one.');
    return;
  }

  const { report } = await runCheck({ cwd: repoRoot, mode: 'all' });
  if (report.violations.length === 0) {
    return;
  }

  const existing = await readBaseline(repoRoot);
  if (existing !== null) {
    console.log(`This run found ${report.violations.length} violation(s) across the repository.`);
    console.log('A baseline already exists; init did not replace it. See docs/adoption.md for the adoption path.');
    return;
  }

  console.log(`This run found ${report.violations.length} violation(s) across the repository.`);
  console.log(
    'A baseline records these as deferred debt, not a fix. See docs/adoption.md for the adoption path.',
  );

  const take = await confirm(
    false,
    'Take a baseline now?',
    'Refusing to take a baseline without confirmation: stdin is not a TTY and the baseline prompt was not answered. ' +
      'To take a baseline non-interactively, run `cyv baseline --yes`; or run `cyv init` in a TTY to be offered one.',
  );

  if (!take) {
    console.log('No baseline written. Run `cyv baseline` to take one when you are ready.');
    return;
  }

  const commit = await resolveCommit(repoRoot);
  await writeBaseline(repoRoot, report, commit);
  console.log(`Baseline written: ${report.violations.length} violation(s) recorded against commit ${commit}.`);
  console.log(
    'These are now deferred, not fixed. They still exist, and every run of `cyv check` continues to know ' +
      'about them; use `cyv baseline --status` to track burn-down.',
  );
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const { yes, dryRun, adopt, allowOutsideRepo, analyzer } = parseArgs(ctx.argv);
      const root = await repoRoot(ctx.cwd);
      const homeDir = resolveHomeDir(ctx.env);
      const configPath = join(root, CONFIG_FILENAME);

      let existingRaw: string | null;
      try {
        existingRaw = await readFile(configPath, 'utf-8');
      } catch (err) {
        if (!isEnoent(err)) {
          throw err;
        }
        existingRaw = null;
      }

      const firstRun = existingRaw === null;
      const plugins = agentPluginsOverride.plugins ?? (await loadAllPlugins());

      const detectionResults: DetectionResult[] = [];
      for (const plugin of plugins) {
        detectionResults.push(await runPluginDetection(plugin, { repoRoot: root, homeDir }));
      }

      const detectedAgentIds = detectionResults
        .filter((result) => result.detected)
        .map((result) => result.plugin.id);

      const existingConfig = existingRaw !== null ? parseExistingConfig(existingRaw, configPath) : null;
      const configuredAgentIds = new Set(existingConfig?.agents ?? []);

      // The brief describes lanes, and lanes are declared by hand — a first run
      // has none, so no adapter gets an orchestration block until the user has
      // written one (spec 0041 Requirement 1.1).
      //
      // Read through `loadConfig` rather than `parseExistingConfig`: the latter
      // is deliberately lenient so that `cyv init` can repair a configuration
      // that does not validate, and it keeps only the fields it needs, dropping
      // `executor` — so briefing from it produced no block at all. A
      // configuration too broken to load has no lane declaration worth briefing
      // from either, so that case degrades to no block rather than to a guess.
      let orchestration: BriefInput | undefined;
      if (existingConfig !== null) {
        try {
          orchestration = await resolveBriefInput(await loadConfig(root), ctx.env, root);
        } catch {
          orchestration = undefined;
        }
      }

      /**
       * `--yes` confirms the plan for agents already in `checkyourvibe.json`
       * and must never enlarge scope. Newly detected agents need an explicit
       * opt-in. The first run is different: adopting every detected agent is
       * the point of the command, so we do that by default instead of forcing
       * the user to list agents the tool just found.
       */
      const adoptedIds = new Set<string>(configuredAgentIds);
      const invalidAdopt: string[] = [];
      if (firstRun) {
        for (const id of detectedAgentIds) {
          adoptedIds.add(id);
        }
      } else {
        for (const requested of adopt) {
          if (configuredAgentIds.has(requested)) {
            continue;
          }
          if (detectedAgentIds.includes(requested)) {
            adoptedIds.add(requested);
          } else {
            invalidAdopt.push(requested);
          }
        }
      }

      if (invalidAdopt.length > 0) {
        console.error(
          `Ignored --adopt for agent(s) that are not detected: ${invalidAdopt.join(', ')}.`,
        );
      }

      /**
       * A specifier the user named is resolved without a fallback: if it does
       * not load, the run fails with the reason rather than quietly configuring
       * a different analyzer than the one that was asked for.
       */
      const requestedAnalyzer =
        analyzer !== undefined ? await resolveAnalyzerChoice(analyzer, root) : undefined;
      const chosenAnalyzer =
        requestedAnalyzer ?? (firstRun ? await resolveDefaultAnalyzer(root) : undefined);

      let baseConfig: CheckYourVibeConfig;
      if (existingConfig !== null) {
        const withAgents: CheckYourVibeConfig = { ...existingConfig, agents: [...adoptedIds] };
        baseConfig =
          requestedAnalyzer !== undefined ? withAnalyzer(withAgents, requestedAnalyzer) : withAgents;
      } else {
        baseConfig = buildDefaultConfig(chosenAnalyzer, [...adoptedIds]);
      }

      const manifests = await loadAnalyzers(baseConfig.analyzers, root);
      const catalog = allRules(manifests);
      const cyvCommand = await resolveCyvCommand();
      await assertCyvCommandResolvable(cyvCommand);

      const pluginResults: PluginPlanResult[] = [];
      const skippedAgents: SkippedAgent[] = [];
      const unavailableAgents: UnavailableAgent[] = [];

      for (const result of detectionResults) {
        if (!adoptedIds.has(result.plugin.id)) {
          if (result.detected) {
            skippedAgents.push({ name: result.plugin.name, id: result.plugin.id });
          } else {
            unavailableAgents.push({
              name: result.plugin.name,
              id: result.plugin.id,
              reason: result.reason ?? 'not detected on this machine',
            });
          }
          continue;
        }

        if (!result.detected) {
          // The agent is in the existing config but was not detected this run.
          // Keep it in the config, but do not try to refresh its glue.
          unavailableAgents.push({
            name: result.plugin.name,
            id: result.plugin.id,
            reason: result.reason ?? 'not detected on this machine',
          });
          pluginResults.push({
            plugin: result.plugin,
            available: false,
            reason: result.reason ?? 'not detected on this machine',
            writes: [],
          });
          continue;
        }

        const planResult = await runPluginPlan(result.plugin, {
          repoRoot: root,
          homeDir,
          cyvCommand,
          rules: catalog,
          ...(orchestration === undefined ? {} : { orchestration }),
        });
        pluginResults.push(planResult);

        // A plugin that threw while planning contributes no writes, so it would
        // otherwise leave no trace in the plan at all — the run would look like
        // it configured every adopted agent while one of them got nothing. The
        // run still continues, because one broken plugin is not a reason to
        // leave the other agents unconfigured.
        if (!planResult.available) {
          unavailableAgents.push({
            name: result.plugin.name,
            id: result.plugin.id,
            reason: `could not be planned: ${planResult.reason ?? 'the plugin gave no reason'}`,
          });
        }
      }

      // The core ships no analyzer, so a run with none installed is a supported
      // state rather than a broken one. It is still reported, because a
      // configuration resolving to no rules must never read as a clean setup.
      if (firstRun && chosenAnalyzer === undefined) {
        unavailableAgents.push({
          name: 'No analyzer',
          id: 'analyzer',
          reason:
            'none is installed in this repository, and none was found beside the checkyourvibe ' +
            'installation running this command. Analyzers are separate modules — name one with ' +
            '`cyv init --analyzer <path-or-package>`, for example a built ' +
            '`@checkyourvibe/analyzer-typescript` checkout, then re-run `cyv init`',
        });
      }

      const effectiveConfig: CheckYourVibeConfig = { ...baseConfig, agents: [...adoptedIds] };

      const mergePatch: ConfigMergePatch = { agents: [...adoptedIds] };
      if (requestedAnalyzer !== undefined) {
        mergePatch.analyzers = baseConfig.analyzers;
        mergePatch.packs = baseConfig.packs;
      }

      const configWrite: PlannedWrite = firstRun
        ? {
            path: configPath,
            strategy: 'create-if-absent',
            content: configFileContent(effectiveConfig),
            description:
              chosenAnalyzer !== undefined
                ? `Create ${CONFIG_FILENAME} naming the "${chosenAnalyzer.id}" analyzer as "${chosenAnalyzer.specifier}", with pack(s): ${chosenAnalyzer.packs.join(', ')}.`
                : `Create ${CONFIG_FILENAME} with no analyzer, because none resolved from this repository or from beside the checkyourvibe installation running this command. Analyzers are separate modules: name one with \`cyv init --analyzer <path-or-package>\`, or install one into this repository and re-run \`cyv init\`. Until then \`cyv check\` has no rules to run and will say so.`,
          }
        : {
            path: configPath,
            strategy: 'json-merge',
            content: JSON.stringify(mergePatch, null, 2),
            description:
              requestedAnalyzer !== undefined
                ? `Update ${CONFIG_FILENAME} with the agents this run will configure and the "${requestedAnalyzer.id}" analyzer named as "${requestedAnalyzer.specifier}".`
                : `Update ${CONFIG_FILENAME} with the agents this run will configure.`,
          };

      const schemaWrite: PlannedWrite = {
        path: join(root, 'docs', 'protocol', 'config.schema.json'),
        strategy: 'create-if-absent',
        content: await resolveSchemaContent(),
        description: 'Copy the checkyourvibe protocol schema so the configuration can be validated.',
      };

      const writes: PlannedWrite[] = [configWrite, schemaWrite];
      for (const result of pluginResults) {
        if (result.available) {
          writes.push(...result.writes);
        }
      }

      const diffs = await planDiff(writes);
      const plan = buildPlan(
        root,
        configWrite,
        schemaWrite,
        pluginResults,
        diffs,
        [...adoptedIds],
        skippedAgents,
        unavailableAgents,
        firstRun || requestedAnalyzer !== undefined ? describeAnalyzer(chosenAnalyzer) : [],
      );
      printPlan(plan);

      if (dryRun) {
        return 0;
      }

      const decision = await decideConfirmation(yes);
      if (!decision.proceed) {
        console.error(decision.reason);
        return 1;
      }

      const writesToApply = allowOutsideRepo ? writes : writes.filter((write) => isInsideRepo(write.path, root));
      const outcomes: Outcome[] = [];
      for (const write of writesToApply) {
        await mkdir(dirname(write.path), { recursive: true });
        outcomes.push(await applyPlannedWrite(write));
      }
      printOutcomes(writesToApply, outcomes);

      const outsideCount = writes.length - writesToApply.length;
      if (outsideCount > 0 && !allowOutsideRepo) {
        console.log(
          `Skipped ${outsideCount} machine-wide write(s). Re-run with --allow-outside-repo to apply them.`,
        );
      }

      await maybeOfferBaseline(root, yes);

      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
