/**
 * Declared file ownership (spec 0011 Requirement 4.2 - 4.4).
 *
 * A dispatch names the paths it may write before it runs. Two comparisons are
 * built on that declaration: whether a written path was in scope (Requirement
 * 2.5) and whether two dispatches the core would run at the same time overlap
 * (Requirement 4.3).
 *
 * Paths are repo-relative and compared lexically after normalisation. A
 * declared path stands for itself and, when a directory, for everything beneath
 * it. Nothing here reads the file system: the comparison must work on a
 * declaration made before the dispatch exists, so it cannot depend on whether
 * a path is currently a directory on disk.
 */

/**
 * Reduce a declared or observed path to the form the comparisons use:
 * backslashes become forward slashes, a leading `./` and any trailing slash are
 * removed, and `.` becomes the empty string, which denotes the repository root.
 */
export function normalizeOwnedPath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  while (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === '.' || normalized === '/') return '';
  return normalized;
}

/** True when `path` is `owned` itself or sits beneath it. */
export function pathIsWithin(path: string, owned: string): boolean {
  const a = normalizeOwnedPath(path);
  const b = normalizeOwnedPath(owned);
  if (b === '') return true;
  return a === b || a.startsWith(`${b}/`);
}

/** True when either path contains the other, in either direction. */
export function pathsOverlap(left: string, right: string): boolean {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

/** True when any declared path in `owned` covers `path`. */
export function ownsPath(owned: readonly string[], path: string): boolean {
  return owned.some((entry) => pathIsWithin(path, entry));
}

/**
 * Every pair of paths, one from each declaration, that overlap. Returned as the
 * left-hand path so a refusal can name the paths that collided (Requirement
 * 4.3). Sorted and de-duplicated so the same collision always reads the same.
 */
export function overlappingPaths(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const found = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) {
        found.add(normalizeOwnedPath(a));
      }
    }
  }
  return [...found].sort();
}
