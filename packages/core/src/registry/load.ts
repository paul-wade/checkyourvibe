import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROTOCOL_VERSION, type AnalyzerManifest, type RuleManifest } from '../protocol/index.js';
import { isUnknownArray } from '../guards.js';

export type { AnalyzerManifest, RuleManifest } from '../protocol/index.js';

export type RegistryErrorCode = 'NOT_FOUND' | 'INVALID' | 'AMBIGUOUS';

/** A registry error names both the failing condition and the object that failed. */
export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/** The analyzer entry a user writes in configuration. */
export interface AnalyzerConfig {
  id: string;
  package: string;
  options?: Record<string, unknown>;
}

/**
 * Which of the two places a bare analyzer specifier was found in.
 *
 * `project` is the repository being checked: the specifier resolved from that
 * repository's own dependencies, so the reference travels to any machine that
 * installs the same dependency.
 *
 * `cli` is the checkyourvibe installation running the command. A local clone
 * keeps every analyzer next to the core package under `packages/`, and an npm
 * install keeps them next to it under `node_modules/@checkyourvibe/`; in both
 * layouts the analyzer exists beside the CLI rather than inside the checked
 * project. Resolving there is what lets a clone-installed `cyv` analyse a
 * project that has never heard of checkyourvibe, while the configuration still
 * names a package rather than a path into someone's home directory.
 */
export type AnalyzerOrigin = 'project' | 'cli';

/** An analyzer manifest located on disk, and the lookup that located it. */
export interface ResolvedAnalyzerManifest {
  /** Absolute path to the `analyzer.manifest.json` that will be read. */
  path: string;
  origin: AnalyzerOrigin;
}

/** The scope whose package layout this CLI knows by convention. */
const CHECKYOURVIBE_SCOPE = '@checkyourvibe/';

/**
 * Check whether a bare command is reachable on the process PATH.
 *
 * This is intentionally a synchronous, PATH-only check: `cyv init` needs a
 * boolean before it can build a default config, and spawning the command just
 * to see if it exists would be a surprising side effect.
 */
export function hasCommandOnPath(command: string): boolean {
  const pathEnv = process.env.PATH;
  if (command.length === 0 || pathEnv === undefined || pathEnv.length === 0) {
    return false;
  }

  const isWindows = process.platform === 'win32';
  const rawExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const delimiter = isWindows ? ';' : ':';
  const extensions = rawExt
    .split(';')
    .map((ext) => (ext.startsWith('.') ? ext.slice(1) : ext))
    .filter((ext) => ext.length > 0);

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }

    const candidates: string[] = [path.join(dir, command)];
    for (const ext of extensions) {
      candidates.push(path.join(dir, `${command}.${ext}`));
    }

    for (const candidate of candidates) {
      const info = statSync(candidate, { throwIfNoEntry: false });
      if (info === undefined || !info.isFile()) {
        continue;
      }
      if (isWindows) {
        return true;
      }
      if ((info.mode & 0o111) !== 0) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Convenience for `cyv init`: the C# analyzer is only useful when `dotnet`
 * is on PATH, so the default config should not include it otherwise.
 */
export function hasDotnetOnPath(): boolean {
  return hasCommandOnPath('dotnet');
}

/**
 * Load a single analyzer manifest without executing the analyzer.
 *
 * The specifier is either a repo-relative path to `analyzer.manifest.json` or a
 * package name whose package root contains that file. Package names are resolved
 * from `repoRoot` first and from the checkyourvibe installation second, so a
 * config that names `@checkyourvibe/analyzer-typescript` keeps working on a
 * machine that never cloned this repository and also works on one where the
 * analyzer exists only inside the clone the CLI was installed from. The manifest
 * is read as JSON and validated; it is never imported.
 */
export async function loadAnalyzerManifest(
  specifier: string,
  repoRoot: string,
): Promise<AnalyzerManifest> {
  const { path: manifestPath } = await resolveAnalyzerManifestPath(specifier, repoRoot);
  const text = await readManifestText(manifestPath, specifier);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" is not valid JSON: ${cause}`,
    );
  }

  const manifest = asManifest(raw, specifier);
  return withResolvedExecPaths(manifest, path.dirname(manifestPath));
}

/**
 * Rewrite relative `exec` paths to absolute, against the manifest's own directory.
 *
 * A manifest says `./dist/index.js` meaning "next to me", not "next to whatever
 * repository happens to be loading me". Resolving that is a load-time concern:
 * the loader is the only place that knows where the manifest came from, and
 * doing it here keeps the executor from having to be told separately — a seam
 * that silently resolved against the repository root until an analyzer outside
 * the root exposed it.
 *
 * Bare commands (`dotnet`, `clang-query`) are left alone so PATH lookup works.
 */
function withResolvedExecPaths(
  manifest: AnalyzerManifest,
  manifestDir: string,
): AnalyzerManifest {
  const isRelative = (p: string): boolean => p.startsWith('./') || p.startsWith('../');

  if (manifest.exec.type === 'node') {
    if (!isRelative(manifest.exec.module)) return manifest;
    return {
      ...manifest,
      exec: { type: 'node', module: path.resolve(manifestDir, manifest.exec.module) },
    };
  }

  // `args` needs the same treatment as `command`, and for a sharper reason.
  // The portable way to invoke a managed or interpreted analyzer is a runtime
  // plus a relative artefact path — `dotnet ./bin/analyzer.dll`, `python
  // ./analyze.py`. There `command` is a bare PATH lookup and the only relative
  // path lives in `args`. Leaving args alone forced such analyzers to point
  // `command` at a directly-executable, OS-specific wrapper instead, which is
  // exactly the thing that does not survive a move to another platform.
  const resolvedCommand = isRelative(manifest.exec.command)
    ? path.resolve(manifestDir, manifest.exec.command)
    : manifest.exec.command;

  const args = manifest.exec.args;
  let resolvedArgs: string[] | undefined;
  let argsChanged = false;
  if (args !== undefined) {
    resolvedArgs = [];
    for (const arg of args) {
      const resolved = isRelative(arg) ? path.resolve(manifestDir, arg) : arg;
      resolvedArgs.push(resolved);
      if (resolved !== arg) {
        argsChanged = true;
      }
    }
  }

  const unchanged = resolvedCommand === manifest.exec.command && !argsChanged;
  if (unchanged) return manifest;

  return {
    ...manifest,
    exec: resolvedArgs
      ? { type: 'process', command: resolvedCommand, args: resolvedArgs }
      : { type: 'process', command: resolvedCommand },
  };
}

/** Load every configured analyzer and verify its declared id matches the config. */
export async function loadAnalyzers(
  config: AnalyzerConfig[],
  repoRoot: string,
): Promise<AnalyzerManifest[]> {
  const manifests: AnalyzerManifest[] = [];

  for (const entry of config) {
    const manifest = await loadAnalyzerManifest(entry.package, repoRoot);
    if (manifest.id !== entry.id) {
      throw new RegistryError(
        'INVALID',
        `Configured analyzer id "${entry.id}" does not match manifest id "${manifest.id}" from "${entry.package}"`,
      );
    }
    manifests.push(manifest);
  }

  return manifests;
}

/**
 * Every rule from every configured analyzer, as one catalog.
 *
 * **Rule ids are global, not qualified by analyzer, and that is a decision
 * rather than an oversight.** It was reconsidered once four analyzers existed
 * and left as it is, for three reasons.
 *
 * A collision is already loud: it throws here, names both analyzers, and exits
 * 2 before anything runs. This project's cardinal failure is a silent one, and
 * this is not that — verified by constructing a second analyzer declaring
 * `no-any` and watching the run refuse to start.
 *
 * Bare ids appear in places users have already written down: `rules` and
 * `overrides` in configuration, `suppressions[].ruleId`, every entry in a
 * committed baseline, and `cyv explain <id>`. Qualifying them would either
 * break all of those or require a compatibility layer that accepts both
 * spellings — and two spellings for one rule is its own source of confusion.
 *
 * And it has not happened. Four analyzers, seventeen rules, no collision,
 * because rule names track language idiom: `no-any` is a TypeScript concept and
 * the C# analyzer independently arrived at `no-dynamic`. The pressure would come
 * from a third-party analyzer whose author cannot see our names — and when that
 * happens the loud error is what tells us, at which point qualification can be
 * added knowing what it is for.
 *
 * `notFixes` are unaffected either way: a notFix's `rule` may only name a
 * sibling in the same analyzer, so it is unambiguous by construction.
 */
export function allRules(manifests: AnalyzerManifest[]): RuleManifest[] {
  const byId = new Map<string, string>();
  const rules: RuleManifest[] = [];

  for (const manifest of manifests) {
    for (const rule of manifest.rules) {
      const existing = byId.get(rule.id);
      if (existing) {
        // Loud, named, and fatal — deliberately not resolved by qualifying the
        // id with its analyzer. See the note above `allRules`.
        //
        // The message says what to DO, because there is no way for the user to
        // rename someone else's rule: the only real options are to drop one
        // analyzer or to ask its author to rename. Reporting the collision
        // without saying that leaves a reader stuck at a correct error.
        throw new RegistryError(
          'AMBIGUOUS',
          `Rule "${rule.id}" is defined by both analyzer "${existing}" and analyzer "${manifest.id}". ` +
            'Rule ids are global across configured analyzers, so the two cannot both be loaded. ' +
            `Remove one of those analyzers from "analyzers" in ${'checkyourvibe.json'}, or ask its ` +
            'author to rename the rule. This is reported rather than resolved silently because ' +
            'picking one would mean running a rule you did not configure, under a name that means ' +
            'something else.',
        );
      }
      byId.set(rule.id, manifest.id);
      rules.push(rule);
    }
  }

  return rules;
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const info = await stat(dirPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * The root of the package this code is running from, found by walking up from
 * this module until a `package.json` appears.
 *
 * The walk is used rather than a fixed number of `..` segments because the same
 * module runs from `dist/registry/` in a built CLI and from `src/registry/`
 * under the test runner. Both sit inside the same package, at different depths.
 */
async function cliPackageRoot(): Promise<string | undefined> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (await fileExists(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Find an analyzer manifest inside the checkyourvibe installation itself.
 *
 * Two lookups, in order. Node's resolver runs from the core package's own
 * location, which covers an analyzer installed as a dependency or peer of the
 * CLI. Then the sibling-directory convention: a clone holds analyzers at
 * `packages/<name>` next to `packages/core`, and an npm install holds them at
 * `node_modules/@checkyourvibe/<name>` next to `node_modules/@checkyourvibe/core`,
 * so one `dirname(coreRoot)/<name>` covers both.
 *
 * The convention is applied only to the `@checkyourvibe/` scope. A directory
 * name is not proof of identity, and another author's `@acme/analyzer-typescript`
 * must not be answered with this project's analyzer of the same last segment.
 */
async function resolveCliManifestPath(specifier: string): Promise<string | undefined> {
  const coreRoot = await cliPackageRoot();
  if (coreRoot === undefined) {
    return undefined;
  }

  const resolved = resolvePackageManifestPath(specifier, coreRoot);
  if (resolved !== undefined && (await fileExists(resolved))) {
    return resolved;
  }

  if (!specifier.startsWith(CHECKYOURVIBE_SCOPE)) {
    return undefined;
  }

  const name = specifier.slice(CHECKYOURVIBE_SCOPE.length);
  if (name.length === 0 || name.includes('/')) {
    return undefined;
  }

  const sibling = path.join(path.dirname(coreRoot), name, 'analyzer.manifest.json');
  return (await fileExists(sibling)) ? sibling : undefined;
}

/**
 * Locate the manifest a specifier names, and report which lookup found it.
 *
 * A path-like specifier is resolved against the repository being checked and is
 * returned whether or not it exists, so a mistyped path is reported by name
 * when the file is read rather than being replaced by an unrelated analyzer.
 *
 * A bare package specifier is resolved from the repository first. The
 * repository winning matters: a project that installs its own analyzer must get
 * that copy, not whichever one happens to sit beside the CLI.
 */
export async function resolveAnalyzerManifestPath(
  specifier: string,
  repoRoot: string,
): Promise<ResolvedAnalyzerManifest> {
  const normalizedRepoRoot = path.resolve(repoRoot);

  if (isPathLike(specifier)) {
    const resolved = path.resolve(normalizedRepoRoot, specifier);
    if (resolved.toLowerCase().endsWith('.json')) {
      return { path: resolved, origin: 'project' };
    }
    if (await directoryExists(resolved)) {
      return { path: path.join(resolved, 'analyzer.manifest.json'), origin: 'project' };
    }
    return { path: resolved, origin: 'project' };
  }

  const fromProject = resolvePackageManifestPath(specifier, normalizedRepoRoot);
  if (fromProject !== undefined && (await fileExists(fromProject))) {
    return { path: fromProject, origin: 'project' };
  }

  const fromCli = await resolveCliManifestPath(specifier);
  if (fromCli !== undefined) {
    return { path: fromCli, origin: 'cli' };
  }

  const coreRoot = await cliPackageRoot();
  const cliLocation = coreRoot === undefined ? 'unknown' : path.dirname(coreRoot);
  throw new RegistryError(
    'NOT_FOUND',
    `Could not resolve analyzer package "${specifier}" from ${normalizedRepoRoot}, ` +
      `nor beside the checkyourvibe installation running this command (${cliLocation}). ` +
      'If this is an npm package, install it in this repository; otherwise use a path to the analyzer manifest.',
  );
}

function isPathLike(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    return true;
  }
  if (path.isAbsolute(specifier)) {
    return true;
  }
  if (specifier.toLowerCase().endsWith('.json')) {
    return true;
  }
  // A bare package name may contain a single slash for a scope, but a
  // repo-relative path with multiple path components is not a package.
  return specifier.includes('/') && !specifier.startsWith('@');
}

/**
 * Resolve a bare package specifier from the repository root using Node's own
 * CommonJS resolver. The manifest is not imported; `require.resolve` is only
 * used for its path-finding behavior.
 *
 * The resolver is constructed with a synthetic file inside the repository so
 * that package lookup starts from `repoRoot` and walks upward through
 * `node_modules`, exactly as `import.meta.resolve` would from a module in that
 * directory.
 */
function resolvePackageManifestPath(specifier: string, repoRoot: string): string | undefined {
  let resolver: NodeRequire;
  try {
    const baseFile = path.join(repoRoot, '__cyv-resolve.js');
    resolver = createRequire(pathToFileURL(baseFile).href);
  } catch {
    return undefined;
  }

  const manifestPath = resolveIfPossible(resolver, `${specifier}/analyzer.manifest.json`);
  if (manifestPath !== undefined) {
    return manifestPath;
  }

  // Some packages block subpath exports; falling back to their package.json
  // still lets us read a manifest that ships in the package.
  const packageJson = resolveIfPossible(resolver, `${specifier}/package.json`);
  if (packageJson !== undefined) {
    return path.join(path.dirname(packageJson), 'analyzer.manifest.json');
  }

  return undefined;
}

function resolveIfPossible(resolver: NodeRequire, id: string): string | undefined {
  try {
    return resolver.resolve(id);
  } catch {
    return undefined;
  }
}

async function readManifestText(manifestPath: string, specifier: string): Promise<string> {
  try {
    return await readFile(manifestPath, 'utf-8');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new RegistryError(
      'NOT_FOUND',
      `Could not find analyzer manifest for "${specifier}" at ${manifestPath}: ${cause}`,
    );
  }
}

/** True when `value` is a non-null object, so its properties can be inspected by name. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asManifest(value: unknown, specifier: string): AnalyzerManifest {
  if (!isRecord(value)) {
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" must be a JSON object`,
    );
  }

  const m = value;

  if (m.protocol !== PROTOCOL_VERSION) {
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" must use protocol version ${PROTOCOL_VERSION}`,
    );
  }

  const id = m.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" must have a non-empty "id"`,
    );
  }

  const match = toStringArray(m.match);
  if (match === undefined || match.length === 0) {
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" must have a non-empty "match" array of strings`,
    );
  }

  const rules = toRuleArray(m.rules, id);
  if (rules === undefined) {
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" must have a "rules" array of valid rule manifests`,
    );
  }

  const exec = toExec(m.exec);
  if (exec === undefined) {
    throw new RegistryError(
      'INVALID',
      `Analyzer manifest for "${specifier}" must have a valid "exec" shape`,
    );
  }

  const manifest: AnalyzerManifest = {
    protocol: PROTOCOL_VERSION,
    id,
    match,
    rules,
    exec,
  };

  if (m.exclude !== undefined) {
    const exclude = toStringArray(m.exclude);
    if (exclude === undefined) {
      throw new RegistryError(
        'INVALID',
        `Analyzer manifest for "${specifier}" has an invalid "exclude" array`,
      );
    }
    manifest.exclude = exclude;
  }

  if (m.supplements !== undefined) {
    if (typeof m.supplements !== 'boolean') {
      throw new RegistryError(
        'INVALID',
        `Analyzer manifest for "${specifier}" has a non-boolean "supplements" value`,
      );
    }
    manifest.supplements = m.supplements;
  }

  if (m.capabilities !== undefined) {
    const capabilities = toCapabilities(m.capabilities);
    if (capabilities === undefined) {
      throw new RegistryError(
        'INVALID',
        `Analyzer manifest for "${specifier}" has invalid "capabilities"`,
      );
    }
    manifest.capabilities = capabilities;
  }

  return manifest;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

function toRuleArray(value: unknown, analyzerId: string): RuleManifest[] | undefined {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const result: RuleManifest[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw: unknown = value[i];
    const rule = toRule(raw, analyzerId, i);
    if (rule === undefined) {
      return undefined;
    }
    result.push(rule);
  }
  return result;
}

function toRule(value: unknown, analyzerId: string, index: number): RuleManifest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const r = value;

  const id = r.id;
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }

  const category = r.category;
  if (typeof category !== 'string' || category.length === 0) {
    return undefined;
  }

  const scope = r.scope;
  if (scope !== 'file' && scope !== 'project') {
    return undefined;
  }

  const severity = r.severity;
  if (severity !== 'error' && severity !== 'warning') {
    return undefined;
  }

  const summary = r.summary;
  if (typeof summary !== 'string' || summary.length === 0) {
    return undefined;
  }

  const why = r.why;
  if (typeof why !== 'string' || why.length === 0) {
    return undefined;
  }

  const allowedFixes = toStringArray(r.allowedFixes);
  if (allowedFixes === undefined) {
    return undefined;
  }

  const notFixes = toNotFixes(r.notFixes);
  if (notFixes === undefined) {
    return undefined;
  }

  const examples = r.examples;
  if (!isRecord(examples)) {
    return undefined;
  }
  const bad = examples.bad;
  const good = examples.good;
  if (typeof bad !== 'string' || typeof good !== 'string') {
    return undefined;
  }

  const rule: RuleManifest = {
    id,
    category,
    scope,
    severity,
    summary,
    why,
    allowedFixes,
    notFixes,
    examples: { bad, good },
  };

  if (r.evidence !== undefined) {
    if (r.evidence !== 'syntax' && r.evidence !== 'semantic') {
      return undefined;
    }
    rule.evidence = r.evidence;
  }

  // This validator is a whitelist: fields not copied here are dropped. Pack
  // membership went missing exactly that way, which made `packs: [...]` in
  // configuration expand to nothing and silently enable no rules at all.
  if (r.pack !== undefined) {
    if (typeof r.pack !== 'string' || r.pack.length === 0) {
      return undefined;
    }
    rule.pack = r.pack;
  }

  if (r.optionsSchema !== undefined) {
    if (!isRecord(r.optionsSchema)) {
      return undefined;
    }
    rule.optionsSchema = r.optionsSchema;
  }

  return rule;
}

function toNotFixes(value: unknown): { pattern: string; because: string; rule?: string }[] | undefined {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const result: { pattern: string; because: string; rule?: string }[] = [];
  for (let i = 0; i < value.length; i++) {
    const raw: unknown = value[i];
    if (!isRecord(raw)) {
      return undefined;
    }
    const n = raw;
    const pattern = n.pattern;
    const because = n.because;
    if (typeof pattern !== 'string' || typeof because !== 'string') {
      return undefined;
    }
    const notFix: { pattern: string; because: string; rule?: string } = { pattern, because };
    if (n.rule !== undefined) {
      if (typeof n.rule !== 'string') {
        return undefined;
      }
      notFix.rule = n.rule;
    }
    result.push(notFix);
  }
  return result;
}

function toExec(value: unknown): AnalyzerManifest['exec'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const e = value;

  if (e.type === 'node') {
    const module = e.module;
    if (typeof module !== 'string' || module.length === 0) {
      return undefined;
    }
    return { type: 'node', module };
  }

  if (e.type === 'process') {
    const command = e.command;
    if (typeof command !== 'string' || command.length === 0) {
      return undefined;
    }
    const exec: { type: 'process'; command: string; args?: string[] } = { type: 'process', command };
    if (e.args !== undefined) {
      const args = toStringArray(e.args);
      if (args === undefined) {
        return undefined;
      }
      exec.args = args;
    }
    return exec;
  }

  return undefined;
}

function toCapabilities(value: unknown): { session?: boolean } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const c = value;
  if (c.session !== undefined && typeof c.session !== 'boolean') {
    return undefined;
  }
  return c.session === undefined ? {} : { session: c.session };
}
