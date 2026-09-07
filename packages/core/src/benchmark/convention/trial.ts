/**
 * @file packages/core/src/benchmark/convention/trial.ts
 *
 * One convention trial for one arm.
 *
 * The fixture is a generated service repository. The agent's task is to add a
 * test for a named service. The repository's convention is visible in
 * neighbours; the file the agent must write is absent, so the convention is
 * discoverable but not demonstrated at the exact target. Scoring reads the
 * written file and answers whether the convention was followed.
 *
 * The environment setup delegates entirely to `armSettings` and
 * `makeTrialConfigDir` from the harness — the same code a fixture trial uses —
 * so a convention trial's `.claude/settings.json` is byte-identical to a
 * fixture trial's for the same arm.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  armSettings,
  makeTrialConfigDir,
  type AgentExecutorConfig,
  type AgentTrialOutput,
  type BenchmarkCondition,
  type HookEventCounts,
  type TrialEnvironment,
} from '../harness.js';
import { checkDi } from './check-di.js';
import { generateRepo, type GeneratorOptions } from './generator.js';

const execFileAsync = promisify(execFile);

/** The task text sent to the agent. Never names the convention. */
function conventionTaskText(feature: string): string {
  return (
    `Add a unit test for the ${feature} service covering the case where the id is not found.`
  );
}

/**
 * The inputs that define one convention trial for one arm. Everything that
 * varies between trials or arms belongs here; nothing that would hint at the
 * expected convention may appear in the task text or in extra files.
 */
export interface ConventionTrialInput {
  /** The arm to run this trial under. */
  condition: BenchmarkCondition;
  /** Options for the repository generator (module count, legacy count, placement). */
  generator: GeneratorOptions;
  /**
   * The feature whose test file is deleted so the agent must write it.
   * Must name one of the features the generator will produce at the given
   * options; the trial throws if the generated repo has no such module.
   */
  targetFeature: string;
  /** The agent runner — injected so live tests can use a real agent and unit tests can use a stub. */
  agent: AgentExecutorConfig;
  /** Maximum turns the agent is allowed. Defaults to 5. */
  maxTurns?: number;
  /**
   * The `cyv` command the arm's hook entries invoke. Defaults to `cyv`,
   * resolved from the agent's PATH.
   */
  cyvCommand?: string;
}

/** Three-way outcome of one convention trial. */
export interface ConventionOutcome {
  /** Whether the agent wrote the test file at all. */
  wrote: boolean;
  /** Whether it resolved through the container (the convention). */
  followed: boolean;
  /** Whether it constructed the subject directly (bypassing the convention). */
  bypassed: boolean;
  /** Human-readable diagnosis. */
  why: string;
}

/** The full record of one convention trial. */
export interface ConventionTrialResult {
  arm: BenchmarkCondition;
  /** The feature the agent was asked to write a test for. */
  targetFeature: string;
  /** Generator options that produced the repository. */
  generator: GeneratorOptions;
  /** What the agent wrote — or did not write. */
  outcome: ConventionOutcome;
  /**
   * A pass is `followed && !bypassed`: the agent discovered and followed the
   * repository's convention without being told which way was right.
   */
  passed: boolean;
  turnsTaken: number;
  sawHookEvents: boolean;
  hookEvents: HookEventCounts;
  /**
   * How many tool calls the arm's gate denied. The headline for this condition:
   * a run where it never fired says the arms did not differ, whatever the pass
   * rates look like.
   */
  denials: number;
  /** Tokens billed by the runtime, when reported. */
  tokens?: AgentTrialOutput['tokens'];
  /** What the runtime said this trial cost, in US dollars. */
  costUsd?: number;
  /**
   * Absolute path to the scratch repository, for post-hoc inspection.
   * The trial does not remove it; the caller owns that decision.
   */
  repoRoot: string;
  /** Absolute path to the trial's configuration directory (no credentials). */
  configDir: string;
}

/**
 * Materialise the generated repository as real files on disk inside `repoRoot`.
 * Initialises a git repository so `cyv hook` can resolve it through
 * `git rev-parse`.
 */
async function materializeRepo(
  repoRoot: string,
  generatedFiles: ReadonlyMap<string, string>,
): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot });
  for (const [relativePath, contents] of generatedFiles) {
    const target = join(repoRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf-8');
  }
}

/**
 * Run one convention trial for one arm.
 *
 * Steps:
 * 1. Generate the repository as a file map.
 * 2. Materialise it into a scratch directory.
 * 3. Delete the target module's test file so the agent must write it from
 *    scratch, with the convention visible only in neighbours.
 * 4. Write the arm's `.claude/settings.json` using the same machinery as a
 *    fixture trial.
 * 5. Invoke the agent with the task text — naming the target, not the
 *    convention (requirement 2.3).
 * 6. Score with `checkDi`.
 * 7. Return the result.
 *
 * The scratch repository is not removed; the caller decides whether to keep it
 * as evidence or clean up.
 */
export async function runConventionTrial(
  input: ConventionTrialInput,
): Promise<ConventionTrialResult> {
  const { condition, generator, targetFeature, agent, cyvCommand = 'cyv' } = input;
  const maxTurns = input.maxTurns ?? 5;

  const generatedFiles = generateRepo(generator);

  const targetTestPath = `test/${targetFeature}.service.test.ts`;
  if (!generatedFiles.has(targetTestPath)) {
    throw new Error(
      `generateRepo produced no test file at "${targetTestPath}" — ` +
        `check that "${targetFeature}" is a valid feature for the given generator options`,
    );
  }

  // Scratch directories: the repository and the agent's config directory.
  const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'cyv-conv-')));
  let configDir: string | undefined;

  try {
    await materializeRepo(repoRoot, generatedFiles);

    // Delete the target's test file: the agent must discover the convention
    // from the neighbours that do have it, not from the file it is about to
    // write.
    const absoluteTestPath = join(repoRoot, targetTestPath);
    await unlink(absoluteTestPath);

    const settingsPath = join(repoRoot, '.claude', 'settings.json');
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(armSettings(condition, cyvCommand), null, 2),
      'utf-8',
    );

    const defaultCyvConfig: Record<string, unknown> = { analyzers: [], rules: {} };
    await writeFile(
      join(repoRoot, 'checkyourvibe.json'),
      JSON.stringify(defaultCyvConfig, null, 2),
      'utf-8',
    );

    configDir = await makeTrialConfigDir();

    const environment: TrialEnvironment = {
      arm: condition,
      repoRoot,
      // The "fixture path" for a convention trial is the test file the agent
      // must write. It does not exist yet, but the environment shape requires a
      // path — the invoker receives it as the file to write.
      fixturePath: absoluteTestPath,
      settingsPath,
      configPath: join(repoRoot, 'checkyourvibe.json'),
      configDir,
      permissionMode: 'acceptEdits',
    };

    const taskText = conventionTaskText(targetFeature);
    const invokerFn = agent.invoker;

    let agentOutput: AgentTrialOutput;
    if (invokerFn !== undefined) {
      try {
        agentOutput = await invokerFn(taskText, absoluteTestPath, environment);
      } catch (err) {
        // Remove scratch directories on invoker failure — same pattern as the
        // harness's `invokeOrClean`.
        await rm(repoRoot, { recursive: true, force: true });
        await rm(configDir, { recursive: true, force: true });
        configDir = undefined;
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `convention trial invoker failed in arm ${condition} for feature ${targetFeature}: ${detail}`,
          { cause: err },
        );
      }
    } else {
      // No invoker — score the repository as the generator left it (test file
      // absent), which lets the harness produce a baseline result without a live
      // agent.
      agentOutput = { code: '', turns: 1 };
    }

    if (agentOutput.permissionMode === 'bypassPermissions') {
      throw new Error(
        `convention trial (${condition}) for ${targetFeature} ran under ` +
          '--permission-mode bypassPermissions, which never fires PreToolUse hooks. ' +
          'The run is void and is rejected rather than reported.',
      );
    }

    const diResult = checkDi(repoRoot, targetFeature);
    const passed = diResult.followed && !diResult.bypassed;

    const turnsTaken = Math.min(Math.max(1, agentOutput.turns), maxTurns);
    const sawHookEvents = agentOutput.sawHookEvents ?? false;
    const hookEvents = agentOutput.hookEvents ?? { allowed: 0, denied: 0, advisory: 0 };

    // Count gate denials from the transcript.
    const transcript = agentOutput.transcript ?? [];
    const denials = transcript.filter(
      (event) => event.outcome === 'denied' && event.rules !== undefined,
    ).length;

    const result: ConventionTrialResult = {
      arm: condition,
      targetFeature,
      generator,
      outcome: {
        wrote: diResult.wrote,
        followed: diResult.followed,
        bypassed: diResult.bypassed,
        why: diResult.why,
      },
      passed,
      turnsTaken,
      sawHookEvents,
      hookEvents,
      denials,
      repoRoot,
      configDir: configDir ?? '',
    };

    if (agentOutput.tokens !== undefined) {
      result.tokens = agentOutput.tokens;
    }
    if (agentOutput.costUsd !== undefined) {
      result.costUsd = agentOutput.costUsd;
    }

    return result;
  } catch (err) {
    // Remove the scratch directories if setup failed before the invoker ran.
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
    if (configDir !== undefined) {
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}
