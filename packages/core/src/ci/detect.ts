/**
 * What CI system, package manager and hook framework a repository is using,
 * read from files that are actually on disk.
 *
 * Nothing here infers a platform from a dependency name, a remote URL, or a
 * branch naming convention. A repository is on GitLab CI when it has a
 * `.gitlab-ci.yml`, and it is not when it does not. Every detection carries the
 * paths that made it true, so a caller can print the evidence rather than ask
 * the user to trust the verdict.
 *
 * Absence is a result, not an error. `cyv install-ci` prints "no CI system
 * detected" as a statement of fact and exits 0.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isUnknownArray } from '../guards.js';

export type CiSystemId =
  | 'github-actions'
  | 'gitlab-ci'
  | 'jenkins'
  | 'circleci'
  | 'azure-pipelines'
  | 'bitbucket-pipelines'
  | 'travis-ci';

export type PackageManagerId = 'pnpm' | 'yarn' | 'npm' | 'bun';

export type HookFrameworkId = 'husky' | 'pre-commit' | 'lefthook';

export interface DetectedCiSystem {
  id: CiSystemId;
  name: string;
  /** Repository-relative paths whose presence made this detection true. */
  evidence: string[];
}

export interface DetectedPackageManager {
  id: PackageManagerId;
  /** The lockfile or `packageManager` field this was read from. */
  evidence: string;
}

export interface DetectedHookFramework {
  id: HookFrameworkId;
  name: string;
  evidence: string;
}

export interface CiDetection {
  /** Every CI system with config present, in the order this module checks them. */
  systems: DetectedCiSystem[];
  /** The systems checked for and not found, so the report can name them. */
  absent: CiSystemId[];
  packageManager: DetectedPackageManager | undefined;
  hookFrameworks: DetectedHookFramework[];
  /**
   * The checkyourvibe package this repository depends on, if any.
   *
   * A generated pipeline has to invoke `cyv` on a machine that is not this one.
   * When the repository declares checkyourvibe as a dependency, the package
   * manager's own runner reaches it after the install step the pipeline already
   * runs. When it does not, the pipeline names a bare `cyv` and the runner has
   * to supply it — which is a real gap, and one the generated file states in
   * its own comments rather than leaving to be discovered on a red build.
   */
  dependency: string | undefined;
}

/**
 * Every CI system this module looks for, in the order it reports them.
 *
 * Written as a list of literal ids rather than derived from the name table's
 * keys, because `Object.keys` returns `string[]` and recovering `CiSystemId[]`
 * from it needs an assertion the checker rightly refuses. The list is the
 * source of truth; the name table is indexed by it, so the compiler still
 * rejects an id that has no name and a name that has no id.
 */
export const CI_SYSTEM_IDS: readonly CiSystemId[] = [
  'github-actions',
  'gitlab-ci',
  'jenkins',
  'circleci',
  'azure-pipelines',
  'bitbucket-pipelines',
  'travis-ci',
];

export const CI_SYSTEM_NAMES: Record<CiSystemId, string> = {
  'github-actions': 'GitHub Actions',
  'gitlab-ci': 'GitLab CI',
  jenkins: 'Jenkins',
  circleci: 'CircleCI',
  'azure-pipelines': 'Azure Pipelines',
  'bitbucket-pipelines': 'Bitbucket Pipelines',
  'travis-ci': 'Travis CI',
};

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && err.code === code;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (err) {
    if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) {
      return false;
    }
    throw err;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch (err) {
    if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) {
      return false;
    }
    throw err;
  }
}

/** The first of `candidates` that exists, as a repository-relative path. */
async function firstPresent(repoRoot: string, candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(join(repoRoot, candidate))) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * A GitHub Actions repository is one with at least one workflow file, not one
 * with a `.github` directory. `.github` alone holds issue templates,
 * `CODEOWNERS`, and Dependabot configuration in repositories that run no CI at
 * all, and treating it as evidence would report a gate for a platform the
 * project does not use.
 */
async function detectGithubWorkflows(repoRoot: string): Promise<string[]> {
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  if (!(await directoryExists(workflowsDir))) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(workflowsDir);
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) {
      return [];
    }
    throw err;
  }

  const workflows = entries
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  return workflows.map((name) => `.github/workflows/${name}`);
}

async function detectSystems(repoRoot: string): Promise<DetectedCiSystem[]> {
  const systems: DetectedCiSystem[] = [];

  const add = (id: CiSystemId, evidence: string[]): void => {
    if (evidence.length > 0) {
      systems.push({ id, name: CI_SYSTEM_NAMES[id], evidence });
    }
  };

  add('github-actions', await detectGithubWorkflows(repoRoot));
  add('gitlab-ci', await firstPresent(repoRoot, ['.gitlab-ci.yml', '.gitlab-ci.yaml']));
  add('jenkins', await firstPresent(repoRoot, ['Jenkinsfile']));
  add('circleci', await firstPresent(repoRoot, ['.circleci/config.yml', '.circleci/config.yaml']));
  add('azure-pipelines', await firstPresent(repoRoot, ['azure-pipelines.yml', 'azure-pipelines.yaml']));
  add('bitbucket-pipelines', await firstPresent(repoRoot, ['bitbucket-pipelines.yml', 'bitbucket-pipelines.yaml']));
  add('travis-ci', await firstPresent(repoRoot, ['.travis.yml', '.travis.yaml']));

  return systems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

/**
 * The package manager, read from a lockfile first and the `packageManager`
 * field second.
 *
 * A lockfile is the stronger evidence: it is what the pipeline's install step
 * will actually consume, and `npm ci` against a `pnpm-lock.yaml` fails. The
 * `packageManager` field is the fallback for a repository that gitignores its
 * lockfile, which is unusual but not wrong.
 */
async function detectPackageManager(repoRoot: string): Promise<DetectedPackageManager | undefined> {
  const lockfiles: { file: string; id: PackageManagerId }[] = [
    { file: 'pnpm-lock.yaml', id: 'pnpm' },
    { file: 'yarn.lock', id: 'yarn' },
    { file: 'bun.lockb', id: 'bun' },
    { file: 'bun.lock', id: 'bun' },
    { file: 'package-lock.json', id: 'npm' },
  ];

  for (const { file, id } of lockfiles) {
    if (await fileExists(join(repoRoot, file))) {
      return { id, evidence: file };
    }
  }

  const declared = await readPackageJsonField(repoRoot, 'packageManager');
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun') {
      return { id: name, evidence: `package.json "packageManager": "${declared}"` };
    }
  }

  return undefined;
}

async function readPackageJson(repoRoot: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, 'package.json'), 'utf-8');
  } catch (err) {
    if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) {
      return undefined;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A `package.json` this repository cannot parse is not a package manager
    // signal. `cyv check` reports broken files; detection only reads them.
    return undefined;
  }

  return isRecord(parsed) ? parsed : undefined;
}

async function readPackageJsonField(repoRoot: string, field: string): Promise<unknown> {
  const parsed = await readPackageJson(repoRoot);
  return parsed?.[field];
}

const CHECKYOURVIBE_SCOPE = '@checkyourvibe/';

/**
 * Whether the repository declares a checkyourvibe package as a dependency,
 * and under what name.
 *
 * The published package name is not settled (spec 0005 lists it as a release
 * decision), so this matches the scope and the bare project name rather than
 * one hardcoded string that would go stale the day a name is chosen.
 */
async function detectDependency(repoRoot: string): Promise<string | undefined> {
  const parsed = await readPackageJson(repoRoot);
  if (parsed === undefined) {
    return undefined;
  }

  for (const field of ['dependencies', 'devDependencies']) {
    const deps = parsed[field];
    if (!isRecord(deps)) {
      continue;
    }
    for (const name of Object.keys(deps)) {
      if (name === 'checkyourvibe' || name.startsWith(CHECKYOURVIBE_SCOPE)) {
        return name;
      }
    }
  }

  return undefined;
}

async function detectHookFrameworks(repoRoot: string): Promise<DetectedHookFramework[]> {
  const frameworks: DetectedHookFramework[] = [];

  if (await directoryExists(join(repoRoot, '.husky'))) {
    frameworks.push({ id: 'husky', name: 'husky', evidence: '.husky/' });
  }

  const preCommit = await firstPresent(repoRoot, [
    '.pre-commit-config.yaml',
    '.pre-commit-config.yml',
  ]);
  const preCommitPath = preCommit[0];
  if (preCommitPath !== undefined) {
    frameworks.push({ id: 'pre-commit', name: 'pre-commit (the Python framework)', evidence: preCommitPath });
  }

  const lefthook = await firstPresent(repoRoot, ['lefthook.yml', 'lefthook.yaml']);
  const lefthookPath = lefthook[0];
  if (lefthookPath !== undefined) {
    frameworks.push({ id: 'lefthook', name: 'lefthook', evidence: lefthookPath });
  }

  return frameworks;
}

export async function detectCi(repoRoot: string): Promise<CiDetection> {
  const systems = await detectSystems(repoRoot);
  const present = new Set(systems.map((system) => system.id));
  const absent = CI_SYSTEM_IDS.filter((id) => !present.has(id));

  return {
    systems,
    absent,
    packageManager: await detectPackageManager(repoRoot),
    hookFrameworks: await detectHookFrameworks(repoRoot),
    dependency: await detectDependency(repoRoot),
  };
}
