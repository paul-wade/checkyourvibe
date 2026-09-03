import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Project, ts, type SourceFile } from 'ts-morph';

export interface LoadResult {
  project: Project;
  loaded: SourceFile[];
  skipped: { file: string; reason: string }[];
}

export interface ProjectGroup {
  project: Project;
  files: string[];
  tsConfigFilePath: string | undefined;
  /** Set when this group could not get a real compiler configuration. */
  degraded?: string;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function findNearestTsConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

const rawConfigCache = new Map<string, Record<string, unknown> | undefined>();

function readRawConfig(tsConfigFilePath: string): Record<string, unknown> | undefined {
  const cached = rawConfigCache.get(tsConfigFilePath);
  if (cached !== undefined || rawConfigCache.has(tsConfigFilePath)) {
    return cached;
  }

  let raw: Record<string, unknown> | undefined;
  try {
    const text = readFileSync(tsConfigFilePath, 'utf8');
    const parsed = ts.parseConfigFileTextToJson(tsConfigFilePath, text);
    if (parsed.error === undefined) {
      const config: unknown = parsed.config;
      raw = isRecord(config) ? config : undefined;
    }
  } catch {
    raw = undefined;
  }

  rawConfigCache.set(tsConfigFilePath, raw);
  return raw;
}

/**
 * A solution-style tsconfig contains only project references — no
 * `compilerOptions` and no files of its own.
 *
 * Loading one produces a project with no `lib`, no `types`, and no module
 * resolution, so every import resolves to `any`, and rules that read inferred
 * types report the entire standard library as untyped. On one repository that
 * was 673 findings, none of them real.
 */
function isSolutionStyle(tsConfigFilePath: string): boolean {
  const raw = readRawConfig(tsConfigFilePath);
  if (raw === undefined) return false;

  const references = raw.references;
  const files = raw.files;
  const include = raw.include;

  const hasReferences = isUnknownArray(references) && references.length > 0;
  const hasNoOwnFiles =
    (files === undefined || (isUnknownArray(files) && files.length === 0)) &&
    (include === undefined || (isUnknownArray(include) && include.length === 0));
  const hasNoOptions = raw.compilerOptions === undefined;

  return hasReferences && hasNoOwnFiles && hasNoOptions;
}

/**
 * When the nearest tsconfig is solution-style, look for a sibling base config.
 *
 * A monorepo root almost always holds both: a solution-style `tsconfig.json`
 * carrying only project references, and a `tsconfig.base.json` holding the
 * compiler options every package extends. Files that live at the root — build
 * tooling, config files — are governed by neither in the eyes of a naive
 * lookup, so they were being analysed with invented defaults and reported as
 * degraded. The base config is the right answer and is sitting right there.
 */
function findSiblingBaseConfig(solutionConfigPath: string): string | undefined {
  const dir = dirname(solutionConfigPath);
  for (const name of ['tsconfig.base.json', 'tsconfig.options.json']) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && !isSolutionStyle(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function fallbackProject(): Project {
  return new Project({
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      strict: true,
      allowJs: false,
    },
  });
}

export function createProject(repoRoot: string): Project {
  const tsConfigFilePath = findNearestTsConfig(repoRoot);
  if (tsConfigFilePath !== undefined && !isSolutionStyle(tsConfigFilePath)) {
    return new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
  }
  return fallbackProject();
}

interface LeafConfig {
  configPath: string;
  fileCount: number;
  fileSet: ReadonlySet<string>;
  /** Messages for files the config named but TypeScript could not read. */
  unreadableFiles: readonly string[];
  /** The config's resolved `outDir`, used to rebuild TypeScript's default excludes. */
  outDir: string | undefined;
}

/**
 * TypeScript's diagnostic codes for "the config named a file I could not read".
 *
 * 6053 is raised for an `extends` target that does not resolve and for a
 * `files` entry that is missing; 5012 and 5083 are read failures on a config
 * in the chain. Any of them means the compiler options in force are not the
 * ones the repository declared: an `extends` that fails takes `target`, `lib`
 * and `types` with it, so the standard library disappears and every inferred
 * type collapses to `any`.
 *
 * Unknown-option (5023) and empty-input (18003) diagnostics are deliberately
 * not here. The first fires when the repository's own TypeScript is newer than
 * the analyzer's, the second when a config selects no files of its own; in
 * neither case has type resolution been lost.
 */
const UNREADABLE_CONFIG_FILE_CODES: ReadonlySet<number> = new Set([5012, 5083, 6053]);

const leafConfigCache = new Map<string, LeafConfig | undefined>();

function parseLeafConfig(configPath: string): LeafConfig | undefined {
  const cached = leafConfigCache.get(configPath);
  if (cached !== undefined || leafConfigCache.has(configPath)) {
    return cached;
  }

  let leaf: LeafConfig | undefined;
  if (existsSync(configPath)) {
    try {
      const text = readFileSync(configPath, 'utf8');
      const sourceFile = ts.parseJsonText(configPath, text);
      const parsed = ts.parseJsonSourceFileConfigFileContent(
        sourceFile,
        ts.sys,
        dirname(configPath),
      );
      const fileSet = new Set<string>();
      for (const file of parsed.fileNames) {
        fileSet.add(normalizePath(file));
      }
      const unreadableFiles: string[] = [];
      for (const error of parsed.errors) {
        if (UNREADABLE_CONFIG_FILE_CODES.has(error.code)) {
          unreadableFiles.push(ts.flattenDiagnosticMessageText(error.messageText, ' '));
        }
      }
      leaf = {
        configPath,
        fileCount: fileSet.size,
        fileSet,
        unreadableFiles,
        outDir: parsed.options.outDir,
      };
    } catch {
      leaf = undefined;
    }
  }

  leafConfigCache.set(configPath, leaf);
  return leaf;
}

const solutionLeavesCache = new Map<string, readonly LeafConfig[]>();

function getLeafConfigs(solutionPath: string): readonly LeafConfig[] {
  const cached = solutionLeavesCache.get(solutionPath);
  if (cached !== undefined) {
    return cached;
  }

  const visited = new Set<string>();
  const leaves = collectLeafConfigs(solutionPath, visited);
  solutionLeavesCache.set(solutionPath, leaves);
  return leaves;
}

function collectLeafConfigs(
  configPath: string,
  visited: Set<string>,
): readonly LeafConfig[] {
  if (visited.has(configPath)) return [];
  visited.add(configPath);

  if (!existsSync(configPath)) return [];

  if (!isSolutionStyle(configPath)) {
    const leaf = parseLeafConfig(configPath);
    return leaf !== undefined ? [leaf] : [];
  }

  const raw = readRawConfig(configPath);
  if (raw === undefined) return [];

  const references = getReferencePaths(raw, dirname(configPath));
  const leaves: LeafConfig[] = [];
  for (const reference of references) {
    for (const leaf of collectLeafConfigs(reference, visited)) {
      leaves.push(leaf);
    }
  }
  return leaves;
}

function getReferencePaths(
  raw: Record<string, unknown>,
  solutionDir: string,
): readonly string[] {
  const references = raw.references;
  if (!isUnknownArray(references)) return [];

  const paths: string[] = [];
  for (const reference of references) {
    if (!isRecord(reference)) continue;
    const pathValue = reference.path;
    if (!isNonEmptyString(pathValue)) continue;
    const resolved = resolveReferencePath(solutionDir, pathValue);
    if (resolved !== undefined) {
      paths.push(resolved);
    }
  }
  return paths;
}

function resolveReferencePath(
  baseDir: string,
  referencePath: string,
): string | undefined {
  const absolute = resolve(baseDir, referencePath);

  if (existsSync(absolute)) {
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      const candidate = join(absolute, 'tsconfig.json');
      return existsSync(candidate) ? candidate : undefined;
    }
    return absolute;
  }

  if (!referencePath.endsWith('.json')) {
    const candidate = join(absolute, 'tsconfig.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function normalizePath(file: string): string {
  const normalized = resolve(file).replace(/\\/g, '/');
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function findBestReferencedConfig(
  file: string,
  solutionConfigPath: string,
): string | undefined {
  const leaves = getLeafConfigs(solutionConfigPath);
  if (leaves.length === 0) return undefined;

  const canonical = normalizePath(file);
  let best: LeafConfig | undefined;
  for (const leaf of leaves) {
    if (leaf.fileSet.has(canonical)) {
      if (best === undefined || leaf.fileCount < best.fileCount) {
        best = leaf;
      }
    }
  }

  return best?.configPath;
}

/**
 * The excludes TypeScript applies on its own when a config writes none.
 *
 * Re-parsing a config with these in place of its own `exclude` answers a
 * narrower question than "is this file in the project": it separates a file the
 * repository told TypeScript to skip from a file the config's `include` simply
 * never reached. The defaults are kept so the re-parse does not walk
 * `node_modules` or the build output.
 */
function defaultExcludes(outDir: string | undefined): string[] {
  const excludes = ['node_modules', 'bower_components', 'jspm_packages'];
  if (outDir !== undefined) {
    excludes.push(outDir);
  }
  return excludes;
}

const relaxedFileSetCache = new Map<string, ReadonlySet<string>>();

/** The files `configPath` would claim if its own `exclude` were not there. */
function getFileSetIgnoringExclude(configPath: string): ReadonlySet<string> {
  const cached = relaxedFileSetCache.get(configPath);
  if (cached !== undefined) {
    return cached;
  }

  const fileSet = new Set<string>();
  const raw = readRawConfig(configPath);
  const leaf = parseLeafConfig(configPath);
  if (raw !== undefined && leaf !== undefined) {
    const relaxed: Record<string, unknown> = { ...raw, exclude: defaultExcludes(leaf.outDir) };
    try {
      const parsed = ts.parseJsonConfigFileContent(
        relaxed,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath,
      );
      for (const file of parsed.fileNames) {
        fileSet.add(normalizePath(file));
      }
    } catch {
      fileSet.clear();
    }
  }

  relaxedFileSetCache.set(configPath, fileSet);
  return fileSet;
}

/**
 * Whether `configPath` excludes `file`.
 *
 * A config that names a file describes the program that file belongs to: its
 * options, its libs, and the other files whose types it may see. A config that
 * excludes a file describes nothing about it, so anything inferred there comes
 * from a program the repository never asked for.
 *
 * Only the exclusion is treated this way. A file the config's `include` merely
 * does not reach is left alone: on this repository every `packages/*\/test/**`
 * file sits outside an `include` of `src/**\/*`, and every one of them still
 * resolves its imports and yields true findings. Withholding those would cost
 * real coverage to fix a problem they do not have.
 */
function isExcludedByConfig(configPath: string, file: string): boolean {
  const leaf = parseLeafConfig(configPath);
  if (leaf === undefined || leaf.fileCount === 0) {
    return false;
  }

  const canonical = normalizePath(file);
  if (leaf.fileSet.has(canonical)) {
    return false;
  }

  return getFileSetIgnoringExclude(configPath).has(canonical);
}

function findNearestPackageJson(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Whether `name` is installed in a `node_modules` reachable from `fromDir`. */
function isInstalled(fromDir: string, name: string): boolean {
  let dir = resolve(fromDir);
  for (;;) {
    if (existsSync(join(dir, 'node_modules', name))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

function declaredDependencyNames(manifest: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of ['dependencies', 'devDependencies']) {
    const value = manifest[field];
    if (isRecord(value)) {
      names.push(...Object.keys(value));
    }
  }
  return names;
}

const uninstalledCache = new Map<string, string | undefined>();

/**
 * Why the packages this config's code imports cannot be trusted to resolve, or
 * `undefined` when they can.
 *
 * A package whose declared dependencies are not installed has no types for any
 * of them. Every import from such a package resolves to nothing, every value it
 * produces is inferred `any`, and rules that read inferred types report the
 * whole file. On a typeorm clone `packages/codemod` was in exactly that state —
 * its own package.json, no node_modules — and produced 869 semantic findings,
 * none of which described the source.
 *
 * The check reads what the repository declared rather than what the files
 * import, because a missing dependency is a fact about the package and holds
 * for every file in it.
 */
function uninstalledDependencyReason(configPath: string): string | undefined {
  const cached = uninstalledCache.get(configPath);
  if (cached !== undefined || uninstalledCache.has(configPath)) {
    return cached;
  }

  let reason: string | undefined;
  const packageJsonPath = findNearestPackageJson(dirname(configPath));
  if (packageJsonPath !== undefined) {
    let manifest: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      manifest = isRecord(parsed) ? parsed : undefined;
    } catch {
      manifest = undefined;
    }

    if (manifest !== undefined) {
      const packageDir = dirname(packageJsonPath);
      const declared = declaredDependencyNames(manifest);
      const missing = declared.filter((name) => !isInstalled(packageDir, name));
      if (missing.length > 0) {
        const shown = missing.slice(0, 3).join(', ');
        const rest = missing.length > 3 ? `, and ${missing.length - 3} more` : '';
        reason =
          `${packageJsonPath} declares ${missing.length} of ${declared.length} dependencies ` +
          `that are not installed (${shown}${rest}). Imports from them resolve to nothing, so the ` +
          'types they would have supplied are inferred as `any` and semantic findings from these ' +
          'files are not reliable. Install the dependencies and run again.';
      }
    }
  }

  uninstalledCache.set(configPath, reason);
  return reason;
}

function excludedByConfigReason(configPath: string): string {
  return (
    `${configPath} excludes these files, so TypeScript never type-checks them as part of that ` +
    'project. Their inferred types come from a program the repository does not describe, so ' +
    'semantic findings for them are not reported. Bring them under a config that claims them if ' +
    'they should be checked.'
  );
}

/** Which tsconfig governs `file`, or `undefined` when none does. */
function chooseConfig(file: string): string | undefined {
  const found = findNearestTsConfig(dirname(file));
  if (found === undefined) {
    return undefined;
  }

  if (!isSolutionStyle(found)) {
    return found;
  }

  return findBestReferencedConfig(file, found) ?? findSiblingBaseConfig(found);
}

interface FileBucket {
  tsConfigFilePath: string | undefined;
  excluded: boolean;
  files: string[];
}

/**
 * Group files by the tsconfig that actually governs them.
 *
 * Resolution starts at each FILE's directory, not the repository root. In a
 * monorepo the root config is usually solution-style, so resolving once from
 * the root gives every package the wrong compiler options — which is how real
 * type resolution silently becomes no type resolution.
 *
 * When the nearest config is solution-style, its references are followed
 * transitively and the referenced project whose include covers the file is
 * chosen. The smallest matching project wins, so a source file goes to the lib
 * config and a spec file goes to the spec config without hard-coding either.
 *
 * A group carries `degraded` when the configuration it was built from cannot
 * deliver the types the rules read: the config names files TypeScript could not
 * read, the package's dependencies are not installed, or the config excludes
 * these particular files. The core withholds semantic findings for such files
 * and reports the count and the reason instead.
 */
export function groupFilesByProject(files: string[]): ProjectGroup[] {
  const buckets = new Map<string, FileBucket>();

  for (const file of files) {
    const configPath = chooseConfig(file);
    // Excluded files share the config's options but not its guarantees, so they
    // get their own bucket: same project, different verdict on their findings.
    const excluded = configPath !== undefined && isExcludedByConfig(configPath, file);
    // The flag leads so the key stays unambiguous: a config path can contain
    // any text, including the text another key would use as its suffix.
    const key = `${excluded ? 'excluded:' : 'claimed:'}${configPath ?? ''}`;

    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { tsConfigFilePath: configPath, excluded, files: [file] });
    } else {
      bucket.files.push(file);
    }
  }

  const groups: ProjectGroup[] = [];
  for (const bucket of buckets.values()) {
    const configPath = bucket.tsConfigFilePath;
    if (configPath === undefined) {
      groups.push({
        project: fallbackProject(),
        files: bucket.files,
        tsConfigFilePath: undefined,
        degraded:
          'No usable tsconfig.json governs these files (none found, or the nearest one is ' +
          'solution-style). Analysed with default compiler options, so inferred-type findings ' +
          'may be unreliable.',
      });
      continue;
    }

    const group: ProjectGroup = {
      project: new Project({ tsConfigFilePath: configPath, skipAddingFilesFromTsConfig: true }),
      files: bucket.files,
      tsConfigFilePath: configPath,
    };

    const reasons: string[] = [];
    const broken = brokenConfigReason(configPath);
    if (broken !== undefined) {
      reasons.push(broken);
    }
    const uninstalled = uninstalledDependencyReason(configPath);
    if (uninstalled !== undefined) {
      reasons.push(uninstalled);
    }
    if (bucket.excluded) {
      reasons.push(excludedByConfigReason(configPath));
    }
    if (reasons.length > 0) {
      group.degraded = reasons.join(' ');
    }

    groups.push(group);
  }

  return groups;
}

/**
 * Why the compiler options from `configPath` cannot be trusted, or `undefined`
 * when they can.
 *
 * A tsconfig that exists and parses as JSON is not the same as one TypeScript
 * could assemble. When a file it names cannot be read — most often an
 * `extends` target that is not installed — the options it was supposed to
 * contribute are absent, `target` falls back to ES5 and `lib` to nothing, and
 * the analyzer reports the standard library as untyped. That is the same
 * outcome as having no configuration at all, so it is declared the same way.
 */
function brokenConfigReason(configPath: string): string | undefined {
  const leaf = parseLeafConfig(configPath);
  if (leaf === undefined || leaf.unreadableFiles.length === 0) {
    return undefined;
  }

  return (
    `${configPath} names files TypeScript could not read: ${leaf.unreadableFiles.join(' ')} ` +
    'The compiler options it was supposed to supply are missing, so inferred types from ' +
    'these files are not reliable. Install the missing configuration or correct the path.'
  );
}

export function loadFiles(project: Project, files: string[]): LoadResult {
  const loaded: SourceFile[] = [];
  const skipped: LoadResult['skipped'] = [];

  for (const file of files) {
    try {
      loaded.push(project.addSourceFileAtPath(file));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ file, reason });
    }
  }

  return { project, loaded, skipped };
}

export function refreshFiles(project: Project, files: string[]): LoadResult {
  const loaded: SourceFile[] = [];
  const skipped: LoadResult['skipped'] = [];

  for (const file of files) {
    try {
      const existing = project.getSourceFile(file);
      if (existing !== undefined) {
        existing.refreshFromFileSystemSync();
        loaded.push(existing);
      } else {
        loaded.push(project.addSourceFileAtPath(file));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push({ file, reason });
    }
  }

  return { project, loaded, skipped };
}
