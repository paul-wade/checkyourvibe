import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalyzer, AnalyzerError } from '../../src/run/execute.js';
import { loadAnalyzerManifest } from '../../src/registry/load.js';
import {
  PROTOCOL_VERSION,
  type AnalyzerManifest,
  type AnalyzeRequest,
  type RuleManifest,
  type Severity,
} from '../../src/protocol/index.js';

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function makeRule(id: string, severity: Severity = 'error'): RuleManifest {
  return {
    id,
    category: 'test',
    scope: 'file',
    severity,
    summary: 'Test rule',
    why: 'For testing analyzer invocation.',
    allowedFixes: [],
    notFixes: [],
    examples: { bad: 'bad', good: 'good' },
  };
}

function makeManifest(id: string, exec: AnalyzerManifest['exec']): AnalyzerManifest {
  return {
    protocol: PROTOCOL_VERSION,
    id,
    match: ['*.ts'],
    rules: [makeRule('test-rule', 'warning')],
    exec,
  };
}

function makeRequest(repoRoot: string, rules: AnalyzeRequest['rules'] = {}): AnalyzeRequest {
  return {
    protocol: PROTOCOL_VERSION,
    repoRoot,
    mode: 'file',
    files: [],
    rules,
  };
}

describe('runAnalyzer node shape', () => {
  it('loads and runs an in-process analyzer module', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-node-'));
    const modulePath = join(tmpDir, 'analyzer.mjs');
    await writeFile(
      modulePath,
      `
export default async function (request) {
  return {
    protocol: 1,
    violations: request.files.map((file, index) => {
      const base = { file, line: 1, column: 1, message: 'test', snippet: 'x' };
      if (index === 0) return { ...base, ruleId: 'test-rule' };
      if (index === 1) return { ...base, ruleId: 'unknown-rule' };
      return { ...base, ruleId: 'test-rule', severity: 'error' };
    }),
    skipped: [],
    diagnostics: [{ level: 'info', message: 'analyzer info' }],
  };
}
      `,
    );

    const manifest = makeManifest('node-test', { type: 'node', module: modulePath });
    const request = makeRequest(tmpDir, { 'test-rule': { severity: 'warning' } });
    request.files = [join(tmpDir, 'a.ts'), join(tmpDir, 'b.ts'), join(tmpDir, 'c.ts')];

    const response = await runAnalyzer(manifest, request, tmpDir);

    expect(response.protocol).toBe(PROTOCOL_VERSION);
    expect(response.violations).toHaveLength(3);
    const [first, second, third] = response.violations;
    assertDefined(first, 'expected first violation');
    assertDefined(second, 'expected second violation');
    assertDefined(third, 'expected third violation');
    expect(first.severity).toBe('warning');
    expect(second.severity).toBe('error');
    expect(third.severity).toBe('error');
    expect(response.diagnostics).toEqual([{ level: 'info', message: 'analyzer info' }]);
    expect(first.guidance).toBeUndefined();
  });

  it('throws LOAD_FAILED when the module has no default export', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-node-'));
    await writeFile(join(tmpDir, 'no-default.mjs'), `export const notDefault = 1;`);

    const manifest = makeManifest('no-default-test', {
      type: 'node',
      module: join(tmpDir, 'no-default.mjs'),
    });
    const request = makeRequest(tmpDir);

    try {
      await runAnalyzer(manifest, request, tmpDir);
      throw new Error('expected runAnalyzer to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerError);
      if (!(e instanceof AnalyzerError)) throw e;
      expect(e.code).toBe('LOAD_FAILED');
      expect(e.analyzerId).toBe('no-default-test');
    }
  });

  it('throws MALFORMED when the analyzer returns an invalid protocol', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-malformed-'));
    await writeFile(
      join(tmpDir, 'malformed.mjs'),
      `
export default async function () {
  return { protocol: 2, violations: [], skipped: [], diagnostics: [] };
}
      `,
    );

    const manifest = makeManifest('malformed-test', {
      type: 'node',
      module: join(tmpDir, 'malformed.mjs'),
    });
    const request = makeRequest(tmpDir);

    try {
      await runAnalyzer(manifest, request, tmpDir);
      throw new Error('expected runAnalyzer to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerError);
      if (!(e instanceof AnalyzerError)) throw e;
      expect(e.code).toBe('MALFORMED');
      expect(e.analyzerId).toBe('malformed-test');
    }
  });

  it('resolves a relative module against the manifest directory, not the repository root', async () => {
    // The manifest and its module live outside the repository being checked,
    // which is the arrangement that tells the two candidate base directories
    // apart: an installed analyzer package is never inside the repository.
    const analyzerDir = await mkdtemp(join(tmpdir(), 'cyv-analyzer-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-repo-'));

    await writeFile(
      join(analyzerDir, 'analyzer.mjs'),
      `
export default async function () {
  return {
    protocol: 1,
    violations: [],
    skipped: [],
    diagnostics: [{ level: 'info', message: 'resolved from the manifest directory' }],
  };
}
      `,
    );
    const manifestPath = join(analyzerDir, 'analyzer.manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        protocol: PROTOCOL_VERSION,
        id: 'relative-module-test',
        match: ['*.ts'],
        rules: [makeRule('test-rule', 'warning')],
        exec: { type: 'node', module: './analyzer.mjs' },
      }),
    );

    const manifest = await loadAnalyzerManifest(manifestPath, repoRoot);
    expect(manifest.exec).toEqual({ type: 'node', module: join(analyzerDir, 'analyzer.mjs') });

    const response = await runAnalyzer(manifest, makeRequest(repoRoot), repoRoot);
    expect(response.diagnostics).toEqual([
      { level: 'info', message: 'resolved from the manifest directory' },
    ]);
  });

  it('reports a still-relative module rather than resolving it against the repository root', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-unresolved-'));
    await writeFile(
      join(tmpDir, 'analyzer.mjs'),
      `export default async function () { return { protocol: 1, violations: [], skipped: [], diagnostics: [] }; }`,
    );

    // A manifest built in memory never went through the loader, so its relative
    // path has not been resolved. Running it against the repository root would
    // succeed here by coincidence — the module happens to sit in that directory
    // — and that coincidence is the behaviour being ruled out.
    const manifest = makeManifest('unresolved-test', { type: 'node', module: './analyzer.mjs' });

    try {
      await runAnalyzer(manifest, makeRequest(tmpDir), tmpDir);
      throw new Error('expected runAnalyzer to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerError);
      if (!(e instanceof AnalyzerError)) throw e;
      expect(e.code).toBe('LOAD_FAILED');
      expect(e.message).toContain('loadAnalyzerManifest');
    }
  });

  it('treats a bare module value as a package specifier and says so when it fails', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-bare-'));
    const manifest = makeManifest('bare-test', {
      type: 'node',
      module: 'cyv-no-such-analyzer-package/index.js',
    });

    try {
      await runAnalyzer(manifest, makeRequest(tmpDir), tmpDir);
      throw new Error('expected runAnalyzer to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerError);
      if (!(e instanceof AnalyzerError)) throw e;
      expect(e.code).toBe('LOAD_FAILED');
      expect(e.message).toContain('package specifier');
    }
  });
});

describe('runAnalyzer process shape', () => {
  it('spawns an analyzer and folds stderr into diagnostics', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-process-'));
    const scriptPath = join(tmpDir, 'analyzer.mjs');
    await writeFile(
      scriptPath,
      `
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const response = {
    protocol: 1,
    violations: request.files.map((file) => ({
      file,
      line: 1,
      column: 1,
      ruleId: 'test-rule',
      message: 'process test',
      snippet: 'x',
    })),
    skipped: [],
    diagnostics: [{ level: 'info', message: 'from process' }],
  };
  process.stderr.write('process stderr line\\n');
  process.stdout.write(JSON.stringify(response));
});
      `,
    );

    const manifest = makeManifest('process-test', {
      type: 'process',
      command: process.execPath,
      args: [scriptPath],
    });
    const request = makeRequest(tmpDir, { 'test-rule': { severity: 'warning' } });
    request.files = [join(tmpDir, 'a.ts')];

    const response = await runAnalyzer(manifest, request, tmpDir);

    expect(response.violations).toHaveLength(1);
    const [first] = response.violations;
    assertDefined(first, 'expected violation');
    expect(first.severity).toBe('warning');
    expect(response.diagnostics).toEqual([
      { level: 'info', message: 'from process' },
      { level: 'warn', message: 'process stderr line' },
    ]);
  });

  it('throws CRASHED when the subprocess exits with unparseable stdout', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-process-'));
    const scriptPath = join(tmpDir, 'crash.mjs');
    await writeFile(
      scriptPath,
      `process.stdout.write('not json', () => process.exit(1));`,
    );

    const manifest = makeManifest('crash-test', {
      type: 'process',
      command: process.execPath,
      args: [scriptPath],
    });
    const request = makeRequest(tmpDir);

    try {
      await runAnalyzer(manifest, request, tmpDir);
      throw new Error('expected runAnalyzer to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerError);
      if (!(e instanceof AnalyzerError)) throw e;
      expect(e.code).toBe('CRASHED');
      expect(e.analyzerId).toBe('crash-test');
      expect(e.message).toContain('exited with code 1');
    }
  });

  it('throws MISSING_COMMAND when the subprocess command is not on PATH', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cyv-process-'));
    const request = makeRequest(tmpDir);

    const manifest = makeManifest('missing-cmd-test', {
      type: 'process',
      command: 'cyv-definitely-missing-command',
    });

    try {
      await runAnalyzer(manifest, request, tmpDir);
      throw new Error('expected runAnalyzer to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AnalyzerError);
      if (!(e instanceof AnalyzerError)) throw e;
      expect(e.code).toBe('MISSING_COMMAND');
      expect(e.analyzerId).toBe('missing-cmd-test');
      expect(e.message).toContain('cyv-definitely-missing-command');
      expect(e.message).toContain('Install the');
    }
  });
});
