import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, Schema } from 'ajv/dist/types/index.js';
import type { CheckYourVibeConfig } from './types.js';
import { laneConfigProblem } from './lanes.js';
import { readProtocolSchema } from '../protocol/schema-path.js';

export const CONFIG_FILENAME = 'checkyourvibe.json';

export class ConfigError extends Error {
  constructor(
    readonly code: 'MISSING' | 'INVALID' | 'UNKNOWN_RULE',
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** True when `value` is an object exposing a `code` property, regardless of its type. */
function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && hasErrorCode(err) && err.code === code;
}

function firstValidationMessage(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return 'unknown validation error';
  }
  const error = errors[0];
  if (error === undefined) {
    return 'unknown validation error';
  }
  const pointer = error.instancePath === '' ? '<root>' : error.instancePath;
  return `Config is invalid at ${pointer}: ${error.message ?? 'unknown error'}`;
}

// `Schema` (from ajv) is `SchemaObject | boolean` — a JSON Schema document is either
// an object of (all-optional) keywords or one of the two boolean schemas. That is
// the actual shape being claimed here, so checking for it is a faithful guard
// rather than a stand-in for validating this specific config's fields.
function isSchemaValue(value: unknown): value is Schema {
  return typeof value === 'boolean' || (typeof value === 'object' && value !== null);
}

/**
 * The config schema belongs to the tool, not to the repository being checked.
 *
 * This used to read `<repoRoot>/docs/protocol/config.schema.json` — a path
 * inside the USER's repository. It worked only because `cyv init` writes a copy
 * of the schema into every project it sets up, so `check` was reading a file the
 * tool had planted. Any repository where init had not run, or where someone had
 * tidied that file away, failed with a bare ENOENT naming a path in their own
 * tree that they had never heard of.
 *
 * Found by hand-writing a `checkyourvibe.json` in a real Python project and
 * running `check` — which is exactly how an adopter who reads the documentation
 * rather than running `init` would meet it.
 *
 * The copy `init` writes is still useful: it is what a `$schema` pointer in the
 * generated config resolves to for editor completion. It is no longer what
 * validation depends on, and a repository without it now validates fine.
 */
async function loadSchema(repoRoot: string): Promise<Schema> {
  let raw: string;
  try {
    raw = await readProtocolSchema('config.schema.json', import.meta.url);
  } catch (err) {
    // Fall back to a copy inside the repository, for a checkout whose build has
    // not populated `dist/schema/` yet. Reported with both failures if neither
    // exists, rather than pointing at one path and implying it is the only one.
    const inRepo = join(repoRoot, 'docs', 'protocol', 'config.schema.json');
    try {
      raw = await readFile(inRepo, 'utf-8');
    } catch {
      throw new ConfigError(
        'INVALID',
        `Could not read the configuration schema. ${err instanceof Error ? err.message : String(err)}\n` +
          `Also tried ${inRepo}.`,
      );
    }
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isSchemaValue(parsed)) {
    throw new ConfigError('INVALID', 'The configuration schema must be a JSON Schema object or boolean.');
  }
  return parsed;
}

/**
 * Walk from `startDir` up to the git root looking for `checkyourvibe.json`.
 *
 * Stopping at the git root keeps the search inside the repository the user
 * is working in; without that guard, a nested project could accidentally pick
 * up a config from an ancestor directory.
 */
export async function findConfig(startDir: string): Promise<string | null> {
  let dir = startDir;

  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch (err) {
      if (!isErrnoException(err, 'ENOENT')) {
        throw err;
      }
    }

    try {
      await stat(join(dir, '.git'));
      break;
    } catch (err) {
      if (!isErrnoException(err, 'ENOENT')) {
        throw err;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

/**
 * Load and validate the configuration in `repoRoot`.
 *
 * Missing files are reported with the `cyv init` remediation path. Validation
 * failures surface the JSON pointer from ajv so the user can locate the typo.
 */
export async function loadConfig(repoRoot: string): Promise<CheckYourVibeConfig> {
  const configPath = join(repoRoot, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) {
      throw new ConfigError(
        'MISSING',
        `No ${CONFIG_FILENAME} found in ${repoRoot}. Run \`cyv init\` to create one.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      'INVALID',
      `Invalid JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const schema = await loadSchema(repoRoot);
  const ajv = new Ajv2020({ useDefaults: true });
  // Compiling with the `CheckYourVibeConfig` type parameter makes `validate` a
  // real type guard (`data is CheckYourVibeConfig`): the schema is the published
  // source of truth for this shape, so narrowing through it needs no separate
  // cast once ajv confirms the data matches.
  const validate = ajv.compile<CheckYourVibeConfig>(schema);

  if (!validate(parsed)) {
    throw new ConfigError('INVALID', firstValidationMessage(validate.errors));
  }

  // Relationships between lane declarations, which the schema validates one at
  // a time and cannot state: a duplicated lane id, a second orchestrator, or a
  // metered lane missing from the by-name opt-in list.
  const laneProblem = laneConfigProblem(parsed);
  if (laneProblem !== undefined) {
    throw new ConfigError('INVALID', laneProblem);
  }

  return parsed;
}
