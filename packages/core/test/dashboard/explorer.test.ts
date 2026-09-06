import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get as httpGet, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../src/cli/dashboard.js';
import { isUnknownArray } from '../../src/guards.js';

const ANALYZER_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const violations = [];
  for (const file of request.files) {
    const content = readFileSync(file, 'utf-8');
    if (content.includes('VIOLATION')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'no-violation-marker',
        message: 'File contains a VIOLATION marker.',
        snippet: 'VIOLATION',
      });
    }
  }
  return { protocol: 1, violations, skipped: [], diagnostics: [] };
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function analyzerManifest(): unknown {
  return {
    protocol: 1,
    id: 'stub',
    match: ['**/*'],
    rules: [
      {
        id: 'no-violation-marker',
        category: 'test',
        scope: 'file',
        severity: 'error',
        summary: 'Flags an explicit VIOLATION marker left in source.',
        why: 'Keeps this fixture deterministically wrong so tests can assert on it.',
        allowedFixes: ['Remove the VIOLATION marker from the file.'],
        notFixes: [],
        examples: { bad: 'const x = 1; // VIOLATION', good: 'const x = 1;' },
      },
    ],
    exec: { type: 'node', module: './analyzer.mjs' },
  };
}

function repoConfig(): unknown {
  return {
    packs: [],
    analyzers: [{ id: 'stub', package: './analyzer.manifest.json' }],
    rules: { 'no-violation-marker': {} },
    strict: false,
    exclude: [],
  };
}

async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-explorer-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(repoConfig(), null, 2));
  await writeFile(join(repo, 'analyzer.manifest.json'), JSON.stringify(analyzerManifest(), null, 2));
  await writeFile(join(repo, 'analyzer.mjs'), ANALYZER_MODULE);
  return repo;
}

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The dashboard server is not bound to a TCP port.');
  }
  return address.port;
}

async function startServer(repo: string): Promise<{ server: Server; port: number }> {
  const { server } = await createDashboardServer({ root: repo, registry: [] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: boundPort(server) };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((err) => (err !== undefined ? reject(err) : resolve())));
}

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

async function post(port: number, path: string, data: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function readObjectBody(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error('Response body is not a JSON object');
  }
  return parsed;
}

function flattenTree(node: unknown): string[] {
  const paths: string[] = [];
  function walk(current: unknown): void {
    if (!isRecord(current)) return;
    if (current.kind === 'file' && typeof current.path === 'string') {
      paths.push(current.path);
      return;
    }
    if (isUnknownArray(current.children)) {
      for (const child of current.children) walk(child);
    }
  }
  walk(node);
  return paths;
}

describe('dashboard solution explorer API', () => {
  it('lists tracked and untracked-but-not-ignored files, and omits ignored files', async () => {
    const repo = await makeRepo();
    const parent = join(repo, '..');
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src/tracked.txt'), 'tracked\n');
      await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
      await writeFile(join(repo, 'ignored.txt'), 'ignored\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await writeFile(join(repo, 'src/untracked.txt'), 'untracked\n');

      const { server, port } = await startServer(repo);
      try {
        const { status, body } = await get(port, '/api/explorer/tree');
        expect(status).toBe(200);
        const parsed = readObjectBody(body);
        const paths = flattenTree(parsed.tree);
        expect(paths).toContain('src/tracked.txt');
        expect(paths).toContain('src/untracked.txt');
        expect(paths).not.toContain('ignored.txt');
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('reads a file and refuses a path that escapes the repository', async () => {
    const repo = await makeRepo();
    const parent = join(repo, '..');
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src/readme.txt'), 'hello\n');

      const { server, port } = await startServer(repo);
      try {
        const good = await get(port, '/api/explorer/read?f=src/readme.txt');
        expect(good.status).toBe(200);
        const parsed = readObjectBody(good.body);
        expect(typeof parsed.content).toBe('string');
        expect(parsed.content).toBe('hello\n');

        const bad = await get(port, '/api/explorer/read?f=../readme.txt');
        expect(bad.status).toBe(400);
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('refuses a write with a stale lock', async () => {
    const repo = await makeRepo();
    const parent = join(repo, '..');
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src/locked.txt'), 'first\n');

      const { server, port } = await startServer(repo);
      try {
        const first = await post(port, '/api/explorer/write', { file: 'src/locked.txt', content: 'first\n', holder: 'holder-a' });
        expect(first.status).toBe(200);

        const second = await post(port, '/api/explorer/write', { file: 'src/locked.txt', content: 'second\n', holder: 'holder-b' });
        expect(second.status).toBe(409);
        const parsed = readObjectBody(second.body);
        expect(typeof parsed.holder).toBe('string');
        expect(parsed.holder).toBe('holder-a');
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('reports the findings cyv produced, not a silent success', async () => {
    const repo = await makeRepo();
    const parent = join(repo, '..');
    try {
      await mkdir(join(repo, 'src'), { recursive: true });

      const { server, port } = await startServer(repo);
      try {
        const clean = await post(port, '/api/explorer/write', { file: 'src/clean.ts', content: 'const ok = 1;\n', holder: 'h1' });
        expect(clean.status).toBe(200);
        const cleanParsed = readObjectBody(clean.body);
        expect(cleanParsed.ok).toBe(true);
        const cleanFindings = cleanParsed.findings;
        expect(isUnknownArray(cleanFindings)).toBe(true);
        if (!isUnknownArray(cleanFindings)) throw new Error('clean findings is not an array');
        expect(cleanFindings).toHaveLength(0);

        const dirty = await post(port, '/api/explorer/write', { file: 'src/dirty.ts', content: 'const bad = 1; // VIOLATION\n', holder: 'h2' });
        expect(dirty.status).toBe(200);
        const dirtyParsed = readObjectBody(dirty.body);
        expect(dirtyParsed.ok).toBe(false);
        const findings = dirtyParsed.findings;
        expect(isUnknownArray(findings)).toBe(true);
        if (!isUnknownArray(findings)) throw new Error('findings is not an array');
        expect(findings.length).toBeGreaterThan(0);

        const first = findings[0];
        expect(isRecord(first)).toBe(true);
        if (!isRecord(first)) throw new Error('first finding is not an object');
        expect(typeof first.ruleId).toBe('string');
        expect(first.ruleId).toBe('no-violation-marker');
        expect(typeof first.message).toBe('string');
        expect(first.message).toBe('File contains a VIOLATION marker.');

        const saved = await readFile(join(repo, 'src/dirty.ts'), 'utf-8');
        expect(saved).toBe('const bad = 1; // VIOLATION\n');
      } finally {
        await closeServer(server);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
