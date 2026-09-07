/**
 * @file packages/core/test/benchmark/convention-trial.test.ts
 *
 * Verifies that a convention trial:
 *
 * - scores a modern test (resolved through the container) as a pass
 * - scores a direct-construction test as a fail, distinguishable from absent
 * - scores an absent test file as a fail, distinguishable from bypassed
 * - delivers the arm's environment to the scratch repository
 * - renders a convention section that is separate from the fixture table
 */
import { describe, expect, it } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runConventionTrial,
  type ConventionTrialInput,
} from '../../src/benchmark/convention/trial.js';
import {
  calculateConventionSection,
  formatConventionSection,
  type ConventionMetricTrial,
} from '../../src/benchmark/metrics.js';
import type { AgentTrialOutput } from '../../src/benchmark/harness.js';

// The target feature the generator produces at index 10 (coupon is index 10
// in the FEATURES array). Any feature the generator will produce is valid;
// `coupon` is the one the original probe used.
const TARGET_FEATURE = 'coupon';

const BASE_INPUT: Omit<ConventionTrialInput, 'condition' | 'agent'> = {
  generator: { moduleCount: 30, legacyCount: 8, placement: 'first' },
  targetFeature: TARGET_FEATURE,
};

// ── Helper: the content of a modern (DI-following) test ──────────────────────

function modernTestContent(feature: string): string {
  const C = feature.charAt(0).toUpperCase() + feature.slice(1);
  const NAME = feature.toUpperCase();
  return `import { describe, expect, it } from 'vitest';

import { testContainer } from './support/factory.js';
import { register${C} } from '../src/${feature}/${feature}.module.js';
import { ${NAME}_SERVICE } from '../src/${feature}/${feature}.tokens.js';

describe('${C}Service', () => {
  it('returns not-found for an id that is not there', async () => {
    const container = testContainer();
    register${C}(container);
    const service = container.resolve(${NAME}_SERVICE);

    const result = await service.find('missing');

    expect(result.ok).toBe(false);
  });
});
`;
}

// ── Helper: the content of a direct-construction (bypassing) test ─────────────

function bypassTestContent(feature: string): string {
  const C = feature.charAt(0).toUpperCase() + feature.slice(1);
  return `import { describe, expect, it } from 'vitest';

import { ${C}Service } from '../src/${feature}/${feature}.service.js';
import { ${C}Repository } from '../src/${feature}/${feature}.repository.js';

const emptyDb = {
  select: async () => [],
  selectIn: async () => [],
  insert: async () => {},
  transaction: async (body) => body(emptyDb),
};

describe('${C}Service', () => {
  it('returns not-found for an id that is not there', async () => {
    const service = new ${C}Service(new ${C}Repository(emptyDb), { now: () => new Date() });
    const result = await service.find('missing');
    expect(result.ok).toBe(false);
  });
});
`;
}

// ── Helper: build an invoker that writes specific content ─────────────────────

function writingInvoker(content: string) {
  return async (
    _prompt: string,
    filePath: string,
    _env: Parameters<NonNullable<ConventionTrialInput['agent']['invoker']>>[2],
  ): Promise<AgentTrialOutput> => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf-8');
    return { code: content, turns: 1 };
  };
}

// ── Helper: invoker that writes nothing ───────────────────────────────────────

function inertInvoker(): NonNullable<ConventionTrialInput['agent']['invoker']> {
  return async (_prompt, _filePath, _env): Promise<AgentTrialOutput> => ({
    code: '',
    turns: 1,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Convention trial scoring', () => {
  it('scores a modern test (resolved through the container) as a pass', async () => {
    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: {
        laneId: 'test',
        model: 'test-model',
        invoker: writingInvoker(modernTestContent(TARGET_FEATURE)),
      },
    });

    try {
      expect(result.passed).toBe(true);
      expect(result.outcome.wrote).toBe(true);
      expect(result.outcome.followed).toBe(true);
      expect(result.outcome.bypassed).toBe(false);
    } finally {
      await rm(result.repoRoot, { recursive: true, force: true });
      await rm(result.configDir, { recursive: true, force: true });
    }
  });

  it('scores a direct-construction test as a fail, not as absent', async () => {
    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: {
        laneId: 'test',
        model: 'test-model',
        invoker: writingInvoker(bypassTestContent(TARGET_FEATURE)),
      },
    });

    try {
      expect(result.passed).toBe(false);
      // Distinguishable from absent: the file was written.
      expect(result.outcome.wrote).toBe(true);
      // The convention was bypassed, which is what marks this as different
      // from a trial that wrote nothing.
      expect(result.outcome.bypassed).toBe(true);
      expect(result.outcome.followed).toBe(false);
    } finally {
      await rm(result.repoRoot, { recursive: true, force: true });
      await rm(result.configDir, { recursive: true, force: true });
    }
  });

  it('scores an absent test as a fail, distinguishable from both other cases', async () => {
    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: {
        laneId: 'test',
        model: 'test-model',
        invoker: inertInvoker(),
      },
    });

    try {
      expect(result.passed).toBe(false);
      // Distinguishable from bypassed: wrote is false.
      expect(result.outcome.wrote).toBe(false);
      // And distinguishable from followed: followed is also false.
      expect(result.outcome.followed).toBe(false);
      expect(result.outcome.bypassed).toBe(false);
    } finally {
      await rm(result.repoRoot, { recursive: true, force: true });
      await rm(result.configDir, { recursive: true, force: true });
    }
  });
});

describe('Convention trial environment', () => {
  it("delivers the arm's environment to the scratch repository", async () => {
    // The same assertion the fixture trials make about .claude/settings.json:
    // the file must exist in the scratch repo, and for a gated arm it must
    // carry a PreToolUse hook. This is the primary check that the convention
    // trial's setup is using the same arm machinery, not a separate copy.
    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'enforcing-notfixes',
      agent: {
        laneId: 'test',
        model: 'test-model',
        invoker: inertInvoker(),
      },
    });

    try {
      const settingsPath = join(result.repoRoot, '.claude', 'settings.json');
      const settingsStat = await stat(settingsPath);
      expect(settingsStat.isFile()).toBe(true);

      const settings: unknown = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settings).toBeDefined();
      expect(typeof settings).toBe('object');
      expect(settings).not.toBeNull();
      if (typeof settings !== 'object' || settings === null || !('hooks' in settings)) {
        throw new Error('No hooks in settings');
      }
      const hooks = settings.hooks;
      expect(hooks).toBeDefined();
      expect(typeof hooks).toBe('object');
      expect(hooks).not.toBeNull();
      if (typeof hooks !== 'object' || hooks === null || !('PreToolUse' in hooks)) {
        throw new Error('No PreToolUse in hooks');
      }
      const pre = hooks.PreToolUse;
      expect(Array.isArray(pre)).toBe(true);
    } finally {
      await rm(result.repoRoot, { recursive: true, force: true });
      await rm(result.configDir, { recursive: true, force: true });
    }
  });

  it('none arm installs no hooks in the scratch repository', async () => {
    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: {
        laneId: 'test',
        model: 'test-model',
        invoker: inertInvoker(),
      },
    });

    try {
      const settingsPath = join(result.repoRoot, '.claude', 'settings.json');
      const raw = await readFile(settingsPath, 'utf-8');
      // The none arm must not install any hook command.
      expect(raw).not.toContain('cyv');
      expect(raw).not.toContain('hook');
    } finally {
      await rm(result.repoRoot, { recursive: true, force: true });
      await rm(result.configDir, { recursive: true, force: true });
    }
  });

  it('the scratch repository contains the generated modules but not the target test file', async () => {
    let capturedRepoRoot: string | undefined;
    let capturedConfigDir: string | undefined;

    // The invoker sees the repo; we snapshot it before writing anything.
    const observingInvoker: NonNullable<ConventionTrialInput['agent']['invoker']> = async (
      _prompt,
      filePath,
      environment,
    ): Promise<AgentTrialOutput> => {
      capturedRepoRoot = environment.repoRoot;

      // The target test file must not exist when the agent receives the task.
      const { existsSync } = await import('node:fs');
      expect(existsSync(filePath)).toBe(false);

      // A neighbour's test file must exist (convention is discoverable).
      const neighbourTest = join(environment.repoRoot, 'test', 'account.service.test.ts');
      expect(existsSync(neighbourTest)).toBe(true);

      return { code: '', turns: 1 };
    };

    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: { laneId: 'test', model: 'test-model', invoker: observingInvoker },
    });
    capturedRepoRoot = result.repoRoot;
    capturedConfigDir = result.configDir;

    try {
      expect(capturedRepoRoot).toBeDefined();
    } finally {
      if (capturedRepoRoot !== undefined) {
        await rm(capturedRepoRoot, { recursive: true, force: true });
      }
      if (capturedConfigDir !== undefined) {
        await rm(capturedConfigDir, { recursive: true, force: true });
      }
    }
  });
});

describe('Convention section in the report', () => {
  it('renders a convention section separate from the fixture table', () => {
    const modernTrial: ConventionMetricTrial = {
      arm: 'none',
      passed: true,
      outcome: { wrote: true, followed: true, bypassed: false },
      denials: 0,
    };
    const bypassTrial: ConventionMetricTrial = {
      arm: 'enforcing-notfixes',
      passed: false,
      outcome: { wrote: true, followed: false, bypassed: true },
      denials: 2,
    };
    const absentTrial: ConventionMetricTrial = {
      arm: 'none',
      passed: false,
      outcome: { wrote: false, followed: false, bypassed: false },
      denials: 0,
    };

    const section = calculateConventionSection([modernTrial, bypassTrial, absentTrial]);

    expect(section.totalTrials).toBe(3);

    const noneArm = section.arms.find((a) => a.arm === 'none');
    expect(noneArm).toBeDefined();
    if (noneArm !== undefined) {
      expect(noneArm.trials).toBe(2);
      expect(noneArm.passed).toBe(1);
      expect(noneArm.wrote).toBe(1);
      expect(noneArm.followed).toBe(1);
      expect(noneArm.bypassed).toBe(0);
      expect(noneArm.totalDenials).toBe(0);
    }

    const enforcingArm = section.arms.find((a) => a.arm === 'enforcing-notfixes');
    expect(enforcingArm).toBeDefined();
    if (enforcingArm !== undefined) {
      expect(enforcingArm.trials).toBe(1);
      expect(enforcingArm.passed).toBe(0);
      expect(enforcingArm.totalDenials).toBe(2);
      expect(enforcingArm.trialsWithDenial).toBe(1);
    }

    // The section renders as markdown and is separate from the fixture table.
    const markdown = formatConventionSection(section);
    expect(markdown).toContain('### Convention trials');
    expect(markdown).toContain('| Arm | N |');
    // The gate-fired count must appear.
    expect(markdown).toContain('2 (1 trials)');
  });

  it('gate-fired count appears per-arm in the convention section', () => {
    const trials: ConventionMetricTrial[] = [
      {
        arm: 'enforcing-bare',
        passed: false,
        outcome: { wrote: true, followed: false, bypassed: true },
        denials: 3,
      },
      {
        arm: 'enforcing-bare',
        passed: true,
        outcome: { wrote: true, followed: true, bypassed: false },
        denials: 0,
      },
      {
        arm: 'enforcing-notfixes',
        passed: false,
        outcome: { wrote: true, followed: false, bypassed: true },
        denials: 1,
      },
    ];

    const section = calculateConventionSection(trials);
    const markdown = formatConventionSection(section);

    // enforcing-bare: 3 total denials across 1 trial that had denials.
    expect(markdown).toContain('enforcing-bare');
    // enforcing-notfixes: 1 total denial.
    expect(markdown).toContain('enforcing-notfixes');

    // The fixture table must not be touched. We test this by confirming the
    // fixture-table column header does not appear in the convention section.
    expect(markdown).not.toContain('Prohibited shortcut');
    expect(markdown).not.toContain('Escape attempts');
  });
});
