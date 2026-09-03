import { statSync } from 'node:fs';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/**
 * A PATH that contains git and nothing else.
 *
 * `cyv init` and `cyv doctor` detect an agent partly by looking for its binary
 * on PATH, so whatever agent CLIs happen to be installed on the machine running
 * the tests would otherwise change what they report. These tests need agent
 * detection to be driven only by the directories they create.
 *
 * Subtracting agent-looking directories from the real PATH does not achieve
 * that. It matched on the directory's *name*, but the CLIs do not live in
 * directories named after themselves: `agy`, `claude` and `devin` install into
 * `~/.local/bin` and `gemini` into Homebrew's `bin`, alongside ordinary tools.
 * Every one of them survived the filter, and the filter grew more wrong with
 * each agent installed. It also split PATH on `;`, the Windows delimiter, so on
 * POSIX the whole PATH was a single entry that matched the pattern and was
 * dropped — leaving PATH empty and every `git` call in these tests failing with
 * ENOENT.
 *
 * So rather than subtract, build up: a directory holding one shim that forwards
 * to the real git, used as the entire PATH. Nothing else is reachable, whatever
 * the host has installed.
 */
export async function makeGitOnlyPath(): Promise<string> {
  const originalPath = process.env.PATH ?? process.env.Path ?? '';
  const gitPath = findGit(originalPath);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cyv-git-only-')));

  // Windows gets the directory holding git.exe rather than a shim. A `git.cmd`
  // forwarder is not reachable: `spawnSync('git')` does not resolve a `.cmd`
  // through PATHEXT, so every `execFileSync('git', ...)` here failed with
  // ENOENT even though PATHEXT contained `.CMD`. Reproduced in isolation before
  // changing this.
  //
  // A symlink is not the alternative — creating one on Windows needs Developer
  // Mode or elevation — and copying git.exe out of its install directory
  // separates it from the DLLs it loads. Exposing git's own directory keeps git
  // working, at the cost of making its siblings reachable too. That directory
  // holds git's runtime rather than agent CLIs, so detection is still driven by
  // the directories a test creates.
  if (process.platform === 'win32') {
    return dirname(gitPath);
  }

  const shim = join(dir, 'git');
  await writeFile(shim, `#!/bin/sh\nexec "${gitPath}" "$@"\n`);
  await chmod(shim, 0o755);

  return dir;
}

/** The first `git` on the given PATH, or a failure naming what is missing. */
function findGit(pathEnv: string): string {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat'] : ['git'];

  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }

    for (const name of names) {
      // `throwIfNoEntry: false` rather than a try/catch: a PATH entry that does
      // not exist is an ordinary result of scanning PATH, not a failure worth
      // swallowing. Same idiom as `hasCommandOnPath` in src/registry/load.ts.
      const candidate = join(dir, name);
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
        return candidate;
      }
    }
  }

  throw new Error('git was not found on PATH, and these tests need it to create repositories.');
}
