import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Command, CommandContext } from './types.js';
import { isUnknownArray } from '../guards.js';

interface ParsedNewRuleArgs {
  ruleId: string;
  analyzer: string;
  dryRun: boolean;
}

interface RuleInterface {
  name: string;
  hasMakeViolation: boolean;
}

interface TargetFile {
  path: string;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function isEnoent(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error && 'code' in err)) {
    return false;
  }
  const code = err.code;
  return typeof code === 'string' && code === 'ENOENT';
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toCamelCase(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+(.?)/g, (_, ch: string | undefined) =>
    ch !== undefined ? ch.toUpperCase() : '',
  );
}

function parseArgs(argv: string[]): ParsedNewRuleArgs {
  let ruleId: string | undefined;
  let analyzer = 'packages/analyzer-typescript';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--analyzer') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error('--analyzer requires a directory path.');
      }
      analyzer = next;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag "${arg}" for cyv new-rule.`);
    } else if (ruleId === undefined) {
      ruleId = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}". cyv new-rule takes a single rule id.`);
    }
  }

  if (ruleId === undefined) {
    throw new Error('Missing rule id. Usage: cyv new-rule <rule-id> [--analyzer <dir>] [--dry-run]');
  }

  if (!/^[a-z][a-z0-9-]*$/.test(ruleId)) {
    throw new Error(
      `Rule id "${ruleId}" must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`,
    );
  }

  return { ruleId, analyzer, dryRun };
}

function displayPath(targetPath: string, cwd: string): string {
  const relative = path.relative(cwd, targetPath).replace(/\\/g, '/');
  return relative.startsWith('..') ? targetPath : relative;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch (err) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }
}

async function detectRuleInterface(analyzerDir: string): Promise<RuleInterface> {
  const ruleFile = path.join(analyzerDir, 'src', 'rule.ts');
  const text = await readFile(ruleFile, 'utf-8').catch(() => '');

  const interfaceRegex = /export\s+interface\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  let interfaceName: string | undefined;

  while ((match = interfaceRegex.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) {
      continue;
    }
    if (body.includes('manifest:') && body.includes('check')) {
      interfaceName = name;
      break;
    }
  }

  if (interfaceName === undefined) {
    throw new Error(
      `Could not determine the rule interface from ${ruleFile}. This scaffold only supports analyzers with a src/rule.ts file exporting a rule interface.`,
    );
  }

  const utilFile = path.join(analyzerDir, 'src', 'util.ts');
  const utilText = await readFile(utilFile, 'utf-8').catch(() => '');
  const hasMakeViolation = /export\s+(?:function|const)\s+makeViolation\b/.test(utilText);

  return { name: interfaceName, hasMakeViolation };
}

async function readExistingRuleIds(analyzerDir: string): Promise<Set<string>> {
  const manifestPath = path.join(analyzerDir, 'analyzer.manifest.json');
  const text = await readFile(manifestPath, 'utf-8');
  const raw: unknown = JSON.parse(text);

  if (!isRecord(raw)) {
    throw new Error(`Analyzer manifest at ${manifestPath} is not a JSON object.`);
  }

  const rules = raw.rules;
  if (!isUnknownArray(rules)) {
    throw new Error(`Analyzer manifest at ${manifestPath} does not contain a valid "rules" array.`);
  }

  const ids = new Set<string>();
  for (const rawRule of rules) {
    if (!isRecord(rawRule) || typeof rawRule.id !== 'string') {
      throw new Error(`Analyzer manifest at ${manifestPath} contains a rule with no id.`);
    }
    ids.add(rawRule.id);
  }

  return ids;
}

function ruleSource(
  ruleId: string,
  constName: string,
  interfaceName: string,
  hasMakeViolation: boolean,
): string {
  const makeViolationImport = hasMakeViolation
    ? "import { makeViolation } from '../util.js';\n"
    : '';
  const hintLines: string[] = [];
  if (hasMakeViolation) {
    hintLines.push('  // Use makeViolation(sourceFile, node, ruleId, message, severity) to build findings.');
  }
  hintLines.push(`  // TODO: implement the check for ${ruleId} and remove the early return.`);
  const body = hintLines.join('\n');

  return `import type { SourceFile } from 'ts-morph';
${makeViolationImport}import type { ${interfaceName} } from '../rule.js';
import type { RuleManifest, Violation } from '@checkyourvibe/core';

const manifest: RuleManifest = {
  id: '${ruleId}',
  category: 'TODO-pick-a-category',
  pack: 'TODO-pick-a-pack',
  scope: 'file',
  severity: 'error',
  summary: 'TODO: write a one-line summary for ${ruleId}.',
  why: 'TODO: explain why ${ruleId} exists and what failure mode it prevents.',
  allowedFixes: [
    'TODO: describe one concrete, independently sufficient remediation.',
    'TODO: describe another concrete remediation if there is one.',
  ],
  notFixes: [
    {
      pattern: 'TODO: describe a tempting non-fix for ${ruleId}',
      because: 'TODO: explain why this does not actually solve the problem.',
      // A notFix's 'rule' may only name a rule in the same analyzer; a dangling reference fails conformance.
      rule: 'TODO-sibling-rule',
    },
  ],
  examples: {
    bad: 'TODO: paste the smallest code shape that ${ruleId} flags.',
    good: 'TODO: paste the corrected version of the bad example.',
  },
};

function check(sourceFile: SourceFile, _options: Record<string, unknown>): Violation[] {
${body}
  return [];
}

export const ${constName}: ${interfaceName} = { manifest, check };
`;
}

function ruleTest(ruleId: string, constName: string): string {
  return `import { describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ${constName} } from '../../src/rules/${ruleId}.js';
import { createProject, loadFiles } from '../../src/project.js';
import type { SourceFile } from 'ts-morph';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

function loadFixture(name: string): SourceFile {
  const project = createProject(packageRoot);
  const path = join(fixturesDir, name);
  const { loaded } = loadFiles(project, [path]);
  const sourceFile = loaded[0];
  if (sourceFile === undefined) {
    throw new Error(\`Fixture \${name} did not load\`);
  }
  return sourceFile;
}

describe('${ruleId}', () => {
  it.todo('reports violations in the bad fixture');
  it.todo('reports zero violations in the ok fixture');
});
`;
}

function fixtureContent(ruleId: string, kind: 'bad' | 'ok'): string {
  return `// TODO: ${kind} fixture for ${ruleId}. Edit this file to match what the rule should ${kind === 'bad' ? 'flag' : 'accept'}.
`;
}

function buildTargets(
  analyzerDir: string,
  ruleId: string,
  ruleInterface: RuleInterface,
): TargetFile[] {
  const constName = toCamelCase(ruleId);
  const ruleSourcePath = path.join(analyzerDir, 'src', 'rules', `${ruleId}.ts`);
  const badFixturePath = path.join(analyzerDir, 'test', 'fixtures', `${ruleId}.bad.ts`);
  const okFixturePath = path.join(analyzerDir, 'test', 'fixtures', `${ruleId}.ok.ts`);
  const ruleTestPath = path.join(analyzerDir, 'test', 'rules', `${ruleId}.test.ts`);

  return [
    { path: ruleSourcePath, content: ruleSource(ruleId, constName, ruleInterface.name, ruleInterface.hasMakeViolation) },
    { path: badFixturePath, content: fixtureContent(ruleId, 'bad') },
    { path: okFixturePath, content: fixtureContent(ruleId, 'ok') },
    { path: ruleTestPath, content: ruleTest(ruleId, constName) },
  ];
}

async function ensureParentDir(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
}

function printDryRun(targets: TargetFile[], cwd: string, analyzerDir: string, ruleId: string): void {
  console.log('Would create:');
  for (const target of targets) {
    console.log(`  ${displayPath(target.path, cwd)}`);
  }
  printWiringNotice(cwd, analyzerDir, ruleId);
}

function printCreated(targets: TargetFile[], cwd: string, analyzerDir: string, ruleId: string): void {
  console.log(`Created:`);
  for (const target of targets) {
    console.log(`  ${displayPath(target.path, cwd)}`);
  }
  printWiringNotice(cwd, analyzerDir, ruleId);
}

/**
 * The line without which this command is a trap.
 *
 * A scaffolded rule file compiles, its test passes, and it never runs — it is
 * not in the analyzer's rule list and not in the manifest, so `cyv check`
 * neither loads it nor mentions it. That exact failure has happened in this
 * repository more than once: a rule pack that expanded to nothing, and a
 * finished rule whose manifest entry was never added. Both looked like a clean
 * pass. Saying so here is cheaper than finding it again.
 */
function printWiringNotice(cwd: string, analyzerDir: string, ruleId: string): void {
  const rel = (...parts: string[]): string => displayPath(path.join(analyzerDir, ...parts), cwd);
  console.log('');
  console.log(`"${ruleId}" does not run yet. It is scaffolded, not registered.`);
  console.log(`  1. Export it from ${rel('src', 'rules', 'index.ts')}.`);
  console.log(`  2. Add its manifest entry to ${rel('analyzer.manifest.json')}.`);
  console.log('  3. Fill in every placeholder — a manifest whose `why` still reads TODO is');
  console.log('     guidance an agent will follow.');
  console.log('  4. Declare its notFixes. A rule with none is a rule that teaches an agent to');
  console.log('     trade one violation for another.');
  console.log(`  Then: cyv verify-analyzer ${rel('analyzer.manifest.json')}`);
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    try {
      const parsed = parseArgs(ctx.argv);
      const analyzerDir = path.resolve(ctx.cwd, parsed.analyzer);

      const ruleInterface = await detectRuleInterface(analyzerDir);
      const existingIds = await readExistingRuleIds(analyzerDir);

      if (existingIds.has(parsed.ruleId)) {
        throw new Error(`Rule "${parsed.ruleId}" already exists in the analyzer manifest.`);
      }

      const targets = buildTargets(analyzerDir, parsed.ruleId, ruleInterface);

      for (const target of targets) {
        if (await fileExists(target.path)) {
          throw new Error(`File already exists: ${target.path}`);
        }
      }

      if (parsed.dryRun) {
        printDryRun(targets, ctx.cwd, analyzerDir, parsed.ruleId);
        return 0;
      }

      for (const target of targets) {
        await ensureParentDir(target.path);
        await writeFile(target.path, target.content, 'utf-8');
      }

      printCreated(targets, ctx.cwd, analyzerDir, parsed.ruleId);
      return 0;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
