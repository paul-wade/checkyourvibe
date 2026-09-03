/**
 * `cyvCommand` is the one value in the generated glue that has to keep working
 * after the tool itself moves. `cyv init` resolves it to one of two shapes — a
 * bare command on PATH when the CLI came from an installed package, or an
 * absolute path to a `.js` entry point when it came from a source clone — and
 * every adapter has to embed whichever it is given in a form a shell can run.
 *
 * A bare name is invoked directly. A `.js` path is not executable on its own,
 * so it has to be prefixed with the Node interpreter. Getting that backwards
 * produces a hook that is written, reported as applied, and never runs, which
 * is why it is checked here for every shipped adapter rather than for the one
 * adapter a given test happened to use.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandResolves, loadAllPlugins, resolveCyvCommand } from '../../src/cli/init.js';
import type { AgentPlugin, PlannedWrite } from '../../src/protocol/index.js';

const BARE_COMMAND = 'cyv';
const ENTRY_POINT = resolve('/cyv-checkout/dist/cli/index.js');

/**
 * Some planned writes are JSON, where a Windows path arrives with its
 * separators escaped. Both spellings mean the same embedded string, so a
 * containment check has to accept either.
 */
function mentions(content: string, needle: string): boolean {
  return content.includes(needle) || content.includes(needle.replace(/\\/g, '\\\\'));
}

async function planWith(plugin: AgentPlugin, cyvCommand: string): Promise<PlannedWrite[]> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'cyv-agents-repo-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'cyv-agents-home-'));
  try {
    return await plugin.plan({ repoRoot, homeDir, cyvCommand, rules: [] });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

/** The writes that actually carry the hook invocation for this plugin. */
function hookWrites(writes: PlannedWrite[], pluginId: string): PlannedWrite[] {
  return writes.filter((write) => write.content.includes(`hook ${pluginId}`));
}

describe('cyvCommand as every adapter embeds it', () => {
  it('loads every shipped adapter', async () => {
    const plugins = await loadAllPlugins();
    const ids = plugins.map((plugin) => plugin.id).sort();
    expect(ids).toEqual(['antigravity', 'claude-code', 'codex', 'cursor', 'devin', 'gemini']);
  });

  it('embeds a bare command directly, with no interpreter in front of it', async () => {
    const plugins = await loadAllPlugins();

    for (const plugin of plugins) {
      const writes = await planWith(plugin, BARE_COMMAND);
      const hooks = hookWrites(writes, plugin.id);
      expect(hooks.length, `${plugin.id} planned no write carrying its hook invocation`).toBeGreaterThan(0);

      for (const write of hooks) {
        expect(
          mentions(write.content, `${BARE_COMMAND} hook ${plugin.id}`),
          `${plugin.id} did not embed "${BARE_COMMAND} hook ${plugin.id}" in ${write.path}`,
        ).toBe(true);
        expect(
          mentions(write.content, process.execPath),
          `${plugin.id} put an interpreter in front of a bare command in ${write.path}`,
        ).toBe(false);
      }
    }
  });

  it('runs a .js entry point through the Node interpreter', async () => {
    const plugins = await loadAllPlugins();

    for (const plugin of plugins) {
      const writes = await planWith(plugin, ENTRY_POINT);
      const hooks = hookWrites(writes, plugin.id);
      expect(hooks.length, `${plugin.id} planned no write carrying its hook invocation`).toBeGreaterThan(0);

      for (const write of hooks) {
        expect(
          mentions(write.content, ENTRY_POINT),
          `${plugin.id} did not embed the entry point in ${write.path}`,
        ).toBe(true);
        expect(
          mentions(write.content, process.execPath),
          `${plugin.id} embedded a .js path with no interpreter in ${write.path}`,
        ).toBe(true);
      }
    }
  });

  it('resolves a cyvCommand that can actually be invoked', async () => {
    const cyvCommand = await resolveCyvCommand();
    expect(await commandResolves(cyvCommand)).toBe(true);
  });
});
