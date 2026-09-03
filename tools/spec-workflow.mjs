#!/usr/bin/env node
// Check that specs follow the workflow AGENTS.md describes: requirements, then
// design, then tasks each carrying an `_Exec:` line, and only then dispatch.
//
//   node tools/spec-workflow.mjs
//
// Written because the prose version was advisory and did not hold. Of 33 specs,
// 22 hold requirements and nothing else: they were written, and never planned.
// One was started by dispatching work with no design and no tasks at all, and
// when the agent died mid-run there was no record of what it had been asked for.
//
// What counts as a violation is deliberately narrower than "every spec must be
// complete". A spec with no tasks.md is UNPLANNED, which is a legitimate state —
// an idea recorded against a number. Demanding a design document for an idea
// nobody has committed to would make the check something to be silenced.
//
// A violation is a spec that has started being worked without being planned:
//
//   - tasks.md holds OPEN tasks but design.md does not exist. Work is being
//     dispatched against decisions nobody wrote down. A spec whose tasks are all
//     finished is history: a design document written for it now would be
//     archaeology, and the check would be something to silence rather than
//     something to obey.
//   - a task has no `_Exec:` line. It names no lane and no gate, so it cannot
//     be dispatched or verified, which means it is not a task yet.
//   - a spec folder holds no requirements.md. It is not a spec.

import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SPECS = path.join(REPO, 'docs', 'specs');

/** A task line: `- [ ] **T1234** title` or `- [x] **T1234** title`. */
const TASK = /^- \[([ xX])\]\s*\*\*(T\d+)\*\*\s*(.*)$/;
const EXEC = /^\s*_Exec:/;

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every task in a tasks.md, with whether an `_Exec:` line follows it.
 *
 * The line may sit several lines below the task, after its description, so the
 * search runs to the next task or heading rather than to the next line.
 */
function tasksIn(text) {
  const lines = text.split(/\r?\n/);
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const match = TASK.exec(lines[i] ?? '');
    if (match === null) continue;

    let hasExec = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (TASK.test(line) || /^##/.test(line)) break;
      if (EXEC.test(line)) {
        hasExec = true;
        break;
      }
    }

    found.push({ id: match[2] ?? '', done: (match[1] ?? '').toLowerCase() === 'x', hasExec });
  }

  return found;
}

async function main() {
  let entries;
  try {
    entries = await readdir(SPECS, { withFileTypes: true });
  } catch {
    process.stderr.write(`No spec directory at ${SPECS}.\n`);
    process.exit(2);
  }

  const specs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const violations = [];
  let planned = 0;
  let unplanned = 0;

  for (const id of specs) {
    const dir = path.join(SPECS, id);
    const hasRequirements = await exists(path.join(dir, 'requirements.md'));
    const hasDesign = await exists(path.join(dir, 'design.md'));
    const tasksPath = path.join(dir, 'tasks.md');
    const hasTasks = await exists(tasksPath);

    if (!hasRequirements) {
      violations.push(`${id}: no requirements.md, so this is not a spec.`);
      continue;
    }

    if (!hasTasks) {
      unplanned += 1;
      continue;
    }

    planned += 1;

    const text = await readFile(tasksPath, 'utf-8');
    const tasks = tasksIn(text);
    const open = tasks.filter((t) => !t.done);

    if (!hasDesign && open.length > 0) {
      violations.push(
        `${id}: has ${open.length} open task(s) but no design.md. Work is being ` +
          `dispatched against decisions nobody wrote down.`,
      );
    }

    const withoutExec = open.filter((t) => !t.hasExec);
    for (const task of withoutExec) {
      violations.push(
        `${id}: task ${task.id} has no _Exec: line, so it names no lane and no ` +
          `gate. It cannot be dispatched or verified.`,
      );
    }
  }

  process.stdout.write(
    `${specs.length} spec(s): ${planned} planned, ${unplanned} holding requirements only.\n`,
  );
  process.stdout.write(
    'A spec with no tasks.md is unplanned, which is a legitimate state and not reported.\n\n',
  );

  if (violations.length === 0) {
    process.stdout.write('Every planned spec has a design and every task names its lane.\n');
    return;
  }

  for (const v of violations) {
    process.stdout.write(`  ${v}\n`);
  }
  process.stderr.write(
    `\n${violations.length} workflow violation(s). AGENTS.md, "How work is planned": ` +
      'requirements, then design, then tasks each carrying an _Exec: line, then dispatch.\n',
  );
  process.exit(1);
}

await main();
