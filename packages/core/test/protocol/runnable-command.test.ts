import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toRunnableCommand } from '../../src/protocol/agent.js';

const isWindows = process.platform === 'win32';

async function makeEntry(name: string, mode: number): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cyv-runnable-')));
  const entry = join(dir, name);
  await writeFile(entry, '#!/usr/bin/env node\n');
  await chmod(entry, mode);
  return entry;
}

describe('toRunnableCommand', () => {
  it('leaves a bare command alone', () => {
    expect(toRunnableCommand('cyv')).toBe('cyv');
  });

  // The command is written into an agent's hook config and read back much
  // later. `process.execPath` is the absolute, realpathed location of the Node
  // running `init`, so a version-managed install records a path containing a
  // version number and the hook breaks at the next upgrade. An executable entry
  // carries a shebang and resolves Node from PATH when the hook runs instead.
  it.skipIf(isWindows)('runs an executable entry directly, naming no interpreter', async () => {
    const entry = await makeEntry('index.js', 0o755);
    expect(toRunnableCommand(entry)).toBe(entry);
  });

  it.skipIf(isWindows)('names the current interpreter for an entry that is not executable', async () => {
    const entry = await makeEntry('index.js', 0o644);
    expect(toRunnableCommand(entry)).toBe(`${process.execPath} ${entry}`);
  });

  // A shebang is not consulted on Windows, so the interpreter has to be named
  // there whatever the mode bits say.
  it.skipIf(!isWindows)('names the interpreter on Windows', async () => {
    const entry = await makeEntry('index.js', 0o755);
    expect(toRunnableCommand(entry)).toBe(`"${process.execPath}" "${entry}"`);
  });

  it('names the interpreter for a target that does not exist', () => {
    const missing = join(tmpdir(), 'cyv-does-not-exist', 'index.js');
    expect(toRunnableCommand(missing)).toContain(process.execPath);
  });

  it('quotes a path containing a space', () => {
    const spaced = join(tmpdir(), 'cyv does not exist', 'index.js');
    expect(toRunnableCommand(spaced)).toContain(`"${spaced}"`);
  });
});
