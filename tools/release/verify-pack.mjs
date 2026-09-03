#!/usr/bin/env node
// verify-pack.mjs — verify the actual contents of every publishable package.
//
// The `files` field is a whitelist, but `npm pack --dry-run --json` is the only
// tool that knows what a tarball really contains. This script packs each
// workspace package, asserts that the built entry points and analyzer manifests
// are present, and rejects anything that looks like tests, fixtures, source
// maps, or TypeScript source.

import { readdir, readFile, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execAsync = promisify(exec);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE_FILE = path.join(REPO, 'pnpm-workspace.yaml');

const FORBIDDEN_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'fixture',
  'fixtures',
]);

const METADATA_FIELDS = ['description', 'license', 'repository', 'author'];

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

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('Could not parse npm pack output as JSON');
  }
}

async function dryRunPack(packageDir) {
  const { stdout } = await execAsync(
    'npm pack --dry-run --json',
    { cwd: packageDir, maxBuffer: 32 * 1024 * 1024 }
  );
  const parsed = extractJson(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('npm pack --json returned an empty or unexpected structure');
  }
  return parsed[0];
}

function isForbidden(filePath) {
  const lower = filePath.toLowerCase();
  const segments = filePath.split('/');

  for (const segment of segments) {
    const base = segment.replace(/\..*$/, ''); // strip extension for segment checks
    if (FORBIDDEN_SEGMENTS.has(base.toLowerCase())) {
      return `forbidden segment "${segment}"`;
    }
  }

  if (/\.map$/i.test(lower)) {
    return 'source map (.map)';
  }

  if (/\.tsx?$/i.test(lower) && !/\.d\.ts$/i.test(lower)) {
    return 'TypeScript source (.ts)';
  }

  if (/\.(?:mts|cts)$/i.test(lower)) {
    return 'TypeScript source (.mts/.cts)';
  }

  return null;
}

function isExpectedFile(filePath, hasManifest) {
  if (filePath === 'package.json') return true;
  if (hasManifest && filePath === 'analyzer.manifest.json') return true;
  if (filePath.startsWith('dist/')) return true;

  // npm includes these by default if present; they are not runtime output but
  // are also not the things the whitelist exists to exclude.
  const lower = filePath.toLowerCase();
  if (lower.startsWith('readme')) return true;
  if (lower.startsWith('license')) return true;
  if (lower.startsWith('changelog')) return true;
  if (lower.startsWith('notice')) return true;

  return false;
}

function normalizeEntryPath(entryPath) {
  return entryPath.replace(/^package\//, '');
}

function formatPackage(pkg, defects, hasManifest, fileLines) {
  const lines = [`--- ${pkg.name}@${pkg.version}`];

  const missing = [];
  if (pkg.main) {
    const mainPath = pkg.main.replace(/^\.\//, '');
    lines.push(`main:      ${mainPath} ${fileLines.has(mainPath) ? 'OK' : 'MISSING'}`);
    if (!fileLines.has(mainPath)) missing.push(`main entry point "${mainPath}"`);
  }

  if (pkg.bin) {
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
    for (const [name, target] of Object.entries(bins)) {
      const binPath = target.replace(/^\.\//, '');
      lines.push(`bin[${name}]: ${binPath} ${fileLines.has(binPath) ? 'OK' : 'MISSING'}`);
      if (!fileLines.has(binPath)) missing.push(`bin "${name}" at "${binPath}"`);
    }
  }

  if (hasManifest) {
    lines.push(`manifest:  analyzer.manifest.json ${fileLines.has('analyzer.manifest.json') ? 'OK' : 'MISSING'}`);
    if (!fileLines.has('analyzer.manifest.json')) missing.push('analyzer.manifest.json');
  } else {
    lines.push('manifest:  (none)');
  }

  // A dependency range no registry can resolve.
  //
  // `workspace:*` is a package-manager convenience that must be rewritten to a
  // real version before publishing. A tarball still carrying it is not merely
  // suspect, it is uninstallable: `npm install` refuses it outright with
  // EUNSUPPORTEDPROTOCOL.
  //
  // This check exists because the packed tarballs passed every other check here
  // and then failed at the only step that mattered — installing them into a
  // real project. "All 7 packages passed pack verification" was a green light
  // on something nobody could install.
  const unpublishable = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range === 'string' && /^(workspace|link|file):/.test(range)) {
        lines.push(`UNPUBLISHABLE: ${field}.${dep} = "${range}"`);
        unpublishable.push(
          `${field}.${dep} = "${range}" — no registry can resolve this; run tools/release/set-version.mjs first`,
        );
      }
    }
  }
  if (unpublishable.length === 0) {
    lines.push('deps:      all resolvable');
  }
  defects.unpublishable.push(...unpublishable);

  const metadata = [];
  for (const field of METADATA_FIELDS) {
    const ok = pkg[field] !== undefined && pkg[field] !== null && pkg[field] !== '';
    lines.push(`${field.padEnd(9)} ${ok ? 'OK' : 'MISSING'}`);
    if (!ok) metadata.push(field);
  }

  if (metadata.length) {
    defects.metadata.push(...metadata);
  }

  const forbidden = [];
  const unexpected = [];
  for (const p of fileLines) {
    const reason = isForbidden(p);
    if (reason) forbidden.push({ path: p, reason });
    if (!isExpectedFile(p, hasManifest)) unexpected.push(p);
  }

  if (forbidden.length) {
    for (const { path: p, reason } of forbidden) {
      lines.push(`FORBIDDEN: ${p} (${reason})`);
      defects.forbidden.push(`${p} (${reason})`);
    }
  } else {
    lines.push('forbidden: none');
  }

  if (unexpected.length) {
    for (const p of unexpected) {
      lines.push(`UNEXPECTED: ${p}`);
      defects.unexpected.push(p);
    }
  }

  missing.forEach((m) => defects.missing.push(m));

  lines.push(`files (${fileLines.size}):`);
  for (const p of Array.from(fileLines).sort()) {
    lines.push(`  ${p}`);
  }

  return lines.join('\n');
}

async function main() {
  const globs = await readWorkspaces();
  const packageDirs = [];
  for (const glob of globs) {
    packageDirs.push(...(await expandGlob(glob)));
  }

  const results = [];
  let anyDefect = false;

  for (const dir of packageDirs) {
    const pkgFile = path.join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
    const pack = await dryRunPack(dir);
    const filePaths = new Set(pack.files.map((f) => normalizeEntryPath(f.path)));
    const hasManifest = await stat(path.join(dir, 'analyzer.manifest.json')).catch(() => null) !== null;

    const defects = { missing: [], forbidden: [], unexpected: [], metadata: [], unpublishable: [] };
    const output = formatPackage(pkg, defects, hasManifest, filePaths);
    console.log(output);
    console.log();

    results.push({ name: pkg.name, dir, defects });

    if (Object.values(defects).some((arr) => arr.length > 0)) {
      anyDefect = true;
    }
  }

  if (anyDefect) {
    console.error('Pack verification failed. Defects:');
    for (const { name, defects } of results) {
      const all = [
        ...defects.missing.map((m) => `missing ${m}`),
        ...defects.forbidden,
        ...defects.unexpected.map((u) => `unexpected ${u}`),
        ...defects.metadata.map((m) => `missing metadata: ${m}`),
        ...defects.unpublishable,
      ];
      if (all.length) {
        console.error(`  ${name}:`);
        for (const d of all) console.error(`    - ${d}`);
      }
    }
    process.exit(1);
  }

  console.log(`All ${results.length} package(s) passed pack verification.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
