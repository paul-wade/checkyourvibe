import { describe, expect, it } from 'vitest';
import { buildGateModel } from '../../src/ci/model.js';
import { CI_SYSTEM_IDS, type CiSystemId } from '../../src/ci/detect.js';
import { renderGate } from '../../src/ci/render.js';

const REPO = '/tmp/repo';

function modelWithPnpm(): ReturnType<typeof buildGateModel> {
  return buildGateModel({ id: 'pnpm', evidence: 'pnpm-lock.yaml' }, '@checkyourvibe/core');
}

/**
 * A structural check over the subset of YAML these renderers emit.
 *
 * This is not a YAML parser and does not claim to be one — spec 0019
 * Requirement 6.3 is explicit that this project verifies shape, not execution.
 * What it does catch is the class of mistake a string-concatenating renderer
 * actually makes: a tab, an indent that is not a multiple of two, a duplicate
 * top-level key from appending a second document into one file, and a block
 * scalar whose body is not indented past its introducer.
 */
function yamlProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  const topLevelKeys = new Set<string>();
  let blockScalarIndent: number | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }

    if (line.includes('\t')) {
      problems.push(`line ${i + 1}: contains a tab`);
    }

    const indent = line.length - line.trimStart().length;

    if (blockScalarIndent !== undefined) {
      if (indent > blockScalarIndent) {
        continue;
      }
      blockScalarIndent = undefined;
    }

    if (line.trimStart().startsWith('#')) {
      continue;
    }

    if (indent % 2 !== 0) {
      problems.push(`line ${i + 1}: indent ${indent} is not a multiple of 2`);
    }

    if (line.trimEnd().endsWith(': |') || line.trimEnd().endsWith(':|')) {
      blockScalarIndent = indent;
      continue;
    }

    if (indent === 0 && !line.startsWith('-')) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        const key = line.slice(0, colon);
        if (topLevelKeys.has(key)) {
          problems.push(`duplicate top-level key "${key}" at line ${i + 1}`);
        }
        topLevelKeys.add(key);
      }
    }
  }

  return problems;
}

describe('CI gate renderers', () => {
  it('renders a gate for every system this module claims to know', () => {
    for (const id of CI_SYSTEM_IDS) {
      const gate = renderGate(id, REPO, modelWithPnpm());
      expect(gate.system).toBe(id);
      expect(gate.snippet.length).toBeGreaterThan(0);
    }
  });

  it('emits structurally sound YAML for every YAML platform', () => {
    const yamlSystems: CiSystemId[] = CI_SYSTEM_IDS.filter((id) => id !== 'jenkins');
    for (const id of yamlSystems) {
      const gate = renderGate(id, REPO, modelWithPnpm());
      expect({ id, problems: yamlProblems(gate.snippet) }).toEqual({ id, problems: [] });
    }
  });

  it('runs check --all --strict, and only adds --since-baseline behind a file test', () => {
    for (const id of CI_SYSTEM_IDS) {
      const gate = renderGate(id, REPO, modelWithPnpm());
      expect(gate.snippet).toContain('pnpm exec cyv check --all --strict');
      expect(gate.snippet).toContain('pnpm exec cyv check --all --strict --since-baseline');
      expect(gate.snippet).toContain('if [ -f checkyourvibe.baseline.json ]; then');
    }
  });

  it('writes a file for the three platforms that have somewhere safe to put one', () => {
    const written = CI_SYSTEM_IDS.filter(
      (id) => renderGate(id, REPO, modelWithPnpm()).delivery === 'file',
    );
    expect(written.sort()).toEqual(['azure-pipelines', 'github-actions', 'gitlab-ci']);
  });

  it('gives every manual gate a reason and a follow-up rather than silence', () => {
    for (const id of CI_SYSTEM_IDS) {
      const gate = renderGate(id, REPO, modelWithPnpm());
      if (gate.delivery === 'manual') {
        expect(gate.write).toBeUndefined();
        expect(gate.manualReason?.length ?? 0).toBeGreaterThan(0);
        expect(gate.followUp.length).toBeGreaterThan(0);
      }
    }
  });

  it('marks the two files it names itself with a hash-comment managed block', () => {
    const gate = renderGate('github-actions', REPO, modelWithPnpm());
    expect(gate.write?.strategy).toBe('managed-block');
    expect(gate.write?.blockComment).toBe('hash');
    expect(gate.write?.blockId).toBe('ci-github-actions');
  });

  it('states in the file itself that nothing here was executed on the platform', () => {
    for (const id of CI_SYSTEM_IDS) {
      const gate = renderGate(id, REPO, modelWithPnpm());
      expect(gate.snippet).toContain('maintains no account and no runner on');
      expect(gate.snippet).toContain('has not been executed on');
    }
  });

  it('says so in the generated file when nothing in the pipeline installs cyv', () => {
    const withDependency = renderGate('github-actions', REPO, modelWithPnpm());
    expect(withDependency.snippet).not.toContain('cyv: command not found');
    expect(withDependency.snippet).toContain('pnpm exec cyv');

    const without = renderGate(
      'github-actions',
      REPO,
      buildGateModel({ id: 'pnpm', evidence: 'pnpm-lock.yaml' }, undefined),
    );
    expect(without.snippet).toContain('does not declare checkyourvibe as a dependency');
    expect(without.snippet).toContain('cyv: command not found');
  });

  it('omits the install step entirely when no package manager was detected', () => {
    const gate = renderGate('github-actions', REPO, buildGateModel(undefined, undefined));
    expect(gate.snippet).not.toContain('Install dependencies');
    expect(gate.snippet).not.toContain('corepack');
    expect(gate.snippet).toContain('cyv check --all --strict');
  });

  it('uses each package manager\'s own install command and runner', () => {
    const cases: { id: 'pnpm' | 'yarn' | 'npm' | 'bun'; install: string; runner: string }[] = [
      { id: 'pnpm', install: 'pnpm install --frozen-lockfile', runner: 'pnpm exec cyv' },
      { id: 'yarn', install: 'yarn install --immutable', runner: 'yarn cyv' },
      { id: 'npm', install: 'npm ci', runner: 'npx --no-install cyv' },
      { id: 'bun', install: 'bun install --frozen-lockfile', runner: 'bunx cyv' },
    ];

    for (const entry of cases) {
      const gate = renderGate(
        'github-actions',
        REPO,
        buildGateModel({ id: entry.id, evidence: 'lockfile' }, '@checkyourvibe/core'),
      );
      expect(gate.snippet).toContain(entry.install);
      expect(gate.snippet).toContain(entry.runner);
    }
  });

  it('requests full history everywhere the platform can express it', () => {
    expect(renderGate('github-actions', REPO, modelWithPnpm()).snippet).toContain('fetch-depth: 0');
    expect(renderGate('gitlab-ci', REPO, modelWithPnpm()).snippet).toContain('GIT_DEPTH: "0"');
    expect(renderGate('azure-pipelines', REPO, modelWithPnpm()).snippet).toContain('fetchDepth: 0');
  });

  it('renders the same bytes twice, so a re-run is not spurious drift', () => {
    for (const id of CI_SYSTEM_IDS) {
      const first = renderGate(id, REPO, modelWithPnpm());
      const second = renderGate(id, REPO, modelWithPnpm());
      expect(first.snippet).toBe(second.snippet);
    }
  });
});
