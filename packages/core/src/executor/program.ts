/**
 * Finding an executor's program on this machine, and launching it (spec 0011
 * Requirement 1.2).
 *
 * An executor is a CLI the user already installed and authenticated, so the
 * core locates it the way a shell would: walk `PATH`, and on Windows try each
 * suffix in `PATHEXT`, because a bare name names no executable there.
 *
 * A Windows batch shim (`.cmd`, `.bat`) is not something the operating system
 * starts directly; it is a script the command interpreter reads. npm installs
 * its global CLIs as exactly that, so a launcher for one names the interpreter
 * and carries the shim as its leading arguments. Every argument the mapping in
 * `invocation.ts` puts after it is a flag or a path the core wrote — a
 * dispatch's prompt reaches a batch-shimmed CLI on standard input instead, so
 * text the user authored is never handed to the interpreter to re-parse.
 */
import { stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Where a program was found, and what has to be spawned to run it. */
export interface ProgramLauncher {
  /** The executable `runChild` spawns. */
  command: string;
  /**
   * Arguments that precede the executor's own. Empty unless the program is a
   * shim an interpreter has to read.
   */
  prefixArgs: readonly string[];
  /** The file the program name resolved to. */
  path: string;
}

/** Suffixes tried after a bare program name, in the order `PATHEXT` gives them. */
export function pathExtensions(env: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== 'win32') return [''];
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').filter((entry) => entry.length > 0);
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** The first existing file among `program` plus each suffix, in order. */
async function firstExisting(
  program: string,
  suffixes: readonly string[],
): Promise<string | undefined> {
  for (const suffix of suffixes) {
    const candidate = `${program}${suffix}`;
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * How to spawn the file a program name resolved to.
 *
 * A batch shim is run through the interpreter named by `ComSpec`, which is the
 * only way to start one; anything else is spawned as itself.
 */
export function launcherFor(path: string, env: NodeJS.ProcessEnv): ProgramLauncher {
  if (/\.(cmd|bat)$/i.test(path)) {
    return {
      command: env.ComSpec ?? 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', path],
      path,
    };
  }
  return { command: path, prefixArgs: [], path };
}

/** The argument list and spawn flag `runChild` needs to start `launcher` with `args`. */
export interface LaunchArguments {
  args: string[];
  /**
   * True when the arguments are one pre-quoted command line for the command
   * interpreter and must reach it untouched.
   */
  windowsVerbatimArguments: boolean;
}

/**
 * Quote one word for the command interpreter's command line. A word with no
 * space or quote is left alone so a flag reads as written.
 */
function quoteForInterpreter(word: string): string {
  if (!/[\s"]/.test(word)) return word;
  return `"${word.replace(/"/g, '\\"')}"`;
}

/**
 * Compose the arguments to spawn `launcher` with `args` appended.
 *
 * A shim is run as `cmd /d /s /c "<shim> <args>"`, built here as one string
 * and passed verbatim. Handing the interpreter separate arguments does not
 * work: Node quotes any argument with a space, and `/s` then strips the first
 * and last quote of the whole command string, so a shim installed under a
 * directory with a space in its name — the default install location on this
 * platform — was run as the text before the space. A gate naming such a shim
 * failed with "is not recognized" while the same command passed in a shell.
 */
export function launchArguments(launcher: ProgramLauncher, args: readonly string[]): LaunchArguments {
  if (launcher.prefixArgs.length === 0) {
    return { args: [...args], windowsVerbatimArguments: false };
  }
  const switches = launcher.prefixArgs.slice(0, -1);
  const line = [launcher.path, ...args].map(quoteForInterpreter).join(' ');
  return { args: [...switches, `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * Locate `program` and return how to launch it, or `undefined` when nothing on
 * `PATH` carries that name.
 *
 * A name that is already a path is resolved against `cwd` and checked as-is,
 * so a lane can name a CLI that was installed outside `PATH`.
 */
export async function findProgram(
  program: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProgramLauncher | undefined> {
  const suffixes = pathExtensions(env);

  if (program.includes('/') || program.includes('\\') || isAbsolute(program)) {
    const base = resolve(cwd, program);
    const found = (await isFile(base)) ? base : await firstExisting(base, suffixes);
    return found === undefined ? undefined : launcherFor(found, env);
  }

  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    const found = await firstExisting(join(directory, program), suffixes);
    if (found !== undefined) return launcherFor(found, env);
  }
  return undefined;
}
