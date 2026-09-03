import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { watch, type WatchHandle, type WatchRunResult } from '../../src/run/watch.js';

/**
 * Marker analyzer's own module content. Module-scope state (`seenCounts`) is
 * the point of this fixture: a fresh `import()` of a new URL, or a respawned
 * subprocess, would reset the map to empty. If two separate `onRun` batches
 * both see counts that carry forward, the same module instance served both —
 * proof that watch mode retains analyzer state between runs (Requirement
 * 4.10), rather than rebuilding it on every change.
 */
const MARKER_ANALYZER_SOURCE = `
import { readFileSync } from 'node:fs';

const seenCounts = new Map();

export default async function analyze(request) {
  const violations = [];
  const diagnostics = [];

  for (const file of request.files) {
    const count = (seenCounts.get(file) ?? 0) + 1;
    seenCounts.set(file, count);

    const content = readFileSync(file, 'utf8');
    diagnostics.push({ level: 'info', message: \`seen:\${file}:\${count}\` });

    if (content.includes('VIOLATE')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'test/marker',
        message: 'contains VIOLATE marker',
        snippet: 'VIOLATE',
      });
    }
  }

  return { protocol: 1, violations, skipped: [], diagnostics };
}
`;

function testRule(id: string): Record<string, unknown> {
  return {
    id,
    category: 'test',
    scope: 'file',
    severity: 'error',
    summary: `Test rule ${id}.`,
    why: 'Test fixture rule.',
    allowedFixes: ['Remove the offending content.'],
    notFixes: [],
    examples: { bad: 'bad', good: 'good' },
  };
}

/**
 * Build a self-contained repo: a real `docs/protocol/config.schema.json`
 * (copied from this repository, since `loadConfig` reads it off `repoRoot`),
 * a node-shaped "marker" analyzer that flags files containing `VIOLATE`, and
 * a process-shaped analyzer that watch mode must never invoke.
 */
async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cyv-watch-'));

  await mkdir(join(root, 'docs', 'protocol'), { recursive: true });
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  await writeFile(join(root, 'docs', 'protocol', 'config.schema.json'), schema);

  await mkdir(join(root, 'analyzers', 'marker'), { recursive: true });
  await writeFile(
    join(root, 'analyzers', 'marker', 'analyzer.manifest.json'),
    JSON.stringify({
      protocol: 1,
      id: 'marker',
      match: ['**/*.ts'],
      rules: [testRule('test/marker')],
      exec: { type: 'node', module: './analyzer.mjs' },
    }),
  );
  await writeFile(join(root, 'analyzers', 'marker', 'analyzer.mjs'), MARKER_ANALYZER_SOURCE);

  // Never actually run: only loaded, so it needs a structurally valid
  // manifest, not a runnable command.
  await mkdir(join(root, 'analyzers', 'proc'), { recursive: true });
  await writeFile(
    join(root, 'analyzers', 'proc', 'analyzer.manifest.json'),
    JSON.stringify({
      protocol: 1,
      id: 'proc-lang',
      match: ['**/*.proc'],
      rules: [testRule('test/proc-rule')],
      exec: { type: 'process', command: process.execPath, args: ['--version'] },
    }),
  );

  await writeFile(
    join(root, 'checkyourvibe.json'),
    JSON.stringify({
      packs: [],
      analyzers: [
        { id: 'marker', package: './analyzers/marker/analyzer.manifest.json' },
        { id: 'proc-lang', package: './analyzers/proc/analyzer.manifest.json' },
      ],
      rules: {
        'test/marker': {},
        'test/proc-rule': {},
      },
      strict: false,
      exclude: [],
    }),
  );

  return root;
}

const DEBOUNCE_MS = 100;
const openHandles: WatchHandle[] = [];

async function startWatch(root: string, onRun: (result: WatchRunResult) => void): Promise<WatchHandle> {
  const handle = await watch({ repoRoot: root, paths: [root], onRun, debounceMs: DEBOUNCE_MS });
  openHandles.push(handle);
  // Give the underlying fs.watch a moment to actually start before the first
  // write, so the write isn't racing watcher setup.
  await delay(50);
  return handle;
}

afterEach(async () => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (handle !== undefined) {
      await handle.close();
    }
  }
});

describe('watch', () => {
  it('triggers a run whose result contains a violation from a written file', async () => {
    const root = await createFixtureRepo();
    const filePath = join(root, 'watched.ts');
    await writeFile(filePath, 'const ok = 1;\n');

    const onRun = vi.fn<(result: WatchRunResult) => void>();
    await startWatch(root, onRun);

    await writeFile(filePath, 'const bad = 1; // VIOLATE\n');

    await vi.waitFor(() => expect(onRun).toHaveBeenCalled(), { timeout: 5000, interval: 50 });

    const result = onRun.mock.calls[0]?.[0];
    expect(result).toBeDefined();
    expect(result?.changedFiles).toContain(resolve(filePath));
    expect(result?.violations).toHaveLength(1);
    expect(result?.violations[0]?.ruleId).toBe('test/marker');
    expect(result?.violations[0]?.file).toBe(resolve(filePath));
  }, 10000);

  it('coalesces two rapid writes into exactly one run', async () => {
    const root = await createFixtureRepo();
    const filePath = join(root, 'watched.ts');
    await writeFile(filePath, 'const ok = 1;\n');

    const onRun = vi.fn<(result: WatchRunResult) => void>();
    await startWatch(root, onRun);

    await writeFile(filePath, 'const ok = 2; // VIOLATE\n');
    await writeFile(filePath, 'const ok = 3; // VIOLATE\n');

    await vi.waitFor(() => expect(onRun).toHaveBeenCalled(), { timeout: 5000, interval: 50 });
    // Settle well past the debounce window to make sure a second, unwanted
    // run isn't just late.
    await delay(DEBOUNCE_MS * 4);

    expect(onRun).toHaveBeenCalledTimes(1);
  }, 10000);

  it('reflects new file content on a later run instead of stale results', async () => {
    const root = await createFixtureRepo();
    const filePath = join(root, 'watched.ts');
    const resolvedPath = resolve(filePath);
    await writeFile(filePath, 'const ok = 1;\n');

    const onRun = vi.fn<(result: WatchRunResult) => void>();
    await startWatch(root, onRun);

    await writeFile(filePath, 'const bad = 1; // VIOLATE\n');
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 50 });

    const first = onRun.mock.calls[0]?.[0];
    expect(first?.violations).toHaveLength(1);
    expect(first?.diagnostics.some((d) => d.message === `seen:${resolvedPath}:1`)).toBe(true);

    await delay(DEBOUNCE_MS * 2);
    await writeFile(filePath, 'const ok = 2;\n');
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 50 });

    const second = onRun.mock.calls[1]?.[0];
    // Content changed, so the violation must be gone — proves the run used
    // fresh content, not a cached result from the first pass.
    expect(second?.violations).toHaveLength(0);
    // The per-file count kept counting up rather than resetting to 1 —
    // proves the SAME analyzer module instance served both runs.
    expect(second?.diagnostics.some((d) => d.message === `seen:${resolvedPath}:2`)).toBe(true);
  }, 10000);

  it('stops producing runs after close()', async () => {
    const root = await createFixtureRepo();
    const filePath = join(root, 'watched.ts');
    await writeFile(filePath, 'const ok = 1;\n');

    const onRun = vi.fn<(result: WatchRunResult) => void>();
    const handle = await startWatch(root, onRun);

    await writeFile(filePath, 'const bad = 1; // VIOLATE\n');
    await vi.waitFor(() => expect(onRun).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 50 });

    await handle.close();
    const indexInOpenHandles = openHandles.indexOf(handle);
    if (indexInOpenHandles !== -1) {
      openHandles.splice(indexInOpenHandles, 1);
    }

    await writeFile(filePath, 'const other = 2; // VIOLATE\n');
    await delay(DEBOUNCE_MS * 4);

    expect(onRun).toHaveBeenCalledTimes(1);
  }, 10000);

  it('emits a diagnostic for a configured process-shaped analyzer instead of silence', async () => {
    const root = await createFixtureRepo();
    const filePath = join(root, 'watched.ts');
    await writeFile(filePath, 'const ok = 1;\n');

    const onRun = vi.fn<(result: WatchRunResult) => void>();
    await startWatch(root, onRun);

    await writeFile(filePath, 'const bad = 1; // VIOLATE\n');
    await vi.waitFor(() => expect(onRun).toHaveBeenCalled(), { timeout: 5000, interval: 50 });

    const result = onRun.mock.calls[0]?.[0];
    const skipDiagnostic = result?.diagnostics.find(
      (d) => d.message.includes('proc-lang') && d.message.toLowerCase().includes('process'),
    );
    expect(skipDiagnostic).toBeDefined();
    expect(skipDiagnostic?.level).toBe('warn');
  }, 10000);
});
