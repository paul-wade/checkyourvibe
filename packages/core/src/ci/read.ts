import { readFile } from 'node:fs/promises';

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && err.code === code;
}

/**
 * A file's contents, or `null` when it is not there.
 *
 * "Not there" is the answer to a question this module asks constantly, and it
 * is not an error. Every other failure — a permission problem, a directory
 * where a file was expected — still throws, because those are states a user
 * needs told about rather than states to plan around.
 */
export async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) {
      return null;
    }
    throw err;
  }
}
