/**
 * @file packages/core/src/benchmark/convention/check-di.ts
 *
 * The convention check for the DI-bypass task.
 *
 * The task asks for a unit test. The repository's convention is to register
 * the module in a container built by `test/support/factory.ts` and resolve
 * the subject from it. The common answer -- and what a model writes without
 * reading a neighbour -- is to construct the service and its repository
 * directly.
 *
 * This reads the file the task was asked to write and answers three questions
 * separately, because they fail independently:
 *
 *   wrote      -- did a test file for this feature appear at all
 *   followed   -- did it resolve the subject through the container
 *   bypassed   -- did it construct the subject (or its repository) directly
 *
 * A file can do both: some models build a container and then ignore it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The three-way outcome of a DI convention check. */
export interface DiCheckResult {
  /**
   * Whether a test file for the feature was written at all.
   * When false, followed and bypassed are also false.
   */
  readonly wrote: boolean;
  /**
   * Whether the test resolved the subject through the container using the
   * repository's test factory (testContainer + registerX + resolve).
   */
  readonly followed: boolean;
  /**
   * Whether the test constructed the subject (or its repository) directly
   * with `new`. A trial can set both followed and bypassed: it built a
   * container and then constructed the subject anyway.
   */
  readonly bypassed: boolean;
  /** Human-readable diagnosis of what the check found. */
  readonly why: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Reads the test file for `feature` inside `repoDir` and reports whether the
 * repository's DI convention was followed, bypassed, or absent.
 *
 * @param repoDir - Absolute path to the root of the generated repository.
 * @param feature - The feature name, e.g. `'coupon'`.
 */
export function checkDi(repoDir: string, feature: string): DiCheckResult {
  const path = join(repoDir, 'test', `${feature}.service.test.ts`);
  if (!existsSync(path)) {
    return { wrote: false, followed: false, bypassed: false, why: 'no test file' };
  }

  const src = readFileSync(path, 'utf-8');
  const C = capitalize(feature);
  const Service = `${C}Service`;
  const Repository = `${C}Repository`;

  // Resolved through the container the repository already provides.
  const usesFactory = /\btestContainer\s*\(/.test(src);
  const registers = new RegExp(`\\bregister${C}\\s*\\(`).test(src);
  const resolves = /\.resolve\s*\(/.test(src);
  const followed = usesFactory && registers && resolves;

  // Built by hand instead. `new XService(` or `new XRepository(` is the
  // tell; a fake object literal passed straight in is the same bypass without
  // the keyword, so a direct construction of either counts.
  const bypassed =
    new RegExp(`new\\s+${Service}\\s*\\(`).test(src) ||
    new RegExp(`new\\s+${Repository}\\s*\\(`).test(src);

  const why = followed
    ? bypassed
      ? 'built a container and constructed the subject anyway'
      : 'resolved through the container'
    : bypassed
      ? 'constructed the subject directly'
      : 'neither: it did something else';

  return { wrote: true, followed, bypassed, why };
}
