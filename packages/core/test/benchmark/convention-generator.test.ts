import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateRepo, type GeneratedRepo } from '../../src/benchmark/convention/generator.js';
import { checkDi } from '../../src/benchmark/convention/check-di.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Counts the test files in the generated repo that contain the legacy pattern
 * (direct construction with `new`), as opposed to the container factory.
 */
function countLegacyTests(repo: GeneratedRepo): number {
  let count = 0;
  for (const [path, content] of repo) {
    if (path.startsWith('test/') && path.endsWith('.service.test.ts')) {
      // Legacy tests use `new XService(` or `new XRepository(`; modern ones
      // call testContainer().
      if (/\bnew\s+\w+Service\s*\(/.test(content)) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Writes a generated repo to a temp directory and returns the directory path.
 * Caller is responsible for cleanup.
 */
async function materializeRepo(repo: GeneratedRepo): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-0064-test-'));
  for (const [rel, content] of repo) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Kernel invariants
// ---------------------------------------------------------------------------

describe('generateRepo — kernel invariants', () => {
  it('produces the same kernel files at 3 modules and at 30 modules', () => {
    const small = generateRepo({ moduleCount: 3, legacyCount: 0, placement: 'first' });
    const large = generateRepo({ moduleCount: 30, legacyCount: 0, placement: 'first' });

    const kernelPaths = [
      'src/kernel/container.ts',
      'src/kernel/clock.ts',
      'src/kernel/result.ts',
      'src/kernel/errors.ts',
      'src/kernel/config.ts',
      'src/kernel/http.ts',
      'src/kernel/db.ts',
      'src/kernel/page.ts',
      'src/kernel/tokens.ts',
      'test/support/factory.ts',
    ];

    for (const path of kernelPaths) {
      expect(small.get(path), `kernel file ${path} missing from 3-module repo`).toBeDefined();
      expect(large.get(path), `kernel file ${path} missing from 30-module repo`).toBeDefined();
      expect(small.get(path)).toBe(large.get(path));
    }
  });

  it('generates the right number of module files', () => {
    // Each module produces: tokens, repository, service, module, test = 5 files
    // Plus kernel (10) + app.ts + README.md = 12 non-module files
    const repo = generateRepo({ moduleCount: 3, legacyCount: 0, placement: 'first' });
    expect(repo.size).toBe(12 + 3 * 5);
  });
});

// ---------------------------------------------------------------------------
// Legacy placement
// ---------------------------------------------------------------------------

describe('generateRepo — legacy placement', () => {
  it('produces no legacy tests when legacyCount is 0', () => {
    const repo = generateRepo({ moduleCount: 10, legacyCount: 0, placement: 'first' });
    expect(countLegacyTests(repo)).toBe(0);
  });

  it('produces exactly 8 legacy tests when legacyCount is 8', () => {
    const repo = generateRepo({ moduleCount: 30, legacyCount: 8, placement: 'first' });
    expect(countLegacyTests(repo)).toBe(8);
  });

  it('produces exactly 8 legacy tests with scattered placement', () => {
    const repo = generateRepo({ moduleCount: 30, legacyCount: 8, placement: 'scattered' });
    expect(countLegacyTests(repo)).toBe(8);
  });

  it('places legacy modules first when placement is first', () => {
    const repo = generateRepo({ moduleCount: 10, legacyCount: 3, placement: 'first' });
    // The first three feature names are account, invoice, shipment
    expect(countLegacyTests(repo)).toBe(3);
    const accountTest = repo.get('test/account.service.test.ts');
    expect(accountTest).toBeDefined();
    // Legacy tests construct directly; modern ones call testContainer
    expect(accountTest).toMatch(/new AccountService\s*\(/);
    const webhookTest = repo.get('test/webhook.service.test.ts');
    expect(webhookTest).toBeDefined();
    // webhook is not in the first 3, so it should be a modern test
    expect(webhookTest).toMatch(/testContainer\s*\(\)/);
  });

  it('places legacy modules past the target when placement is late', () => {
    const repo = generateRepo({ moduleCount: 10, legacyCount: 3, placement: 'late' });
    expect(countLegacyTests(repo)).toBe(3);
    const accountTest = repo.get('test/account.service.test.ts');
    expect(accountTest).toBeDefined();
    expect(accountTest).toMatch(/testContainer\s*\(\)/);
  });

  // The condition that separates position from proportion: stale modules sit
  // second, third and fourth in the listing with ordinary names, and only the
  // first is current. Measured separately from 'late', which also marks its
  // stale modules by name.
  it('spreads legacy modules through the listing and keeps the first current', () => {
    const repo = generateRepo({ moduleCount: 10, legacyCount: 3, placement: 'scattered' });
    expect(countLegacyTests(repo)).toBe(3);

    const accountTest = repo.get('test/account.service.test.ts');
    expect(accountTest).toBeDefined();
    expect(accountTest).toMatch(/testContainer\s*\(\)/);

    // Not all bunched at the end: at least one stale module precedes the last.
    const staleNames = [...repo.keys()]
      .filter((path) => path.startsWith('test/') && path.endsWith('.service.test.ts'))
      .filter((path) => !/testContainer\s*\(\)/.test(repo.get(path) ?? ''))
      .sort();
    expect(staleNames.length).toBe(3);
    expect(staleNames.at(0)).not.toBe(staleNames.at(-1));
  });

  it('accepts legacyCount === moduleCount', () => {
    const repo = generateRepo({ moduleCount: 3, legacyCount: 3, placement: 'first' });
    expect(countLegacyTests(repo)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// checkDi — three outcomes
// ---------------------------------------------------------------------------

describe('checkDi', () => {
  it('returns wrote:false for a feature with no test file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyv-0064-check-'));
    try {
      const result = checkDi(dir, 'coupon');
      expect(result.wrote).toBe(false);
      expect(result.followed).toBe(false);
      expect(result.bypassed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns followed:true for a generated modern test', async () => {
    const repo = generateRepo({ moduleCount: 3, legacyCount: 0, placement: 'first' });
    const dir = await materializeRepo(repo);
    try {
      const result = checkDi(dir, 'account');
      expect(result.wrote).toBe(true);
      expect(result.followed).toBe(true);
      expect(result.bypassed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns bypassed:true for a generated legacy test', async () => {
    // legacyCount:1, placement:'first' puts account (index 0) as legacy
    const repo = generateRepo({ moduleCount: 3, legacyCount: 1, placement: 'first' });
    const dir = await materializeRepo(repo);
    try {
      const result = checkDi(dir, 'account');
      expect(result.wrote).toBe(true);
      expect(result.followed).toBe(false);
      expect(result.bypassed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Generated output type-checks under strict settings
// ---------------------------------------------------------------------------

describe('generateRepo — generated TypeScript compiles', () => {
  it('compiles a 3-module repo under strict settings', async () => {
    const repo = generateRepo({ moduleCount: 3, legacyCount: 0, placement: 'first' });
    const dir = await materializeRepo(repo);
    try {
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          // Only check src/ — test/ imports vitest which is not installed in the
          // temp directory. The source files are what matters: they use no
          // third-party types, only platform globals (DOM lib covers fetch et al).
          include: ['src/**/*'],
        }),
        'utf-8',
      );

      const result = spawnSync('npx', ['tsc', '--project', join(dir, 'tsconfig.json')], {
        encoding: 'utf-8',
        shell: true,
      });
      // Only check the exit code; npm may emit env-config warnings to stderr
      // that are unrelated to TypeScript diagnostics.
      const tsErrors = (result.stdout + result.stderr)
        .split('\n')
        .filter((l) => /error TS/.test(l))
        .join('\n');
      expect(tsErrors).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('compiles a 30-module repo under strict settings', async () => {
    const repo = generateRepo({ moduleCount: 30, legacyCount: 8, placement: 'first' });
    const dir = await materializeRepo(repo);
    try {
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          // Only check src/ — test/ imports vitest which is not installed in the
          // temp directory. The source files are what matters: they use no
          // third-party types, only platform globals (DOM lib covers fetch et al).
          include: ['src/**/*'],
        }),
        'utf-8',
      );

      const result = spawnSync('npx', ['tsc', '--project', join(dir, 'tsconfig.json')], {
        encoding: 'utf-8',
        shell: true,
      });
      // Only check the exit code; npm may emit env-config warnings to stderr
      // that are unrelated to TypeScript diagnostics.
      const tsErrors = (result.stdout + result.stderr)
        .split('\n')
        .filter((l) => /error TS/.test(l))
        .join('\n');
      expect(tsErrors).toBe('');
      expect(result.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
