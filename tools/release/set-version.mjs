#!/usr/bin/env node
// set-version.mjs — single source of truth for the workspace release version.
//
// The root package.json is the version source of truth. This script writes the
// requested version there, then propagates it to every workspace package and
// rewrites all workspace-protocol dependencies to that exact version before
// anything is published. Leaving workspace:* in a published package.json ships
// a dependency that resolves to a version that does not exist, which breaks the
// first person running `npx`.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT_PACKAGE = path.join(REPO, 'package.json');
const WORKSPACE_FILE = path.join(REPO, 'pnpm-workspace.yaml');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;

function fatal(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  let force = false;
  let version = null;
  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('-')) {
      version = arg;
    } else {
      fatal(`Unknown option: ${arg}`, 2);
    }
  }
  if (!version) {
    fatal('Usage: node tools/release/set-version.mjs <version> [--force]', 2);
  }
  return { version, force };
}

function validateVersion(version) {
  if (!SEMVER.test(version)) {
    fatal(`Refusing to use ${version} as a version. It does not look like a valid semantic version.`, 2);
  }
}

async function gitIsDirty() {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO });
    return stdout.trim().length > 0;
  } catch (err) {
    fatal(`Could not determine git state: ${err.message}`);
  }
}

async function readYamlWorkspaces() {
  let text;
  try {
    text = await readFile(WORKSPACE_FILE, 'utf8');
  } catch {
    return [];
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
  return globs;
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

async function loadPackage(file) {
  const text = await readFile(file, 'utf8');
  const data = JSON.parse(text);
  return { file, text, data };
}

function rewriteWorkspaceDeps(data, version, workspaceNames) {
  const depGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const group of depGroups) {
    const deps = data[group];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (workspaceNames.has(name)) {
        deps[name] = version;
      } else if (deps[name] === 'workspace:*') {
        // Defensive: if a workspace:* dependency is not a known package, we
        // still rewrite it so the publishable package does not ship a broken
        // protocol. This should not happen in a healthy workspace.
        deps[name] = version;
      }
    }
  }
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function updateIfChanged({ file, text, data, version, workspaceNames, isRoot }) {
  const original = text;
  const clone = JSON.parse(JSON.stringify(data));
  const eol = detectEol(original);

  if (!isRoot || clone.version !== version) {
    clone.version = version;
  }

  if (!isRoot) {
    rewriteWorkspaceDeps(clone, version, workspaceNames);
  }

  const next = JSON.stringify(clone, null, 2).replace(/\n/g, eol) + eol;
  return { changed: next !== original, data: clone, content: next };
}

async function main() {
  const { version, force } = parseArgs(process.argv.slice(2));
  validateVersion(version);

  const globs = await readYamlWorkspaces();
  if (globs.length === 0) {
    globs.push('packages/*');
  }

  const packageDirs = [];
  for (const glob of globs) {
    const expanded = await expandGlob(glob);
    packageDirs.push(...expanded);
  }

  const root = await loadPackage(ROOT_PACKAGE);
  const packages = await Promise.all(packageDirs.map((dir) => loadPackage(path.join(dir, 'package.json'))));
  const workspaceNames = new Set(packages.map((p) => p.data.name).filter(Boolean));

  const planned = [];

  const rootUpdate = updateIfChanged({ ...root, version, workspaceNames, isRoot: true });
  if (rootUpdate.changed) planned.push({ file: ROOT_PACKAGE, ...rootUpdate });

  for (const pkg of packages) {
    const update = updateIfChanged({ ...pkg, version, workspaceNames, isRoot: false });
    if (update.changed) planned.push({ file: pkg.file, ...update });
  }

  if (planned.length === 0) {
    console.log(`Version ${version} is already set in every package. No changes made.`);
    return;
  }

  if (!force && (await gitIsDirty())) {
    fatal(
      'Refusing to set version: the working tree has uncommitted changes. ' +
      'Publishing from an unreviewed tree can ship files nobody approved. ' +
      'Pass --force if this is intentional.',
      1
    );
  }

  for (const { file, content } of planned) {
    await writeFile(file, content, 'utf8');
    console.log(`Updated ${path.relative(REPO, file)} to ${version}`);
  }

  console.log(`Set workspace version to ${version} in ${planned.length} package.json file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
