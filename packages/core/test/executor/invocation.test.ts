import { describe, expect, it } from 'vitest';

import {
  AGENT_COMMANDS,
  agentCommandFor,
  knownAgentIds,
  type ExecutorInvocation,
} from '../../src/executor/invocation.js';
import type { ChildObservation } from '../../src/executor/child.js';

const invocation: ExecutorInvocation = {
  cwd: '/repo',
  model: 'a-model-name',
  promptPath: '/repo/.cyv-review/dispatch-prompts/w1.md',
  prompt: 'rename the symbol & report "what" you did\nsecond line',
};

function observation(overrides: Partial<ChildObservation> = {}): ChildObservation {
  return { timedOut: false, stdout: '', stderr: '', ...overrides };
}

describe('the agent command mapping', () => {
  it('gives every entry a distinct agent id', () => {
    expect(new Set(knownAgentIds()).size).toBe(AGENT_COMMANDS.length);
  });

  it('looks an entry up by the agent id a lane declares', () => {
    expect(agentCommandFor('antigravity')?.program).toBe('agy');
    expect(agentCommandFor('codex')?.program).toBe('codex');
    expect(agentCommandFor('claude-code')?.program).toBe('claude');
    expect(agentCommandFor('devin')?.program).toBe('devin');
    expect(agentCommandFor('gemini')?.program).toBe('gemini');
  });

  it('has nothing for an agent it does not know', () => {
    expect(agentCommandFor('an-agent-nobody-wrote')).toBeUndefined();
  });

  it('passes the model through verbatim, without translating or ranking it', () => {
    for (const spec of AGENT_COMMANDS) {
      expect(spec.build(invocation).args).toContain('a-model-name');
    }
  });

  it('keeps the prompt out of the argument list', () => {
    for (const spec of AGENT_COMMANDS) {
      const launch = spec.build(invocation);
      for (const arg of launch.args) {
        expect(arg.includes(invocation.prompt)).toBe(false);
      }
    }
  });

  // An entry either hands the prompt over on standard input or names the file
  // the core wrote. A CLI whose headless flag takes the prompt as its value
  // names that file inside the flag's value, so the file is looked for across
  // each argument rather than as an argument of its own.
  it('sends the prompt either on standard input or in the file the core wrote', () => {
    for (const spec of AGENT_COMMANDS) {
      const launch = spec.build(invocation);
      const viaStdin = launch.stdin === invocation.prompt;
      const viaFile = launch.args.some((arg) => arg.includes(invocation.promptPath));
      expect(viaStdin || viaFile).toBe(true);
    }
  });

  it('reports no rate limit for output that mentions none', () => {
    for (const spec of AGENT_COMMANDS) {
      expect(spec.detectsRateLimit(observation({ stdout: 'done, wrote one file' }))).toBe(false);
    }
  });

  it('reports a rate limit from either stream, whatever the casing', () => {
    for (const spec of AGENT_COMMANDS) {
      expect(spec.detectsRateLimit(observation({ stderr: 'Error: Rate Limit reached' }))).toBe(true);
      expect(spec.detectsRateLimit(observation({ stdout: 'HTTP 429' }))).toBe(true);
    }
  });

  // Observed from `agy` on 2026-09-08. It matched none of the phrases, so two
  // dispatches into an exhausted lane closed as ordinary failures and the lane
  // was never marked as out of quota.
  it('recognises a quota message that says "reached" rather than "exceeded"', () => {
    const message =
      'Error: Individual quota reached. Please upgrade your subscription to ' +
      'increase your limits. Resets in 25m25s.';

    for (const spec of AGENT_COMMANDS) {
      expect(spec.detectsRateLimit(observation({ stderr: message }))).toBe(true);
    }
  });
});

describe("each agent's non-interactive invocation", () => {
  it("gives antigravity's print flag a directive naming the prompt file", () => {
    const launch = agentCommandFor('antigravity')?.build(invocation);
    const printFlag = launch?.args.indexOf('--print') ?? -1;
    expect(printFlag).toBeGreaterThan(-1);
    expect(launch?.args[printFlag + 1]).toBe(
      `Read the file ${invocation.promptPath} and carry out the instructions it contains.`,
    );
    expect(launch?.args).toContain('--dangerously-skip-permissions');
    expect(launch?.stdin).toBeUndefined();
  });

  // Every antigravity dispatch this repository ran ended at five minutes with
  // "timeout waiting for response", whatever deadline the dispatch declared,
  // because the CLI's own `--print-timeout` defaults to five minutes and was
  // never passed.
  it("bounds antigravity's own wait by the dispatch's deadline", () => {
    const launch = agentCommandFor('antigravity')?.build({ ...invocation, timeoutMs: 3_000_000 });
    const at = launch?.args.indexOf('--print-timeout') ?? -1;

    expect(at).toBeGreaterThan(-1);
    // Below the deadline, so the CLI reaches its own timeout and exits with
    // what it has rather than being killed mid-write.
    expect(launch?.args[at + 1]).toBe('2700s');
  });

  it('leaves antigravity to its own default when the dispatch names no deadline', () => {
    const launch = agentCommandFor('antigravity')?.build(invocation);

    expect(launch?.args).not.toContain('--print-timeout');
  });

  it('asks codex for one run that ends by itself, reading its prompt from stdin', () => {
    const launch = agentCommandFor('codex')?.build(invocation);
    expect(launch?.args.slice(0, 4)).toEqual(['exec', '--model', 'a-model-name', '--sandbox']);
    expect(launch?.args).toContain('-');
    expect(launch?.stdin).toBe(invocation.prompt);
  });

  it('asks claude to print and exit rather than open a session', () => {
    const launch = agentCommandFor('claude-code')?.build(invocation);
    expect(launch?.args).toContain('-p');
    expect(launch?.stdin).toBe(invocation.prompt);
  });

  it('hands devin the prompt file rather than standard input', () => {
    const launch = agentCommandFor('devin')?.build(invocation);
    expect(launch?.args).toContain('--prompt-file');
    expect(launch?.args).toContain(invocation.promptPath);
    expect(launch?.stdin).toBeUndefined();
  });

  it("gives gemini's headless flag a fixed value and the prompt on stdin", () => {
    const launch = agentCommandFor('gemini')?.build(invocation);
    const promptFlag = launch?.args.indexOf('-p') ?? -1;
    expect(promptFlag).toBeGreaterThan(-1);
    expect(launch?.args[promptFlag + 1]).toBe('Carry out the instructions supplied on standard input.');
    expect(launch?.stdin).toBe(invocation.prompt);
  });
});
