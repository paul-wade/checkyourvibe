#!/usr/bin/env node
// publish.mjs — publish every public workspace package in dependency order.
//
// The decision to make a package public is the repository owner's to make, and
// an accidental publish cannot be undone. This script therefore treats any
// remaining `private: true` as a hard stop for the whole release and exits
// cleanly with an explanation, rather than attempting a partial or accidental
// publish. When every package is public, it publishes them in topological order
// so that dependencies that are also in the workspace are already on the
// registry before their dependents are published.

import { readdir, readFile, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execAsync = promisify(exec);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE_FILE = path.join(REPO, 'pnpm-workspace.yaml');

async function readWorkspaces() {
  let text;
  try {
    text = await readFile(WORKSPACE_FILE, 'utf8');
  } catch {
    return ['packages/*'];
  }

  const globs = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line === 'packages:') {
      inPackages = true;
      continue;
    }

    if (inPackages) {
      if (line.startsWith('- ')) {
        const value = line.slice(2).trim().replace(/^["']|["']$/g, '');
        if (value) globs.push(value);
      } else {
        inPackages = false;
      }
    }
  }
  return globs.length ? globs : ['packages/*'];
}

async function expandGlob(glob) {
  if (!glob.endsWith('/*')) {
    const pkg = path.resolve(REPO, glob);
    const hasPkg = await stat(path.join(pkg, 'package.json')).catch(() => null);
    return hasPkg ? [pkg] : [];
  }

  const base = path.resolve(REPO, glob.slice(0, -2));
  const entries = await readdir(base).catch(() => []);
  const packages = [];
  for (const entry of entries) {
    const dir = path.join(base, entry);
    const st = await stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    const hasPkg = await stat(path.join(dir, 'package.json')).catch(() => null);
    if (hasPkg) packages.push(dir);
  }
  return packages;
}

function fatal(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function topoSort(packages, workspaceNames) {
  const graph = new Map();
  const reverse = new Map();

  for (const pkg of packages) {
    graph.set(pkg.dir, []);
    reverse.set(pkg.dir, []);
  }

  for (const pkg of packages) {
    const depGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const locals = new Set();
    for (const group of depGroups) {
      const deps = pkg.json[group];
      if (!deps || typeof deps !== 'object') continue;
      for (const name of Object.keys(deps)) {
        if (workspaceNames.has(name)) locals.add(name);
      }
    }
    for (const name of locals) {
      const target = packages.find((p) => p.json.name === name);
      if (target) {
        graph.get(pkg.dir).push(target.dir);
        reverse.get(target.dir).push(pkg.dir);
      }
    }
  }

  const inDegree = new Map();
  for (const pkg of packages) {
    inDegree.set(pkg.dir, graph.get(pkg.dir).length);
  }

  const queue = packages.filter((p) => inDegree.get(p.dir) === 0).map((p) => p.dir);
  const sorted = [];

  while (queue.length) {
    const next = queue.shift();
    sorted.push(next);
    for (const dependent of reverse.get(next)) {
      const updated = inDegree.get(dependent) - 1;
      inDegree.set(dependent, updated);
      if (updated === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== packages.length) {
    const remaining = packages.filter((p) => !sorted.includes(p.dir)).map((p) => p.json.name);
    fatal(`Circular workspace dependency detected among: ${remaining.join(', ')}`);
  }

  return sorted.map((dir) => packages.find((p) => p.dir === dir));
}

async function main() {
  const globs = await readWorkspaces();
  const packageDirs = [];
  for (const glob of globs) {
    packageDirs.push(...(await expandGlob(glob)));
  }

  const packages = [];
  for (const dir of packageDirs) {
    const json = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    packages.push({ dir, json });
  }

  const privatePackages = packages.filter((p) => p.json.private === true);
  if (privatePackages.length) {
    console.log('Release publish step: nothing was published.');
    console.log('The following packages are still marked private:');
    for (const p of privatePackages) {
      console.log(`  - ${p.json.name}`);
    }
    console.log('Removing `private: true` is a release decision, not an automation step.');
    process.exit(0);
  }

  const workspaceNames = new Set(packages.map((p) => p.json.name));
  const ordered = topoSort(packages, workspaceNames);

  for (const pkg of ordered) {
    console.log(`Publishing ${pkg.json.name} from ${path.relative(REPO, pkg.dir)} ...`);
    try {
      const { stdout, stderr } = await execAsync('npm publish', { cwd: pkg.dir });
      if (stdout) console.log(stdout.trim());
      if (stderr) console.error(stderr.trim());
    } catch (err) {
      fatal(`Publishing ${pkg.json.name} failed: ${err.message}`);
    }
  }

  console.log(`Published ${ordered.length} package(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
