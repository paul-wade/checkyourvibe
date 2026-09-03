import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPlannedWrite,
  mergeToml,
  MergeError,
  quoteTomlString,
  TomlMergeError,
} from '../../src/merge/index.js';
import type { PlannedWrite } from '../../src/protocol/index.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cyv-merge-toml-'));
}

/**
 * Narrow a caught `unknown` to `TomlMergeError`, the way apply.test.ts narrows
 * to `MergeError`: a readable failure if the thrown value is the wrong type,
 * and a rethrow (rather than an unchecked assertion) on the branch that
 * should be unreachable.
 */
function assertTomlMergeError(err: unknown): asserts err is TomlMergeError {
  expect(err).toBeInstanceOf(TomlMergeError);
  if (!(err instanceof TomlMergeError)) {
    throw err;
  }
}

function assertMergeError(err: unknown): asserts err is MergeError {
  expect(err).toBeInstanceOf(MergeError);
  if (!(err instanceof MergeError)) {
    throw err;
  }
}

const path = 'hooks.PostToolUse.hooks';
const marker = 'owned-by:cyv-codex';

describe('mergeToml — creating from nothing', () => {
  it('emits the parent table and our entry, and the result is re-parseable', () => {
    const entryLines = ['command = "cyv hook codex"', `# ${marker}`];
    const result = mergeToml(null, path, entryLines, marker);

    expect(result).toBe(
      '[hooks.PostToolUse]\n\n[[hooks.PostToolUse.hooks]]\ncommand = "cyv hook codex"\n# owned-by:cyv-codex',
    );

    // Re-parseable: feeding the fresh output back through mergeToml with the
    // same marker must recognise our own entry and leave it unchanged.
    const again = mergeToml(result, path, entryLines, marker);
    expect(again).toBe(result);
  });

  it('treats an empty existing string the same as a missing file', () => {
    const entryLines = ['command = "cyv hook codex"'];
    expect(mergeToml('', path, entryLines, marker)).toBe(
      mergeToml(null, path, entryLines, marker),
    );
  });

  it('emits only the array header when the path has no parent table', () => {
    const result = mergeToml(null, 'top_level_array', ['x = 1'], undefined);
    expect(result).toBe('[[top_level_array]]\nx = 1');
  });
});

describe('mergeToml — foreign entries', () => {
  const existing =
    '[hooks.PostToolUse]\n\n[[hooks.PostToolUse.hooks]]\ncommand = "other-tool run"\n# keep me\ntimeout_ms = 5000\n';
  const entryLines = ['command = "cyv hook codex"', `# ${marker}`];

  it('survives byte-for-byte and our entry is appended after it', () => {
    const result = mergeToml(existing, path, entryLines, marker);

    expect(result).toBe(
      '[hooks.PostToolUse]\n\n' +
        '[[hooks.PostToolUse.hooks]]\ncommand = "other-tool run"\n# keep me\ntimeout_ms = 5000\n\n' +
        '[[hooks.PostToolUse.hooks]]\ncommand = "cyv hook codex"\n# owned-by:cyv-codex\n',
    );
  });

  it('is replaced, not duplicated, when applied a second time', () => {
    const once = mergeToml(existing, path, entryLines, marker);
    const twice = mergeToml(once, path, entryLines, marker);
    expect(twice).toBe(once);
  });
});

describe('mergeToml — surrounding content', () => {
  it('leaves unrelated tables, comments, and blank lines untouched', () => {
    const existing = [
      '# top comment',
      '',
      '[other_tool]',
      'setting = 1',
      '',
      '[hooks.PostToolUse]',
      '',
      '[[hooks.PostToolUse.hooks]]',
      'command = "other-tool run"',
      '',
      '[unrelated.table]',
      'x = 2',
      '',
    ].join('\n');

    const entryLines = ['command = "cyv hook codex"', `# ${marker}`];
    const result = mergeToml(existing, path, entryLines, marker);

    expect(result).toBe(
      '# top comment\n\n[other_tool]\nsetting = 1\n\n[hooks.PostToolUse]\n\n' +
        '[[hooks.PostToolUse.hooks]]\ncommand = "other-tool run"\n\n' +
        '[unrelated.table]\nx = 2\n\n' +
        '[[hooks.PostToolUse.hooks]]\ncommand = "cyv hook codex"\n# owned-by:cyv-codex\n',
    );
  });
});

describe('mergeToml — no ownership marker', () => {
  it('replaces all entries at the path with ours, matching json-merge no-marker behaviour', () => {
    const existing = [
      '[hooks.PostToolUse]',
      '',
      '[[hooks.PostToolUse.hooks]]',
      'command = "first-tool run"',
      '',
      '[[hooks.PostToolUse.hooks]]',
      'command = "second-tool run"',
      '',
      '[other_table]',
      'z = 1',
      '',
    ].join('\n');

    const result = mergeToml(existing, path, ['command = "cyv hook codex"'], undefined);

    expect(result).toBe(
      '[hooks.PostToolUse]\n\n[[hooks.PostToolUse.hooks]]\ncommand = "cyv hook codex"\n[other_table]\nz = 1\n',
    );
  });
});

describe('mergeToml — line endings', () => {
  it('keeps CRLF input CRLF, including in newly appended content', () => {
    const existing = '[other]\r\nfoo = 1\r\n';
    const result = mergeToml(existing, path, ['command = "x"'], marker);

    expect(result).toBe(
      '[other]\r\nfoo = 1\r\n\r\n[hooks.PostToolUse]\r\n\r\n[[hooks.PostToolUse.hooks]]\r\ncommand = "x"\r\n',
    );
    // No bare LF that isn't part of a CRLF pair.
    expect(/(?<!\r)\n/.test(result)).toBe(false);
  });
});

describe('quoteTomlString', () => {
  it('escapes backslashes and double quotes', () => {
    expect(quoteTomlString('plain')).toBe('"plain"');
    expect(quoteTomlString('has "quotes"')).toBe('"has \\"quotes\\""');
  });

  it('round-trips a Windows path with backslashes as valid TOML', () => {
    const winPath = 'C:\\Users\\test\\run.cmd';
    const quoted = quoteTomlString(winPath);

    expect(quoted).toBe('"C:\\\\Users\\\\test\\\\run.cmd"');

    // TOML basic-string escaping of backslash/quote matches JSON's, so
    // JSON.parse is a faithful way to assert the escaping round-trips.
    const parsedDirect: unknown = JSON.parse(quoted);
    expect(parsedDirect).toBe(winPath);

    const entryLines = [`command = ${quoted}`];
    const result = mergeToml(null, path, entryLines, undefined);

    const match = /^command = (.+)$/m.exec(result);
    if (match === null) {
      throw new Error('expected a command line in the merged output');
    }
    const value = match[1];
    if (value === undefined) {
      throw new Error('regex capture group for the command value was missing');
    }
    const parsedFromFile: unknown = JSON.parse(value);
    expect(parsedFromFile).toBe(winPath);
  });
});

describe('mergeToml — unparseable input', () => {
  const badExisting = '[hooks.PostToolUse]\n[[hooks.PostToolUse.hooks\ncommand = "x"\n';

  it('throws TomlMergeError with code UNPARSEABLE on an unterminated header', () => {
    try {
      mergeToml(badExisting, path, ['command = "y"'], marker);
      throw new Error('mergeToml should have thrown');
    } catch (err) {
      assertTomlMergeError(err);
      expect(err.code).toBe('UNPARSEABLE');
    }
  });

  it('writes nothing when applyPlannedWrite hits an unparseable file', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'config.toml');
      await writeFile(file, badExisting);

      const write: PlannedWrite = {
        path: file,
        strategy: 'toml-merge',
        content: 'command = "y"',
        tomlTableArrayPath: path,
        ownershipMarker: marker,
        description: 'codex post-tool hook',
      };

      try {
        await applyPlannedWrite(write);
        throw new Error('applyPlannedWrite should have thrown');
      } catch (err) {
        assertMergeError(err);
        expect(err.code).toBe('UNPARSEABLE_TOML');
        expect(err.path).toBe(file);
      }

      const onDisk = await readFile(file, 'utf-8');
      expect(onDisk).toBe(badExisting);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('applyPlannedWrite — toml-merge wiring', () => {
  it('throws MISSING_TOML_TABLE_ARRAY_PATH when the path field is absent', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'config.toml');
      await writeFile(file, 'foreign = 1\n');

      const write: PlannedWrite = {
        path: file,
        strategy: 'toml-merge',
        content: 'command = "y"',
        description: 'missing table array path',
      };

      try {
        await applyPlannedWrite(write);
        throw new Error('applyPlannedWrite should have thrown');
      } catch (err) {
        assertMergeError(err);
        expect(err.code).toBe('MISSING_TOML_TABLE_ARRAY_PATH');
        expect(err.path).toBe(file);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('merges into a real file end-to-end and is idempotent', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'config.toml');
      await writeFile(file, '[hooks.PostToolUse]\n\n[[hooks.PostToolUse.hooks]]\ncommand = "other-tool run"\n');

      const write: PlannedWrite = {
        path: file,
        strategy: 'toml-merge',
        content: `command = ${quoteTomlString('cyv hook codex')}\n# ${marker}`,
        tomlTableArrayPath: path,
        ownershipMarker: marker,
        description: 'codex post-tool hook',
      };

      const first = await applyPlannedWrite(write);
      expect(first.changed).toBe(true);
      expect(first.after).toBe(
        '[hooks.PostToolUse]\n\n[[hooks.PostToolUse.hooks]]\ncommand = "other-tool run"\n\n' +
          `[[hooks.PostToolUse.hooks]]\ncommand = "cyv hook codex"\n# ${marker}\n`,
      );

      const second = await applyPlannedWrite(write);
      expect(second.changed).toBe(false);
      expect(second.after).toBe(first.after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
