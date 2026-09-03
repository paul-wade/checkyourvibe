import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import type { FileSelection, RunMode } from './modes.js';

const execFileAsync = promisify(execFile);

/**
 * How much `git` output to accept before giving up.
 *
 * Node's default is 1 MB, and `git ls-files --others --exclude-standard` in a
 * repository with an uncommitted `node_modules` produces far more than that:
 * measured at 28,612 paths and 2.4 MB in a real project. The run died with
 * `stdout maxBuffer length exceeded` — no mention of git, of which command, or
 * of what the tool had been trying to do. Found on the first attempt to check a
 * real codebase from an installed package.
 *
 * 256 MB is not a real limit for path text; it is high enough that hitting it
 * means something is genuinely wrong, and the handler below says so in terms a
 * reader can act on rather than leaving them with a buffer error.
 */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

interface ExecFailure extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error && (
    'code' in error ||
    'killed' in error ||
    'signal' in error
  );
}

function isAllowedExit(error: ExecFailure, allowed: readonly number[]): boolean {
  return typeof error.code === 'number' && allowed.includes(error.code);
}

function rethrowGitError(error: unknown): never {
  if (isExecFailure(error)) {
    const stderr = error.stderr ?? '';
    if (error.code === 'ENOENT') {
      throw new Error('git is not available or the directory is not a git repository');
    }
    if (typeof error.code === 'number' && error.code !== 0 && stderr.includes('not a git repository')) {
      throw new Error('git is not available or the directory is not a git repository');
    }
  }
  throw error;
}

async function gitExitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
    return true;
  } catch (error: unknown) {
    if (!isExecFailure(error)) {
      throw error;
    }
    if (error.code === 'ENOENT') {
      throw new Error('git is not available or the directory is not a git repository');
    }
    if (error.code === 1) {
      return false;
    }
    rethrowGitError(error);
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  { allowedExitCodes = [] }: { readonly allowedExitCodes?: readonly number[] } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
    return stdout;
  } catch (error: unknown) {
    if (!isExecFailure(error)) {
      throw error;
    }
    if (isAllowedExit(error, allowedExitCodes)) {
      return error.stdout ?? '';
    }
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(error.message ?? '')) {
      throw new Error(
        `\`git ${args.join(' ')}\` produced more output than this run can hold. ` +
          'That usually means the working tree contains an enormous number of untracked files — ' +
          'an uncommitted node_modules or build directory is the common cause. ' +
          'Add them to .gitignore, or narrow the run with explicit paths or --staged.',
      );
    }
    rethrowGitError(error);
  }
}

async function stdoutToFiles(stdout: string, repoRoot: string): Promise<string[]> {
  const raw = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line): line is string => line.length > 0)
    .map((line) => resolve(repoRoot, line));

  const files: string[] = [];
  for (const absolute of raw) {
    if (await fileExists(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

export async function repoRoot(cwd: string): Promise<string> {
  try {
    const stdout = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    return resolve(stdout.trim());
  } catch {
    throw new Error('git is not available or the directory is not a git repository');
  }
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  return gitExitOk(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
}

export async function defaultBranch(repoRoot: string): Promise<string> {
  const originHead = (await runGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowedExitCodes: [1] })).trim();
  if (originHead.length > 0) {
    const prefix = 'refs/remotes/origin/';
    const name = originHead.startsWith(prefix) ? originHead.slice(prefix.length) : originHead;
    if (await refExists(repoRoot, name)) {
      return name;
    }
  }

  const initDefault = (await runGit(repoRoot, ['config', '--get', 'init.defaultBranch'], { allowedExitCodes: [1] })).trim();
  if (initDefault.length > 0 && await refExists(repoRoot, initDefault)) {
    return initDefault;
  }

  const candidates = ['main', 'master', 'trunk'] as const;
  for (const candidate of candidates) {
    if (await refExists(repoRoot, candidate)) {
      return candidate;
    }
  }

  return 'HEAD';
}

export async function mergeBase(repoRoot: string, branch: string): Promise<string | null> {
  const stdout = await runGit(repoRoot, ['merge-base', branch, 'HEAD'], { allowedExitCodes: [1] });
  const output = stdout.trim();
  return output.length > 0 ? output : null;
}

async function resolveFilePaths(repoRoot: string, paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const p of paths) {
    const absolute = isAbsolute(p) ? p : resolve(repoRoot, p);
    if (await fileExists(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

interface SelectOptions {
  repoRoot: string;
  mode: RunMode;
  paths?: string[];
}

export async function selectFiles(opts: SelectOptions): Promise<FileSelection> {
  const { repoRoot, mode } = opts;

  if (mode === 'files') {
    const paths = opts.paths ?? [];
    const files = paths.length > 0 ? await resolveFilePaths(repoRoot, paths) : [];
    const reason = paths.length === 0 ? 'No paths provided for files mode.' : undefined;
    return toFileSelection(mode, files, reason);
  }

  if (mode === 'all') {
    // `git ls-files` lists TRACKED files only, so a newly written file is
    // invisible to `--all` until it is committed. That let a pre-commit check
    // pass on code the very next commit would introduce — a run reporting a
    // clean bill of health over files it never opened, which is precisely the
    // silent pass this project exists to prevent. It happened here.
    //
    // `--others --exclude-standard` adds untracked files while still honouring
    // .gitignore, so build output and node_modules stay out. "All" now means
    // all.
    const tracked = await runGit(repoRoot, ['ls-files']);
    const untracked = await runGit(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    const files = [
      ...(await stdoutToFiles(tracked, repoRoot)),
      ...(await stdoutToFiles(untracked, repoRoot)),
    ];
    // A file can appear in both lists after `git add -N`.
    return toFileSelection(mode, [...new Set(files)]);
  }

  // `staged` compares the index against HEAD and needs neither the default
  // branch nor a merge base. Computing them anyway made `--staged` fail
  // outright in a repository with no commits yet — `git merge-base HEAD HEAD`
  // is fatal there — which is exactly the state a freshly installed pre-commit
  // hook meets on the very first commit.
  if (mode === 'staged') {
    const stdout = await runGit(repoRoot, [
      'diff', '--cached', '--name-only', '--diff-filter=ACMR',
    ]);
    return toFileSelection(mode, await stdoutToFiles(stdout, repoRoot));
  }

  const branch = await defaultBranch(repoRoot);
  const base = await mergeBase(repoRoot, branch);

  let reason: string | undefined;
  let args: string[];

  if (mode === 'working') {
    if (base === null) {
      reason = `Could not find a merge base for ${branch}; comparing the working tree against HEAD.`;
      args = ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'];
    } else {
      args = ['diff', '--name-only', '--diff-filter=ACMR', base];
    }
  } else if (mode === 'branch') {
    if (base === null) {
      reason = `Could not find a merge base for ${branch}; comparing the branch against HEAD.`;
      args = ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD...HEAD'];
    } else {
      args = ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`];
    }
  } else {
    // exhaustiveCheck(mode);
    args = [];
  }

  const stdout = await runGit(repoRoot, args);
  return toFileSelection(mode, await stdoutToFiles(stdout, repoRoot), reason);
}

function toFileSelection(mode: RunMode, files: string[], reason?: string): FileSelection {
  return {
    mode,
    files,
    empty: files.length === 0,
    ...(reason !== undefined ? { reason } : {}),
  };
}
