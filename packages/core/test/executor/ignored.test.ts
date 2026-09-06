import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { splitGeneratedPaths } from '../../src/executor/ignored.js';

describe('splitGeneratedPaths', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'cyv-ignore-')));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('returns empty split for no changed paths', async () => {
    const result = await splitGeneratedPaths(repo, []);

    expect(result.authored).toEqual([]);
    expect(result.generated).toEqual([]);
    expect(result.undetermined).toBeUndefined();
  });

  it('fails safe by treating every path as authored when git cannot be asked', async () => {
    const result = await splitGeneratedPaths(repo, ['src/a.ts']);

    expect(result.authored).toEqual(['src/a.ts']);
    expect(result.generated).toEqual([]);
    expect(result.undetermined).toContain('could not ask git');
  });

  it('separates ignored paths from authored paths using .gitignore', async () => {
    execFileSync('git', ['init'], { cwd: repo });
    await writeFile(join(repo, '.gitignore'), 'build/\n', 'utf-8');
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'build'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), '', 'utf-8');
    await writeFile(join(repo, 'build', 'output.js'), '', 'utf-8');

    const result = await splitGeneratedPaths(repo, ['src/a.ts', 'build/output.js']);

    expect(result.authored).toEqual(['src/a.ts']);
    expect(result.generated).toEqual(['build/output.js']);
    expect(result.undetermined).toBeUndefined();
  });
});
