# 0019 — CI integrations beyond GitHub Actions: Requirements

**Status:** draft, partly implemented
**Created:** 2026-08-27
**Depends on:** 0001, 0003, 0008

## What is implemented, and what is not

`cyv install-ci` (`packages/core/src/cli/install-ci.ts`, `packages/core/src/ci/`) detects the CI
system from files present, builds one shared `GateModel`, and renders a gate per platform. Seven
platforms are covered rather than the four this spec names — Bitbucket Pipelines and Travis CI were
added alongside GitHub Actions, and GitHub Actions is generated rather than only generalized from.

Landed:

- **Requirement 2.1, 2.2** — one `GateModel`, seven renderers, each an exhaustive `switch` over
  `GateStep` so a new step does not compile until every platform answers for it.
- **Requirement 2.3, 6.3, 6.4** — every rendered gate states in its own comments that this project
  maintains no account or runner on the platform, and that the output is shape-checked and not
  execution-verified.
- **Requirement 3.4** — the gate tests for `checkyourvibe.baseline.json` at run time and passes
  `--since-baseline` only when one is present.
- **Requirement 5** — `create`/append via `managed-block` with format-correct delimiters
  (`ManagedBlockComment` in `protocol/agent.ts`); no `json-merge` or `toml-merge`; per-platform
  block ids; nothing outside a block is touched. Requirement 5.5's refusal is generalized: any
  platform whose gate would have to nest inside an existing key gets a printed snippet and a stated
  reason instead of a guessed insertion.
- **Requirement 6.1** — unit tests, no network, no account.

Not landed, and not claimed:

- **Requirement 1.2, 3.1, 3.2** — no base-ref resolution order, because the generated gate runs
  `--all`, which has no base ref to fail to resolve. Full history is still requested everywhere the
  platform can express it, so narrowing the mode later is a config change rather than a rewrite.
- **Requirement 1.3** — `filesChecked` reaches the job log through `cyv check`'s ordinary human
  output; nothing promotes or restates it.
- **Requirement 4.3, 4.5** — no `--sarif` artifact step, no GitLab code-quality report, no Azure
  `logissue` annotations. The gate's interface is its exit code and its console output.
- **Requirement 6.2** — generated YAML is checked structurally by this project's own tests
  (`test/ci/render.test.ts`), not against each platform's published schema.

## Introduction

The roadmap calls this entry "dull, and the reason a tool gets ruled out in procurement." That framing
is the spec: nobody adopts a code-quality tool *because* it supports GitLab CI, and every team that
already lives on GitLab CI, Azure Pipelines, CircleCI, or Jenkins rules it out the moment it does not.
There is no interesting feature to design here. There is only a large number of small facts — a
variable name, a default clone depth, a report schema — that are either right or wrong, and being wrong
about one of them produces the single worst outcome this project has a name for: a job that ran, found
nothing, and exited 0, while believing it had checked something.

This repository already has one CI integration: `.github/workflows/ci.yml` runs `cyv check --all
--strict --sarif` against its own source on every push and pull request, with a full (`fetch-depth: 0`)
checkout, uploading the result via `github/codeql-action/upload-sarif@v3` so findings annotate the PR
through GitHub's own code-scanning UI. That job is not diff-scoped and does not use `--since-baseline`,
but it is not report-less either — it is the baseline this spec has to generalize from, not duplicate
four times by hand, and it is also the proof that `--sarif` is a live, already-working flag rather than
a future dependency (see the corrected note on `cyv sarif` below).

The other half of this project's enforcement story is `cyv install-hooks`, the git pre-commit backstop.
Between the two of them, the project's own vocabulary distinguishes three tiers:

- **Advisory** — MCP, agent instructions files. May be wrong, may be ignored, may say nothing.
- **A fast loop that may degrade** — agent hooks (`cyv hook <agent-id>`). Best-effort, and explicitly
  allowed to fail open: a vendor payload the plugin cannot parse becomes no feedback, not a wedged
  editor.
- **A guarantee** — the git hook and CI. Per the roadmap's principles: *"Degrade in the right direction.
  The advisory loop may fail open; the backstop may not."*

CI is the second half of the guarantee tier, alongside the git hook. This spec is about keeping it one.

## Verified state before writing this spec

- `packages/core/src/cli/check.ts` accepts mode flags `--staged`, `--working`, `--branch`, `--all`
  (default `working` with no paths, `files` with paths), plus `--json`, `--sarif`, `--strict`,
  `--no-color`, `--since-baseline`, `--record-history` (`--json` and `--sarif` are mutually exclusive; both
  are machine formats for the same stdout). An unrecognized flag throws. `--since-baseline` with no
  baseline file present prints an error to stderr and returns exit code `2` — distinct from `1`.
- `packages/core/src/report/exit.ts` (`exitCodeFor`) returns `1` if any violation has
  `severity: 'error'`, or if `report.strict` and `report.skipped.length > 0`; otherwise `0`. A
  `warning`-severity violation never fails a run, strict or not — `Severity` is only `'error' |
  'warning'`.
- `RunReport` (`packages/core/src/report/types.ts`) carries `filesChecked`, `mode`, `diagnostics`
  (`{ level: 'info' | 'warn' | 'error'; message: string }`, free text, no structured code), `skipped`,
  and `projectRulesSkipped`. `renderJson` includes all of these, so `filesChecked` is machine-readable
  from `--json` output today.
- `packages/core/src/run/discover.ts` computes `branch`/`working` mode by finding `defaultBranch()` and
  `mergeBase(repoRoot, branch)`. **When `mergeBase` cannot resolve a common ancestor — the exact
  situation a shallow clone produces — the fallback for both modes is to diff against `HEAD` itself**,
  which is empty by construction. The only trace left is one `level: 'info'` diagnostic with a
  human-readable `reason` string; nothing about the report's shape, mode, or exit code changes. This is
  a real, already-implemented instance of the failure this spec exists to prevent, not a hypothetical:
  wired into a CI job with a shallow checkout, it produces `filesChecked: 0`, exit `0`, and a green
  build, indistinguishable from a PR that genuinely touched nothing this tool cares about.
- `packages/core/src/backstop/install.ts` (the git hook backstop) refuses to overwrite a pre-existing
  pre-commit hook it did not write, detected by a `# checkyourvibe-managed` marker, unless `--force` is
  given. This is the direct precedent for configuration ownership in this spec.
- `packages/core/src/protocol/agent.ts` defines the merge vocabulary this project already uses for
  generated files: `MergeStrategy = 'create-if-absent' | 'json-merge' | 'managed-block' |
  'toml-merge'`, plus `UnverifiedSurface` (a surface a plugin implements against inferred, not
  vendor-confirmed, behavior) and namespaced `blockId`s so two plugins editing the same shared file
  cannot silently clobber each other.
- `packages/core/src/report/sarif.ts` exports a working `renderSarif(report)` producing SARIF 2.1.0, and
  it is exported from the `report` barrel. **The CLI surface is already live, not a future dependency**:
  `cyv check` takes a `--sarif` flag (`cli/check.ts`, alongside `--json`) that renders this project's own
  SARIF and writes it to stdout, and this repository's own `.github/workflows/ci.yml` already invokes it
  (`cyv check --all --strict --sarif`) and uploads the result. There is no separate `cyv sarif`
  subcommand — `cli/index.ts`'s command table has no `sarif` entry, and no `cli/sarif.ts` file exists —
  but none is needed: the working surface is the `check --sarif` flag, not a standalone command. An
  earlier draft of this spec asserted the opposite (a registered-but-unimplemented `cyv sarif`
  subcommand); that claim was checked against the source while reviewing this spec and found false, and
  is corrected here and everywhere it was load-bearing below (Requirement 4.5, Non-goals).
- Nothing in the repository today (code, tests, or docs) references GitLab, Azure Pipelines, CircleCI,
  or Jenkins. This is a greenfield spec with one real precedent (GitHub Actions) to generalize from.

## Requirement 1 — The enforcement tier, and making the zero-file pass impossible

1. Each of the four platforms' generated pipelines SHALL be documented as sitting in the **guarantee**
   tier, with the same standing as the git hook: it MAY refuse to run rather than guess, and it MAY NOT
   silently report success over work it did not do.
2. A generated CI job SHALL fail the build outright — not merely log a warning — when it cannot
   establish, by a documented and verifiable mechanism, which commit range it is checking. It SHALL NOT
   fall back to a diff mode whose failure mode is an empty diff, because an empty diff and a genuinely
   clean run are indistinguishable from the outside once that happens, and that is precisely today's
   `discover.ts` fallback described above. Requirement 3 defines the resolution order this failure sits
   at the end of.
3. `filesChecked` (already present in `--json` output) SHALL be surfaced unconditionally in the job's
   visible log, not only inside a JSON blob a human is not reading — a reviewer glancing at a green job
   must be able to see, without opening an artifact, how many files were actually checked.
4. WHEN a repository has no analyzer configured, or every configured analyzer's rules resolve to
   nothing, the run already reports this through `diagnostics`/`projectRulesSkipped`; the CI templates
   SHALL NOT swallow or downgrade that reporting on the way to the job's pass/fail decision.
5. The distinction between "genuinely nothing changed" (a real, legitimate `filesChecked: 0` — e.g. a
   pull request touching only a file no analyzer routes) and "the pipeline could not tell what changed"
   SHALL be preserved end to end. Requirement 1.2 governs the second case; the first case remains a
   pass, because failing it would be its own kind of false alarm and would teach teams to bypass the
   gate.

## Requirement 2 — One shared model, four renderers

Across GitLab CI, Azure Pipelines, CircleCI, and Jenkins, the axes that actually differ are:

| Axis | GitLab CI | Azure Pipelines | CircleCI | Jenkins |
|---|---|---|---|---|
| Config file | `.gitlab-ci.yml` (or an `include:`d path), YAML | `azure-pipelines.yml`, YAML, path chosen at pipeline creation — no fixed convention | `.circleci/config.yml`, YAML, fixed path | `Jenkinsfile`, Groovy (declarative or scripted), path conventionally at repo root but configurable |
| Base-ref exposure | `CI_MERGE_REQUEST_DIFF_BASE_SHA` in merge-request pipelines only; absent on branch/push pipelines | `System.PullRequest.TargetBranch` on PR-triggered runs; absent otherwise | No first-party base-ref or target-branch variable at all | `CHANGE_TARGET`/`CHANGE_ID`, but only when a PR-discovery source is configured for that job — a bare Pipeline job has neither |
| Findings surfaced natively | `artifacts:reports:codequality` populates the MR widget (GitLab's own JSON schema, not SARIF) | `##vso[task.logissue ...]` logging commands produce build-summary annotations; no inline PR comments without an authenticated API call | No native findings surface; job pass/fail plus console output and artifacts only | No first-party annotation concept; a report-consuming plugin, if the user has one installed, may render a supported format — this project assumes none |
| Caching | `cache:` keys/paths in the YAML | `Cache@2` task | `save_cache`/`restore_cache` steps keyed by a checksum | No first-party primitive; depends on agent/workspace persistence the user controls |

1. This variance SHALL be captured once, as a shared, platform-neutral pipeline model — the ordered
   steps (checkout with sufficient history, set up Node, optionally set up .NET, install dependencies,
   run `cyv check` with a resolved mode and flags, surface the result) — from which each platform's
   config is *rendered*, not hand-authored four times.
2. A change to the shared model (a new required step, a changed flag, a changed cache key) SHALL
   propagate to all four rendered outputs from one edit. Four independently maintained YAML/Groovy files
   that happen to agree today are the drift this requirement exists to prevent.
3. Each platform's renderer SHALL declare, per the `UnverifiedSurface` vocabulary already used for agent
   plugins, which of its integration points are confirmed against that platform's own documentation and
   which are best-effort inference — the report-surfacing row above in particular, since this project
   verifies none of it against a live account (Requirement 6).
4. The shared model SHALL NOT encode anything that only one platform can express (an Azure-specific
   logging command, say) directly in itself; that belongs in the platform-specific renderer, keyed off
   the model's generic step.

## Requirement 3 — Determining what changed

1. Each platform's renderer SHALL attempt, in order:
   1. The platform's own base-ref mechanism, per the table above, when the trigger context provides one.
   2. An explicit override the user can set once (e.g. a configured base-branch name), for the
      documented cases where no platform mechanism is reliably present — Jenkins without a
      PR-discovery source, and CircleCI always.
   3. Failure — Requirement 1.2 applies: the job fails with an actionable message naming what could not
      be determined and how to fix it (typically: widen the checkout's fetch depth, or set the
      override), rather than silently doing less than it claimed.
2. Every generated config SHALL request enough git history for `git merge-base` to succeed against the
   resolved base branch. A shallow, single-commit checkout — several platforms' default — is the most
   common real-world way to reach the failure this spec exists to prevent, and the fix is a config field,
   not a runtime guess.
3. WHEN a fallback in step 1.2 is used, that fact SHALL be visible in the job's log at a level a human
   skimming CI output would notice — not folded into an `info`-level diagnostic inside a JSON payload,
   which is what the underlying `discover.ts` mechanism does today. This spec requires the CI-facing
   wrapper to promote and restate it, since the diagnostic's `message` is free text with no structured
   code a wrapper can safely match on — a gap noted again in Open questions.
4. `--since-baseline` (spec 0008) remains the mechanism for adopting this on a codebase with existing
   debt. A generated CI job SHALL use it when a baseline file is present in the repository, and SHALL
   NOT pass the flag when one is not — relying on `cyv check`'s existing behavior of failing with exit
   `2` and a clear message in that case, rather than adding a second check for the same condition.

## Requirement 4 — Exit codes, annotations, and reports

1. The job SHALL fail (non-zero) on: any `error`-severity violation in the resolved scope; a strict-mode
   run with any skipped file; and the base-ref failure in Requirement 1.2 / 3.1.3.
2. The job SHALL NOT fail, but SHALL report, on: `warning`-severity violations; violations deferred by
   a baseline (still printed with their count, per 0008 Requirement 2.4); and diagnostics that do not
   indicate a base-ref failure.
3. Where a platform exposes a native mechanism for surfacing findings inline in its review UI (GitLab's
   code-quality report, Azure's log-issue annotations), the generated pipeline SHALL use it. Where none
   exists (CircleCI, Jenkins without an installed report-consuming plugin), the job's console output and
   exit code remain the only interface, and the spec SHALL say so rather than inventing an
   authenticated workaround (Requirement 7 / Non-goals: no API keys).
4. Whichever machine format is requested — `--json` or `--sarif`, `check.ts`'s own two mutually
   exclusive machine-format flags — SHALL go to stdout alone, exactly as `cyv check` already does; any
   human-readable notice (the baseline line, the fallback notice) SHALL go to stderr in that mode, per
   `check.ts`'s existing convention. A CI wrapper that merges the two streams before parsing will corrupt
   the JSON or SARIF it depends on — this is the kind of small, exact thing this spec has to get right.
5. `cyv check <mode> --sarif` already renders this project's SARIF (`renderSarif` in `report/sarif.ts`)
   to stdout — the same live flag this repository's own `.github/workflows/ci.yml` uses today — so a
   generated pipeline MAY redirect it to a file and publish it as a build artifact on any of the four
   platforms, even though none of them (per Requirement 2's comparison table) natively ingests SARIF the
   way GitHub's code-scanning UI does. Where a platform has no native structured-findings surface
   (Requirement 4.3), publishing the SARIF file as a plain artifact is still strictly more useful than
   nothing, and it costs this spec nothing to include, since the flag already exists and is already
   proven in this repository's own job.

## Requirement 5 — Generated configuration is the user's file

Of the four `MergeStrategy` values already defined in `packages/core/src/protocol/agent.ts`, only two
apply to CI pipeline files; the other two are declared inapplicable rather than stretched to fit, and no
fifth strategy is invented.

1. `json-merge` and `toml-merge` SHALL NOT be used for any of the four platforms' config formats — none
   of `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/config.yml`, or `Jenkinsfile` is JSON or TOML.
2. WHEN no config file exists at the platform's conventional location, the renderer SHALL use
   `create-if-absent` and write the full generated file.
3. WHEN a config file already exists, the renderer SHALL use a `managed-block` strategy: a delimited
   region inserted into the existing file, everything outside it preserved byte-for-byte, exactly as
   `agent.ts` already requires for shared instruction files. The delimiter comment syntax SHALL match the
   target format — `#`-prefixed for the three YAML-based platforms, `//`-prefixed for a `Jenkinsfile` —
   rather than reusing the literal HTML-comment (`<!-- checkyourvibe:start:... -->`) constant `agent.ts`
   defines, which is specific to the Markdown-like files it was written for.
4. The `managed-block` id SHALL be namespaced per platform (e.g. `ci-gitlab`, not `ci`), for the same
   reason `agent.ts` requires it for agent plugins: more than one tool, or more than one checkyourvibe
   integration, may write into the same shared pipeline file.
5. WHERE an existing `Jenkinsfile` is a scripted (not declarative) pipeline, the renderer SHALL NOT
   attempt a `managed-block` insertion — Groovy with arbitrary control flow cannot be safely parsed for
   a stage-insertion point — and SHALL instead print the stage to add and instructions for adding it by
   hand, the same way `cyv install-hooks` already refuses to guess at an unrecognized existing hook
   rather than force one in.
6. No renderer SHALL delete or reformat any part of an existing file outside its own managed block.

## Requirement 6 — Verification, honestly

1. The shared pipeline model and each platform's renderer SHALL be covered by unit tests that do not
   require network access or an account on any platform.
2. WHERE a platform publishes a schema for its config format, generated output SHALL be validated
   against it as part of this project's own test suite.
3. **This project does not maintain accounts, runners, or a live pipeline on GitLab, Azure DevOps,
   CircleCI, or Jenkins, and this spec does not require it to start.** Consequently: schema validity and
   the shared model's logic are verified; a generated pipeline actually running to completion on that
   platform, resolving its base ref the way this spec assumes, and rendering its report the way
   Requirement 4.3 assumes, is **not** verified by this project and is not claimed to be.
4. This limitation SHALL be stated in the generated output itself — a comment at the top of each
   generated file — not only in project documentation a user may never open, so a team relying on one of
   these pipelines knows precisely what has and has not been exercised before they trust it.
5. WHERE this repository or a contributor does have ad hoc, occasional access to one of the four
   platforms, a manual verification pass is welcome and should update the claim in 6.3 for that platform
   specifically — but the default, honest state is "schema-checked, not execution-verified."

## Non-goals

- Hosted dashboards, or any UI beyond what a platform's own native job page and review UI already show.
- Anything requiring an API key, a personal access token, or a service-account credential — this rules
  out authenticated inline PR-comment posting on Azure Pipelines and GitLab (both possible in principle,
  neither reachable without a token this project will not ask a user to provision), and any "log in and
  see your findings" feature.
- Anything that spends a token on the user's behalf, per the roadmap's standing constraint — no
  generated pipeline step may call a model to summarize, triage, or explain a finding. Guidance is the
  rule manifest's `summary`/`why`/`allowedFixes`, already written once, same as everywhere else.
- A fifth platform. Four is deliberately exhaustive for this spec; a fifth is the next one, not this one.
- Maintaining live accounts, runners, or CI subscriptions on any of the four platforms.
- New analysis rules, new severities, or any change to `Violation`, `Diagnostic`, or `exitCodeFor`
  semantics. This spec consumes the existing report contract; it does not renegotiate it (though
  Requirement 3.3 notes a real gap in `Diagnostic` this spec cannot itself close).

## Open questions

- **Is a hard job failure the right default when the base ref cannot be determined** (Requirement
  1.2 / 3.1.3), or should the declared fallback instead be a full-tree `--all` scan with a loud warning,
  reserving the hard failure for a stricter opt-in? The guarantee-tier framing argues for failing closed;
  the adoption experience (a team's very first CI run tripping over their default shallow-clone setting)
  argues the other way. This spec picks fail-closed and states why, but it is a real trade-off, not a
  settled one.
- **`Diagnostic` has no structured code, only a free-text `message`.** This spec's Requirement 3.3
  needs a CI wrapper to detect "the merge-base fallback fired" reliably; today that means matching a
  human-readable sentence, which breaks the moment the sentence's wording changes for a reason having
  nothing to do with CI. Whether `Diagnostic` gains a `code` field is a core protocol change outside this
  spec's scope, but this spec cannot be fully implemented without it or an equivalent.
- **Package layout is undecided**: one `packages/ci-integrations` producing four renderers from the
  shared model, or four `adapter-ci-*` packages mirroring the existing `adapter-*` (Claude Code, Cursor,
  Gemini, Antigravity, Codex) convention. The existing convention argues for symmetry; Requirement 2's
  insistence on one shared model argues for one package with four render targets, since splitting into
  four packages is exactly the shape that invites the drift Requirement 2.2 rules out.
- **Whether a CI platform should be modeled as another `AgentPlugin`** (reusing `detect`/`plan`, and
  `cyv init`/`cyv doctor`'s existing drift detection) or as a distinct, narrower interface. The `detect`/
  `plan`/merge-strategy machinery fits cleanly; `parseHookPayload` and `formatResult` — built for a
  per-edit hook payload — do not correspond to anything a CI job receives. Forcing CI through the full
  `AgentPlugin` shape to get `doctor` support for free may cost more clarity than it saves.
- **Jenkins is the platform where "the integration exists in principle" is least true in practice**,
  since so much of what it can expose (base ref, report rendering) depends on which optional source and
  plugin configuration a given Jenkins installation happens to have. The roadmap lists it; this spec
  does not resolve whether a Jenkins integration this dependent on the installation is worth the same
  confidence the other three warrant, or whether it should ship more conditionally documented than the
  others from the start.
