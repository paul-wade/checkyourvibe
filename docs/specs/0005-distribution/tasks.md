# 0005 — Distribution and installers: Tasks

**Status:** open — nothing here has shipped

This is the spec that decides whether the project is usable by anyone who is not us. Every package
still carries `private: true`; every generated agent hook still embeds an absolute path into a local
checkout. Both are correct for a repository nobody has cloned, and disqualifying for one anybody has.

Ordered so the two things that would be expensive to change later — the version source of truth and
what `cyvCommand` resolves to — are settled before anything is published.

## Foundations

- [x] **T5001** One version, one source of truth
  Requirement 3. All publishable packages share a version driven from a single file, and the release
  workflow rewrites `workspace:*` to that exact version before publishing. Getting this wrong ships a
  package that resolves to a version that does not exist, and the first person to hit it is a
  stranger running `npx`.
  _Exec: executor=devin model=swe gates=tsc,test files=package.json,packages/*/package.json,tools/release/**_

- [x] **T5002** Package metadata and a `files` whitelist
  Requirement 1. Accurate `description`, `license` (MIT), `repository`, `author`, and a `files`
  whitelist carrying only runtime output plus the analyzer manifest — never tests, fixtures, source
  maps, or TypeScript source. Verify by packing and listing the tarball contents, not by reading the
  field: `npm pack --dry-run` is the only thing that actually knows.
  _Exec: executor=devin model=swe gates=tsc files=packages/*/package.json_

- [x] **T5003** `cyvCommand` must survive an upgrade
  Requirement 5, and the one decision here that is expensive to reverse. Generated hook glue today
  embeds an absolute path to a local checkout; under `npx` that path is a transient cache directory
  that will not exist tomorrow. Resolve to a stable invocation, make every agent adapter format it
  correctly whether it is a bare command or a path to a JS entry point, and keep `doctor` detecting
  drift when it stops resolving.

  `resolveCyvCommand` reads this package's own `bin` field and then asks one question: is the package
  root under a `node_modules` directory. If it is, the CLI arrived from a package manager and the only
  invocation that survives a move or an upgrade is the bare `cyv` on PATH. If it is not, this is a
  source clone and the absolute path to the built entry point is what resolves. Either value is
  checked before it is written into a hook, so a command that cannot be invoked is reported at `init`
  time rather than failing silently at hook time.

  The two shapes need different glue: a bare name is invoked directly, a `.js` path is not executable
  on its own and has to be prefixed with the Node interpreter. Every adapter does this; nothing held
  all five to it. `packages/core/test/agents/cyv-command.test.ts` now plans every shipped adapter
  twice, once with each shape, and asserts each embeds the right one.

  `doctor` keeps two independent checks: the command `init` would resolve today, and — for claude-code
  — the command actually written into `~/.claude/settings.json`, recovered by stripping the hook
  suffix. Either failing to resolve is drift, with a different message for a missing entry point and
  for a bare name that is not on PATH.

  Verified by running the CLI from a staged installed package, not from the checkout: the generated
  hook is `cyv hook claude-code`, and `cyv doctor` in the same repository reports `The embedded cyv
  command resolves (cyv)` and exits 0. Held by `packages/core/test/cli/installed-package.test.ts`.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/agents/**,packages/core/src/cli/init.ts,packages/core/test/agents/**_

## The published experience

- [x] **T5004** `init` from a published package writes portable references
  Requirement 4. The generated `checkyourvibe.json` names package specifiers or paths inside the
  installed package — never an absolute path into someone's home directory. An optional analyzer that
  is not installed must leave the config pointing at something that resolves, or not be added at all;
  a config naming a missing package is the silent-skip failure in configuration form.

  Read under T5011: the core ships no analyzer, so a first run with none installed is a supported
  state and "not added at all" is the ordinary outcome rather than the degraded one. `init` picks a
  candidate by where it is running from — a bare package specifier when installed, the repository's
  own relative manifest path first when in a clone — and writes it only after `loadAnalyzerManifest`
  has resolved and parsed it from the target repository. If no candidate resolves, `packs` and
  `analyzers` are written empty and the plan says an analyzer is a separate module, names one, and
  says `cyv check` has no rules until one is added.

  Verified twice against a staged installed package outside this repository, with `NODE_PATH` dropped
  so a bare specifier only resolves if the project really has it. With the analyzer linked into the
  project, the written config names `@checkyourvibe/analyzer-typescript` and contains no path into
  the checkout or the staging directory. Without it, the config carries zero analyzers and the run
  prints how to add one. Held by `packages/core/test/cli/installed-package.test.ts`, which is the
  first test here that runs the CLI from outside the checkout — the layout in which all four defects
  in T5009 lived.

  **Superseded in part by T5014**, which found that this answer left the tool configurable only
  inside this repository. The rule it states — never an absolute path into someone's home directory —
  is unchanged and still held; what changed is where a bare specifier is allowed to resolve from.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/cli/init.ts,packages/core/src/registry/**_

- [x] **T5014** `init` could not configure an analyzer for any repository except this one
  Measured against a real clone of an unrelated public TypeScript project. In a source clone, `init`
  tried `./packages/analyzer-typescript/analyzer.manifest.json` **resolved against the target
  repository**, then the bare specifier `@checkyourvibe/analyzer-typescript` **resolved from the
  target's `node_modules`**. Neither can resolve in someone else's project. So `init` wrote
  `"analyzers": [], "packs": []`, advised `npm install @checkyourvibe/analyzer-typescript` — a package
  `docs/getting-started.md` says on the same page is not published — and the next `cyv check --all`
  printed `0 errors, 0 warnings, 0 files checked / 0 of 0 rules enabled`. A clean-looking pass over
  nothing, which is the exact failure this project exists to prevent, produced by the command whose
  job is to prevent it. There was no documented way out: the only run anyone got was by hand-writing
  an absolute path into `checkyourvibe.json`.

  **The tension.** T5004 says never write an absolute path into a configuration. But a local clone is
  currently the only supported install, and the analyzer exists only inside that clone. An absolute
  path to it was the only value that could resolve. Both constraints could not be satisfied by
  choosing what to *write*.

  **Decision: change where a written reference is allowed to resolve from, not what gets written.**
  `init` writes the bare package specifier, exactly as T5004 requires. `loadAnalyzerManifest` now
  resolves a bare specifier in two places, in order: the repository being checked, and then the
  checkyourvibe installation running the command. A clone holds its analyzers at `packages/<name>`
  next to `packages/core`; an npm install holds them at `node_modules/@checkyourvibe/<name>` next to
  `node_modules/@checkyourvibe/core`. One `dirname(coreRoot)/<name>` covers both layouts, which is the
  same convention `loadOnePlugin` already uses to reach the agent adapters.

  The project is tried first and wins. A project that installs its own analyzer must get that copy,
  not whichever one happens to sit beside the CLI. The sibling convention is applied only to the
  `@checkyourvibe/` scope: a directory name is not proof of identity, and another author's
  `@acme/analyzer-typescript` must never be answered with ours.

  **What this costs, stated rather than hidden.** The configuration now names a package that, on this
  machine, resolves only because this checkyourvibe installation exists. That is a real dependency and
  it is not visible in the file. So `init` prints it: which analyzer, which packs, and — when the
  manifest came from beside the CLI rather than from the project — the absolute manifest path it used,
  that the written specifier is deliberately not that path, and that on a machine without this
  installation `cyv check` reports the analyzer as unresolvable and exits 2. Unresolvable is loud:
  `RegistryError('NOT_FOUND')` names both places it looked. The failure mode of this decision is an
  error, never a silent skip.

  **Also decided here:** the analyzer's id and packs are read from its manifest instead of being
  hardcoded to `typescript` and `core-ts`. A first run enables the analyzer's `core-*` packs, or all
  of its packs when it declares no `core-*` pack — because a configuration that names an analyzer and
  enables none of its rules is the same clean-looking pass over nothing in a different disguise.

  **And an escape hatch:** `cyv init --analyzer <path-or-package>`. It is how a user reaches an
  analyzer neither lookup would find — one built from a checkout elsewhere, or one of the three
  analyzers here that `init` does not choose by default. The value is written verbatim, so a relative
  path stays relative. Unlike the default candidates it is resolved without a fallback: if it does not
  load, the run fails with the reason and writes nothing.

  **Rejected alternatives:**
  - **Write the absolute path when running from a clone, and say so.** It is honest and it works, but
    the value it writes is not shareable. `checkyourvibe.json` is a committed file; a path into one
    contributor's home directory breaks for everyone else on the repository and reintroduces exactly
    the class of defect T5004 exists to prevent. Announcing it in the plan does not make a committed
    file portable.
  - **`--analyzer` as the only route.** It makes the first run in a stranger's project fail by default
    and require a flag nobody knows to pass. The failure was that `init` produced a configuration that
    could not work; requiring a flag to avoid that keeps the broken default.
  - **Resolve nothing at write time and search for analyzers at check time.** It removes the record of
    what is configured, which is the thing `checkyourvibe.json` is for, and makes the rule set depend
    on the machine rather than on the repository.

  **Verified by running it, not by testing around it.** Cloned `sindresorhus/ky` (54 TypeScript
  files) into a temp directory, ran `cyv init --yes` and `cyv check --all` from the clone-installed
  CLI exactly as a stranger would. `init` wrote `"analyzers": [{"id": "typescript", "package":
  "@checkyourvibe/analyzer-typescript"}]` with `"packs": ["core-ts"]` and no absolute path anywhere in
  the file; `check --all` reported **259 errors across 54 files, 9 of 14 rules enabled**, with 2018
  further findings withheld and the reason named. Held by
  `packages/core/test/cli/unrelated-project.test.ts`, which spawns the built CLI in an unrelated git
  repository with `NODE_PATH` dropped — the layout in which this defect lived, and which no existing
  test covered, because every one of them ran either inside this checkout or inside a staged install
  where the analyzer had been linked in on purpose.
  _Exec: executor=self model=opus gates=tsc,test,self-check files=packages/core/src/cli/init.ts,packages/core/src/registry/**,packages/core/test/cli/**,docs/getting-started.md_

- [x] **T5005** A user without a .NET toolchain
  Requirement 7, and the most likely first-run failure for a stranger. `check` reports the C#
  analyzer's absence clearly and continues; `init` does not add it when `dotnet` is missing;
  `install.sh` warns and continues. An opaque spawn error here reads as "this tool is broken", and
  the user is right.

  **Decision — Requirement 7.4:** The C# analyzer is distributed as a prebuilt DLL bundled inside
  the published package, with the same relative `exec.args` path it has today. The release workflow
  builds the DLL with `dotnet build` once, before packing, so users who do not have the .NET SDK
  still receive the artifact and a clear `cyv check` message when `dotnet` is missing. Installing
  the .NET SDK later makes the analyzer work immediately; no separate artifact download or source
  build step is required at install time.

  **Rejected alternatives:**
  - **Source build under `dotnet build` at install time.** This would make the optional analyzer a
    hard build-time dependency: a user without .NET would either fail to install or end up with an
    unbuilt, silently-unavailable analyzer. It also adds platform- and toolchain-specific build time
    to every install. Rejected.
  - **Separate .NET release artifact.** This would split the package into two downloads, complicate
    version pinning and offline installs, and require either a network fetch from `cyv` or manual
    user setup. Rejected because it contradicts the zero-cost, offline-after-install goal.

  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/registry/**,packages/core/src/cli/init.ts,install.sh_

- [x] **T5006** `cyv upgrade`
  Requirement 6. Re-resolve every analyzer, rebuild the catalog, re-plan agent glue, update per-rule
  guidance whose rule changed, and remove guidance for rules that no longer exist — but only from
  files it generated and can identify. Never overwrite a user-edited file without `--force`, and
  report what changed, what is stale, and what could not be updated. Shares planning and merge logic
  with `init` (6.7), because two commands that disagree about the same file are worse than one.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/cli/upgrade.ts,packages/core/src/cli/index.ts,packages/core/test/cli/**_

- [x] **T5007** `install.sh` for the local-clone workflow
  Requirement 8. Verify node ≥ 20, pnpm, and a git checkout before doing anything; warn about a
  missing .NET toolchain and continue. It must be safe to run twice. The script now also supports
  `--dry-run`, runs `pnpm build` (which includes the schema copy), and ends with a single next
  command plus the shell rc line that makes `cyv` a bare command.
  _Exec: executor=devin model=swe gates=none files=install.sh_

- [x] **T5013** `install.ps1` — a PowerShell equivalent of `install.sh`
  Not a numbered requirement, but a real gap: this project is developed on Windows and
  `install.sh` needs a POSIX shell. `install.ps1` mirrors the bash installer's checks,
  warnings, dry-run, pnpm install, pnpm build, and final instruction.
  _Exec: executor=devin model=swe gates=none files=install.ps1_

- [x] **T5008** Release workflow
  Requirement 9. Build, test, self-check with `--strict`, run the provenance gate, pack, and publish
  — in that order, failing closed. The provenance check must run against the packed tarball as well
  as the tree; the whole point is that nothing leaves this machine unscreened.
  _Exec: executor=devin model=swe gates=tsc,test,self-check files=.github/workflows/**,tools/release/**_

- [x] **T5011** Three of the four analyzers are not packages at all
  Requirement 7.4 asks how the C# analyzer is distributed. Checking the workspace, the question is
  broader than that spec assumed: `analyzer-csharp`, `analyzer-python` and `analyzer-rust` have no
  `package.json`. They are directories in this repository, reachable only by a relative path in
  `checkyourvibe.json`. Seven npm packages exist — core, the TypeScript analyzer, and five agent
  adapters — and none of the other three analyzers is among them.

  So a stranger who runs `npx <package> init` gets TypeScript analysis and nothing else, and there is
  currently no supported way for them to get the rest. That is a defensible product decision — the
  TypeScript pack is the one with thirteen rules and the others have four each — but it is not a
  decision anyone has made, and the README implies four analyzers exist without saying three of them
  are reachable only from a clone.

  **Decision (revised, review comment #12).** The core ships no analyzer. Analyzers are modules a
  user adds, and the core is the engine and the protocol.

  That dissolves the question this task was written to answer. There is no per-analyzer distribution
  problem to solve, because the core does not carry a rules processor of any language: not the C#
  DLL, not a Rust binary for each platform, not `analyze.py`. Each analyzer is obtained the way any
  other dependency is, and `checkyourvibe.json` names it. The earlier answer here — ship core plus
  the TypeScript analyzer and call the rest clone-only — was choosing which analyzers to bundle,
  which is a question that only exists if the core bundles any.

  What follows from it:

  - A first run with no analyzer installed is a supported state, not a failure to explain away. The
    configuration resolves to no rules, `check` exits 2 rather than reporting a clean pass, and the
    message says an analyzer has to be added and how.
  - `cyv init` never writes a configuration naming an analyzer the user cannot resolve. That is
    T5004, and under this model it is the whole of the distribution contract rather than one half.
    T5014 refines what "can resolve" means: a clone-installed CLI carries its analyzers beside
    itself, and a bare specifier is allowed to resolve there when the checked project has no copy.
  - The release pipeline needs neither a .NET SDK nor a Rust toolchain, because it builds no
    analyzer artefact. The costs recorded below for C# and Rust are costs whoever publishes those
    analyzers pays, not costs the core pays on their behalf.
  - The README describes analyzers as modules to add, not as a set the tool comes with.

  Retained from the earlier analysis, because it is still true about each analyzer as a package:
  TypeScript needs no external toolchain and is already an npm package; Python is pure source and
  would be trivial to package, needing only `python` on PATH; C# needs `dotnet build` to produce a
  framework-dependent DLL, which is platform-independent and so packages cleanly; Rust needs either
  the toolchain at run time or a prebuilt binary per platform, which is the most machinery of the
  four. None of that is now a precondition for releasing the core.

  Rejected, unchanged: a `postinstall` that builds from source. It is slow, it fails on machines
  without the toolchain, and a package that compiles code during installation is a thing security
  teams refuse.

  _Exec: executor=self model=opus gates=none files=docs/specs/0005-distribution/**,README.md_

## Proof

- [x] **T5009** Install it somewhere clean and use it — four defects found, then it worked
  The requirement none of the above satisfies. Pack the tarballs, install them into an empty
  directory outside this repository, and run `init` then `check` on a small real project. Every
  defect worth having found in this project so far came from pointing the tool at something real, and
  every one of them was invisible to the tests.
  Record what broke. If nothing breaks, say so — but only after doing it.

  **First pass done.** Packed `core` and `analyzer-typescript`, installed them into a fresh project
  outside this repository containing 341 TypeScript files copied from a real, unrelated codebase, and
  ran the installed CLI. Four defects, none of which any test could have caught, because every test
  runs from the checkout where the broken paths resolve.

  1. **The tarball was uninstallable.** `npm install` refused it outright —
     `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`. The packed
     `analyzer-typescript` still carried `"@checkyourvibe/core": "workspace:*"`, which no registry can
     resolve. `verify-pack` had reported "All 7 packages passed" on it: it checked the file list and
     never checked that the manifest was installable. Fixed — an unpublishable dependency range is now
     a pack defect, and it correctly fails all six dependent packages until `set-version` has run.
  2. **`cyv verify-analyzer` was broken for every installed user** (fixed in an earlier commit): the
     conformance suite read its schemas from `../../../../docs/protocol/`, which is the repository root
     from a clone and `node_modules/docs/protocol/` from an install.
  3. **`cyv init` had the same path bug**, separately, in `resolveSchemaContent`. A first run in a real
     project failed with `ENOENT ... node_modules\docs\protocol\config.schema.json` *while it was
     writing the configuration*. Both call sites now go through one `readProtocolSchema` helper that
     knows both layouts and names every path it tried when it cannot find one.
  4. **Every agent adapter failed to load.** `@checkyourvibe/core` does not depend on the five
     adapters, so an install has none of them, and `init` printed five `Cannot find module` lines and
     configured nothing. It reports rather than silently succeeding, which is right — but the tool's
     entire purpose is agent integration, so shipping a core that cannot reach a single agent is not a
     product. Needs a decision alongside T5011: which adapters ship, and how a missing one reads.
     Filed as T5012.

  **Second pass: it works.** With T5012 decided and the schema paths fixed, all seven tarballs install
  into an empty project outside this repository and the whole flow runs: `init` writes a portable
  config naming `@checkyourvibe/analyzer-typescript`, `check` reports real findings with their full
  guidance and notFixes, `doctor` reports every surface ok and confirms the embedded command resolves
  to a bare `cyv`, and `explain` prints a rule with its pack, evidence and owning analyzer.

  Pointed at 170 files from a real codebase it found the tsconfig defect that became T7009 and T7010 —
  the single most valuable result this project has produced, and unreachable from any test.
  _Exec: executor=self model=opus gates=manual files=docs/specs/0005-distribution/**_

- [ ] **T5010** Decide what becomes public
  Requirement 1.5. Removing `private: true` is a release decision, not a code change, and it is the
  last thing to do — an accidental publish cannot be unpublished.
  _Exec: executor=user model=n/a gates=none files=packages/*/package.json_

- [x] **T5012** A published core cannot reach a single agent
  Found by T5009's first pass. `@checkyourvibe/core` declares no dependency on the five adapter
  packages, so installing it gives you a tool with no agent integration at all — and agent integration
  is the entire point. `cyv init` printed five `Cannot find module` lines and configured nothing.

  Reporting rather than silently succeeding is correct, and the message is not the problem. The
  packaging decision is. Options, in the order they should be argued:
  - Core depends on the adapters it supports. Simple, and every install works — but core then carries
    five packages most users will not use, and adding a sixth agent means a core release.
  - Adapters are optional peer dependencies, discovered at runtime. Keeps core small and keeps the
    plug-in axis honest, but a fresh install does nothing until the user finds out they need a second
    package, which is a bad first run.
  - Core depends on the claude-code adapter alone, matching T5011's decision to ship one analyzer:
    the release is a working tool for one agent, with the rest documented as separate installs.

  **Decision: core depends on the five adapters it ships**, and the adapters declare core as a
  `peerDependency` rather than a `dependency` so the graph has no cycle. Four of the five import core
  for types only; `adapter-codex` needs one runtime value, which a peer dependency covers because core
  is necessarily present.

  Rejected: optional peer dependencies discovered at runtime. It keeps core small and reads as the
  purer expression of the plug-in axis, but a fresh install would then do nothing until the user
  discovers they need a second package — and the first run is the whole adoption moment. The axis is a
  claim about the *protocol*, not about packaging: core still resolves any adapter by name, so a
  third-party adapter is exactly as installable as a bundled one.

  Cost, stated plainly: adding a sixth agent now requires a core release. That is a small, recurring
  tax paid to avoid a broken first run, and it is reversible in a `package.json` if it ever stops
  being worth it. The adapters are 25 KB each, so bundling costs nothing in bytes.

  **This refines T5011 rather than contradicting it.** That decision drew the release line around the
  *analyzers*: one ships, three are clone-only. The adapters are on the other side of that line — all
  five publish, because core is uninstallable without them. Confirmed the hard way: with core
  depending on unpublished adapters, `npm install` fails with a 404 before anything else can go wrong.
  _Exec: executor=self model=opus gates=none files=docs/specs/0005-distribution/**,packages/core/package.json_
