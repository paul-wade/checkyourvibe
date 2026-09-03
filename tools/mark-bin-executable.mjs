/**
 * Make the built CLI entry executable.
 *
 * `packages/core/package.json` declares `bin: { cyv: "./dist/cli/index.js" }`
 * and the source carries a `#!/usr/bin/env node` shebang, but `tsc` emits the
 * file with whatever the umask gives — 644 here. A package manager sets the bit
 * when it links the bin, so the mode depended on whether install or build ran
 * last, and `pnpm build` on an installed checkout took it away again.
 *
 * `toRunnableCommand` runs the entry directly when it is executable, which is
 * what keeps a generated hook command working across a Node upgrade, so the bit
 * has to be set by the build rather than by whoever happened to install.
 */
import { chmod, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'packages/core/dist/cli/index.js');

const info = await stat(entry);

// Keep whatever read/write bits are already there; add execute wherever read is
// granted, which is what `chmod +x` does.
const mode = info.mode & 0o777;
const executable = mode | ((mode & 0o444) >> 2);

if (mode !== executable) {
  await chmod(entry, executable);
  console.log(`Marked ${entry} executable (${mode.toString(8)} -> ${executable.toString(8)})`);
}
