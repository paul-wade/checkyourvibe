import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FILENAME,
  ConfigError,
  configuredLanes,
  laneConfigNotice,
  laneConfigProblem,
  loadConfig,
  meteredLanesEnabled,
  type CheckYourVibeConfig,
} from '../../src/config/index.js';
import {
  type LaneDeclaration,
  type LaneExecutionMode,
  type ResolvedLaneDeclaration,
} from '../../src/executor/lane.js';
import { TASK_KINDS } from '../../src/executor/task-kind.js';

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-lanes-'));
  await mkdir(join(dir, '.git'));
  const schemaUrl = new URL('../../../../docs/protocol/config.schema.json', import.meta.url);
  const schemaDir = join(dir, 'docs', 'protocol');
  await mkdir(schemaDir, { recursive: true });
  await writeFile(join(schemaDir, 'config.schema.json'), await readFile(schemaUrl, 'utf-8'));
  return dir;
}

async function writeConfig(repoRoot: string, content: unknown): Promise<void> {
  await writeFile(join(repoRoot, CONFIG_FILENAME), JSON.stringify(content, null, 2));
}

function assertConfigError(err: unknown): asserts err is ConfigError {
  expect(err).toBeInstanceOf(ConfigError);
  if (!(err instanceof ConfigError)) {
    throw err;
  }
}

/** Load `content` from a throwaway repository and return the message it was rejected with. */
async function rejectionMessage(content: unknown): Promise<string> {
  const repo = await makeTempRepo();
  try {
    await writeConfig(repo, content);
    try {
      await loadConfig(repo);
    } catch (err) {
      assertConfigError(err);
      expect(err.code).toBe('INVALID');
      return err.message;
    }
    throw new Error('loadConfig should have rejected this configuration');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function loadFrom(content: unknown): Promise<CheckYourVibeConfig> {
  const repo = await makeTempRepo();
  try {
    await writeConfig(repo, content);
    return await loadConfig(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

const claudeLane = {
  id: 'claude-code',
  agentId: 'claude-code',
  concurrencyCap: 2,
  orchestrator: true,
  billing: { kind: 'subscription' },
  models: [
    { kind: 'mechanical-transformation', ordering: ['opus-4', 'sonnet-4', 'haiku-4'] },
    { kind: 'judgment-required', ordering: ['opus-4', 'sonnet-4'] },
  ],
};

const codexLane = {
  id: 'codex',
  agentId: 'codex',
  concurrencyCap: 1,
  billing: { kind: 'subscription' },
  models: [{ kind: 'mechanical-transformation', ordering: ['gpt-5-codex', 'gpt-5-codex-mini'] }],
};

const meteredLane = {
  id: 'codex-api',
  agentId: 'codex',
  concurrencyCap: 1,
  billing: { kind: 'metered', permitsBilledOverage: true },
  models: [{ kind: 'judgment-required', ordering: ['gpt-5-pro', 'gpt-5'] }],
};

describe('lane declarations in checkyourvibe.json', () => {
  it('loads declared lanes with their caps, billing and per-kind orderings intact', async () => {
    const config = await loadFrom({
      executor: {
        lanes: [claudeLane, codexLane, meteredLane],
        meteredLanesEnabled: ['codex-api'],
      },
    });

    const lanes = configuredLanes(config);
    expect(lanes.map((lane) => lane.id)).toEqual(['claude-code', 'codex', 'codex-api']);

    const claude = lanes.find((lane) => lane.id === 'claude-code');
    expect(claude?.concurrencyCap).toBe(2);
    expect(claude?.orchestrator).toBe(true);
    expect(claude?.billing).toEqual({ kind: 'subscription', permitsBilledOverage: false });
    expect(claude?.models.find((m) => m.kind === 'judgment-required')?.ordering).toEqual([
      'opus-4',
      'sonnet-4',
    ]);

    const metered = lanes.find((lane) => lane.id === 'codex-api');
    expect(metered?.billing).toEqual({ kind: 'metered', permitsBilledOverage: true });
    expect(meteredLanesEnabled(config)).toEqual(['codex-api']);
  });

  it('leaves a lane ordering in the order it was written', async () => {
    const config = await loadFrom({ executor: { lanes: [codexLane] } });
    const ordering = configuredLanes(config)[0]?.models[0]?.ordering;
    expect(ordering).toEqual(['gpt-5-codex', 'gpt-5-codex-mini']);
  });

  it('defaults orchestrator and permitsBilledOverage rather than leaving them absent', async () => {
    const config = await loadFrom({ executor: { lanes: [codexLane] } });
    const lane = configuredLanes(config)[0];
    expect(lane?.orchestrator).toBe(false);
    expect(lane?.billing.permitsBilledOverage).toBe(false);
  });

  it('treats a config with no executor key as declaring no lanes', async () => {
    const config = await loadFrom({ packs: ['core-ts'] });
    expect(config.executor).toBeUndefined();
    expect(configuredLanes(config)).toEqual([]);
    expect(meteredLanesEnabled(config)).toEqual([]);
  });

  it('accepts an ordering for every task kind the core defines', async () => {
    for (const kind of TASK_KINDS) {
      const config = await loadFrom({
        executor: {
          lanes: [{ ...codexLane, models: [{ kind, ordering: ['only-model'] }] }],
        },
      });
      expect(configuredLanes(config)[0]?.models[0]?.kind).toBe(kind);
    }
  });
});

describe('rejecting a malformed lane declaration', () => {
  it('names concurrencyCap when it is not a number', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [{ ...codexLane, concurrencyCap: 'as many as it can take' }] },
    });
    expect(message).toContain('/executor/lanes/0/concurrencyCap');
    expect(message).toMatch(/integer/);
  });

  it('names concurrencyCap when it is zero', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [{ ...codexLane, concurrencyCap: 0 }] },
    });
    expect(message).toContain('/executor/lanes/0/concurrencyCap');
  });

  it('names models when a lane declares none', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [{ ...codexLane, models: [] }] },
    });
    expect(message).toContain('/executor/lanes/0/models');
  });

  it('names the ordering when it is empty', async () => {
    const message = await rejectionMessage({
      executor: {
        lanes: [{ ...codexLane, models: [{ kind: 'judgment-required', ordering: [] }] }],
      },
    });
    expect(message).toContain('/executor/lanes/0/models/0/ordering');
  });

  it('names the task kind when it is not one the core defines', async () => {
    const message = await rejectionMessage({
      executor: {
        lanes: [{ ...codexLane, models: [{ kind: 'refactoring', ordering: ['a'] }] }],
      },
    });
    expect(message).toContain('/executor/lanes/0/models/0/kind');
  });

  it('names a lane id declared twice', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [codexLane, { ...codexLane, concurrencyCap: 3 }] },
    });
    expect(message).toContain('/executor/lanes/1/id');
    expect(message).toContain('"codex"');
  });

  it('names the second lane marked as the orchestrator', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [claudeLane, { ...codexLane, orchestrator: true }] },
    });
    expect(message).toContain('/executor/lanes/1/orchestrator');
  });

  it('names the duplicated task kind within one lane', async () => {
    const message = await rejectionMessage({
      executor: {
        lanes: [
          {
            ...codexLane,
            models: [
              { kind: 'judgment-required', ordering: ['a'] },
              { kind: 'judgment-required', ordering: ['b'] },
            ],
          },
        ],
      },
    });
    expect(message).toContain('/executor/lanes/0/models/1/kind');
  });
});

describe('opting into a metered lane by name', () => {
  it('rejects a metered lane that is not named in meteredLanesEnabled', async () => {
    const message = await rejectionMessage({ executor: { lanes: [codexLane, meteredLane] } });
    expect(message).toContain('/executor/lanes/1/billing/kind');
    expect(message).toContain('executor.meteredLanesEnabled');
    expect(message).toContain('billed per use');
  });

  it('still rejects it when another metered lane is named', async () => {
    const message = await rejectionMessage({
      executor: {
        lanes: [meteredLane, { ...meteredLane, id: 'gemini-api' }],
        meteredLanesEnabled: ['codex-api'],
      },
    });
    expect(message).toContain('/executor/lanes/1/billing/kind');
    expect(message).toContain('"gemini-api"');
  });

  it('rejects an opt-in naming a lane that is not declared', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [codexLane], meteredLanesEnabled: ['codex-api'] },
    });
    expect(message).toContain('/executor/meteredLanesEnabled/0');
    expect(message).toContain('"codex-api"');
  });

  it('rejects an opt-in naming a lane that is not metered', async () => {
    const message = await rejectionMessage({
      executor: { lanes: [codexLane], meteredLanesEnabled: ['codex'] },
    });
    expect(message).toContain('/executor/meteredLanesEnabled/0');
    expect(message).toContain('subscription');
  });

  it('reports the same problems from laneConfigProblem without touching disk', () => {
    const problem = laneConfigProblem({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: {
        lanes: [
          {
            id: 'codex-api',
            agentId: 'codex',
            concurrencyCap: 1,
            orchestrator: false,
            billing: { kind: 'metered', permitsBilledOverage: false },
            models: [{ kind: 'judgment-required', ordering: ['gpt-5'] }],
          },
        ],
      },
    });
    expect(problem).toContain('executor.meteredLanesEnabled');
  });

  it('finds no problem in a repository that declares no lanes', () => {
    const problem = laneConfigProblem({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
    });
    expect(problem).toBeUndefined();
  });
});

describe('resolving acceptsDispatch (spec 0036 Requirements 1.1, 1.2)', () => {
  function laneWith(overrides: {
    id: string;
    orchestrator: boolean;
    acceptsDispatch?: boolean;
  }): LaneDeclaration {
    return {
      id: overrides.id,
      agentId: 'test',
      concurrencyCap: 1,
      orchestrator: overrides.orchestrator,
      billing: { kind: 'subscription', permitsBilledOverage: false },
      models: [],
      ...(overrides.acceptsDispatch === undefined
        ? {}
        : { acceptsDispatch: overrides.acceptsDispatch }),
    };
  }

  function resolveAll(lanes: LaneDeclaration[]): readonly ResolvedLaneDeclaration[] {
    return configuredLanes({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: { lanes },
    });
  }

  function resolveFor(lane: LaneDeclaration): boolean | undefined {
    return resolveAll([lane])[0]?.acceptsDispatch;
  }

  it('resolves to true for a lane that is not the orchestrator and omits acceptsDispatch', () => {
    expect(resolveFor(laneWith({ id: 'worker', orchestrator: false }))).toBe(true);
  });

  it('resolves to false for the orchestrator when another lane is declared', () => {
    const lanes = resolveAll([
      laneWith({ id: 'session', orchestrator: true }),
      laneWith({ id: 'worker', orchestrator: false }),
    ]);
    expect(lanes[0]?.acceptsDispatch).toBe(false);
  });

  it('keeps an explicit acceptsDispatch: true on the orchestrator', () => {
    expect(
      resolveFor(laneWith({ id: 'session', orchestrator: true, acceptsDispatch: true })),
    ).toBe(true);
  });

  it('keeps an explicit acceptsDispatch: false on a non-orchestrator', () => {
    expect(
      resolveFor(laneWith({ id: 'worker', orchestrator: false, acceptsDispatch: false })),
    ).toBe(false);
  });

  it('does not mutate the lane it was given', () => {
    const lane = laneWith({ id: 'session', orchestrator: true });
    configuredLanes({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: { lanes: [lane] },
    });
    expect(lane.acceptsDispatch).toBeUndefined();
  });
});

describe('the one-lane defaults (spec 0041 Requirement 2.2)', () => {
  function laneWith(overrides: {
    id: string;
    orchestrator: boolean;
    acceptsDispatch?: boolean;
    executes?: LaneExecutionMode;
  }): LaneDeclaration {
    return {
      id: overrides.id,
      agentId: 'test',
      concurrencyCap: 1,
      orchestrator: overrides.orchestrator,
      billing: { kind: 'subscription', permitsBilledOverage: false },
      models: [],
      ...(overrides.acceptsDispatch === undefined
        ? {}
        : { acceptsDispatch: overrides.acceptsDispatch }),
      ...(overrides.executes === undefined ? {} : { executes: overrides.executes }),
    };
  }

  function resolveAll(lanes: LaneDeclaration[]): readonly ResolvedLaneDeclaration[] {
    return configuredLanes({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: { lanes },
    });
  }

  it('lets the sole orchestrating lane accept dispatched work', () => {
    const lanes = resolveAll([laneWith({ id: 'session', orchestrator: true })]);
    expect(lanes[0]?.acceptsDispatch).toBe(true);
  });

  it('executes the sole orchestrating lane as a sub-agent', () => {
    const lanes = resolveAll([laneWith({ id: 'session', orchestrator: true })]);
    expect(lanes[0]?.executes).toBe('subagent');
  });

  it('keeps the 0036 reservation as soon as a second lane exists', () => {
    const lanes = resolveAll([
      laneWith({ id: 'session', orchestrator: true }),
      laneWith({ id: 'worker', orchestrator: false }),
    ]);
    expect(lanes[0]?.acceptsDispatch).toBe(false);
    expect(lanes[0]?.executes).toBe('cli');
  });

  it('defaults a lane that is not the orchestrator to cli, alone or not', () => {
    expect(resolveAll([laneWith({ id: 'worker', orchestrator: false })])[0]?.executes).toBe('cli');
  });

  it('keeps an explicit executes on the sole orchestrating lane', () => {
    const lanes = resolveAll([
      laneWith({ id: 'session', orchestrator: true, executes: 'cli' }),
    ]);
    expect(lanes[0]?.executes).toBe('cli');
  });

  it('keeps an explicit acceptsDispatch: false on the sole orchestrating lane', () => {
    const lanes = resolveAll([
      laneWith({ id: 'session', orchestrator: true, acceptsDispatch: false }),
    ]);
    expect(lanes[0]?.acceptsDispatch).toBe(false);
  });

  it('does not mutate the lane it was given', () => {
    const lane = laneWith({ id: 'session', orchestrator: true });
    resolveAll([lane]);
    expect(lane.acceptsDispatch).toBeUndefined();
    expect(lane.executes).toBeUndefined();
  });
});

describe('laneConfigNotice (spec 0036 Requirement 1.3)', () => {
  function noticeFor(overrides: {
    id: string;
    orchestrator: boolean;
    acceptsDispatch?: boolean;
  }): string | undefined {
    return laneConfigNotice({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: {
        lanes: [
          {
            id: overrides.id,
            agentId: 'test',
            concurrencyCap: 1,
            orchestrator: overrides.orchestrator,
            billing: { kind: 'subscription', permitsBilledOverage: false },
            models: [],
            ...(overrides.acceptsDispatch === undefined
              ? {}
              : { acceptsDispatch: overrides.acceptsDispatch }),
          },
        ],
      },
    });
  }

  function noticeForLanes(lanes: LaneDeclaration[]): string | undefined {
    return laneConfigNotice({
      packs: [],
      analyzers: [],
      rules: {},
      strict: false,
      exclude: [],
      executor: { lanes },
    });
  }

  function plainLane(id: string, orchestrator: boolean): LaneDeclaration {
    return {
      id,
      agentId: 'test',
      concurrencyCap: 1,
      orchestrator,
      billing: { kind: 'subscription', permitsBilledOverage: false },
      models: [],
    };
  }

  it('says nothing about a lane that is not the orchestrator', () => {
    expect(noticeFor({ id: 'worker', orchestrator: false })).toBeUndefined();
    expect(noticeFor({ id: 'worker', orchestrator: false, acceptsDispatch: false })).toBeUndefined();
  });

  it('says nothing when the orchestrator is reserved beside another lane', () => {
    expect(
      noticeForLanes([plainLane('session', true), plainLane('worker', false)]),
    ).toBeUndefined();
  });

  it('quotes the field when the orchestrator explicitly accepts dispatches', () => {
    const notice = noticeForLanes([
      { ...plainLane('session', true), acceptsDispatch: true },
      plainLane('worker', false),
    ]);
    expect(notice).toContain('session');
    expect(notice).toContain('declares acceptsDispatch: true');
  });

  it('states the cost without quoting a field the sole orchestrating lane never wrote', () => {
    const notice = noticeFor({ id: 'session', orchestrator: true });
    expect(notice).toContain('session');
    expect(notice).toContain('the only lane declared');
    expect(notice).not.toContain('declares acceptsDispatch: true');
  });
});
