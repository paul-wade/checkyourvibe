#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Command, CommandContext } from './types.js';

/** One entry in the command table: where its module lives, and its one-line summary. */
interface CommandEntry {
  /** Specifier passed to `import()`, resolved relative to this file. */
  module: string;
  summary: string;
}

/**
 * Every subcommand `cyv` knows about. All of these modules exist in
 * `src/cli/`; the table is written out rather than discovered from disk so
 * `--help` reads the same in a source clone and in an installed package,
 * where the layout of `dist/` is not something to enumerate at runtime.
 *
 * The modules are reached through `import()` in `loadCommand` rather than
 * static imports, so a run of one command loads one command's module and
 * `--help` loads none of them.
 */
const COMMANDS: Record<string, CommandEntry> = {
  check: {
    module: './check.js',
    summary: 'Run configured analyzers and report violations.',
  },
  explain: {
    module: './explain.js',
    summary: 'Print remediation guidance for a rule.',
  },
  dashboard: {
    module: './dashboard.js',
    summary: 'Serve the dashboard: what needs you, what is in motion, and the lanes.',
  },
  projects: {
    module: './projects.js',
    summary: 'List, add, or remove the projects the dashboard serves.',
  },
  plan: {
    module: './plan.js',
    summary: "The waves a spec's open tasks fall into: what can run at once.",
  },
  comments: {
    module: './comments.js',
    summary: 'Notes the owner left on the dashboard, and a way to write back.',
  },
  acknowledge: {
    module: './acknowledge.js',
    summary: 'Take a needs-you item off the dashboard once it needs nothing more.',
  },
  orchestrator: {
    module: './orchestrator.js',
    summary: "Record the orchestrating session's own state, self-reported.",
  },
  dispatch: {
    module: './dispatch.js',
    summary: 'Hand one unit of work to a declared executor lane and judge what it did.',
  },
  baseline: {
    module: './baseline.js',
    summary: 'Record existing violations so new ones can be gated separately.',
  },
  hook: {
    module: './hook.js',
    summary: 'Run as an agent hook, reading a payload from stdin.',
  },
  init: {
    module: './init.js',
    summary: 'Detect installed agents and write their glue.',
  },
  upgrade: {
    module: './upgrade.js',
    summary: 'Re-apply generated agent glue after rule manifests change.',
  },
  doctor: {
    module: './doctor.js',
    summary: 'Report drift between applied glue and its source.',
  },
  mcp: {
    module: './mcp.js',
    summary: 'Serve analysis and guidance over MCP on stdio.',
  },
  metrics: {
    module: './metrics.js',
    summary: 'Rule quality metrics from run history, baseline, and suppressions.',
  },
  'new-rule': {
    module: './new-rule.js',
    summary: 'Scaffold a new rule into an analyzer package.',
  },
  'install-hooks': {
    module: './install-hooks.js',
    summary: 'Install a git pre-commit hook that runs check --staged --strict.',
  },
  'install-ci': {
    module: './install-ci.js',
    summary: 'Detect the CI system in use and offer it a gate that runs check --all --strict.',
  },
  'verify-analyzer': {
    module: './verify-analyzer.js',
    summary: 'Conformance-test an analyzer against the request/response schemas.',
  },
  watch: {
    module: './watch.js',
    summary: 'Re-run checks in-process as files change.',
  },
};

/**
 * The commands and their summaries, then the one command that documents its
 * own flags.
 *
 * The footer names the commands that handle `--help` rather than saying
 * `cyv <command> --help` works generally, because only those do. Every other
 * command would treat it as an argument, and several reject it outright.
 */
function usage(): string {
  const ids = Object.keys(COMMANDS).sort();
  const width = ids.reduce((max, id) => Math.max(max, id.length), 0);

  const lines = ['Usage: cyv <command> [options]', '', 'Commands:'];
  for (const id of ids) {
    const entry = COMMANDS[id];
    if (entry === undefined) {
      continue;
    }
    lines.push(`  ${id.padEnd(width)}  ${entry.summary}`);
  }
  lines.push(
    '',
    'Run `cyv check --help` for the options `check` accepts, including --pin,',
    'which prints a ready-to-paste suppression for one finding,',
    '`cyv dispatch --help` for how a unit of work is declared and judged, and',
    '`cyv install-ci --help` for how a CI gate is detected, planned and written.',
  );
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasVersion(value: unknown): value is { version: string } {
  return isRecord(value) && typeof value.version === 'string';
}

async function readVersion(): Promise<string> {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const raw = await readFile(packageJsonUrl, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return hasVersion(parsed) ? parsed.version : '0.0.0';
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && isRecord(err) && err.code === code;
}

function isModuleNotFound(err: unknown): boolean {
  return isErrnoException(err, 'ERR_MODULE_NOT_FOUND') || isErrnoException(err, 'MODULE_NOT_FOUND');
}

/**
 * Whether the module that could not be found is the command's own file, rather
 * than something the command imports.
 *
 * `import()` reports both cases with the same error code, and this dispatcher
 * used to treat both as "not implemented yet". So a broken install — a missing
 * dependency, a partial `node_modules` — told the user the feature had not been
 * built. Found by installing the packed tarball without its dependencies and
 * being informed that `verify-analyzer` did not exist, when in fact it shipped
 * and one of its imports did not resolve.
 *
 * Misreporting a broken environment as an unbuilt feature sends someone to wait
 * for work that is already done. The two states need different messages.
 */
function isOwnModuleMissing(err: unknown, moduleSpecifier: string): boolean {
  if (!isModuleNotFound(err)) {
    return false;
  }
  const message = err instanceof Error ? err.message : '';
  // Node names the unresolved specifier in the message. `./verify-analyzer.js`
  // failing to resolve is an unimplemented command; anything else named there
  // is a dependency this command needs and the environment does not have.
  const bare = moduleSpecifier.replace(/^\.\//, '').replace(/\.js$/, '');
  return message.includes(moduleSpecifier) || message.includes(bare);
}

function isCommand(value: unknown): value is Command {
  return isRecord(value) && 'run' in value && typeof value.run === 'function';
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadCommand(name: string, entry: CommandEntry): Promise<Command | undefined> {
  let mod: unknown;
  try {
    mod = await import(entry.module);
  } catch (err) {
    if (isOwnModuleMissing(err, entry.module)) {
      console.error(`Command "${name}" is not implemented yet.`);
      return undefined;
    }
    if (isModuleNotFound(err)) {
      console.error(
        `Command "${name}" is installed but could not load: ${messageFor(err)}\n` +
          'This is a broken installation, not a missing feature. Reinstall the package, ' +
          'or run your package manager\'s install in this project.',
      );
      return undefined;
    }
    throw err;
  }

  if (!isRecord(mod) || !isCommand(mod.command)) {
    console.error(`Command "${name}" is not implemented yet.`);
    return undefined;
  }

  return mod.command;
}

/**
 * Dispatch `argv` to the matching subcommand and resolve to its exit code.
 *
 * Domain errors (bad config, a broken analyzer, a bad rule catalog, corrupt
 * merge state) are reported by message alone, never a stack trace — a stack
 * trace is an implementation detail an agent invoking this CLI cannot act on.
 */
export async function run(ctx: CommandContext): Promise<number> {
  const args = ctx.argv;
  const first = args[0];

  if (first === undefined || first === '--help' || first === '-h') {
    console.log(usage());
    return 0;
  }

  if (first === '--version') {
    console.log(await readVersion());
    return 0;
  }

  const entry = COMMANDS[first];
  if (entry === undefined) {
    console.error(usage());
    return 2;
  }

  try {
    const command = await loadCommand(first, entry);
    if (command === undefined) {
      return 2;
    }

    const subContext: CommandContext = { cwd: ctx.cwd, argv: args.slice(1), env: ctx.env };
    return await command.run(subContext);
  } catch (err) {
    console.error(messageFor(err));
    return 2;
  }
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (entryArg === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(entryArg).href;
}

if (isMainModule()) {
  run({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(messageFor(err));
      process.exitCode = 2;
    });
}
