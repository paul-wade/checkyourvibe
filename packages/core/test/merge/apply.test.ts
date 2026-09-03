import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPlannedWrite,
  mergeCreateIfAbsent,
  mergeJson,
  mergeManagedBlock,
  MergeError,
  planDiff,
} from '../../src/merge/index.js';
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  type PlannedWrite,
} from '../../src/protocol/index.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cyv-merge-'));
}

/**
 * Narrow a caught `unknown` to `MergeError` for the tests below.
 *
 * `expect(err).toBeInstanceOf(MergeError)` gives a readable failure if the
 * thrown value is the wrong type, but it does not narrow `err`'s static type;
 * the `instanceof` check that follows does, and rethrows the original value
 * (rather than asserting past it) on the branch that should be unreachable.
 */
function assertMergeError(err: unknown): asserts err is MergeError {
  expect(err).toBeInstanceOf(MergeError);
  if (!(err instanceof MergeError)) {
    throw err;
  }
}

interface HooksShape {
  hooks: unknown[];
}

function hasHooksArray(value: unknown): value is HooksShape {
  return typeof value === 'object' && value !== null && 'hooks' in value && Array.isArray(value.hooks);
}

function commandOf(entry: unknown): string | undefined {
  return typeof entry === 'object' && entry !== null && 'command' in entry && typeof entry.command === 'string'
    ? entry.command
    : undefined;
}

describe('mergeCreateIfAbsent', () => {
  it('creates the file when nothing exists', () => {
    expect(mergeCreateIfAbsent(null, 'new content')).toBe('new content');
  });

  it('leaves an existing file untouched, even when empty', () => {
    expect(mergeCreateIfAbsent('existing', 'new content')).toBe('existing');
    expect(mergeCreateIfAbsent('', 'new content')).toBe('');
  });
});

describe('mergeManagedBlock comment styles', () => {
  it('defaults to HTML delimiters, so every existing caller is unchanged', () => {
    const id = 'rules';
    expect(MANAGED_BLOCK_START(id)).toBe('<!-- checkyourvibe:start:rules -->');
    expect(mergeManagedBlock(null, id, 'body')).toBe(
      `${MANAGED_BLOCK_START(id)}\nbody\n${MANAGED_BLOCK_END(id)}`,
    );
  });

  it('writes `#` delimiters for a YAML host and updates in place on a second pass', () => {
    const id = 'ci-gitlab';
    const first = mergeManagedBlock('stages:\n  - test\n', id, 'job:\n  script: []', 'hash');
    expect(first).toContain('# checkyourvibe:start:ci-gitlab');
    expect(first).toContain('# checkyourvibe:end:ci-gitlab');
    expect(first.startsWith('stages:\n  - test\n')).toBe(true);

    const second = mergeManagedBlock(first, id, 'job:\n  script: [changed]', 'hash');
    expect(second).toContain('script: [changed]');
    expect(second).not.toContain('script: []');
    expect(second.startsWith('stages:\n  - test\n')).toBe(true);
    // One block, not two: the second pass replaced rather than appended.
    expect(second.split('# checkyourvibe:start:ci-gitlab')).toHaveLength(2);
  });

  it('writes `//` delimiters for a Groovy host', () => {
    const id = 'ci-jenkins';
    const result = mergeManagedBlock(null, id, "stage('x') {}", 'slash');
    expect(result).toBe(`// checkyourvibe:start:${id}\nstage('x') {}\n// checkyourvibe:end:${id}`);
  });

  it('does not see an HTML-delimited block of the same id as a hash-delimited one', () => {
    const id = 'ci-gitlab';
    const html = `${MANAGED_BLOCK_START(id)}\nold\n${MANAGED_BLOCK_END(id)}`;
    const merged = mergeManagedBlock(html, id, 'new', 'hash');
    expect(merged).toContain('old');
    expect(merged).toContain('# checkyourvibe:start:ci-gitlab');
  });
});

describe('mergeManagedBlock', () => {
  it('appends the delimited block when both delimiters are absent', () => {
    const id = 'rules';
    const result = mergeManagedBlock('user prose', id, 'generated body');
    expect(result).toBe(
      `user prose\n\n${MANAGED_BLOCK_START(id)}\ngenerated body\n${MANAGED_BLOCK_END(id)}`,
    );
  });

  it('keeps a single blank line when the file already ends with a newline', () => {
    const id = 'rules';
    const result = mergeManagedBlock('user prose\n', id, 'generated body');
    expect(result).toBe(
      `user prose\n\n${MANAGED_BLOCK_START(id)}\ngenerated body\n${MANAGED_BLOCK_END(id)}`,
    );
  });

  it('replaces only the text between delimiters and preserves surrounding prose', () => {
    const id = 'rules';
    const existing = [
      'leading prose',
      '',
      MANAGED_BLOCK_START(id),
      'old body',
      MANAGED_BLOCK_END(id),
      '',
      'trailing prose with spaces   ',
    ].join('\n');

    const expected = [
      'leading prose',
      '',
      MANAGED_BLOCK_START(id),
      'new body',
      MANAGED_BLOCK_END(id),
      '',
      'trailing prose with spaces   ',
    ].join('\n');

    const result = mergeManagedBlock(existing, id, 'new body');
    expect(result).toBe(expected);
  });

  it('preserves a CRLF final newline when appending', () => {
    const id = 'rules';
    const result = mergeManagedBlock('user prose\r\n', id, 'generated body');
    expect(result).toBe(
      `user prose\r\n\r\n${MANAGED_BLOCK_START(id)}\ngenerated body\n${MANAGED_BLOCK_END(id)}`,
    );
  });

  it('throws CORRUPT_BLOCK when the end delimiter is missing', () => {
    const id = 'rules';
    const existing = `${MANAGED_BLOCK_START(id)}\nbody\n`;
    try {
      mergeManagedBlock(existing, id, 'new body');
      throw new Error('mergeManagedBlock should have thrown');
    } catch (err) {
      assertMergeError(err);
      expect(err.code).toBe('CORRUPT_BLOCK');
    }
  });

  it('throws CORRUPT_BLOCK when the end delimiter appears before the start', () => {
    const id = 'rules';
    const existing = `${MANAGED_BLOCK_END(id)}\n${MANAGED_BLOCK_START(id)}\nbody\n${MANAGED_BLOCK_END(id)}`;
    try {
      mergeManagedBlock(existing, id, 'new body');
      throw new Error('mergeManagedBlock should have thrown');
    } catch (err) {
      assertMergeError(err);
      expect(err.code).toBe('CORRUPT_BLOCK');
    }
  });

  it('throws CORRUPT_BLOCK when there are duplicate start delimiters', () => {
    const id = 'rules';
    const existing = `${MANAGED_BLOCK_START(id)}\nfirst\n${MANAGED_BLOCK_START(id)}\nsecond\n${MANAGED_BLOCK_END(id)}`;
    try {
      mergeManagedBlock(existing, id, 'new body');
      throw new Error('mergeManagedBlock should have thrown');
    } catch (err) {
      assertMergeError(err);
      expect(err.code).toBe('CORRUPT_BLOCK');
    }
  });

  it('throws CORRUPT_BLOCK when only an end delimiter is present', () => {
    const id = 'rules';
    const existing = `some prose\n${MANAGED_BLOCK_END(id)}\n`;
    try {
      mergeManagedBlock(existing, id, 'new body');
      throw new Error('mergeManagedBlock should have thrown');
    } catch (err) {
      assertMergeError(err);
      expect(err.code).toBe('CORRUPT_BLOCK');
    }
  });
});

describe('mergeJson', () => {
  it('preserves foreign keys and their original order', () => {
    const existing = '{"foreign":1,"shared":2}';
    const ourKeys = { shared: 3, new: 4 };
    const result = mergeJson(existing, ourKeys);
    expect(result).toBe('{\n  "foreign": 1,\n  "shared": 3,\n  "new": 4\n}');
  });

  it('preserves existing indentation and final newline', () => {
    const existing = '{\n\t"foreign":"ok"\n}\n';
    const ourKeys = { ours: 1 };
    const result = mergeJson(existing, ourKeys);
    expect(result).toBe('{\n\t"foreign": "ok",\n\t"ours": 1\n}\n');
  });

  it('replaces an array rather than appending and is idempotent', () => {
    const existing = '{"hooks":["old"]}';
    const ourKeys = { hooks: ['new'] };
    const once = mergeJson(existing, ourKeys);
    const twice = mergeJson(once, ourKeys);
    expect(once).toBe(twice);
    expect(once).toBe('{\n  "hooks": [\n    "new"\n  ]\n}');
  });

  it('with an ownership marker, keeps entries belonging to other tools', () => {
    // An agent's settings file is shared ground. Replacing the array wholesale
    // avoids duplicating our own entry on a re-run, but it silently deletes
    // hooks installed by other tools — which is what this marker prevents.
    const existing = JSON.stringify({
      hooks: [
        { command: 'some-other-tool run' },
        { command: 'cyv hook claude-code' },
      ],
    });
    const ourKeys = { hooks: [{ command: 'node cyv.js hook claude-code' }] };

    const once = mergeJson(existing, ourKeys, 'hook claude-code');
    const parsed: unknown = JSON.parse(once);
    if (!hasHooksArray(parsed)) {
      throw new Error('expected merged JSON to have a hooks array');
    }
    const hooks = parsed.hooks;

    expect(hooks).toHaveLength(2);
    expect(commandOf(hooks[0])).toBe('some-other-tool run');
    expect(commandOf(hooks[1])).toBe('node cyv.js hook claude-code');

    // Still idempotent: our previous entry is replaced, not accumulated.
    const twice = mergeJson(once, ourKeys, 'hook claude-code');
    expect(twice).toBe(once);
  });

  it('replaces nested object values', () => {
    const existing = '{"outer":{"keep":1,"replace":2}}';
    const ourKeys = { outer: { replace: 9 } };
    const result = mergeJson(existing, ourKeys);
    expect(result).toBe('{\n  "outer": {\n    "keep": 1,\n    "replace": 9\n  }\n}');
  });

  it('throws INVALID_JSON on malformed input', () => {
    try {
      mergeJson('not json', { ours: 1 });
      throw new Error('mergeJson should have thrown');
    } catch (err) {
      assertMergeError(err);
      expect(err.code).toBe('INVALID_JSON');
    }
  });

  it('treats a null or empty existing value as an empty object', () => {
    expect(mergeJson(null, { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(mergeJson('', { a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('applyPlannedWrite', () => {
  it('reports changed:false and leaves the file untouched for create-if-absent', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'settings.txt');
      await writeFile(file, 'original');

      const write: PlannedWrite = {
        path: file,
        strategy: 'create-if-absent',
        content: 'replacement',
        description: 'should not overwrite',
      };

      const outcome = await applyPlannedWrite(write);
      expect(outcome.changed).toBe(false);
      expect(outcome.before).toBe('original');
      expect(outcome.after).toBe('original');

      const onDisk = await readFile(file, 'utf-8');
      expect(onDisk).toBe('original');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws CORRUPT_BLOCK on a missing end delimiter and does not write', async () => {
    const dir = await makeTempDir();
    try {
      const id = 'rules';
      const file = join(dir, 'settings.md');
      const original = `prose\n${MANAGED_BLOCK_START(id)}\nbody\n`;
      await writeFile(file, original);

      const write: PlannedWrite = {
        path: file,
        strategy: 'managed-block',
        blockId: id,
        content: 'new body',
        description: 'update block',
      };

      try {
        await applyPlannedWrite(write);
        throw new Error('applyPlannedWrite should have thrown');
      } catch (err) {
        assertMergeError(err);
        expect(err.code).toBe('CORRUPT_BLOCK');
        expect(err.path).toBe(file);
      }

      const onDisk = await readFile(file, 'utf-8');
      expect(onDisk).toBe(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws MISSING_BLOCK_ID when a managed-block write has no blockId', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'settings.md');
      await writeFile(file, 'prose');

      const write: PlannedWrite = {
        path: file,
        strategy: 'managed-block',
        content: 'body',
        description: 'missing id',
      };

      try {
        await applyPlannedWrite(write);
        throw new Error('applyPlannedWrite should have thrown');
      } catch (err) {
        assertMergeError(err);
        expect(err.code).toBe('MISSING_BLOCK_ID');
        expect(err.path).toBe(file);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws INVALID_JSON on malformed existing json and does not write', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'settings.json');
      const original = 'not json';
      await writeFile(file, original);

      const write: PlannedWrite = {
        path: file,
        strategy: 'json-merge',
        content: '{"ours":1}',
        description: 'merge settings',
      };

      try {
        await applyPlannedWrite(write);
        throw new Error('applyPlannedWrite should have thrown');
      } catch (err) {
        assertMergeError(err);
        expect(err.code).toBe('INVALID_JSON');
        expect(err.path).toBe(file);
      }

      const onDisk = await readFile(file, 'utf-8');
      expect(onDisk).toBe(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent for managed-block and reports changed:false the second time', async () => {
    const dir = await makeTempDir();
    try {
      const id = 'rules';
      const file = join(dir, 'settings.md');

      const write: PlannedWrite = {
        path: file,
        strategy: 'managed-block',
        blockId: id,
        content: 'managed body',
        description: 'append block',
      };

      const first = await applyPlannedWrite(write);
      expect(first.changed).toBe(true);
      expect(first.after).toBe(
        `${MANAGED_BLOCK_START(id)}\nmanaged body\n${MANAGED_BLOCK_END(id)}`,
      );

      const second = await applyPlannedWrite(write);
      expect(second.changed).toBe(false);
      expect(second.before).toBe(first.after);
      expect(second.after).toBe(first.after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent for json-merge and reports changed:false the second time', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'settings.json');
      await writeFile(file, '{\n  "foreign": 1\n}');

      const write: PlannedWrite = {
        path: file,
        strategy: 'json-merge',
        content: '{"ours":2}',
        description: 'merge settings',
      };

      const first = await applyPlannedWrite(write);
      expect(first.changed).toBe(true);

      const second = await applyPlannedWrite(write);
      expect(second.changed).toBe(false);
      expect(second.after).toBe(first.after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('planDiff', () => {
  it('previews changes without writing', async () => {
    const dir = await makeTempDir();
    try {
      const file = join(dir, 'settings.json');
      await writeFile(file, '{"keep":1}');

      const write: PlannedWrite = {
        path: file,
        strategy: 'json-merge',
        content: '{"added":2}',
        description: 'preview merge',
      };

      const results = await planDiff([write]);
      const result = results[0];
      if (result === undefined) {
        throw new Error('planDiff returned no results for a single write');
      }
      expect(result.changed).toBe(true);
      expect(result.path).toBe(file);
      expect(result.preview).toContain('+');

      const onDisk = await readFile(file, 'utf-8');
      expect(onDisk).toBe('{"keep":1}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
