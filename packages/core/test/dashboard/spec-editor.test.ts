import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  listSpecFiles,
  readSpecFile,
  writeSpecFile,
  claimSpecFile,
  releaseSpecFile,
} from '../../src/dashboard/spec-editor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedFile(dir: string, relPath: string, content: string): Promise<void> {
  const abs = join(dir, relPath);
  await mkdir(join(dir, relPath.split('/').slice(0, -1).join('/')), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('spec-editor', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'cyv-spec-editor-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // listSpecFiles
  // -------------------------------------------------------------------------

  describe('listSpecFiles', () => {
    it('returns empty array when docs/specs/ does not exist', async () => {
      const result = await listSpecFiles(repo);
      expect(result).toEqual([]);
    });

    it('finds files across two spec directories', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', '# R1');
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '# T1');
      await seedFile(repo, 'docs/specs/0002-beta/design.md', '# D2');

      const result = await listSpecFiles(repo);

      expect(result).toHaveLength(2);

      const alpha = result.find(d => d.name === '0001-alpha');
      expect(alpha).toBeDefined();
      expect(alpha?.files.map(f => f.name).sort()).toEqual(['requirements.md', 'tasks.md']);
      expect(alpha?.files[0]?.repoRelativePath).toMatch(/^docs\/specs\/0001-alpha\//);

      const beta = result.find(d => d.name === '0002-beta');
      expect(beta).toBeDefined();
      expect(beta?.files.map(f => f.name)).toEqual(['design.md']);
    });

    it('ignores non-markdown files inside a spec directory', async () => {
      await seedFile(repo, 'docs/specs/0003-gamma/requirements.md', '# R');
      await seedFile(repo, 'docs/specs/0003-gamma/diagram.png', 'binary');

      const result = await listSpecFiles(repo);
      const gamma = result.find(d => d.name === '0003-gamma');
      expect(gamma?.files).toHaveLength(1);
      expect(gamma?.files[0]?.name).toBe('requirements.md');
    });

    it('sorts directories and files within each directory', async () => {
      await seedFile(repo, 'docs/specs/0002-beta/tasks.md', '');
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', '');
      await seedFile(repo, 'docs/specs/0001-alpha/design.md', '');

      const result = await listSpecFiles(repo);
      expect(result[0]?.name).toBe('0001-alpha');
      expect(result[1]?.name).toBe('0002-beta');
      expect(result[0]?.files.map(f => f.name)).toEqual(['design.md', 'requirements.md']);
    });

    it('omits spec directories that contain no markdown files', async () => {
      await mkdir(join(repo, 'docs/specs/0004-empty'), { recursive: true });
      await seedFile(repo, 'docs/specs/0005-notempty/tasks.md', '');

      const result = await listSpecFiles(repo);
      expect(result.map(d => d.name)).not.toContain('0004-empty');
      expect(result.map(d => d.name)).toContain('0005-notempty');
    });
  });

  // -------------------------------------------------------------------------
  // readSpecFile
  // -------------------------------------------------------------------------

  describe('readSpecFile', () => {
    it('returns the content of an existing file', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', '# Requirements\n\nR1. Something.\n');
      const content = await readSpecFile(repo, 'docs/specs/0001-alpha/requirements.md');
      expect(content).toBe('# Requirements\n\nR1. Something.\n');
    });

    it('throws when the file does not exist', async () => {
      await mkdir(join(repo, 'docs/specs'), { recursive: true });
      await expect(readSpecFile(repo, 'docs/specs/0001-alpha/missing.md')).rejects.toThrow();
    });

    it('refuses a path outside docs/specs/', async () => {
      await seedFile(repo, 'secret.md', 'private');
      await expect(readSpecFile(repo, 'secret.md')).rejects.toThrow(/Path refused/);
    });

    it('refuses a traversal attempt', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', '');
      await expect(
        readSpecFile(repo, 'docs/specs/0001-alpha/../../secret.md'),
      ).rejects.toThrow(/Path refused/);
    });

    it('refuses a traversal attempt even if it stays inside the subtree', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', '');
      await expect(
        readSpecFile(repo, 'docs/specs/0001-alpha/../0001-alpha/requirements.md'),
      ).rejects.toThrow(/Path refused.*traversal/);
    });
  });

  // -------------------------------------------------------------------------
  // writeSpecFile
  // -------------------------------------------------------------------------

  describe('writeSpecFile', () => {
    it('writes content and the file round-trips', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', 'original');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/requirements.md', 'user-A');

      await writeSpecFile(repo, 'docs/specs/0001-alpha/requirements.md', 'updated', 'user-A');

      const content = await readSpecFile(repo, 'docs/specs/0001-alpha/requirements.md');
      expect(content).toBe('updated');
    });

    it('refuses a write when no lock is held', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', 'original');

      await expect(
        writeSpecFile(repo, 'docs/specs/0001-alpha/requirements.md', 'updated', 'user-A'),
      ).rejects.toThrow(/Write refused/);
    });

    it('refuses a write when a different holder owns the lock', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', 'original');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/requirements.md', 'user-A');

      await expect(
        writeSpecFile(repo, 'docs/specs/0001-alpha/requirements.md', 'updated', 'user-B'),
      ).rejects.toThrow(/Write refused/);
    });

    it('refuses a path outside docs/specs/', async () => {
      await expect(
        writeSpecFile(repo, '../escape.md', 'evil', 'user-A'),
      ).rejects.toThrow(/Path refused/);
    });

    it('is atomic: the original survives if a write fails', async () => {
      // Verify that the .tmp rename strategy means the original is preserved
      // when the file exists and a write is refused (lock check throws before
      // we ever open the temp file, so the original is intact).
      await seedFile(repo, 'docs/specs/0001-alpha/requirements.md', 'original');

      await expect(
        writeSpecFile(repo, 'docs/specs/0001-alpha/requirements.md', 'bad write', 'nobody'),
      ).rejects.toThrow();

      const content = await readFile(
        join(repo, 'docs/specs/0001-alpha/requirements.md'),
        'utf-8',
      );
      expect(content).toBe('original');
    });
  });

  // -------------------------------------------------------------------------
  // claimSpecFile / releaseSpecFile
  // -------------------------------------------------------------------------

  describe('claimSpecFile', () => {
    it('succeeds on the first claim', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');
      const result = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      expect(result.claimed).toBe(true);
    });

    it('fails when the lock is already held by a different holder', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');

      const result = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-B');
      expect(result.claimed).toBe(false);
      if (!result.claimed) {
        expect(result.holder).toBe('user-A');
      }
    });

    it('succeeds when the same holder re-claims the lock', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      const result = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      expect(result.claimed).toBe(true);
    });

    it('refuses a path outside docs/specs/', async () => {
      await expect(
        claimSpecFile(repo, '../outside.md', 'user-A'),
      ).rejects.toThrow(/Path refused/);
    });
  });

  describe('releaseSpecFile', () => {
    it('release then re-claim by the original holder succeeds', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      await releaseSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');

      const result = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      expect(result.claimed).toBe(true);
    });

    it('release then re-claim by a different holder succeeds', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      await releaseSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');

      const result = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-B');
      expect(result.claimed).toBe(true);
    });

    it('release by a non-holder is a no-op; lock remains', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');
      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      await releaseSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-B');

      const result = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-B');
      expect(result.claimed).toBe(false);
    });

    it('refuses a path outside docs/specs/', async () => {
      await expect(
        releaseSpecFile(repo, '../outside.md', 'user-A'),
      ).rejects.toThrow(/Path refused/);
    });
  });

  // -------------------------------------------------------------------------
  // Mutual exclusion: write blocked while lock is held by another
  // -------------------------------------------------------------------------

  describe('mutual exclusion', () => {
    it('a second claim fails while the first is held', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', '');

      const first = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'agent-1');
      expect(first.claimed).toBe(true);

      const second = await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-B');
      expect(second.claimed).toBe(false);
    });

    it('allows write after valid lock, then blocks once released and re-claimed by another', async () => {
      await seedFile(repo, 'docs/specs/0001-alpha/tasks.md', 'v1');

      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');
      await writeSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'v2', 'user-A');
      await releaseSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-A');

      await claimSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'user-B');

      await expect(
        writeSpecFile(repo, 'docs/specs/0001-alpha/tasks.md', 'v3', 'user-A'),
      ).rejects.toThrow(/Write refused/);

      const content = await readSpecFile(repo, 'docs/specs/0001-alpha/tasks.md');
      expect(content).toBe('v2');
    });
  });
});
