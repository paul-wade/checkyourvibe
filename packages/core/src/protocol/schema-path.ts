import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Where the published JSON schemas can be read from, in order.
 *
 * There is one correct answer per layout and no single path that covers both,
 * which is why this exists once rather than being written at each call site.
 *
 * From a clone, the schemas live at the repository root in `docs/protocol/`,
 * four directories above a module in `dist/<area>/` or `src/<area>/`.
 * From an installed package, four directories up is `node_modules/docs/protocol/`
 * — a directory that has never existed anywhere. `tools/copy-schemas.mjs` puts a
 * copy in `dist/schema/` at build time, and the package's `files` ships it.
 *
 * Both call sites had the repo-root path hard-coded, and both were broken for
 * every installed user. The conformance suite's copy made `cyv verify-analyzer`
 * fail with an ENOENT; `cyv init`'s copy made a first run in a real project fail
 * while it was writing the configuration. Neither was reachable from a test,
 * because tests run from the checkout where the old path resolved.
 */
const SCHEMA_DIRS = ['../schema/', '../../../../docs/protocol/'] as const;

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a published schema by file name, from whichever layout this is running in.
 *
 * `baseUrl` is the calling module's `import.meta.url`. It has to be passed in:
 * resolving against this module's own location would break the moment a caller
 * lived at a different depth, which is precisely the class of bug this replaces.
 *
 * Throws naming every location tried and why each failed. The previous ENOENT
 * named one path and sent the reader looking in the wrong place.
 */
export async function readProtocolSchema(name: string, baseUrl: string): Promise<string> {
  const attempts: string[] = [];

  for (const dir of SCHEMA_DIRS) {
    const url = new URL(`${dir}${name}`, baseUrl);
    try {
      return await readFile(url, 'utf-8');
    } catch (err) {
      attempts.push(`  ${fileURLToPath(url)} — ${messageFor(err)}`);
    }
  }

  throw new Error(
    `Could not read protocol schema "${name}". Looked in:\n` +
      attempts.join('\n') +
      '\nIf this is an installed package, its build did not copy the schemas into dist/schema/.',
  );
}
