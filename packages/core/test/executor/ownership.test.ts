import { describe, expect, it } from 'vitest';

import {
  normalizeOwnedPath,
  overlappingPaths,
  ownsPath,
  pathIsWithin,
  pathsOverlap,
} from '../../src/executor/ownership.js';

describe('normalizeOwnedPath', () => {
  it('turns backslashes into forward slashes', () => {
    expect(normalizeOwnedPath('src\\api\\handler.ts')).toBe('src/api/handler.ts');
  });

  it('strips a leading ./ and a trailing slash', () => {
    expect(normalizeOwnedPath('./src/api/')).toBe('src/api');
  });

  it('treats . as the repository root', () => {
    expect(normalizeOwnedPath('.')).toBe('');
  });
});

describe('pathIsWithin', () => {
  it('matches a path against itself', () => {
    expect(pathIsWithin('src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('matches a file beneath a declared directory', () => {
    expect(pathIsWithin('src/api/handler.ts', 'src/api')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(pathIsWithin('src/api-client.ts', 'src/api')).toBe(false);
  });

  it('does not match a parent against a declared child', () => {
    expect(pathIsWithin('src', 'src/api')).toBe(false);
  });

  it('matches anything against the repository root', () => {
    expect(pathIsWithin('src/a.ts', '.')).toBe(true);
  });
});

describe('pathsOverlap', () => {
  it('is true in either direction of containment', () => {
    expect(pathsOverlap('src/api', 'src/api/handler.ts')).toBe(true);
    expect(pathsOverlap('src/api/handler.ts', 'src/api')).toBe(true);
  });

  it('is false for unrelated paths', () => {
    expect(pathsOverlap('src/a.ts', 'docs/readme.md')).toBe(false);
  });
});

describe('ownsPath', () => {
  it('is true when any declared path covers it', () => {
    expect(ownsPath(['docs', 'src/api'], 'src/api/handler.ts')).toBe(true);
  });

  it('is false when no declared path covers it', () => {
    expect(ownsPath(['src/api'], 'src/other.ts')).toBe(false);
  });

  it('is false against an empty declaration', () => {
    expect(ownsPath([], 'src/a.ts')).toBe(false);
  });
});

describe('overlappingPaths', () => {
  it('returns the left-hand paths that collided, sorted and de-duplicated', () => {
    expect(overlappingPaths(['src/b.ts', 'src/a.ts', 'docs'], ['src/a.ts', 'src/b.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('normalizes separators before comparing', () => {
    expect(overlappingPaths(['src\\a.ts'], ['src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('returns nothing when the declarations are disjoint', () => {
    expect(overlappingPaths(['src/a.ts'], ['docs/readme.md'])).toEqual([]);
  });
});
