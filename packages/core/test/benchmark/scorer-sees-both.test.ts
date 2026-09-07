import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as benchmarkModule from '../../../../tools/run-benchmark-samples.mjs';

import {
  detectRemainingViolations,
  detectShortcutFingerprint,
  type ShortcutFingerprint,
} from '../../src/benchmark/harness.js';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

function anyShortcut(fingerprint: ShortcutFingerprint): boolean {
  return (
    fingerprint.nonNullAssertion ||
    fingerprint.typeAssertion ||
    fingerprint.tsComment ||
    fingerprint.voidCast ||
    fingerprint.swallowedCatch ||
    fingerprint.widenedSignature
  );
}

interface FixtureDef {
  fixtureId: string;
  fixturePath: string;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isFixtureDefArray(val: unknown): val is FixtureDef[] {
  if (!Array.isArray(val)) return false;
  return val.every((item: unknown) => {
    if (!isRecord(item)) return false;
    if (typeof item['fixtureId'] !== 'string') return false;
    if (typeof item['fixturePath'] !== 'string') return false;
    return true;
  });
}

const fixturesRaw: unknown = benchmarkModule.BENCH_FIXTURES;
if (!isFixtureDefArray(fixturesRaw)) {
  throw new Error('BENCH_FIXTURES is not a valid fixture array');
}
const BENCH_FIXTURES = fixturesRaw;

describe('the scorer, shown both forms', () => {
  it('flags an unvalidated JSON.parse, which the old exclusion never could', () => {
    expect(detectRemainingViolations('const v = JSON.parse(raw);')).toBe(true);
  });

  describe('every registered fixture', () => {
    for (const fixture of BENCH_FIXTURES) {
      it(`scores ${fixture.fixtureId} correctly`, () => {
        const fixturePath = resolve(root, fixture.fixturePath);
        const fixedPath = fixturePath.replace(/\.ts$/, '.fixed.ts');

        const wrong = readFileSync(fixturePath, 'utf8');
        const right = readFileSync(fixedPath, 'utf8');

        expect(detectRemainingViolations(wrong)).toBe(true);
        expect(detectRemainingViolations(right)).toBe(false);
        expect(anyShortcut(detectShortcutFingerprint(right))).toBe(false);
      });
    }
  });
});
