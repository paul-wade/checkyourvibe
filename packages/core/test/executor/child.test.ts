import { describe, expect, it } from 'vitest';

import {
  capturedOutput,
  CAPTURED_STREAM_MAX_LENGTH,
  reportFromObservation,
  runChild,
} from '../../src/executor/child.js';
import type { ChildObservation } from '../../src/executor/child.js';

const READ_STDIN = 'process.stdin.on("data",(c)=>process.stdout.write(c));';

describe('runChild standard input', () => {
  it('writes the supplied text to the child and closes the stream', async () => {
    const observation = await runChild({
      command: process.execPath,
      args: ['-e', READ_STDIN],
      stdin: 'the prompt, with "quotes" & an ampersand\nand a second line',
    });

    expect(observation.exitCode).toBe(0);
    expect(observation.stdout).toBe('the prompt, with "quotes" & an ampersand\nand a second line');
  });

  it('leaves standard input closed when no text is supplied', async () => {
    const observation = await runChild({
      command: process.execPath,
      args: ['-e', READ_STDIN],
    });

    expect(observation.exitCode).toBe(0);
    expect(observation.stdout).toBe('');
  });

  it('records the child ending rather than raising when it never reads its input', async () => {
    const observation = await runChild({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      stdin: 'x'.repeat(200_000),
    });

    expect(observation.exitCode).toBe(7);
    expect(observation.spawnError).toBeUndefined();
  });
});

function observation(
  stdout: string,
  stderr: string,
  extras: Partial<Omit<ChildObservation, 'stdout' | 'stderr'>> = {},
): ChildObservation {
  return { stdout, stderr, timedOut: false, ...extras };
}

describe('captured output', () => {
  it('carries stdout and stderr the child wrote', () => {
    const report = reportFromObservation(observation('out text', 'err text'));
    expect(report.output).toEqual({ stdout: 'out text', stderr: 'err text' });
  });

  it('truncates a long stream at its tail and records the original length', () => {
    const long = 'x'.repeat(CAPTURED_STREAM_MAX_LENGTH + 123);
    const output = capturedOutput(observation('short', long));
    expect(output).toBeDefined();
    expect(output?.stderr).toBe(long.slice(long.length - CAPTURED_STREAM_MAX_LENGTH));
    expect(output?.truncatedFrom?.stderr).toBe(long.length);
  });

  it('produces no output field when the child wrote to neither stream', () => {
    const output = capturedOutput(observation('', ''));
    expect(output).toBeUndefined();

    const report = reportFromObservation(observation('', '', { exitCode: 0 }));
    expect(report.output).toBeUndefined();
  });
});
