/**
 * Separating what a dispatch authored from what its gates generated (spec 0011
 * Requirement 2.5; reasoning in docs/specs/0036-orchestrator-survival/design.md,
 * Decision 7).
 *
 * A dispatch is judged on the diff of two snapshots of the working tree, which
 * includes anything a gate wrote: a gate that compiles the project leaves build
 * output behind, and a snapshot cannot tell that from source.
 *
 * `.gitignore` is the repository's own statement of which paths are generated,
 * so git is asked rather than a list of directory names being kept here.
 *
 * An ignored path is excluded from the ownership judgement and still reported.
 */
import { spawn } from 'node:child_process';

import { normalizeOwnedPath } from './ownership.js';

/** What `git check-ignore` produced, and how it ended. */
interface CheckIgnoreRun {
  stdout: string;
  /** Present when the question could not be asked, naming what went wrong. */
  failure?: string;
}

/**
 * Run `git check-ignore`, writing the paths to its standard input.
 *
 * `spawn` rather than `execFile` because the paths go in on stdin, which keeps
 * a filename containing a shell metacharacter off the command line and keeps a
 * long list from meeting the argument-length limit.
 */
function runCheckIgnore(repoRoot: string, input: string): Promise<CheckIgnoreRun> {
  return new Promise<CheckIgnoreRun>((resolve) => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => {
      resolve({ stdout: '', failure: err.message });
    });
    child.on('close', (code: number | null) => {
      resolve({
        stdout,
        ...(code === null || code > 1
          ? { failure: stderr.trim().length > 0 ? stderr.trim() : `git exited with ${String(code)}` }
          : {}),
      });
    });

    // A closed stdin on the reader's side must not take the process down.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Changed paths split by whether the repository ignores them. */
export interface ChangedPathSplit {
  /** Paths git does not ignore. These are what ownership is judged against. */
  authored: readonly string[];
  /** Paths git ignores: build output, caches, anything `.gitignore` names. */
  generated: readonly string[];
  /**
   * Present when the split could not be determined, naming why. Every path is
   * reported as authored in that case, because over-reporting a write is the
   * safe direction: it produces a false violation a reader can see and argue
   * with, where under-reporting hides a real one.
   */
  undetermined?: string;
}

/**
 * Split `changedPaths` by whether git ignores them.
 *
 * One `git check-ignore` call over the changed set, which is small — the paths
 * a dispatch touched, not the repository. `--stdin` keeps the paths off the
 * command line, where a filename containing a shell metacharacter would
 * otherwise have to be trusted, and `-z` keeps a filename containing a newline
 * from splitting into two.
 *
 * `check-ignore` exits 1 when nothing matched, which is an answer rather than a
 * failure; only a different code means the question could not be asked.
 */
export async function splitGeneratedPaths(
  repoRoot: string,
  changedPaths: readonly string[],
): Promise<ChangedPathSplit> {
  if (changedPaths.length === 0) return { authored: [], generated: [] };

  const run = await runCheckIgnore(repoRoot, changedPaths.join('\0'));

  // Exit 1 is "none of these are ignored", which is an answer, not a failure.
  if (run.failure !== undefined) {
    return {
      authored: [...changedPaths],
      generated: [],
      undetermined:
        `could not ask git which paths are ignored (${run.failure}), ` +
        'so every changed path is reported as authored',
    };
  }

  const ignored = new Set(
    run.stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeOwnedPath(entry)),
  );

  const authored: string[] = [];
  const generated: string[] = [];
  for (const path of changedPaths) {
    if (ignored.has(normalizeOwnedPath(path))) generated.push(path);
    else authored.push(path);
  }
  return { authored, generated };
}
