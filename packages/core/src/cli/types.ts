/**
 * Shared shapes for every `cyv` subcommand.
 *
 * Keeping these in their own module lets `index.ts` dynamically import a
 * subcommand module and call it through a structural type, without any of the
 * subcommand modules needing to import from `index.ts` (which would create a
 * cycle back to the dispatcher).
 */

/** What a subcommand receives when it is invoked. */
export interface CommandContext {
  /** The working directory the CLI was invoked from. */
  cwd: string;
  /** Arguments following the command name — flags and bare paths, in order. */
  argv: string[];
  env: NodeJS.ProcessEnv;
}

/** A `cyv` subcommand. `run` resolves to the process exit code (0, 1, or 2). */
export interface Command {
  run(ctx: CommandContext): Promise<number>;
}
