import path from 'node:path';
import picomatch from 'picomatch';
import type { AnalyzerManifest } from '../protocol/index.js';
import { RegistryError } from '../registry/load.js';

/** The result of assigning each file to the one analyzer that claims it. */
export interface RouteResult {
  /** Analyzer id → absolute file paths it claims. */
  routed: Map<string, string[]>;
  /**
   * Supplemental analyzer id → absolute file paths it also inspects.
   *
   * Separate from `routed` because these analyzers do not own the files they
   * match: the same file can appear here and under its owning analyzer, which
   * would be an ambiguity error if it appeared in `routed` twice.
   */
  supplemental: Map<string, string[]>;
  /** Absolute file paths that no analyzer claimed. */
  unmatched: string[];
}

/**
 * Route a list of absolute file paths to the analyzers that claim them.
 *
 * Matching uses the repo-relative path with forward slashes against the
 * analyzer's `match` globs, after removing any `exclude` or `extraExclude`
 * matches. A file matching more than one analyzer is a configuration error.
 */
export function routeFiles(
  files: string[],
  manifests: AnalyzerManifest[],
  repoRoot: string,
  extraExclude?: string[],
): RouteResult {
  const rooted = path.resolve(repoRoot);

  const entries = manifests.map((manifest) => {
    const ignore = [...(manifest.exclude ?? []), ...(extraExclude ?? [])];
    const isMatch = picomatch(manifest.match, { dot: true, ignore });
    return { id: manifest.id, isMatch, supplements: manifest.supplements === true };
  });

  const owners = entries.filter((entry) => !entry.supplements);
  const supplementers = entries.filter((entry) => entry.supplements);

  const routed = new Map<string, string[]>();
  const supplemental = new Map<string, string[]>();
  const unmatched: string[] = [];

  const add = (target: Map<string, string[]>, id: string, file: string): void => {
    const list = target.get(id);
    if (list) list.push(file);
    else target.set(id, [file]);
  };

  for (const file of files) {
    const rel = toRepoRelative(file, rooted);
    if (rel === undefined) {
      unmatched.push(file);
      continue;
    }

    for (const { id, isMatch } of supplementers) {
      if (isMatch(rel)) {
        add(supplemental, id, file);
      }
    }

    const matchedIds: string[] = [];
    for (const { id, isMatch } of owners) {
      if (isMatch(rel)) {
        matchedIds.push(id);
      }
    }

    if (matchedIds.length === 0) {
      unmatched.push(file);
    } else if (matchedIds.length === 1) {
      const id = matchedIds[0];
      if (id === undefined) {
        throw new Error(`Routing invariant violated: matchedIds has length 1 but first element is undefined for "${file}"`);
      }
      add(routed, id, file);
    } else {
      throw new RegistryError(
        'AMBIGUOUS',
        `File "${file}" matches multiple analyzers: ${matchedIds.join(', ')}`,
      );
    }
  }

  return { routed, supplemental, unmatched };
}

function toRepoRelative(file: string, repoRoot: string): string | undefined {
  const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
  if (rel === '' || rel.startsWith('.')) {
    return undefined;
  }
  return rel;
}
