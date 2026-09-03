/**
 * One platform-neutral description of the gate, from which every platform's
 * config is rendered.
 *
 * Spec 0019 Requirement 2 asks for this shape directly: seven hand-maintained
 * pipeline files that agree today drift apart the first time a flag changes, so
 * the steps live here once and each renderer translates them. A renderer may
 * add something only its platform can express — an Azure logging command, a
 * GitLab `image:` — but it may not invent a step the model does not have.
 */
import type { DetectedPackageManager, PackageManagerId } from './detect.js';

/** The Node major the generated pipelines set up. Matches this project's own CI. */
export const GATE_NODE_VERSION = '20';

/** The baseline file the gate tests for before deciding whether to pass `--since-baseline`. */
export const BASELINE_FILENAME = 'checkyourvibe.baseline.json';

export type GateStep =
  /** Clone with full history, so a later switch to a diff-scoped mode has a merge base to find. */
  | { kind: 'checkout'; fetchDepth: 0 }
  | { kind: 'setup-node'; version: string }
  /** Corepack is how pnpm and yarn get onto a runner that ships only npm. */
  | { kind: 'enable-corepack' }
  | { kind: 'install-dependencies'; command: string }
  | { kind: 'run-gate'; script: string };

export interface GateModel {
  steps: GateStep[];
  /**
   * How the pipeline reaches `cyv`, and whether that was resolved from a
   * declared dependency or is a bare name the runner has to supply.
   */
  invocation: GateInvocation;
  packageManager: DetectedPackageManager | undefined;
}

export interface GateInvocation {
  /** The command the pipeline runs, e.g. `pnpm exec cyv` or a bare `cyv`. */
  command: string;
  /**
   * True when the repository declares checkyourvibe as a dependency, so the
   * install step the pipeline already runs puts `cyv` within reach.
   *
   * False means the generated file names a command nothing in the pipeline
   * installs. That is stated in the file's own comments and in the plan, rather
   * than shipped as a pipeline that looks complete and fails on first run.
   */
  resolvedFromDependency: boolean;
}

const RUNNERS: Record<PackageManagerId, string> = {
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  npm: 'npx --no-install',
  bun: 'bunx',
};

const INSTALL_COMMANDS: Record<PackageManagerId, string> = {
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  npm: 'npm ci',
  bun: 'bun install --frozen-lockfile',
};

/**
 * Whether a package manager needs corepack turned on before it can be invoked.
 *
 * Every hosted runner in this list ships npm; pnpm and yarn arrive through
 * corepack, which is bundled with Node but off by default.
 */
function needsCorepack(id: PackageManagerId): boolean {
  return id === 'pnpm' || id === 'yarn';
}

export function resolveInvocation(
  packageManager: DetectedPackageManager | undefined,
  dependency: string | undefined,
): GateInvocation {
  if (dependency === undefined || packageManager === undefined) {
    return { command: 'cyv', resolvedFromDependency: false };
  }
  return { command: `${RUNNERS[packageManager.id]} cyv`, resolvedFromDependency: true };
}

/**
 * The shell the gate step runs, in `/bin/sh`.
 *
 * `--all` rather than a diff-scoped mode, deliberately. A diff-scoped run whose
 * base ref could not be resolved produces an empty diff, exit 0, and a green
 * build that checked nothing — spec 0019 Requirement 1.2 names that as the
 * outcome this whole area exists to prevent, and `discover.ts` reaches it today
 * on a shallow clone. `--all` has no base ref to get wrong: `0 files checked`
 * from `--all` means the analyzers claim no files, which is a different and
 * visible statement.
 *
 * `--strict` so a file an analyzer could not read fails the build instead of
 * being quietly dropped from the count.
 *
 * `--since-baseline` only when a baseline file is present, matching the git
 * hook: passing it without one makes `cyv check` exit 2 on every run, and
 * omitting it where one exists makes the first CI run fail on debt the team
 * already agreed to defer.
 */
export function gateScript(invocation: GateInvocation): string {
  const cyv = invocation.command;
  return [
    `if [ -f ${BASELINE_FILENAME} ]; then`,
    `  ${cyv} check --all --strict --since-baseline`,
    'else',
    `  ${cyv} check --all --strict`,
    'fi',
  ].join('\n');
}

export function buildGateModel(
  packageManager: DetectedPackageManager | undefined,
  dependency: string | undefined,
): GateModel {
  const invocation = resolveInvocation(packageManager, dependency);
  const steps: GateStep[] = [
    { kind: 'checkout', fetchDepth: 0 },
    { kind: 'setup-node', version: GATE_NODE_VERSION },
  ];

  if (packageManager !== undefined) {
    if (needsCorepack(packageManager.id)) {
      steps.push({ kind: 'enable-corepack' });
    }
    steps.push({ kind: 'install-dependencies', command: INSTALL_COMMANDS[packageManager.id] });
  }

  steps.push({ kind: 'run-gate', script: gateScript(invocation) });

  return { steps, invocation, packageManager };
}
