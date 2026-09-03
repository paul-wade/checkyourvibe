import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type HookManager = 'husky' | 'lefthook' | 'raw';

export interface InstallPlan {
  manager: HookManager;
  path: string;
  action: 'create' | 'update' | 'conflict';
  existing: string | null;
}

const MANAGED_MARKER = '# checkyourvibe-managed';
const BASELINE_FILENAME = 'checkyourvibe.baseline.json';

/** The environment variable that turns one commit's drift check off. */
export const DRIFT_SKIP_ENV = 'CYV_SKIP_DRIFT';

export interface HookOptions {
  /**
   * Whether the hook also runs `cyv doctor` and refuses the commit on drift.
   *
   * Defaults to false: a hook installed without `--with-drift-check` runs
   * `cyv check` alone, exactly as before this option existed. `driftCheckScript`
   * documents the two escapes and the exit-code rule the emitted script uses.
   */
  driftCheck?: boolean;
}

/**
 * The pre-commit hook runs `cyv check --staged --strict`.
 *
 * Requirement 4.1 says the hook must default to baseline-aware behaviour so
 * adopting it on a codebase with pre-existing debt does not block every
 * commit. Requirement 2.5 says `--since-baseline` is not the default for a
 * general `cyv check`. We reconcile the two by keeping `cyv check` unchanged
 * and making the installed hook explicitly pass `--since-baseline` when a
 * baseline exists. A user who wants the same filtered view at a terminal can
 * run the same command with `--since-baseline`; a user without a baseline gets
 * the same unfiltered `cyv check --staged` the hook used to run.
 *
 * Because passing `--since-baseline` when no baseline exists would make every
 * commit fail, the generated scripts test for the baseline file at hook time
 * and only add the flag when one is present.
 */

export async function detectHookManager(repoRoot: string): Promise<HookManager> {
  if (await directoryExists(join(repoRoot, '.husky'))) {
    return 'husky';
  }
  if (await fileExists(join(repoRoot, 'lefthook.yml')) || await fileExists(join(repoRoot, 'lefthook.yaml'))) {
    return 'lefthook';
  }
  return 'raw';
}

export async function planInstall(repoRoot: string, cyvCommand: string): Promise<InstallPlan> {
  const manager = await detectHookManager(repoRoot);
  const path = await hookPathForManager(repoRoot, manager);
  const existing = await readExisting(path);

  let action: InstallPlan['action'];
  if (existing === null) {
    action = 'create';
  } else if (existing.includes(MANAGED_MARKER)) {
    action = 'update';
  } else {
    action = 'conflict';
  }

  return { manager, path, action, existing };
}

export async function applyInstall(
  plan: InstallPlan,
  cyvCommand: string,
  opts: { force?: boolean } & HookOptions = {},
): Promise<void> {
  const { force = false, driftCheck = false } = opts;

  if (plan.action === 'conflict' && !force) {
    throw new Error(
      `A pre-commit hook already exists at ${plan.path} and is not managed by checkyourvibe ` +
      `(missing ${MANAGED_MARKER}). Re-run with force: true to replace it.`,
    );
  }

  const content = plan.manager === 'lefthook'
    ? generateLefthookConfig(cyvCommand, { driftCheck })
    : generateHookScript(cyvCommand, { driftCheck });

  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, content, 'utf8');

  if (plan.manager !== 'lefthook' && process.platform !== 'win32') {
    await chmod(plan.path, 0o755);
  }
}

async function hookPathForManager(repoRoot: string, manager: HookManager): Promise<string> {
  if (manager === 'raw') {
    return join(repoRoot, '.git', 'hooks', 'pre-commit');
  }
  if (manager === 'husky') {
    return join(repoRoot, '.husky', 'pre-commit');
  }

  const yml = join(repoRoot, 'lefthook.yml');
  const yaml = join(repoRoot, 'lefthook.yaml');
  if (await fileExists(yml)) {
    return yml;
  }
  if (await fileExists(yaml)) {
    return yaml;
  }
  return yml;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && hasErrorCode(error) && error.code === 'ENOENT';
}

function firstToken(command: string): string {
  const trimmed = command.trim();

  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    const quote = trimmed.charAt(0);
    const end = trimmed.indexOf(quote, 1);
    if (end !== -1) {
      return trimmed.slice(1, end);
    }
  }

  const end = trimmed.search(/\s/);
  if (end === -1) {
    return trimmed;
  }
  return trimmed.slice(0, end);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Make a command safe to interpolate into a `/bin/sh` script.
 *
 * Git hooks run under `sh` even on Windows, where `sh` treats a backslash as an
 * escape character. An unquoted Windows path is therefore silently mangled —
 * `R:\checkyourvibe\...` becomes `R:checkyourvibe...` and the hook dies with
 * "command not found" on every commit. Windows accepts forward slashes in paths
 * everywhere that matters, so normalising is both safe and sufficient, and it
 * leaves POSIX paths (which contain no backslashes) untouched.
 */
function toShellPath(command: string): string {
  return command.replace(/\\/g, '/');
}

function isPathToExecutable(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/**
 * Turn the stored `cyvCommand` into a command a `/bin/sh` hook can actually run.
 *
 * A `.js` or `.mjs` value is invoked through `node` so the hook does not depend on
 * the file having a shebang or an executable bit. A bare name like `cyv` or a
 * wrapper command like `npx cyv` is used as-is. Only actual paths are quoted if
 * they contain spaces or quotes that would otherwise be interpreted by the shell.
 */
function toRunnableBackstopCommand(cyvCommand: string): string {
  const shellPath = toShellPath(cyvCommand);
  if (shellPath.endsWith('.js') || shellPath.endsWith('.mjs')) {
    return `node ${shellSingleQuote(shellPath)}`;
  }
  if (isPathToExecutable(shellPath) && (shellPath.includes(' ') || shellPath.includes("'"))) {
    return shellSingleQuote(shellPath);
  }
  return shellPath;
}

/**
 * The `/bin/sh` that runs `cyv doctor` before the check, emitted only when the
 * hook was installed with `--with-drift-check`.
 *
 * It has two escapes and one exit-code rule.
 *
 * The first escape is automatic: the check does not run while git is part-way
 * through a rebase, merge, cherry-pick, revert or bisect, detected from the
 * state files git writes into `$GIT_DIR` for each. Those states are not
 * reachable from the hook's own arguments, so they are read from disk.
 *
 * The second is `${DRIFT_SKIP_ENV}=1 git commit`, which skips the check for one
 * commit. The message printed on a block names it.
 *
 * Exit 1 from `cyv doctor` means drift, and blocks. Any other non-zero exit
 * means doctor could not determine whether there is drift, and does not block:
 * `cyv check` runs next and fails on the same unreadable config or unresolvable
 * analyzer, with the report attached.
 */
function driftCheckScript(shellCommand: string): string {
  return `
# Drift check (installed with --with-drift-check).
#
# Runs \`cyv doctor\` and refuses the commit when it exits 1, meaning the applied
# agent glue no longer matches what \`cyv init\` would write.
#
# Skipped while git is part-way through a rebase, merge, cherry-pick, revert or
# bisect. Skipped for one commit with ${DRIFT_SKIP_ENV}=1 git commit. Removed
# entirely by re-running \`cyv install-hooks\` without --with-drift-check.
git_dir=$(git rev-parse --git-dir 2>/dev/null || echo ".git")
in_progress=0
for state in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
  if [ -e "\${git_dir}/\${state}" ]; then
    in_progress=1
  fi
done

if [ "\${${DRIFT_SKIP_ENV}:-}" = "" ] && [ "$in_progress" = 0 ]; then
  ${shellCommand} doctor >/dev/null 2>&1
  doctor_status=$?
  if [ "$doctor_status" = 1 ]; then
    echo 'checkyourvibe: the generated agent glue has drifted from what \`cyv init\` would write.' >&2
    echo 'Run \`cyv doctor\` to see what, and \`cyv init\` to reapply.' >&2
    echo 'To commit without this check: ${DRIFT_SKIP_ENV}=1 git commit' >&2
    exit 1
  fi
  if [ "$doctor_status" != 0 ]; then
    echo 'checkyourvibe: \`cyv doctor\` could not report on drift (exit '"$doctor_status"').' >&2
    echo 'Not blocking on that — the check below fails on the same cause with a report attached.' >&2
  fi
fi
`;
}

function generateHookScript(cyvCommand: string, opts: HookOptions = {}): string {
  const shellCommand = toRunnableBackstopCommand(cyvCommand);
  const firstWord = firstToken(shellCommand);
  const drift = opts.driftCheck === true ? driftCheckScript(shellCommand) : '';

  return `#!/bin/sh
${MANAGED_MARKER}

# Guard against a missing checkyourvibe command so a broken install never blocks every commit.
first_word=${shellSingleQuote(firstWord)}
if ! command -v "$first_word" >/dev/null 2>&1 && [ ! -x "$first_word" ]; then
  echo ${shellSingleQuote(`checkyourvibe pre-commit hook is installed, but the checkyourvibe command (${shellCommand}) cannot be found.`)} >&2
  echo 'Reinstall checkyourvibe and run \`cyv install-hooks\` to regenerate this hook.' >&2
  exit 0
fi
${drift}
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
if [ -f "\${repo_root}/${BASELINE_FILENAME}" ]; then
  ${shellCommand} check --staged --strict --since-baseline
else
  ${shellCommand} check --staged --strict
fi
exit $?
`;
}

function yamlQuote(value: string): string {
  if (value.includes("'")) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return `'${value}'`;
}

/**
 * The lefthook form of `driftCheckScript`, on one line because a lefthook
 * `run:` value is a single scalar.
 *
 * Same two escapes and same exit-code rule; the state-file loop is unrolled
 * into one `[ -e ... ]` chain so the whole thing survives being a single
 * command string.
 */
function lefthookDriftCommand(command: string): string {
  const states = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
  const inProgress = states.map((state) => `-e "$git_dir/${state}"`).join(' -o ');

  return [
    'git_dir=$(git rev-parse --git-dir 2>/dev/null || echo ".git")',
    `if [ -z "\${${DRIFT_SKIP_ENV}:-}" ] && [ ! \\( ${inProgress} \\) ]; then`,
    `  ${command} doctor >/dev/null 2>&1;`,
    '  doctor_status=$?;',
    '  if [ "$doctor_status" = 1 ]; then',
    "    echo 'checkyourvibe: generated agent glue has drifted. Run `cyv doctor`, then `cyv init`.' >&2;",
    `    echo 'To commit without this check: ${DRIFT_SKIP_ENV}=1 git commit' >&2;`,
    '    exit 1;',
    '  fi;',
    'fi;',
  ].join(' ');
}

function generateLefthookConfig(cyvCommand: string, opts: HookOptions = {}): string {
  const command = toRunnableBackstopCommand(cyvCommand);
  const drift = opts.driftCheck === true ? `${lefthookDriftCommand(command)} ` : '';
  const run = `${drift}repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "."); if [ -f "$repo_root/${BASELINE_FILENAME}" ]; then ${command} check --staged --strict --since-baseline; else ${command} check --staged --strict; fi`;

  return `${MANAGED_MARKER}
pre-commit:
  commands:
    checkyourvibe:
      run: ${yamlQuote(run)}
`;
}
