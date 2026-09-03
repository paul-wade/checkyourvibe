# 0020 — Monorepo ergonomics: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

The roadmap entry for this spec claims one thing is already delivered and defers the rest. It is worth
being precise about which is which, because restating the delivered part as new work would waste the
reader's trust before Requirement 1 even starts.

**What is already delivered:** `ConfigOverride` (`packages/core/src/config/types.ts`) and
`resolveRulesForFile` (`packages/core/src/config/resolve.ts`) already let one root `checkyourvibe.json`
carry a different rule posture per glob, applied in array order with a later match winning, each entry
required to state a `reason`. This repository's own config uses exactly one such entry today — disabling
`no-console` under `packages/core/src/cli/**`, because that tree's whole job is writing to stdout. That is
a real, working answer to "this directory needs different rules," and it is scoped to a single file a
human can diff in one pull request.

**What it does not do**, and what the rest of this spec is about: it says nothing about who *owns* that
posture (the root config's author, always — a package cannot speak for itself), nothing about running only
what a change actually touches (`packages/core/src/run/discover.ts` produces a flat file list; nothing
downstream of it knows what a "package" is), and nothing about the two failure modes this project has
already paid to learn about the hard way — a rule that only looks safe to skip locally, and a type system
that degrades silently. `groupFilesByProject` in `packages/analyzer-typescript/src/project.ts` exists
because a solution-style tsconfig, read naively, produced 91 fabricated findings (0001's outcome, restated
in the roadmap's "Where things stand"). This spec assumes a monorepo can reproduce that failure in a new
shape, one package's tsconfig away from another's source, and requires it be caught the same way: reported,
not silently degraded into a confident wrong answer.

This repository is the worked example throughout (Requirement 6), because it already is a pnpm workspace —
`pnpm-workspace.yaml` names `packages/*` — with a real, asymmetric dependency graph and, notably, three of
its four analyzer packages entirely outside that graph.

## Requirement 1 — Per-package configuration

**User story:** As a package owner in a monorepo, I want my package to carry a rule posture different from
the root's, without becoming a second place a teammate has to check to answer "why did this rule not fire
here."

1. A package (a directory containing its own manifest — `package.json`, `Cargo.toml`, or equivalent) MAY
   carry its own `checkyourvibe.json`. Its absence means the package inherits the root configuration
   exactly as every package does today — this is the common case, and every package in this repository is
   in it right now.
2. A package config SHALL be found by walking from a file's directory upward, stopping at the nearest
   package manifest — never past it to an ancestor package, and never all the way to the repository root
   the way `findConfig` (`packages/core/src/config/load.ts`) walks for the single root config today. A
   package config nested inside another package's tree is not a thing this spec defines a meaning for.
3. **Combination is inherit-and-extend, never inherit-and-replace, and the extension is one-directional: a
   package config may only make checking stricter than the root resolves for that path, never looser.**
   Concretely: a package config MAY enable a `pack` or a rule the root left off, and MAY raise a rule's
   `severity` from `warning` to `error`. It SHALL NOT set a rule the root config resolves as enabled to
   `false`, and SHALL NOT lower a rule's resolved `severity` from `error` to `warning`. A package config
   that attempts either SHALL be a configuration error at load time, reported by naming the rule, the
   package, and the root setting it conflicts with — not silently ignored and not silently applied.
4. The reasoning behind 1.3, stated plainly because it is the load-bearing decision of this requirement:
   `resolveRulesForFile` already lets two things disable the same rule for the same path today — the base
   `rules` block and a matching `overrides` entry — and that pair lives in one file, so answering "why did
   this not fire" is one `grep`. A package config that could *also* disable a rule turns that into a search
   across every package on the path from the file to the repository root, each potentially owned by a
   different team, potentially changed in a pull request the person asking never saw. Loosening SHALL
   therefore only ever happen in the root's `overrides` — which already requires a `reason` and is already
   diff-reviewable in one place (0008's precedent, restated here for a second mechanism) — never in a file
   a package can edit unilaterally. Tightening carries none of that risk: a stricter package can only ever
   explain a finding a reader did not expect, never one they expected but did not get.
5. A package config's schema SHALL be a strict subset of the root's: `packs` (additive — the file's active
   pack set is the union of root and package) and `rules` (tightening-only, per 1.3). It SHALL NOT declare
   `analyzers` (Requirement 3), `exclude` (equivalent in effect to disabling every rule for a path, so it
   inherits 1.3's prohibition), `overrides` (a second per-path mechanism nested inside a per-path
   mechanism is not a design, it is a maze), `suppressions` (Requirement 5), or `strict`. Every one of
   those is, directly or by composition, a way to make checking *less* strict somewhere, and 1.3 already
   settled where that lives.
6. `cyv doctor` SHALL list every package config found in the repository and, for each, the packs and rules
   it adds beyond the root — the same "state what is actually active" discipline the root config's own
   resolution already owes a reader, extended to a second file instead of introducing a second way to find
   out.

## Requirement 2 — Affected-package detection

**User story:** As a developer who changed one package, I want a check that only runs what my change could
plausibly have broken — but I want that boundary drawn by what actually depends on what, not by which
directory happens to contain the diff, and I want to be told what got skipped and why.

1. "Affected" SHALL be computed from the real dependency graph, not from the location of the changed
   files alone. For a pnpm workspace this means: an edge from package B to package A exists when B
   declares A as a `dependencies` or `devDependencies` entry resolved via the `workspace:` protocol (every
   `package.json` under `packages/*` in this repository does exactly this — see Requirement 6 for the
   concrete edges). A file changing in package A marks A affected, and marks every package with a
   transitive path to A through that graph affected — **dependents, not dependencies.** A change to
   `packages/core` can break `packages/analyzer-typescript`, which imports it; it cannot break whatever
   `packages/core` itself imports, because nothing about editing a consumer changes what it consumes.
2. Getting the direction backwards SHALL be treated as the design bug it would be, not a tuning
   parameter: "only check the package that changed" is unsound for any rule capable of reasoning about
   more than the file in front of it, because the dependent, not the dependency, is where such a rule's
   evidence about the change actually shows up. `RuleManifest.scope` (`packages/core/src/protocol/index.js`
   re-exports, declared per rule as `'file' | 'project'`) already exists as a precedent for exactly this
   distinction at a finer grain: `check.ts`'s `analyzeModeFor` already refuses to run a `project`-scope
   rule against a partial file set, and reports every rule it skipped for that reason via
   `RunReport.projectRulesSkipped`, rather than running it anyway on incomplete input or dropping it
   silently. Affected-package detection is the same refusal at a coarser grain and SHALL be held to the
   same standard: a `project`-scope rule, or any rule an analyzer declares needs cross-file evidence, SHALL
   run against every file the affected set resolves to, never against only the literally-changed files
   within it.
3. A package outside the affected set SHALL be recorded in the run's output as skipped-because-unaffected,
   named individually, alongside the package(s) that made it eligible to skip (which changed package it
   was found unaffected by). A run against forty packages that checked three and printed nothing about the
   other thirty-seven is a clean report that checked almost nothing, and this project's own carried-forward
   principle — silence is the enemy — names precisely this shape of failure. This SHALL be a visible line
   in every report format this project already ships (`packages/core/src/report/text.ts`,
   `json.ts`, `sarif.ts`), not a detail available only with a verbose flag.
4. `--affected` (or equivalent) SHALL be an explicit opt-in mode, alongside the existing `RunMode` values
   in `packages/core/src/run/modes.ts`, never the default behavior of `cyv check` with no flags. A user who
   types the bare command sees the truth about the whole tree, mirroring 0008 Requirement 2.5's identical
   choice for `--since-baseline`.
5. WHEN the dependency graph itself cannot be computed confidently — a workspace package with no
   `package.json` (Requirement 6 has three of these in this very repository), a `package.json` present but
   unparsable, or a dependency specifier that is not a `workspace:` protocol reference and therefore not
   provably in-repo — THEN that package SHALL be treated as affected rather than excluded, and the reason
   SHALL be named in the run's diagnostics. An unreadable edge is exactly the kind of ambiguity Requirement
   4 already refuses to resolve by guessing; affected-package detection SHALL refuse the same way, in the
   direction that degrades to "check it" rather than "skip it."

## Requirement 3 — Which analyzers run

**User story:** As a developer who touched only `.py` files, I want a `.py`-only change to never wait on a
C# compilation.

1. This is substantially already true, and stating that precisely matters more than restating it as new
   scope: `routeFiles` (`packages/core/src/run/route.ts`) claims each file for at most one analyzer by
   matching its `match`/`exclude` globs, and `runCheck` (`packages/core/src/run/check.ts`, the loop
   starting at its `for (const manifest of manifests)`) already skips invoking an analyzer entirely when
   `routed.get(manifest.id)` is empty — no process is spawned, `runAnalyzer` is never called. `loadAnalyzers`
   only reads each configured analyzer's manifest JSON; it never starts a runtime. So a `.py`-only change
   against this repository's own `checkyourvibe.json` (which registers only `typescript` and `csharp`)
   already never pays for a C# compilation, purely from existing file-level routing — no monorepo-specific
   mechanism is required for that property to hold.
2. A file matching more than one analyzer's `match` globs is already a configuration error, not a silent
   first-match win: `routeFiles` throws `RegistryError('AMBIGUOUS', ...)` naming the file and every
   analyzer id that claimed it. This spec does not change that behavior; a per-package config
   (Requirement 1) SHALL NOT be able to introduce a second analyzer registration for a path already routed
   at the root, since Requirement 1.5 already excludes `analyzers` from what a package config can declare —
   consistent with keeping "which binaries this run might execute" answerable from the root config alone.
   `exec.type: "process"` analyzers run with the invoking shell's full privileges (0017 Requirement 6.3's
   framing), and that trust decision does not become delegable to an arbitrary subtree just because the
   subtree gained its own config file.
3. The real gap, and the actual scope of this requirement: nothing in `RunReport`
   (`packages/core/src/report/types.ts`) records, per analyzer, how many files it was invoked against or
   that a configured analyzer matched zero files this run. Today's output carries one aggregate
   `filesChecked` across every analyzer combined. In a repository with several analyzers and dozens of
   packages, "csharp matched 0 files and did not run" is exactly the kind of true-but-unstated fact that
   looks identical to "csharp silently failed to load." `RunReport` SHALL gain a per-analyzer breakdown —
   analyzer id, files matched, whether it ran — surfaced in every report format, so a zero is a stated zero
   rather than an absence a reader has to infer.

## Requirement 4 — The type-resolution trap, across a package boundary

**User story:** As a developer relying on the TypeScript analyzer's inferred-`any` detection, I want a
finding from a monorepo run to mean what it says, even when the file it flags imports from a sibling
package rather than from itself.

1. `groupFilesByProject`'s existing solution-style detection (`packages/analyzer-typescript/src/project.ts`,
   `isSolutionStyle`) catches one specific shape of degraded resolution: a tsconfig that is nothing but
   project references. It inspects only the tsconfig nearest to the file being analyzed. It says nothing
   about whether the *sibling packages that tsconfig references* actually resolve, because a tsconfig can
   be entirely well-formed — real `compilerOptions`, real `include` — while a cross-package import inside
   it still resolves to nothing. This requirement names that second, distinct failure and requires it be
   caught with the same discipline, not folded into the existing check as if it were the same bug.
2. This repository reproduces the second failure concretely, today: `packages/analyzer-typescript/tsconfig.json`
   declares `"references": [{ "path": "../core" }]` and imports `@checkyourvibe/core` via the
   `workspace:*` dependency in its `package.json`. `packages/core/package.json` resolves that specifier
   through `"types": "./dist/index.d.ts"` — a **built artifact**, not source. `groupFilesByProject` never
   inspects whether that path exists. If a file under `packages/analyzer-typescript/src` is analyzed before
   `packages/core` has been built — a fresh checkout before `pnpm build`, a `dist/` wiped by a clean step,
   a build that failed partway — every import from `@checkyourvibe/core` resolves to implicit `any`, and
   every rule detecting inferred `any` reports the entire surface of `@checkyourvibe/core` as untyped. This
   is the 91-fabricated-findings failure again, wearing a monorepo's clothes: the tsconfig itself is
   entirely well-formed, so `isSolutionStyle` reports nothing wrong.
3. WHERE a package's tsconfig declares a `references` entry, or a source file imports a specifier
   resolving to a sibling in-repo package (a `workspace:`-protocol dependency in that package's own
   `package.json`), a project group's degraded-resolution check SHALL also verify that the referenced
   package's declared type entry point (its `package.json` `types`/`typings` field, resolved to an actual
   file) exists on disk before treating that project group as sound. This is a check `ProjectGroup` does
   not perform today; `degraded` (`packages/analyzer-typescript/src/project.ts`) SHALL be extended to carry
   this cause distinctly from the solution-style cause, since the fix differs (build the dependency, versus
   restructure the tsconfig).
4. WHEN this check finds a referenced package's type entry point missing, unbuilt, or unreadable THEN
   every finding from a rule capable of reasoning about inferred types, for every file in that project
   group, SHALL be reported through the same degraded-resolution path `groupFilesByProject`'s existing
   `degraded` field already establishes — named as unreliable in the run's diagnostics — rather than
   produced as an ordinary, trusted finding. Per this project's own stated principle: a false finding costs
   more credibility than a missed one, and a monorepo multiplies the number of places this specific trap can
   spring by the number of packages that import each other.
5. This requirement is scoped to *detecting and reporting* the degraded state, not to fixing type
   resolution by, for example, having the core build a missing dependency automatically. Automatically
   invoking a build is a materially larger and riskier action than reporting a fact, and AGENTS.md's scope
   discipline already forbids this project's own tasks from running package-manager or build commands as a
   side effect of an unrelated one; the same restraint applies here.

## Requirement 5 — Baselines and suppressions across packages

**User story:** As a team burning down debt across a monorepo, I want the record of what is deferred to
live in one place I can diff, not scattered across every package that happens to have some.

1. **One baseline, at the root, covering every package.** `Baseline`/`BaselineEntry`
   (`packages/core/src/baseline/types.ts`) already identify an entry by `(path, ruleId, fingerprint,
   occurrence)` — `path` is repo-relative and is part of identity, with no notion of a package boundary
   attached to it. Splitting the single baseline file into one per package would not follow from that
   shape; it would have to be imposed on top of it, and 5.2 states why it should not be.
2. The concrete argument, stated in the terms 0008 Requirement 1.4 already established for the single
   baseline (that it is committed and diff-reviewable): a change that moves a helper function from one
   package to another, where the moved code still trips a rule, is **one entry disappearing and one entry
   appearing** under today's path-keyed identity — this is already true of a same-repository move today,
   entry-identity does not survive a path change, and that limitation is real and is named again in Open
   questions rather than silently assumed fixed. What a single root baseline *does* still buy, and what a
   baseline split per package would cost: both halves of that move land in the same file, in the same
   diff, in the same pull request, where a human reviewer has a chance of reading "entry removed from
   `packages/a/...`" next to "entry added in `packages/b/...`" and recognizing a move rather than a fix and
   a fresh violation. Splitting the baseline scatters those two lines across two files, plausibly two pull
   requests, plausibly reviewed by two different package owners neither of whom sees the other's diff — the
   exact failure this spec's own framing predicts: a cross-package move reads as debt paid down in one
   place and debt incurred in another, and a per-package baseline makes that misreading *structural*
   rather than merely possible.
3. A package config (Requirement 1) SHALL NOT declare its own `suppressions`, for the same reason it SHALL
   NOT declare `overrides`: a suppression is scoped by a `target` glob against a repo-relative path
   already, so nothing about expressing "defer this violation in my package" requires a second file — it
   requires only that the root's `suppressions` array (or `cyv baseline`) accept a target glob scoped to
   that package's paths, which it already can.
4. `cyv baseline --status` (0008 Requirement 5) SHALL be able to group its by-file and by-rule breakdown by
   package — the workspace-package boundary is a natural axis on top of the existing report, not a
   different report — but this SHALL remain a view over the one root baseline file, never a signal that a
   package-scoped baseline file is an alternative a team could choose instead.

## Requirement 6 — What this repository itself needs

This repository is a pnpm workspace of ten directories under `packages/*`. Seven carry a `package.json` and
are real nodes in the pnpm dependency graph Requirement 2 reads: `core`, `analyzer-typescript`, and the five
adapters (`adapter-claude-code`, `adapter-codex`, `adapter-cursor`, `adapter-gemini`,
`adapter-antigravity`). Every one of those seven depends on `@checkyourvibe/core` via `workspace:*`; nothing
in this workspace depends on any of the other six. **A change to a single file in `packages/core` therefore
affects all seven** — Requirement 2's reverse-dependency closure is not a hypothetical for this repository,
it is the shape of every one of its own packages today.

The remaining three — `analyzer-csharp`, `analyzer-python`, `analyzer-rust` — carry no `package.json` at
all. They are not npm packages; pnpm silently does not treat them as workspace members despite matching
`packages/*`, because there is no manifest for it to read. For Requirement 2's dependency graph, this is not
an edge case to special-case away — it is a real, permanent shape this repository will always have, since
these are analyzers *for* other languages, implemented *in* those languages, and nothing about that changes.
Requirement 2.5's fallback (unreadable graph membership defaults to affected, not skipped) is what actually
governs these three, and it is the correct answer for them: a change to `packages/analyzer-rust/src` has
no in-repo dependents to compute, so "affected" trivially equals "itself," and the fallback rule reaches
that same conclusion without needing a special case written for it.

Concretely, adopting this spec here would mean:

- **Per-package configuration (Requirement 1):** none of the ten packages needs one today. The one existing
  per-path posture — disabling `no-console` under `packages/core/src/cli/**` — is a *loosening*, so under
  Requirement 1.4 it correctly stays exactly where it already lives: the root `overrides` array. Nothing
  about adding per-package config would move it, which is itself a check that Requirement 1's classification
  is doing the right thing on the one real example this repository has.
- **Affected-package detection (Requirement 2):** running `cyv check --affected` after editing
  `packages/core/src/config/resolve.ts` (the file read while researching this very spec) SHALL mark all
  seven `package.json`-bearing packages affected and report `analyzer-csharp`, `analyzer-python`, and
  `analyzer-rust` as affected-by-fallback (2.5), not as skipped — this repository has no package today whose
  change would ever produce a genuine "N of 10 skipped" report, because `core` sits at the root of every
  edge that exists. That absence is itself informative: this repository cannot exercise the "many packages
  legitimately skipped" path Requirement 2.3 is written for, and a synthetic multi-leaf-package fixture would
  be needed to test that path at all.
- **Which analyzers run (Requirement 3):** already correct today, per Requirement 3.1 — a `.py`-only change
  is moot here since no `.py` file is checked (`checkyourvibe.json` registers only `typescript` and
  `csharp`). The gap this spec finds is the missing per-analyzer breakdown in `RunReport`; this repository's
  own two-analyzer run is exactly big enough to show the gap (a report that never once states "csharp: N
  files, ran" or "csharp: 0 files, did not run") without being big enough to make it obviously the wrong
  interface, which is why this spec calls it out now rather than waiting for a larger monorepo to force it.
- **The type-resolution trap (Requirement 4):** this repository is the worked example verbatim —
  `packages/analyzer-typescript/tsconfig.json`'s `references: [{ path: "../core" }]` plus
  `packages/core/package.json`'s `"types": "./dist/index.d.ts"` is the exact shape Requirement 4.2
  describes, and it is live today, not hypothetical. Adopting Requirement 4.3 here means
  `groupFilesByProject` gains a check, before analyzing `packages/analyzer-typescript/src`, that
  `packages/core/dist/index.d.ts` exists; if this repository were checked immediately after `git clone`
  and before `pnpm build`, that check would currently pass silently and analyze against implicit `any`
  for every `@checkyourvibe/core` import.
- **Baselines and suppressions (Requirement 5):** no baseline file exists in this repository today — 0002
  self-compliance closed its own violations by fixing them rather than deferring them. Requirement 5 is
  therefore prospective here: if this repository ever does take a baseline, it stays the single
  `checkyourvibe.baseline.json` at the root spec 0008 already defines, covering all ten packages, never one
  per package.

## Non-goals

A build system (Turborepo-, Nx-, or Bazel-style task graph, caching, or incremental build orchestration) —
this spec is about which files get *checked*, never about building or testing them. A generic,
language-agnostic workspace-graph resolver beyond what `package.json` `workspace:` dependencies already
express — Cargo workspaces, a Python monorepo's `pyproject.toml` interdependencies, and any other
ecosystem's own graph are real and out of scope, named again in Open questions rather than silently assumed
solved by the pnpm case. Automatically building a stale dependency to fix Requirement 4's degraded state
(4.5). A UI or dashboard view of the package graph — 0006 and 0031 own visualization; this spec only
defines what must be computed and reported. Changing `RuleManifest.scope`'s existing two values or
introducing a third — Requirement 2.2 uses `'project'` as a precedent, not a value this spec revises.

## Open questions

- **Cross-package baseline identity for a genuine move.** Requirement 5.2 names the limitation and argues a
  single file makes it *reviewable* rather than *solved*. Making `(path, ruleId, fingerprint, occurrence)`
  survive a path change outright — recognizing a moved-and-unchanged violation as the same entry regardless
  of which file or package it now lives in — is a real enhancement to `identity.ts`'s matching logic that
  this spec does not attempt, because it changes what "the same violation" means for every baseline entry,
  not only ones a package boundary happens to cross.
- **Non-pnpm and non-JS workspace graphs.** Requirement 2.1 is written against `package.json` `workspace:`
  dependencies because that is the graph this repository actually has. A Cargo workspace's `[dependencies]`
  with `path = "../foo"`, or a graph this project's own `analyzer-rust`/`analyzer-python` would need if they
  ever gained in-repo siblings that depend on them, is a materially different parse target this spec has not
  designed for.
- **How Requirement 1's package-config boundary composes with a package that has both a `package.json` and
  is itself further subdivided** — a package containing its own nested workspaces, which pnpm supports and
  this repository does not currently use. Requirement 1.2 stops the walk at the nearest manifest; whether a
  manifest-within-a-manifest should nest a second level of package config or be refused outright is
  unresolved.
- **Whether Requirement 3.3's per-analyzer breakdown belongs in `RunReport` itself or in a separate,
  optional diagnostic stream.** Adding it unconditionally grows every report format's output for every run,
  including the common single-analyzer case where it says nothing surprising; this spec requires it exist
  but does not settle its default visibility.
- **What "the affected set" means for a rule pack spanning analyzers** — if a `strict-boundaries`-style rule
  (0027) ever reasons about a dependency edge the TypeScript analyzer's own project graph does not see (an
  import mediated by a config file, a generated re-export), Requirement 2's package-graph closure and
  Requirement 4's project-graph closure are computed from two different graphs that happen to agree in every
  case this repository has today. Whether they must be unified before a rule can safely depend on both is
  not resolved here.
