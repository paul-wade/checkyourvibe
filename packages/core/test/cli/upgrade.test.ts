import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as initModule from '../../src/cli/init.js';
import * as upgradeModule from '../../src/cli/upgrade.js';
import type { CommandContext } from '../../src/cli/types.js';
import claudeCodePlugin from '../../../adapter-claude-code/dist/index.js';
import geminiPlugin from '../../../adapter-gemini/dist/index.js';

async function makeRepo(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cyv-upgrade-repo-'));
  const repo = join(parent, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

  const docsDir = join(repo, 'docs', 'protocol');
  await mkdir(docsDir, { recursive: true });
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  await writeFile(
    join(docsDir, 'config.schema.json'),
    await readFile(fileURLToPath(schemaUrl), 'utf-8'),
  );

  return repo;
}

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'cyv-upgrade-home-'));
  await mkdir(join(homeDir, '.claude'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'settings.json'), '{}');
  return homeDir;
}

function context(repo: string, argv: string[], homeDir: string): CommandContext {
  return {
    cwd: repo,
    argv,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  };
}

/**
 * Per-rule guidance for Claude Code lives in the user's home directory, so
 * every test that expects it to be written passes the same flag `cyv init`
 * requires for a machine-wide write.
 */
function machineWide(argv: string[]): string[] {
  return [...argv, '--allow-outside-repo'];
}

interface Captured {
  logs: string[];
  errors: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
}

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.slice().sort();
}

interface RuleDefinition {
  id: string;
  summary: string;
  why: string;
  allowedFixes: string[];
  notFixes: Array<{ pattern: string; because: string; rule?: string }>;
  examples: { bad: string; good: string };
}

function makeRule(id: string, overrides?: Partial<RuleDefinition>): RuleDefinition {
  return {
    id,
    summary: `Do not violate rule ${id}.`,
    why: `Rule ${id} keeps the code base safe.`,
    allowedFixes: [`Use the correct alternative for ${id}.`],
    notFixes: [
      {
        pattern: `A tempting but wrong workaround for ${id}.`,
        because: 'It trades one violation for another.',
        rule: 'other-rule',
      },
    ],
    examples: {
      bad: `// bad example for ${id}`,
      good: `// good example for ${id}`,
    },
    ...overrides,
  };
}

function ruleToManifest(rule: RuleDefinition): Record<string, unknown> {
  return {
    id: rule.id,
    category: 'type-safety',
    scope: 'file',
    severity: 'error',
    summary: rule.summary,
    why: rule.why,
    allowedFixes: rule.allowedFixes,
    notFixes: rule.notFixes,
    examples: rule.examples,
  };
}

interface AnalyzerEntry {
  id: string;
  package: string;
}

async function writeConfig(
  repo: string,
  options: { agents?: string[]; packagePath?: string; analyzers?: AnalyzerEntry[] } = {},
): Promise<void> {
  const analyzers =
    options.analyzers ?? [{ id: 'stub', package: options.packagePath ?? './stub.manifest.json' }];
  const agents = options.agents ?? ['claude-code'];
  const config = {
    packs: [],
    analyzers,
    agents,
    rules: {},
    strict: false,
    exclude: [],
  };
  await writeFile(join(repo, 'checkyourvibe.json'), `${JSON.stringify(config, null, 2)}\n`);
}

async function writeManifest(
  repo: string,
  rules: RuleDefinition[],
  options: { id?: string; file?: string } = {},
): Promise<void> {
  const manifest = {
    protocol: 1,
    id: options.id ?? 'stub',
    match: ['*.ts'],
    rules: rules.map(ruleToManifest),
    exec: {
      type: 'process',
      command: 'node',
      args: ['-e', "console.log(JSON.stringify({protocol:1,violations:[],skipped:[],diagnostics:[]}))"],
    },
  };
  await writeFile(
    join(repo, options.file ?? 'stub.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function setupRepo(repo: string, rules: RuleDefinition[], agents?: string[]): Promise<void> {
  await writeConfig(repo, { agents });
  await writeManifest(repo, rules);
}

function guidancePath(homeDir: string, ruleId: string): string {
  return join(homeDir, '.claude', 'agents', `cyv-${ruleId}.md`);
}

beforeAll(() => {
  // Gemini CLI is here for its combined single-file guidance, which is a
  // different shape from Claude Code's file per rule. Only the agents named in
  // a test's config are planned, so adding it changes nothing for the rest.
  initModule.agentPluginsOverride.plugins = [claudeCodePlugin, geminiPlugin];
});

afterAll(() => {
  initModule.agentPluginsOverride.plugins = undefined;
});

describe('cyv upgrade', () => {
  it('creates per-rule guidance on the first run', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const rules = [makeRule('no-any'), makeRule('no-as-cast')];
      await setupRepo(repo, rules);

      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(code).toBe(0);

      const noAny = await readFile(guidancePath(homeDir, 'no-any'), 'utf-8');
      expect(noAny).toContain('name: cyv-no-any');
      expect(noAny).toContain(rules[0]?.summary ?? '');

      const noAsCast = await readFile(guidancePath(homeDir, 'no-as-cast'), 'utf-8');
      expect(noAsCast).toContain('name: cyv-no-as-cast');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('updates per-rule guidance when a rule text changes', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const rule = makeRule('no-any');
      await setupRepo(repo, [rule]);

      const first = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(first).toBe(0);

      const changed = makeRule('no-any', { summary: 'Updated summary for no-any.' });
      await writeManifest(repo, [changed]);

      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('Rule no-any guidance has changed');

      const noAny = await readFile(guidancePath(homeDir, 'no-any'), 'utf-8');
      expect(noAny).toContain(changed.summary);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports that everything is up to date, and exits 0, on a second run with no changes', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any')]);
      expect(await upgradeModule.command.run(context(repo, machineWide([]), homeDir))).toBe(0);

      const before = await snapshot(homeDir);
      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      const after = await snapshot(homeDir);

      expect(code).toBe(0);
      expect(after).toEqual(before);
      expect(captured.logs.join('\n')).toContain('Everything is up to date.');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('refuses to overwrite a hand-edited file without --force, and rewrites it with --force', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const rules = [makeRule('no-any'), makeRule('no-as-cast')];
      await setupRepo(repo, rules);

      const first = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(first).toBe(0);

      const handEdit = guidancePath(homeDir, 'no-as-cast');
      await writeFile(handEdit, `${await readFile(handEdit, 'utf-8')}\n<!-- hand-edited comment -->\n`);

      const second = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(second).toBe(1);

      const output = captured.logs.join('\n');
      expect(output).toContain('Pass --force to overwrite a hand-edited file');
      expect((await readFile(handEdit, 'utf-8'))).toContain('<!-- hand-edited comment -->');

      const third = await upgradeModule.command.run(context(repo, machineWide(['--force']), homeDir));
      expect(third).toBe(0);

      const final = await readFile(handEdit, 'utf-8');
      expect(final).not.toContain('<!-- hand-edited comment -->');
      expect(final).toContain(rules[1]?.summary ?? '');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('keeps a hand edit when the rule text changed in the same run', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any')]);
      expect(await upgradeModule.command.run(context(repo, machineWide([]), homeDir))).toBe(0);

      const handEdit = guidancePath(homeDir, 'no-any');
      const note = 'Our team also allows a documented exception in generated code.';
      await writeFile(handEdit, `${await readFile(handEdit, 'utf-8')}\n\n${note}\n`);

      // The rule text moves at the same time, which is the case that used to
      // rewrite the file and take the note with it.
      await writeManifest(repo, [makeRule('no-any', { why: 'A completely rewritten reason.' })]);

      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(code).toBe(1);

      const after = await readFile(handEdit, 'utf-8');
      expect(after).toContain(note);
      expect(after).not.toContain('A completely rewritten reason.');

      const output = captured.logs.join('\n');
      expect(output).toContain('the generator does not produce');
      expect(output).toContain('Pass --force to overwrite a hand-edited file');

      const forced = await upgradeModule.command.run(context(repo, machineWide(['--force']), homeDir));
      expect(forced).toBe(0);

      const rewritten = await readFile(handEdit, 'utf-8');
      expect(rewritten).toContain('A completely rewritten reason.');
      expect(rewritten).not.toContain(note);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('deletes generated guidance for a removed rule and reports an unknown-provenance file', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const rules = [makeRule('no-any'), makeRule('no-as-cast')];
      await setupRepo(repo, rules);

      const first = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(first).toBe(0);

      const unknownFile = join(homeDir, '.claude', 'agents', 'cyv-unknown.md');
      await writeFile(unknownFile, 'This file was not generated by cyv.\n');

      await writeManifest(repo, [rules[0] ?? makeRule('no-any')]);

      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(code).toBe(1);

      const output = captured.logs.join('\n');
      expect(output).toContain('cyv-no-as-cast.md');
      expect(output).toContain('Unknown provenance');

      await expect(stat(guidancePath(homeDir, 'no-as-cast'))).rejects.toThrow();

      const unknownContent = await readFile(unknownFile, 'utf-8');
      expect(unknownContent).toContain('This file was not generated by cyv.');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('removes guidance for every rule when the last analyzer is taken out of the config', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any'), makeRule('no-as-cast')]);
      expect(await upgradeModule.command.run(context(repo, machineWide([]), homeDir))).toBe(0);

      await writeConfig(repo, { analyzers: [] });

      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(code).toBe(0);

      const output = captured.logs.join('\n');
      expect(output).toContain('The rebuilt catalog has no rules');

      await expect(stat(guidancePath(homeDir, 'no-any'))).rejects.toThrow();
      await expect(stat(guidancePath(homeDir, 'no-as-cast'))).rejects.toThrow();
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('keeps guidance in place when the analyzer that owns it no longer resolves', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await writeConfig(repo, {
        analyzers: [
          { id: 'stub', package: './stub.manifest.json' },
          { id: 'second', package: './second.manifest.json' },
        ],
      });
      await writeManifest(repo, [makeRule('no-any')]);
      await writeManifest(repo, [makeRule('no-console')], {
        id: 'second',
        file: 'second.manifest.json',
      });

      expect(await upgradeModule.command.run(context(repo, machineWide([]), homeDir))).toBe(0);
      const owned = guidancePath(homeDir, 'no-console');
      const contentBefore = await readFile(owned, 'utf-8');

      await rm(join(repo, 'second.manifest.json'));

      const code = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(code).toBe(1);

      const output = captured.logs.join('\n');
      expect(output).toContain('Stale checkyourvibe.json entries');
      expect(output).toContain('analyzer "second" package "./second.manifest.json"');
      expect(output).toContain('may still exist');

      expect(await readFile(owned, 'utf-8')).toBe(contentBefore);
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('does not empty a combined guidance file when one analyzer stops resolving', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await writeConfig(repo, {
        agents: ['gemini'],
        analyzers: [
          { id: 'stub', package: './stub.manifest.json' },
          { id: 'second', package: './second.manifest.json' },
        ],
      });
      await writeManifest(repo, [makeRule('no-any')]);
      await writeManifest(repo, [makeRule('no-console')], {
        id: 'second',
        file: 'second.manifest.json',
      });

      // Gemini CLI writes its guidance inside the repository, so no
      // machine-wide flag is involved here.
      expect(await upgradeModule.command.run(context(repo, [], homeDir))).toBe(0);

      const combined = join(repo, '.gemini', 'checkyourvibe-rules.md');
      expect(await readFile(combined, 'utf-8')).toContain('no-console');

      await rm(join(repo, 'second.manifest.json'));

      const code = await upgradeModule.command.run(context(repo, [], homeDir));
      expect(code).toBe(1);
      expect(await readFile(combined, 'utf-8')).toContain('no-console');
      expect(captured.logs.join('\n')).toContain('may still exist');

      // --force is about hand-edited files. It must not turn an unresolved
      // analyzer into permission to drop that analyzer's rules.
      expect(await upgradeModule.command.run(context(repo, ['--force'], homeDir))).toBe(1);
      expect(await readFile(combined, 'utf-8')).toContain('no-console');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('does not write outside the repository without --allow-outside-repo', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any')]);

      const before = await snapshot(homeDir);
      const code = await upgradeModule.command.run(context(repo, [], homeDir));
      const after = await snapshot(homeDir);

      expect(code).toBe(1);
      expect(after).toEqual(before);
      await expect(stat(guidancePath(homeDir, 'no-any'))).rejects.toThrow();

      const output = captured.logs.join('\n');
      expect(output).toContain('outside this repository');
      expect(output).toContain('--allow-outside-repo');

      // The repository's own CLAUDE.md is inside the repo and is still written.
      const claudeMd = await readFile(join(repo, 'CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('checkyourvibe');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('--dry-run writes nothing and reports the plan', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      const rules = [makeRule('no-any')];
      await setupRepo(repo, rules);

      const first = await upgradeModule.command.run(context(repo, machineWide([]), homeDir));
      expect(first).toBe(0);

      const changed = makeRule('no-any', { summary: 'Updated summary for dry run.' });
      await writeManifest(repo, [changed]);

      const before = await snapshot(homeDir);
      const code = await upgradeModule.command.run(context(repo, machineWide(['--dry-run']), homeDir));
      const after = await snapshot(homeDir);

      expect(code).toBe(0);
      expect(after).toEqual(before);

      const output = captured.logs.join('\n');
      expect(output).toContain('would update');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports an unresolvable analyzer by name', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any')], ['claude-code']);
      await writeConfig(repo, { packagePath: './missing.manifest.json' });

      const code = await upgradeModule.command.run(
        context(repo, machineWide(['--dry-run']), homeDir),
      );
      expect(code).toBe(1);

      const output = captured.logs.join('\n');
      expect(output).toContain('analyzer "stub" package "./missing.manifest.json"');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('reports zero configured agents loudly instead of a clean run', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any')], []);

      const before = await snapshot(homeDir);
      const code = await upgradeModule.command.run(context(repo, machineWide(['--dry-run']), homeDir));
      const after = await snapshot(homeDir);

      expect(code).toBe(1);
      expect(after).toEqual(before);

      const output = captured.logs.join('\n');
      expect(output).toContain('No agents are configured');
      expect(output).not.toContain('Nothing to upgrade');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });

  it('rejects an unknown argument instead of ignoring it', async () => {
    const repo = await makeRepo();
    const homeDir = await makeHome();
    const captured = captureConsole();

    try {
      await setupRepo(repo, [makeRule('no-any')]);
      const code = await upgradeModule.command.run(context(repo, ['--forse'], homeDir));
      expect(code).toBe(2);
      expect(captured.errors.join('\n')).toContain('Unknown argument "--forse"');
    } finally {
      captured.restore();
      await cleanup(repo, homeDir);
    }
  });
});
