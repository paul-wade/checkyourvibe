import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every `/api/...` path this server does not claim is proxied to difit, which
 * answers "No diff is open" and never reaches the handler. A route added
 * without its entry in `OWN_API_PATHS` therefore exists, type-checks, and can
 * never fire — the same shape of failure as a hook that is implemented but
 * registered nowhere.
 *
 * This reads the source rather than the module because the set is module-local
 * and the routes are string literals inside one long request handler.
 */
const SOURCE = fileURLToPath(new URL('../../src/cli/dashboard.ts', import.meta.url));

function ownApiLiterals(source: string): Set<string> {
  const block = /const OWN_API_PATHS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '';
  const paths = new Set<string>();
  for (const match of block.matchAll(/'(\/api\/[^']*)'/g)) {
    const path = match[1];
    if (path !== undefined) paths.add(path);
  }
  return paths;
}

function routedApiLiterals(source: string): Set<string> {
  const paths = new Set<string>();
  for (const match of source.matchAll(/url\.pathname === '(\/api\/[^']*)'/g)) {
    const path = match[1];
    if (path !== undefined) paths.add(path);
  }
  return paths;
}

describe('dashboard api routing', () => {
  it('claims every /api route it handles, so none is proxied away to difit', async () => {
    const source = await readFile(SOURCE, 'utf-8');
    const own = ownApiLiterals(source);
    const routed = routedApiLiterals(source);

    expect(routed.size).toBeGreaterThan(0);
    const unclaimed = [...routed].filter((path) => !own.has(path));

    expect(unclaimed).toEqual([]);
  });
});
