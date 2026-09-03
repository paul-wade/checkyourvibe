/**
 * `cyv install-ci` — detect the CI system a repository uses and offer it a gate.
 *
 * Why its own command rather than a flag on `install-hooks` or a step inside
 * `init`:
 *
 * `install-hooks` writes one file, to a path git decides, with its own
 * conflict rule and its own `--force`. It is the local backstop, and the thing
 * it guarantees is that a commit made on this machine was checked. A CI gate is
 * a different guarantee about a different machine, lands in files the whole
 * team reads, and needs the plan/diff/confirm machinery `install-hooks`
 * deliberately does not have. Folding the two together would produce one
 * command with two flag sets and two meanings for `--force`.
 *
 * `init` is the wrong home for the opposite reason: it is already the command
 * that adopts agents, offers a baseline, and can reach outside the repository.
 * Adding a CI file to what `init --yes` writes would enlarge the blast radius
 * of a flag that currently means "do not ask me about the agents you already
 * found". Committing a pipeline file is a decision a team makes once and
 * reviews; it should have to be asked for by name.
 *
 * What this command shares with `init` is everything that matters: the same
 * `PlannedWrite`s, the same managed blocks, the same `planDiff` preview, and
 * the same refusal to write without confirmation.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Command, CommandContext } from './types.js';
import { repoRoot } from '../run/discover.js';
import { applyPlannedWrite, planDiff } from '../merge/apply.js';
import { MANAGED_BLOCK_START, type PlannedWrite } from '../protocol/index.js';
import {
  BASELINE_FILENAME,
  CI_SYSTEM_IDS,
  CI_SYSTEM_NAMES,
  buildGateModel,
  detectCi,
  readFileOrNull,
  renderGate,
  type CiDetection,
  type CiGate,
  type CiSystemId,
  type GateModel,
} from '../ci/index.js';
import { confirm } from './baseline.js';

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ParsedArgs {
  yes: boolean;
  dryRun: boolean;
  force: boolean;
  /** Systems named explicitly, for a repository that has not set one up yet. */
  requested: CiSystemId[];
  help: boolean;
}

function isCiSystemId(value: string): value is CiSystemId {
  for (const id of CI_SYSTEM_IDS) {
    if (id === value) {
      return true;
    }
  }
  return false;
}

function parseArgs(argv: string[]): ParsedArgs {
  let yes = false;
  let dryRun = false;
  let force = false;
  let help = false;
  const requested: CiSystemId[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--system') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`--system requires one of: ${CI_SYSTEM_IDS.join(', ')}.`);
      }
      if (!isCiSystemId(next)) {
        throw new Error(`--system "${next}" is not one of: ${CI_SYSTEM_IDS.join(', ')}.`);
      }
      requested.push(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument "${arg}" for cyv install-ci.`);
    }
  }

  return { yes, dryRun, force, requested, help };
}

function usage(): string {
  return [
    'Usage: cyv install-ci [options]',
    '',
    'Detect the CI system this repository uses and offer it a gate that runs',
    '`cyv check --all --strict` and fails the build on a non-zero exit.',
    '',
    'Options:',
    '  --system <id>   Render a gate for this system even if it was not detected.',
    `                  One of: ${CI_SYSTEM_IDS.join(', ')}. Repeatable.`,
    '  --dry-run       Print the plan and write nothing.',
    '  --yes, -y       Apply without the confirmation prompt.',
    '  --force         Replace a file at a checkyourvibe-owned path that carries no',
    '                  checkyourvibe marker. Never needed to append to a shared',
    '                  config file: those are managed blocks and are additive.',
    '  --help, -h      This text.',
  ].join('\n');
}

/**
 * A path this command chose the name of, as opposed to the platform's own
 * canonical config file.
 *
 * The distinction decides what "already exists" means. Appending a managed
 * block to `.gitlab-ci.yml` is additive and safe no matter what is in it —
 * that is what the strategy is for. A file at
 * `.github/workflows/checkyourvibe.yml` with no checkyourvibe marker in it is
 * somebody else's workflow that happens to share the name this command picked,
 * and rewriting it is not additive at all. That one is refused.
 */
function isOwnedPath(gate: CiGate): boolean {
  return gate.system === 'github-actions' || gate.system === 'azure-pipelines';
}

interface Conflict {
  gate: CiGate;
  path: string;
}

async function findConflict(gate: CiGate, write: PlannedWrite): Promise<Conflict | undefined> {
  if (!isOwnedPath(gate) || write.blockId === undefined) {
    return undefined;
  }

  const existing = await readFileOrNull(write.path);
  if (existing === null) {
    return undefined;
  }

  const marker = MANAGED_BLOCK_START(write.blockId, write.blockComment);
  if (existing.includes(marker)) {
    return undefined;
  }

  return { gate, path: write.path };
}

function describeDetection(detection: CiDetection, requested: CiSystemId[]): string[] {
  const lines: string[] = [];

  if (detection.systems.length === 0) {
    lines.push('CI systems detected: none.');
  } else {
    lines.push('CI systems detected:');
    for (const system of detection.systems) {
      lines.push(`  ${system.name} — ${system.evidence.join(', ')}`);
    }
  }

  const absentNames = detection.absent.map((id) => CI_SYSTEM_NAMES[id]);
  if (absentNames.length > 0) {
    lines.push(`Looked for and not present: ${absentNames.join(', ')}.`);
  }

  const named = requested.filter((id) => !detection.systems.some((system) => system.id === id));
  if (named.length > 0) {
    lines.push(
      `Named with --system despite not being detected: ${named.map((id) => CI_SYSTEM_NAMES[id]).join(', ')}.`,
    );
  }

  lines.push(
    detection.packageManager === undefined
      ? 'Package manager: none detected. No lockfile and no `packageManager` field, so the gate installs nothing and expects `cyv` to already be on the runner.'
      : `Package manager: ${detection.packageManager.id} — ${detection.packageManager.evidence}.`,
  );

  lines.push(
    detection.hookFrameworks.length === 0
      ? 'Hook frameworks: none detected (no .husky/, .pre-commit-config.yaml or lefthook.yml).'
      : `Hook frameworks: ${detection.hookFrameworks.map((f) => `${f.name} (${f.evidence})`).join(', ')}.`,
  );

  lines.push(
    detection.dependency === undefined
      ? 'checkyourvibe dependency: not declared in package.json. The generated gate names a bare `cyv`, and says so in its own comments.'
      : `checkyourvibe dependency: ${detection.dependency}.`,
  );

  return lines;
}

/** What the gate runs, stated once above the per-platform plan. */
function describeGateCommand(model: GateModel): string[] {
  const cyv = model.invocation.command;
  return [
    'The gate runs, on every push and pull request:',
    '',
    `  ${cyv} check --all --strict`,
    `  ${cyv} check --all --strict --since-baseline   (when ${BASELINE_FILENAME} is present)`,
    '',
    'A non-zero exit fails the build. `--strict` means a file an analyzer could not',
    'read fails it too, rather than being dropped from the count. `--all` rather than',
    'a diff-scoped mode because a diff whose base ref could not be resolved is empty,',
    'and an empty diff and a clean run are indistinguishable once that happens.',
  ];
}

function printManual(gate: CiGate): void {
  console.log(`\n  ${gate.name}: nothing written.`);
  if (gate.manualReason !== undefined) {
    console.log(`    ${gate.manualReason}`);
  }
  console.log('');
  for (const line of gate.snippet.split('\n')) {
    console.log(`    ${line}`);
  }
  for (const step of gate.followUp) {
    console.log(`\n    Then: ${step}`);
  }
}

export const command: Command = {
  async run(ctx: CommandContext): Promise<number> {
    let parsed: ParsedArgs;
    try {
      parsed = parseArgs(ctx.argv);
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }

    if (parsed.help) {
      console.log(usage());
      return 0;
    }

    try {
      const root = await repoRoot(ctx.cwd);
      const detection = await detectCi(root);

      const targets: CiSystemId[] = [];
      for (const system of detection.systems) {
        targets.push(system.id);
      }
      for (const id of parsed.requested) {
        if (!targets.includes(id)) {
          targets.push(id);
        }
      }

      console.log('cyv install-ci plan:');
      console.log('');
      for (const line of describeDetection(detection, parsed.requested)) {
        console.log(line);
      }

      if (targets.length === 0) {
        console.log('');
        console.log(
          'No CI system detected, so no gate was rendered. That is a statement about this\n' +
            'repository, not a failure: `cyv install-hooks` remains the local backstop, and\n' +
            'nothing here is broken.',
        );
        console.log(
          `To set one up anyway, name it: cyv install-ci --system <${CI_SYSTEM_IDS.join('|')}>`,
        );
        return 0;
      }

      const model = buildGateModel(detection.packageManager, detection.dependency);
      const gates = targets.map((id) => renderGate(id, root, model));

      console.log('');
      for (const line of describeGateCommand(model)) {
        console.log(line);
      }

      const conflicts: Conflict[] = [];
      const replacements: Conflict[] = [];
      const writes: PlannedWrite[] = [];
      const writeGates: CiGate[] = [];

      for (const gate of gates) {
        const write = gate.write;
        if (write === undefined) {
          continue;
        }
        const conflict = await findConflict(gate, write);
        if (conflict !== undefined) {
          if (parsed.force) {
            replacements.push(conflict);
          } else {
            conflicts.push(conflict);
          }
          continue;
        }
        writes.push(write);
        writeGates.push(gate);
      }

      const diffs = await planDiff(writes);

      console.log('');
      console.log('Files this run would write:');
      if (writes.length === 0) {
        console.log('  (none)');
      }
      for (let i = 0; i < writes.length; i += 1) {
        const write = writes[i];
        const diff = diffs[i];
        const gate = writeGates[i];
        if (write === undefined || diff === undefined || gate === undefined) {
          continue;
        }
        console.log(`\n  ${gate.name}:`);
        console.log(`    [${diff.changed ? '~' : '='}] ${write.path}`);
        console.log(`        ${write.description}`);
        if (diff.changed && diff.preview.length > 0) {
          for (const line of diff.preview.split('\n')) {
            console.log(`        ${line}`);
          }
        }
        for (const step of gate.followUp) {
          console.log(`        Then: ${step}`);
        }
      }

      if (replacements.length > 0) {
        console.log('');
        console.log('Replaced wholesale (--force), discarding what is there now:');
        for (const replacement of replacements) {
          console.log(`\n  ${replacement.gate.name}:`);
          console.log(`    [!] ${replacement.path}`);
          console.log(
            '        This file carries no checkyourvibe marker, so there is no block to update.\n' +
              '        --force discards it and writes the gate below in its place. Appending instead\n' +
              '        would leave two documents in one file.',
          );
          console.log('');
          for (const line of replacement.gate.snippet.split('\n')) {
            console.log(`        ${line}`);
          }
        }
      }

      const manualGates = gates.filter((gate) => gate.delivery === 'manual');
      if (manualGates.length > 0) {
        console.log('');
        console.log('Printed, not written:');
        for (const gate of manualGates) {
          printManual(gate);
        }
      }

      if (conflicts.length > 0) {
        console.log('');
        console.error('Not written, because a file is already there and checkyourvibe did not write it:');
        for (const conflict of conflicts) {
          console.error(`  ${conflict.path}`);
          console.error(
            `    ${conflict.gate.name}: this path carries no checkyourvibe marker, so replacing it would\n` +
              '    discard whatever it is. Inspect it, then re-run with --force to replace it, or move it\n' +
              '    aside. The gate it would have written follows, so it can be added by hand instead:',
          );
          console.error('');
          for (const line of conflict.gate.snippet.split('\n')) {
            console.error(`    ${line}`);
          }
        }
      }

      const changed = diffs.filter((diff) => diff.changed).length + replacements.length;
      const total = writes.length + replacements.length;
      console.log(`\n${changed} of ${total} file(s) would change.`);

      const refused = conflicts.length > 0 ? 1 : 0;

      if (parsed.dryRun || changed === 0) {
        return refused;
      }

      const proceed = await confirm(
        parsed.yes,
        'Apply these changes?',
        'Refusing to write without confirmation: stdin is not a TTY and --yes was not passed. ' +
          'Re-run with --yes to apply non-interactively, or run this interactively to confirm.',
      );
      if (!proceed) {
        console.error('Aborted: not confirmed.');
        return 1;
      }

      console.log('Applied:');

      // A forced replacement removes the unmarked file first. `managed-block`
      // appends when it finds no marker, which is right for a shared config
      // file and wrong for a whole-document one: appending a second `name:`,
      // `on:` and `jobs:` to a workflow file produces YAML that no longer
      // parses. Removing first makes the merge see an absent target and write
      // the block alone.
      for (const replacement of replacements) {
        await rm(replacement.path, { force: true });
      }

      const applied: PlannedWrite[] = [...writes];
      for (const replacement of replacements) {
        const write = replacement.gate.write;
        if (write !== undefined) {
          applied.push(write);
        }
      }

      for (const write of applied) {
        await mkdir(dirname(write.path), { recursive: true });
        const outcome = await applyPlannedWrite(write);
        const status = outcome.before === null ? 'created' : outcome.changed ? 'updated' : 'unchanged';
        console.log(`  [${status}] ${outcome.path}`);
      }

      return refused;
    } catch (err) {
      console.error(messageFor(err));
      return 2;
    }
  },
};
