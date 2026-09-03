/**
 * Project registry for the multi-project review dashboard.
 *
 * Persists absolute project roots to ~/.cyv/projects.json. Projects are added
 * and removed explicitly; nothing is scanned or inferred. A project is in the
 * registry because somebody put it there.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isUnknownArray } from '../guards.js';

export const REGISTRY_DIR = '.cyv';
export const REGISTRY_FILE = 'projects.json';
export const CONFIG_FILE = 'checkyourvibe.json';

/** A path that is a registered project directory with a configuration file. */
export interface ValidationSuccess {
  readonly ok: true;
  readonly path: string;
  readonly exists: true;
  readonly hasConfig: true;
}

/** A path that is not a usable project, with the facts the check actually saw. */
export interface ValidationFailure {
  readonly ok: false;
  readonly path: string;
  readonly exists: boolean;
  readonly hasConfig: boolean;
  readonly reason: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface AddResult {
  readonly ok: true;
  readonly path: string;
  readonly added: boolean;
}

export interface RemoveResult {
  readonly ok: true;
  readonly path: string;
  readonly removed: boolean;
}

/** One registered project together with what currently exists on disk. */
export interface ProjectListEntry {
  readonly path: string;
  readonly status: 'ok' | 'missing';
  readonly exists: boolean;
  readonly hasConfig: boolean;
  readonly reason?: string;
}

/** Returns the default registry file location in the user's home directory. */
export function defaultRegistryPath(): string {
  return join(homedir(), REGISTRY_DIR, REGISTRY_FILE);
}

/**
 * Normalizes a project directory path to an absolute path.
 *
 * On Windows, capitalizes the drive letter so the same directory reached
 * through different case spellings does not produce duplicate entries.
 */
export function normalizeProjectPath(target: string): string {
  let normalized = resolve(target);
  if (process.platform === 'win32') {
    const match = /^([a-zA-Z]):(.*)$/.exec(normalized);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      normalized = `${match[1].toUpperCase()}:${match[2]}`;
    }
  }
  return normalized;
}

/**
 * Reads the list of registered project paths from disk.
 *
 * Returns an empty array if the registry file does not exist or does not
 * contain a JSON array of non-empty strings.
 */
export async function readRegistry(registryFile = defaultRegistryPath()): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(registryFile, 'utf-8');
  } catch {
    return [];
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isUnknownArray(parsed)) {
    return [];
  }

  const paths: string[] = [];
  for (const item of parsed) {
    if (typeof item === 'string' && item.trim().length > 0) {
      paths.push(normalizeProjectPath(item));
    }
  }
  return paths;
}

/**
 * Writes the list of project paths to the registry file.
 *
 * Preserves uniqueness and ensures the parent directory exists.
 */
export async function writeRegistry(
  paths: readonly string[],
  registryFile = defaultRegistryPath(),
): Promise<void> {
  const unique = [...new Set(paths.map((p) => normalizeProjectPath(p)))];
  await mkdir(dirname(registryFile), { recursive: true });
  await writeFile(registryFile, `${JSON.stringify(unique, null, 2)}\n`, 'utf-8');
}

/**
 * Verifies that a directory exists and contains a checkyourvibe.json file.
 *
 * The result records `exists` and `hasConfig` separately so callers can tell
 * a missing directory apart from a directory that is merely missing a config.
 */
export async function validateProjectPath(target: string): Promise<ValidationResult> {
  const normalized = normalizeProjectPath(target);
  let isDirectory = false;
  try {
    const s = await stat(normalized);
    isDirectory = s.isDirectory();
  } catch {
    return {
      ok: false,
      path: normalized,
      exists: false,
      hasConfig: false,
      reason: `Directory "${normalized}" does not exist.`,
    };
  }

  if (!isDirectory) {
    return {
      ok: false,
      path: normalized,
      exists: false,
      hasConfig: false,
      reason: `Path "${normalized}" is not a directory.`,
    };
  }

  const configPath = join(normalized, CONFIG_FILE);
  let hasConfigFile = false;
  try {
    const s = await stat(configPath);
    hasConfigFile = s.isFile();
  } catch {
    hasConfigFile = false;
  }

  if (!hasConfigFile) {
    return {
      ok: false,
      path: normalized,
      exists: true,
      hasConfig: false,
      reason: `No ${CONFIG_FILE} found in "${normalized}". Expected "${configPath}".`,
    };
  }

  return { ok: true, path: normalized, exists: true, hasConfig: true };
}

/**
 * Adds a project directory to the registry.
 *
 * Rejects paths missing checkyourvibe.json with an actionable error.
 */
export async function addProject(
  target: string,
  registryFile = defaultRegistryPath(),
): Promise<AddResult> {
  const check = await validateProjectPath(target);
  if (!check.ok) {
    throw new Error(`Cannot register project: ${check.reason}`);
  }

  const current = await readRegistry(registryFile);
  const normalized = check.path;
  const exists = current.includes(normalized);

  if (!exists) {
    current.push(normalized);
    await writeRegistry(current, registryFile);
  }

  return { ok: true, path: normalized, added: !exists };
}

/** Removes a project directory from the registry. */
export async function removeProject(
  target: string,
  registryFile = defaultRegistryPath(),
): Promise<RemoveResult> {
  const normalized = normalizeProjectPath(target);
  const current = await readRegistry(registryFile);
  const next = current.filter((p) => p !== normalized);
  const removed = next.length !== current.length;

  if (removed) {
    await writeRegistry(next, registryFile);
  }

  return { ok: true, path: normalized, removed };
}

/**
 * Lists all registered projects with their current accessibility status.
 *
 * Paths that no longer exist or lack configuration are reported as missing
 * without being removed, and the two cases are kept separate.
 */
export async function listProjects(registryFile = defaultRegistryPath()): Promise<ProjectListEntry[]> {
  const paths = await readRegistry(registryFile);
  const results: ProjectListEntry[] = [];

  for (const projectPath of paths) {
    const check = await validateProjectPath(projectPath);
    if (check.ok) {
      results.push({
        path: projectPath,
        status: 'ok',
        exists: true,
        hasConfig: true,
      });
    } else {
      results.push({
        path: projectPath,
        status: 'missing',
        exists: check.exists,
        hasConfig: check.hasConfig,
        reason: check.reason,
      });
    }
  }

  return results;
}

/** Backwards-compatible alias for callers that expect `loadProjects`. */
export const loadProjects = listProjects;
