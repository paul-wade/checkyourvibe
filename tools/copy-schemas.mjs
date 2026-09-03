#!/usr/bin/env node
// Copy the protocol JSON schemas into the core package's build output.
//
// The conformance suite reads them at runtime. They live in `docs/protocol/`
// because they are the published contract and belong beside the protocol
// documentation — but a published npm package cannot reach outside itself, so
// a copy has to ship inside `dist/`.
//
// This was found by packing the tarball and running `cyv verify-analyzer`
// against it: the suite resolved `../../../../docs/protocol/`, which is the
// repository root from a clone and `node_modules/docs/protocol/` from an
// install. Every installed user got an ENOENT from the one command a
// third-party analyzer author needs most.
import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'docs', 'protocol');
const target = path.join(repoRoot, 'packages', 'core', 'dist', 'schema');

const entries = await readdir(source);
const schemas = entries.filter((name) => name.endsWith('.schema.json'));

if (schemas.length === 0) {
  console.error(`No *.schema.json found in ${source}. Refusing to produce an empty dist/schema/.`);
  process.exit(2);
}

await mkdir(target, { recursive: true });
for (const name of schemas) {
  await copyFile(path.join(source, name), path.join(target, name));
}
console.log(`Copied ${schemas.length} schema(s) into ${path.relative(repoRoot, target)}`);
