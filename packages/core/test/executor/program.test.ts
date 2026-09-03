import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { findProgram, launchArguments, launcherFor, pathExtensions } from '../../src/executor/program.js';

const isWindows = process.platform === 'win32';

describe('pathExtensions', () => {
  it('reads PATHEXT on Windows and offers a bare name elsewhere', () => {
    const extensions = pathExtensions({ PATHEXT: '.COM;.EXE;.CMD' });
    expect(extensions).toEqual(isWindows ? ['.COM', '.EXE', '.CMD'] : ['']);
  });

  // PATHEXT is only read on Windows; elsewhere `pathExtensions` returns a single
  // empty suffix, meaning "try the bare name". Asserting `includes('') === false`
  // unconditionally therefore failed everywhere but Windows, which is why this
  // is written the same platform-aware way as the test above.
  it('drops empty entries left by a trailing separator', () => {
    const extensions = pathExtensions({ PATHEXT: '.EXE;;.CMD;' });
    expect(extensions).toEqual(isWindows ? ['.EXE', '.CMD'] : ['']);
  });
});

describe('launchArguments', () => {
  it('passes a plain executable its arguments as they are', () => {
    const launcher = launcherFor('/usr/bin/codex', {});
    expect(launchArguments(launcher, ['exec', '--model', 'm'])).toEqual({
      args: ['exec', '--model', 'm'],
      windowsVerbatimArguments: false,
    });
  });

  it('hands the interpreter one quoted command line, so a shim under a spaced path still runs', () => {
    const launcher = launcherFor('C:\\Program Files\\nodejs\\npx.CMD', { ComSpec: 'C:\\WINDOWS\\cmd.exe' });
    const launch = launchArguments(launcher, ['vitest', 'run', 'a b.test.ts']);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"\"C:\\Program Files\\nodejs\\npx.CMD\" vitest run \"a b.test.ts\""',
    ]);
  });
});

describe('launcherFor', () => {
  it('spawns an ordinary program as itself', () => {
    const launcher = launcherFor('/usr/bin/codex', {});
    expect(launcher).toEqual({ command: '/usr/bin/codex', prefixArgs: [], path: '/usr/bin/codex' });
  });

  it('runs a batch shim through the command interpreter', () => {
    const launcher = launcherFor('C:\\npm\\codex.CMD', { ComSpec: 'C:\\WINDOWS\\cmd.exe' });
    expect(launcher.command).toBe('C:\\WINDOWS\\cmd.exe');
    expect(launcher.prefixArgs).toEqual(['/d', '/s', '/c', 'C:\\npm\\codex.CMD']);
  });

  it('falls back to cmd.exe when ComSpec is unset', () => {
    expect(launcherFor('x.bat', {}).command).toBe('cmd.exe');
  });
});

describe('findProgram', () => {
  it('finds a program on PATH', async () => {
    const directory = dirname(process.execPath);
    const name = basename(process.execPath).replace(/\.exe$/i, '');
    const launcher = await findProgram(name, { PATH: directory, PATHEXT: '.EXE' }, process.cwd());
    expect(launcher?.path.toLowerCase()).toBe(process.execPath.toLowerCase());
  });

  it('returns undefined when no directory on PATH carries the name', async () => {
    const launcher = await findProgram(
      'a-program-no-machine-has',
      { PATH: dirname(process.execPath), PATHEXT: '.EXE' },
      process.cwd(),
    );
    expect(launcher).toBeUndefined();
  });

  it('accepts a path and resolves it against the working directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cyv-program-'));
    try {
      const script = join(directory, 'runner.sh');
      await writeFile(script, '#!/bin/sh\n', 'utf-8');
      await chmod(script, 0o755);

      const launcher = await findProgram('./runner.sh', { PATH: '' }, directory);
      expect(launcher?.path).toBe(script);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not invent a program for an empty PATH', async () => {
    expect(await findProgram('codex', {}, process.cwd())).toBeUndefined();
  });
});
