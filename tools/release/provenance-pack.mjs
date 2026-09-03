#!/usr/bin/env node
// provenance-pack.mjs — run the provenance deny list against the actual files
// that `npm pack` would ship.
//
// `tools/provenance-check.mjs` scans the git working tree and deliberately
// excludes `dist/` and other build output, because a provenance leak lives in
// source we wrote. But the published artifact contains compiled output, and the
// `files` whitelist is what decides what ships. This script asks `npm pack` what
// it will include, then reads those same files from disk and applies the deny
// list to every line. Nothing leaves the machine unscreened.

import { readdir, readFile, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execAsync = promisify(exec);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE_FILE = path.join(REPO, 'pnpm-workspace.yaml');

function fatal(message, code = 1) {
  console.error(message);
  process.exit(code);
}

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

async function readDenyList() {
  const content = process.env.CYV_PROVENANCE_DENY_CONTENT;
  const fromEnv = process.env.CYV_PROVENANCE_DENY;
  const fromRepo = path.join(REPO, '.cyv-provenance-deny');

  let text;
  let source;

  if (content !== undefined && content !== '') {
    text = content;
    source = 'CYV_PROVENANCE_DENY_CONTENT environment variable';
  } else if (fromEnv) {
    try {
      text = await readFile(fromEnv, 'utf8');
      source = fromEnv;
    } catch {
      // fall through
    }
  }

  if (text === undefined) {
    try {
      text = await readFile(fromRepo, 'utf8');
      source = fromRepo;
    } catch {
      // fall through
    }
  }

  if (text === undefined) {
    console.error('\n  No provenance deny list found.');
    console.error('  Set CYV_PROVENANCE_DENY, create .cyv-provenance-deny in the repository root,');
    console.error('  or provide CYV_PROVENANCE_DENY_CONTENT in the release environment.\n');
    console.error('  Failing rather than passing: a clean-room check that silently verifies nothing');
    console.error('  is worse than no check, because it reports success it never earned.\n');
    process.exit(2);
  }

  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf(':');
    if (split === -1) {
      entries.push({ label: 'denied', pattern: trimmed });
      continue;
    }
    entries.push({
      label: trimmed.slice(0, split).trim(),
      pattern: trimmed.slice(split + 1).trim(),
    });
  }

  if (entries.length === 0) {
    console.error(`\n  Deny list from ${source} is empty — nothing would ever be caught.\n`);
    process.exit(2);
  }

  return { source, entries };
}

function normalizePackPath(filePath) {
  return filePath.replace(/^package\//, '');
}

async function scanPackage(dir, pack, patterns) {
  const findings = [];
  const filePaths = pack.files.map((f) => normalizePackPath(f.path));

  for (const filePath of filePaths) {
    const absolute = path.join(dir, filePath);
    let raw;
    try {
      raw = await readFile(absolute, 'utf8');
    } catch (err) {
      // Binary files and anything the packer resolved to but the tree no longer
      // holds are reported so the release cannot silently skip them.
      findings.push({ file: filePath, line: 0, text: `Could not read file for provenance scan: ${err.message}` });
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { label, pattern } of patterns) {
        let re;
        try {
          re = new RegExp(pattern, 'i');
        } catch (err) {
          fatal(`Invalid deny pattern "${pattern}" from ${label}: ${err.message}`);
        }
        if (re.test(line)) {
          findings.push({
            file: filePath,
            line: i + 1,
            label,
            text: line.trim(),
          });
        }
      }
    }
  }

  return findings;
}

async function main() {
  const { source, entries } = await readDenyList();
  const globs = await readWorkspaces();

  const packageDirs = [];
  for (const glob of globs) {
    packageDirs.push(...(await expandGlob(glob)));
  }

  let failed = false;
  let scanned = 0;

  for (const dir of packageDirs) {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    const pack = await dryRunPack(dir);
    const findings = await scanPackage(dir, pack, entries);
    scanned += pack.files.length;

    if (findings.length) {
      failed = true;
      console.error(`\n  Provenance hit in ${pkg.name}`);
      for (const finding of findings.slice(0, 10)) {
        console.error(`    ${finding.file}:${finding.line}  [${finding.label}] ${finding.text}`);
      }
      if (findings.length > 10) {
        console.error(`    ... and ${findings.length - 10} more`);
      }
    } else {
      console.log(`  clean  ${pkg.name} (${pack.files.length} files)`);
    }
  }

  if (failed) {
    console.error('\n  Provenance pack check failed. See AGENTS.md — nothing traceable to a prior');
    console.error('  private codebase may leave this machine in a published tarball.\n');
    process.exit(1);
  }

  console.log(`\n  Provenance pack check passed (${packageDirs.length} packages, ${scanned} files) using ${source}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
