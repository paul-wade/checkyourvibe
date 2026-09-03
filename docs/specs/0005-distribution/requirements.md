# 0005 — Distribution and installers: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0003

## Introduction

The repository is installable today only as a local clone. The README documents that
workflow, and the root `package.json` and every workspace package under `packages/`
still carry `private: true`. Nothing is published to any registry, and no installer
exists.

`cyv init` currently resolves the local checkout's own `cyv` entry point and embeds an
absolute path to it in generated agent glue. `cyv doctor` already reports drift when
that path stops resolving. Distribution turns that from a caveat into a supported
flow: a published binary has a stable invocation, and `npx <package> init` can run
without the user ever cloning the repository.

There are seven npm workspace packages — `core`, `analyzer-typescript`,
`adapter-claude-code`, `adapter-cursor`, `adapter-gemini`, `adapter-antigravity`, and
`adapter-codex` — all of which are `private: true` and depend on each other via
`workspace:*`. `packages/analyzer-csharp` is a .NET project, not part of the npm
workspace, and its `analyzer.manifest.json` points at a built DLL. How a non-npm
analyzer is distributed alongside the npm packages is a real open question this spec
addresses rather than skips.

The zero-token-cost constraint from the roadmap applies here: distribution may use the
network to download packages, but it may never require an API key, a licence check, a
phone-home step, or telemetry.

## Verified state before writing this spec

- Every workspace `package.json` has `private: true` and version `0.1.0`.
- `pnpm-workspace.yaml` includes only `packages/*`.
- `packages/core/package.json` exposes the `cyv` binary at `dist/cli/index.js`.
- `packages/analyzer-typescript/analyzer.manifest.json` uses `exec.type: "node"` and a
  relative module path that the registry loader resolves against the manifest's own
  directory.
- `packages/analyzer-csharp/analyzer.manifest.json` uses `exec.type: "process"` and
  invokes `dotnet` with a relative DLL path under `src/bin/Release/net9.0/`.
- `cyv init` and `cyv doctor` live in `packages/core/src/cli/` and already implement
  local-path resolution and drift detection.
- No `cyv upgrade` command exists yet; the command table in `packages/core/src/cli/index.ts`
  lists it as not implemented.

## Requirement 1 — Package metadata

1. Every publishable npm package SHALL include accurate `description`, `license`,
   `repository`, `author`, and `files` fields.
2. The `license` field for every package SHALL be `"MIT"`.
3. The `files` field SHALL be a whitelist that includes only the built output needed at
   runtime and the analyzer manifest where applicable; it SHALL exclude test files, test
   fixtures, source maps, and TypeScript source.
4. The TypeScript analyzer package SHALL list `analyzer.manifest.json` in `files`.
5. A package that still carries `private: true` SHALL NOT be published until that field
   is removed or changed; the decision of which packages become public is a release
   decision.

## Requirement 2 — Naming and the `npx` entry point

1. The CLI package SHALL be published under a name that makes `npx <package-name> init`
   work on a machine with nothing else installed. The choice of public package name is a
   release decision.
2. The published package's `bin` field SHALL expose the `cyv` command.
3. `npx <package-name> <subcommand>` SHALL execute without requiring a global install, a
   checkout, or an account key.

## Requirement 3 — Versioning across the workspace

1. All publishable packages released together SHALL share a single version number.
2. Inter-package dependencies in the workspace use `workspace:*`; the release workflow
   SHALL resolve these to the exact published versions of that release before any package
   is published.
3. The version SHALL be driven from a single source of truth — for example, the root
   `package.json` or a `VERSION` file — and propagated to every package that ships.

## Requirement 4 — `cyv init` from a published package

1. `npx <package-name> init` SHALL run `cyv init` and produce a working project
   configuration.
2. The generated `checkyourvibe.json` SHALL use portable analyzer references — npm
   package specifiers, relative paths inside the installed package, or bundled manifest
   paths — rather than absolute paths to the user's local checkout.
3. `cyv init` SHALL resolve analyzer packages through normal npm module resolution when
   the analyzer is declared as a package name.
4. WHERE an analyzer is optional and not installed, `cyv init` SHALL either install it
   with user consent or explain how to install it, and SHALL NOT leave the configuration
   pointing at a missing package.

## Requirement 5 — Generated agent glue references a stable binary

1. WHEN the CLI is running from an installed package, `cyv init` SHALL resolve the
   `cyvCommand` value to a stable invocation that survives package moves and upgrades —
   for example, the bare command name `cyv` on `PATH` or the package's published `bin`
   entry.
2. The `cyvCommand` value embedded in generated hook configurations SHALL NOT be an
   absolute path inside a transient `npx` cache.
3. Agent adapters SHALL format `cyvCommand` into a runnable shell command that works
   whether the value is a bare command or a path to a JavaScript entry point.
4. `cyv doctor` SHALL continue to detect drift when the referenced `cyv` binary is
   missing or no longer matches the installed package.

## Requirement 6 — `cyv upgrade` when rule manifests change

1. `cyv upgrade` SHALL load the current `checkyourvibe.json`, re-resolve every configured
   analyzer manifest, and rebuild the rule catalog.
2. It SHALL re-plan generated agent glue for every configured agent using the current
   catalog.
3. It SHALL update per-rule guidance files when their rule's `summary`, `why`,
   `allowedFixes`, `notFixes`, or `examples` have changed.
4. It SHALL remove per-rule guidance files for rules that no longer exist in the
   catalog, but only from locations and files it previously generated and can identify.
5. It SHALL NOT overwrite user-edited agent files unless the user explicitly passes a
   `--force` flag; it SHALL report which files changed, which are stale, and which could
   not be updated.
6. It SHALL report stale `checkyourvibe.json` entries, such as an analyzer `package`
   field that no longer resolves to a valid manifest.
7. `cyv upgrade` and `cyv init` SHALL use the same planning and merge logic so the user
   sees the same behaviour from both commands.

## Requirement 7 — A user without .NET

1. The C# analyzer SHALL be optional. `cyv check` SHALL report its absence clearly,
   continue with other analyzers, and SHALL NOT fail with an opaque spawn error.
2. `cyv init` SHALL detect whether `dotnet` is on `PATH`; if it is not, the C# analyzer
   SHALL NOT be added to the default configuration.
3. `install.sh` SHALL warn when `dotnet` is missing, explain that the C# analyzer will be
   unavailable, and continue.
4. The C# analyzer's distribution format — prebuilt DLL inside an npm package, source
   build under `dotnet build`, or a separate .NET release artifact — SHALL be decided and
   documented before the first release that includes it.
5. The C# analyzer's manifest SHALL keep its `exec.command` and `args` resolvable from
   the published package root, whether by including a built DLL or by documenting the
   build step.

## Requirement 8 — `install.sh` for the local-clone workflow

1. `install.sh` SHALL verify that `node` is version 20 or higher, that `pnpm` is present,
   and that the checkout is inside a git repository.
2. On any missing prerequisite, it SHALL fail loudly with an actionable message naming
   the missing tool and how to install it.
3. It SHALL warn if `dotnet` is absent and explain that the C# analyzer will be
   unavailable, but continue the installation.
4. It SHALL run `pnpm install` and `pnpm build`.
5. It SHALL be idempotent: running it again on an already-installed checkout completes
   without errors and without duplicating state.
6. It SHALL NOT edit the user's shell rc. It SHALL print the exact `cyv` invocation path
   for this checkout and the line the user may add to their shell rc to make `cyv`
   available as a bare command.

## Requirement 9 — Release workflow

1. The release workflow SHALL be documented and SHALL include, at minimum: version bump,
   build, test, conformance, `cyv verify-analyzer` for every analyzer, `pnpm pack` smoke
   tests, npm publish, git tag, and changelog update.
2. The workflow SHALL fail closed if it attempts to publish a package that still carries
   `private: true`.
3. The workflow SHALL produce the C# analyzer artifact and verify that its manifest's
   `exec.command` resolves from the published package root.
4. The workflow SHALL not inject telemetry, licence checks, or phone-home code.

## Requirement 10 — Zero cost and zero telemetry

1. No published package SHALL require an API key, a licence key, or a network call to a
   telemetry or phone-home endpoint to function after install.
2. `cyv init`, `cyv check`, `cyv upgrade`, and `cyv doctor` SHALL work fully offline once
   the packages are installed.
3. Network use is permitted only for installation and for package-manager resolution;
   it SHALL NOT be used to report usage, check a licence, or download non-package assets
   on every run.

## Non-goals

- Telemetry, usage analytics, licence servers, or any phone-home behaviour.
- A hosted service, metered API, or model-backed feature.
- Committing to a specific public package name, npm scope, or registry account.
- Removing `private: true` from any package before the release decision is made.
- Deciding the final distribution format of the C# analyzer.
- Container images, OS package managers, signed binaries, or automatic background
  updates.
