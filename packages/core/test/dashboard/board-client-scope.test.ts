import { describe, expect, it } from 'vitest';

import { boardClientScript } from '../../src/dashboard/board-client.js';

/**
 * The client is several IIFEs concatenated, each guarding its own elements. A
 * function defined in one is invisible to the others, and calling across that
 * boundary throws at runtime while parsing perfectly and type-checking clean.
 *
 * It has happened twice: `insertNodes` called from the explorer while defined
 * in the drawer, which silently killed the markdown preview; and `syncBell`
 * called from the live-updates block while defined in the drawer, which killed
 * the file tree and the explorer toggle with it.
 */
function iifeBodies(script: string): string[] {
  return script
    .split('})();')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function definedFunctions(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  for (const match of body.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*function\b/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

function calledNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

describe('board client scope', () => {
  it('never calls a helper that lives in a different block', () => {
    const bodies = iifeBodies(boardClientScript());
    expect(bodies.length).toBeGreaterThan(1);

    const defined = bodies.map(definedFunctions);
    const offences: string[] = [];

    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index];
      const own = defined[index];
      if (body === undefined || own === undefined) continue;

      for (const name of calledNames(body)) {
        if (own.has(name)) continue;
        // Only a name another block defines is evidence of the mistake; every
        // other unresolved name is a browser global this test does not model.
        const elsewhere = defined.some((names, other) => other !== index && names.has(name));
        if (elsewhere) offences.push(`${name} is called in block ${index} and defined in another`);
      }
    }

    expect(offences).toEqual([]);
  });
});
