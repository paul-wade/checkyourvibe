#!/usr/bin/env node
// Fail if anything traceable to a prior private codebase reaches tracked files.
//
// This repository is a clean-room rebuild (see AGENTS.md). It is private today
// and public later, and git history is permanent — so this runs in CI on every
// commit rather than as a pre-publication sweep. A sweep before flipping the
// switch is too late: the offending blob is already in history.
//
//   node tools/provenance-check.mjs
//
// Exit 0 clean, 1 on a hit, 2 if no deny list is configured.
//
// ---------------------------------------------------------------------------
// WHY THE TERMS ARE NOT IN THIS FILE
//
// They used to be. A committed list of the employer, coworkers and vendors an
// author is scrubbing IS the disclosure it exists to prevent — anyone reading
// the repository learns exactly which company and which products were involved,
// stated more precisely than a stray mention ever would have. Excluding this
// file from its own scan stopped the check failing; it did nothing about the
// leak, and it made this the single most identifying file in the tree.
//
// So the list lives outside the repository:
//
//   1. CYV_PROVENANCE_DENY  — path to a deny-list file, or
//   2. .cyv-provenance-deny — in the repository root, gitignored
//
// Format: one entry per line, `label: pattern` (extended regex, case
// insensitive). Blank lines and lines starting with # are ignored.
// See provenance-deny.example.txt for the shape.
//
// Prefer word-bounded patterns (\bfoo\b). An unanchored fragment matches inside
// ordinary English and inside compiled binaries — one three-letter vendor name
// matched "covariant" in every .NET assembly and failed the build for a word the
// compiler uses constantly. A check that cries wolf gets disabled, and then it
// protects nothing.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Lockfiles carry upstream package names we do not control. Build output is
// excluded because a provenance leak lives in source we wrote, never in a
// vendored compiler — and scanning binaries produces noise, not findings.
const EXCLUDE = [
  ':!pnpm-lock.yaml',
  ':!package-lock.json',
  ':!**/bin/**',
  ':!**/obj/**',
  ':!**/dist/**',
  ':!.cyv-provenance-deny',
];

async function readDenyList() {
  const candidates = [
    process.env.CYV_PROVENANCE_DENY,
    path.join(REPO, '.cyv-provenance-deny'),
  ].filter((p) => typeof p === 'string' && p.length > 0);

  for (const file of candidates) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
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
    return { file, entries };
  }
  return null;
}

const deny = await readDenyList();

if (deny === null) {
  console.error('\n  No provenance deny list found.');
  console.error('  Set CYV_PROVENANCE_DENY, or create .cyv-provenance-deny in the repository root.');
  console.error('  See tools/provenance-deny.example.txt for the format.\n');
  console.error('  Failing rather than passing: a clean-room check that silently verifies nothing');
  console.error('  is worse than no check, because it reports success it never earned.\n');
  process.exit(2);
}

if (deny.entries.length === 0) {
  console.error(`\n  Deny list at ${deny.file} is empty — nothing would ever be caught.\n`);
  process.exit(2);
}

let failed = false;

for (const { label, pattern } of deny.entries) {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'git', ['grep', '-rniE', pattern, '--', '.', ...EXCLUDE], { cwd: REPO }));
  } catch (err) {
    // git grep exits 1 when there are no matches — that is the success case.
    if (err && err.code === 1) continue;

    // Anything else means the question could not be asked. The commonest cause
    // is a pattern this file's own guidance invites: git grep uses POSIX ERE,
    // so a Perl construct such as a negative lookahead is rejected with exit
    // 128. Reporting the raw rejection left the reader a Node stack trace and
    // no indication which of their lines was at fault.
    const detail = String(err?.stderr ?? err?.message ?? err).trim();
    console.error(`\n  ✗ could not run the pattern for "${label}"`);
    console.error(`      pattern:  ${pattern}`);
    console.error(`      from:     ${deny.file}`);
    console.error(`      git said: ${detail.replace(/^fatal: /, '')}`);
    console.error('\n  Patterns are POSIX extended regular expressions, which have no lookahead,');
    console.error('  no non-greedy quantifiers and no \\d shorthand. Rewrite the pattern, or');
    console.error('  narrow it by naming the specific term instead of excluding others.\n');
    console.error('  Exiting 2 rather than 1: the check did not run, so it found nothing and');
    console.error('  is not entitled to report a pass.\n');
    process.exit(2);
  }
  const hits = stdout.split('\n').filter(Boolean);
  if (hits.length) {
    failed = true;
    console.error(`\n  ✗ ${label}`);
    for (const hit of hits.slice(0, 10)) console.error(`      ${hit}`);
    if (hits.length > 10) console.error(`      … and ${hits.length - 10} more`);
  }
}

if (failed) {
  console.error('\n  Provenance check failed. This repository is a clean-room rebuild —');
  console.error('  see AGENTS.md. Rewrite the offending text rather than paraphrasing it.\n');
  process.exit(1);
}

console.log(`  ✓ provenance clean (${deny.entries.length} patterns)`);
