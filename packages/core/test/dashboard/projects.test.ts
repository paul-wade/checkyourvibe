import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addProject,
  listProjects,
  normalizeProjectPath,
  readRegistry,
  removeProject,
  validateProjectPath,
  writeRegistry,
} from '../../src/dashboard/projects.js';

describe('project registry', () => {
  let base: string;
  let registryFile: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'cyv-projects-'));
    registryFile = join(base, 'registry.json');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('normalizes paths to absolute and uppercases Windows drive letters', () => {
    const absolute = normalizeProjectPath(join(base, 'project'));
    expect(absolute).toBe(resolve(join(base, 'project')));
    if (process.platform === 'win32') {
      const match = /^([A-Z]):/.exec(absolute);
      expect(match).not.toBeNull();
    }
  });

  it('reads an empty registry when the file is missing', async () => {
    expect(await readRegistry(registryFile)).toEqual([]);
  });

  it('writes and reads a list of project paths', async () => {
    const a = join(base, 'a');
    const b = join(base, 'b');
    await writeRegistry([a, b], registryFile);
    const paths = await readRegistry(registryFile);
    expect(paths).toEqual([normalizeProjectPath(a), normalizeProjectPath(b)]);
  });

  it('deduplicates and normalizes paths when writing', async () => {
    const project = join(base, 'project');
    await writeRegistry([project, project, `${project}/`], registryFile);
    const paths = await readRegistry(registryFile);
    expect(paths).toEqual([normalizeProjectPath(project)]);
  });

  it('rejects a registry that is not a JSON array', async () => {
    await writeFile(registryFile, '{}', 'utf-8');
    expect(await readRegistry(registryFile)).toEqual([]);
  });

  it('adds a valid project and reports it as added', async () => {
    const project = join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'checkyourvibe.json'), '{}', 'utf-8');
    const result = await addProject(project, registryFile);
    expect(result.added).toBe(true);
    expect(await readRegistry(registryFile)).toEqual([result.path]);
  });

  it('does not add the same project twice', async () => {
    const project = join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'checkyourvibe.json'), '{}', 'utf-8');
    await addProject(project, registryFile);
    const second = await addProject(project, registryFile);
    expect(second.added).toBe(false);
    expect(await readRegistry(registryFile)).toHaveLength(1);
  });

  it('rejects adding a project whose directory is missing', async () => {
    const missing = join(base, 'missing');
    await expect(addProject(missing, registryFile)).rejects.toThrow(/does not exist/);
  });

  it('rejects adding a project that lacks checkyourvibe.json', async () => {
    const project = join(base, 'project');
    await mkdir(project, { recursive: true });
    await expect(addProject(project, registryFile)).rejects.toThrow(/No checkyourvibe.json/);
  });

  it('removes a registered project', async () => {
    const project = join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'checkyourvibe.json'), '{}', 'utf-8');
    await addProject(project, registryFile);
    const result = await removeProject(project, registryFile);
    expect(result.removed).toBe(true);
    expect(await readRegistry(registryFile)).toEqual([]);
  });

  it('reports a missing project as not removed', async () => {
    const result = await removeProject(join(base, 'never-registered'), registryFile);
    expect(result.removed).toBe(false);
  });

  it('lists a valid project with status ok', async () => {
    const project = join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'checkyourvibe.json'), '{}', 'utf-8');
    await addProject(project, registryFile);
    const projects = await listProjects(registryFile);
    expect(projects).toEqual([
      {
        path: normalizeProjectPath(project),
        status: 'ok',
        exists: true,
        hasConfig: true,
      },
    ]);
  });

  it('reports a missing directory separately from a missing config', async () => {
    const present = join(base, 'present');
    const missing = join(base, 'missing');
    await mkdir(present, { recursive: true });
    await writeFile(join(present, 'other.json'), '{}', 'utf-8');
    await writeRegistry([present, missing], registryFile);
    const projects = await listProjects(registryFile);
    expect(projects).toHaveLength(2);

    const presentResult = projects.find((p) => p.path === normalizeProjectPath(present));
    const missingResult = projects.find((p) => p.path === normalizeProjectPath(missing));
    expect(presentResult).toEqual({
      path: normalizeProjectPath(present),
      status: 'missing',
      exists: true,
      hasConfig: false,
      reason: expect.stringContaining('No checkyourvibe.json'),
    });
    expect(missingResult).toEqual({
      path: normalizeProjectPath(missing),
      status: 'missing',
      exists: false,
      hasConfig: false,
      reason: expect.stringContaining('does not exist'),
    });
  });

  it('validateProjectPath measures presence and config independently', async () => {
    const presentNoConfig = join(base, 'presentNoConfig');
    const missing = join(base, 'missing');
    await mkdir(presentNoConfig, { recursive: true });

    const ok = await validateProjectPath(presentNoConfig);
    expect(ok.ok).toBe(false);
    expect(ok.exists).toBe(true);
    expect(ok.hasConfig).toBe(false);

    const gone = await validateProjectPath(missing);
    expect(gone.ok).toBe(false);
    expect(gone.exists).toBe(false);
    expect(gone.hasConfig).toBe(false);
  });
});
