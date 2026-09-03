import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A tiny in-process analyzer module that flags a literal `VIOLATION` marker.
 * Its rule carries a non-empty `notFixes` entry so tests can assert guidance
 * travels with the finding, not just a bare message.
 */
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

export function analyzerManifest(): unknown {
  return {
    protocol: 1,
    id: 'stub',
    match: ['**/*.ts'],
    rules: [
      {
        id: 'no-violation-marker',
        category: 'test',
        scope: 'file',
        severity: 'error',
        summary: 'Flags an explicit VIOLATION marker left in source.',
        why: 'Keeps this fixture deterministically wrong so tests can assert on it.',
        allowedFixes: ['Remove the VIOLATION marker from the file.'],
        notFixes: [
          {
            pattern: 'Rename the marker instead of removing it.',
            because: 'The analyzer matches the literal text, so renaming still trips the rule.',
          },
        ],
        examples: { bad: 'const x = 1; // VIOLATION', good: 'const x = 1;' },
      },
    ],
    exec: { type: 'node', module: './analyzer.mjs' },
  };
}

export function config(): unknown {
  return {
    packs: [],
    analyzers: [{ id: 'stub', package: './analyzer.manifest.json' }],
    rules: { 'no-violation-marker': {} },
    strict: false,
    exclude: [],
  };
}

export async function copySchema(repoRoot: string): Promise<void> {
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf-8');
  const schemaDir = join(repoRoot, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), schema);
}

export async function makeRepo(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cyv-mcp-')));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  return repo;
}

export async function makeConfiguredRepo(sourceContent: string): Promise<{ repo: string; sourcePath: string }> {
  const repo = await makeRepo();
  await copySchema(repo);
  await writeFile(join(repo, 'checkyourvibe.json'), JSON.stringify(config(), null, 2));
  await writeFile(join(repo, 'analyzer.manifest.json'), JSON.stringify(analyzerManifest(), null, 2));
  await writeFile(join(repo, 'analyzer.mjs'), ANALYZER_MODULE);

  const srcDir = join(repo, 'src');
  await mkdir(srcDir, { recursive: true });
  const sourcePath = join(srcDir, 'thing.ts');
  await writeFile(sourcePath, sourceContent);

  await execFileSync('git', ['add', '-A'], { cwd: repo });
  await execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

  return { repo, sourcePath };
}
