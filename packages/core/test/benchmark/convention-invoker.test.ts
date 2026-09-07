/**
 * @file packages/core/test/benchmark/convention-invoker.test.ts
 *
 * The convention invoker is the live seam of the convention condition: it
 * builds the same agent command a fixture trial builds, sends a prompt that
 * names the target test file without naming the convention, and reads the
 * same event stream back — hook events included, because the gate-fired
 * count is this condition's headline number. These tests inject; no test
 * here runs a real agent.
 */
import { describe, expect, it } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildConventionTrialCommand,
  buildConventionTrialPrompt,
  createConventionInvoker,
  type ConventionInvoker,
} from '../../src/benchmark/convention/invoker.js';
import {
  runConventionTrial,
  type ConventionTrialInput,
} from '../../src/benchmark/convention/trial.js';
import {
  agentOutputFromStream,
  parseClaudeStreamJson,
} from '../../src/benchmark/runner.js';
import type { TrialEnvironment } from '../../src/benchmark/harness.js';

const TARGET_FEATURE = 'coupon';
const TARGET_RELATIVE_PATH = `test/${TARGET_FEATURE}.service.test.ts`;

const BASE_INPUT: Omit<ConventionTrialInput, 'condition' | 'agent'> = {
  generator: { moduleCount: 30, legacyCount: 8, placement: 'first' },
  targetFeature: TARGET_FEATURE,
};

const trialEnvironment: TrialEnvironment = {
  arm: 'enforcing-notfixes',
  repoRoot: join('scratch', 'repo'),
  fixturePath: join('scratch', 'repo', 'test', 'coupon.service.test.ts'),
  settingsPath: join('scratch', 'repo', '.claude', 'settings.json'),
  configPath: join('scratch', 'repo', 'checkyourvibe.json'),
  configDir: join('scratch', 'repo', '.cyv-bench-home'),
  permissionMode: 'acceptEdits',
};

async function removeTrialDirs(result: { repoRoot: string; configDir: string }): Promise<void> {
  await rm(result.repoRoot, { recursive: true, force: true });
  if (result.configDir.length > 0) {
    await rm(result.configDir, { recursive: true, force: true });
  }
}

describe('the convention trial prompt', () => {
  it('names the repo-relative target path and nothing about the convention', () => {
    const prompt = buildConventionTrialPrompt(
      'Add a unit test for the coupon service covering the case where the id is not found.',
      trialEnvironment.fixturePath,
      trialEnvironment,
    );

    // checkDi reads test/<feature>.service.test.ts; a correct answer written
    // anywhere else scores as absent — a fail for the wrong reason.
    expect(prompt).toContain(TARGET_RELATIVE_PATH);
    // The repo-relative form is what is named; the absolute scratch path is
    // not the agent's business.
    expect(prompt).not.toContain(trialEnvironment.repoRoot);
    // A prompt that names the convention answers the question the condition
    // exists to ask, and measures nothing.
    expect(prompt).not.toMatch(/container|factory|inject/i);
    expect(prompt).not.toContain('```');
  });

  it('reaches the agent as the task text plus the path, through the trial', async () => {
    let sentPrompt: string | undefined;
    let sentPath: string | undefined;
    let sentEnvironment: TrialEnvironment | undefined;
    const capturing: ConventionInvoker = async (prompt, filePath, environment) => {
      sentPrompt = prompt;
      sentPath = filePath;
      sentEnvironment = environment;
      return { code: '', turns: 1 };
    };

    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: { laneId: 'test', model: 'test-model', invoker: capturing },
    });
    try {
      if (sentPrompt === undefined || sentPath === undefined || sentEnvironment === undefined) {
        throw new Error('the invoker was never called');
      }

      // The task text itself says what to test and never how.
      expect(sentPrompt).toContain('unit test');
      expect(sentPrompt).not.toMatch(/container|factory|inject/i);

      // The prompt the live invoker would send: that text plus the path.
      const built = buildConventionTrialPrompt(sentPrompt, sentPath, sentEnvironment);
      expect(built.startsWith(sentPrompt)).toBe(true);
      expect(built).toContain(TARGET_RELATIVE_PATH);
      expect(built).not.toContain(result.repoRoot);
      expect(built).not.toMatch(/container|factory|inject/i);
    } finally {
      await removeTrialDirs(result);
    }
  });
});

describe('the convention trial command', () => {
  it('is the fixture trial command — same arguments, environment and working directory', () => {
    const command = buildConventionTrialCommand(
      'Add a unit test for the coupon service.',
      trialEnvironment.fixturePath,
      trialEnvironment,
      { model: 'test-model', maxTurns: 3 },
    );

    // The arm's settings only apply beneath its own repository.
    expect(command.cwd).toBe(trialEnvironment.repoRoot);
    // The arm is its hooks, which it only is if no other configuration can
    // install one.
    expect(command.env['CLAUDE_CONFIG_DIR'] ?? '').toBe(trialEnvironment.configDir);
    expect(command.timeoutMs).toBeGreaterThan(0);

    const permissionModeAt = command.args.indexOf('--permission-mode');
    expect(permissionModeAt).toBeGreaterThanOrEqual(0);
    expect(command.args.at(permissionModeAt + 1)).toBe('acceptEdits');

    const permissionPromptsAt = command.args.indexOf('--permission-prompts');
    expect(permissionPromptsAt).toBeGreaterThanOrEqual(0);
    expect(command.args.at(permissionPromptsAt + 1)).toBe('none');

    // A run under bypassPermissions never fires PreToolUse; the trial voids
    // it, so the command must never contain it.
    expect(command.args).not.toContain('bypassPermissions');
    expect(command.args.join(' ')).not.toContain('bypassPermissions');

    // The transcript is where a denial becomes visible, so the run must emit
    // the event stream, not a text reply.
    const outputFormatAt = command.args.indexOf('--output-format');
    expect(command.args.at(outputFormatAt + 1)).toBe('stream-json');
    expect(command.args).toContain('--verbose');
    expect(command.args).toContain('--include-hook-events');
    expect(command.args).toContain('-p');

    expect(command.args.at(command.args.indexOf('--model') + 1)).toBe('test-model');

    // The only divergence from the fixture command is the prompt sentence:
    // the target does not exist, so the prompt names where to write it
    // rather than what to change.
    expect(command.stdin).toBe(
      buildConventionTrialPrompt(
        'Add a unit test for the coupon service.',
        trialEnvironment.fixturePath,
        trialEnvironment,
      ),
    );
    expect(command.stdin).toContain(TARGET_RELATIVE_PATH);
  });
});

describe('the arm environment the invoker runs under', () => {
  it("delivers the arm's hooks to the scratch repository's .claude/settings.json", async () => {
    const observing: ConventionInvoker = async (_prompt, _filePath, environment) => {
      const settingsStat = await stat(environment.settingsPath);
      expect(settingsStat.isFile()).toBe(true);

      const raw = await readFile(environment.settingsPath, 'utf-8');
      const settings: unknown = JSON.parse(raw);
      if (typeof settings !== 'object' || settings === null || !('hooks' in settings)) {
        throw new Error('the enforcing arm installed no hooks');
      }
      const hooks = settings.hooks;
      if (typeof hooks !== 'object' || hooks === null || !('PreToolUse' in hooks)) {
        throw new Error('the enforcing arm installed no PreToolUse hook');
      }
      expect(Array.isArray(hooks.PreToolUse)).toBe(true);
      if (!('PostToolUse' in hooks)) {
        throw new Error('the enforcing arm installed no PostToolUse hook');
      }
      expect(Array.isArray(hooks.PostToolUse)).toBe(true);

      // The mode the run must happen under — anything else never fires
      // PreToolUse and the trial is void.
      expect(environment.permissionMode).toBe('acceptEdits');
      return { code: '', turns: 1 };
    };

    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'enforcing-notfixes',
      agent: { laneId: 'test', model: 'test-model', invoker: observing },
    });
    try {
      expect(result.arm).toBe('enforcing-notfixes');
    } finally {
      await removeTrialDirs(result);
    }
  });

  it('a trial in the none arm has no hooks at all', async () => {
    const observing: ConventionInvoker = async (_prompt, _filePath, environment) => {
      const raw = await readFile(environment.settingsPath, 'utf-8');
      const settings: unknown = JSON.parse(raw);
      if (typeof settings === 'object' && settings !== null && 'hooks' in settings) {
        throw new Error('the none arm installed hooks');
      }
      expect(raw).not.toContain('PreToolUse');
      expect(raw).not.toContain('PostToolUse');
      return { code: '', turns: 1 };
    };

    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'none',
      agent: { laneId: 'test', model: 'test-model', invoker: observing },
    });
    try {
      expect(result.arm).toBe('none');
    } finally {
      await removeTrialDirs(result);
    }
  });
});

describe('hook events on a convention trial', () => {
  it('lands stream-read denials and advisory reports on the trial result', async () => {
    const stream = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'runtime-model-7',
        permissionMode: 'acceptEdits',
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_write',
              name: 'Write',
              input: {
                file_path: TARGET_RELATIVE_PATH,
                content: 'export const attempt = 1;',
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'PreToolUse:Write',
        hook_event: 'PreToolUse',
        output: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'cyv: the proposed content violates configured rules.\n' +
              'test/coupon.service.test.ts:1 bench-direct-construction follow the repository convention',
          },
        }),
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_write',
              is_error: true,
              content: 'cyv: the proposed content violates configured rules.',
            },
          ],
        },
        tool_result_meta: [{ id: 'toolu_write', non_execution_kind: 'permission-rule' }],
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_retry',
              name: 'Edit',
              input: {
                file_path: TARGET_RELATIVE_PATH,
                new_string: 'export const attempt = 2;',
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'PostToolUse:Edit',
        hook_event: 'PostToolUse',
        output: 'Checked 1 file.',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_retry', is_error: false, content: 'ok' },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        num_turns: 2,
        total_cost_usd: 0.4213,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_creation_input_tokens: 90,
          cache_read_input_tokens: 15000,
        },
        permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_write', tool_input: {} }],
      }),
    ].join('\n');

    // What the live invoker does with a stream: parse it and hand the trial
    // the output — denials, advisory reports, tokens and cost included.
    const streamInvoker: ConventionInvoker = async (_prompt, _filePath, environment) =>
      agentOutputFromStream(parseClaudeStreamJson(stream, environment.repoRoot), '');

    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'enforcing-notfixes',
      agent: { laneId: 'test', model: 'test-model', invoker: streamInvoker },
    });
    try {
      expect(result.sawHookEvents).toBe(true);
      expect(result.hookEvents).toEqual({ allowed: 0, denied: 1, advisory: 1 });
      // The gate-fired count is the headline for this condition.
      expect(result.denials).toBe(1);
      expect(result.turnsTaken).toBe(2);
      expect(result.tokens?.input).toBe(1200);
      expect(result.costUsd).toBeCloseTo(0.4213, 6);
      // The denied write never landed, so the target file is absent — a
      // scored outcome, recorded, not a failed trial.
      expect(result.outcome.wrote).toBe(false);
      expect(result.passed).toBe(false);
    } finally {
      await removeTrialDirs(result);
    }
  });

  it('records a stream with no hook events as containing none', async () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'runtime-model-7' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_write',
              name: 'Write',
              input: { file_path: TARGET_RELATIVE_PATH, content: 'export const x = 1;' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_write', is_error: false, content: 'ok' },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, permission_denials: [] }),
    ].join('\n');

    const streamInvoker: ConventionInvoker = async (_prompt, _filePath, environment) =>
      agentOutputFromStream(parseClaudeStreamJson(stream, environment.repoRoot), '');

    const result = await runConventionTrial({
      ...BASE_INPUT,
      condition: 'enforcing-notfixes',
      agent: { laneId: 'test', model: 'test-model', invoker: streamInvoker },
    });
    try {
      // A trial that saw no hook events is recorded as having seen none —
      // never as an arm that enforced.
      expect(result.sawHookEvents).toBe(false);
      expect(result.hookEvents).toEqual({ allowed: 0, denied: 0, advisory: 0 });
      expect(result.denials).toBe(0);
    } finally {
      await removeTrialDirs(result);
    }
  });
});

describe('the live invoker', () => {
  it('produces an invoker function for the runner to hand to a convention trial', () => {
    // The factory is all a unit test can reach: calling the returned invoker
    // spawns a real agent, which only the runner may do.
    expect(typeof createConventionInvoker({ model: 'test-model' })).toBe('function');
  });
});
