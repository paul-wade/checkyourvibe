# 0001 — Core Vertical Slice: Requirements

**Status:** active
**Created:** 2026-08-26

## Introduction

checkyourvibe is a code-standards layer built for code written by AI agents. It plugs into whichever
AI coding CLI the user runs, reports violations *with the guidance needed to fix them correctly*, and
backstops everything with a git hook that runs regardless of which agent (or human) produced the code.

Two things differentiate it from a conventional linter, and every requirement below serves one of them:

1. **Full type resolution.** Analyzers load a real compiler (ts-morph loads the TypeScript compiler),
   so they see inferred types — an `any` that no annotation declares — which a parser-only linter cannot.
2. **The agent feedback loop.** A violation arrives with its remediation guidance, in the agent's own
   format, at edit time. Critically, that guidance names the fixes that are *themselves* violations, so
   an agent cannot launder one violation into another.

This spec covers the **vertical slice**: one core, one analyzer (TypeScript/ts-morph), one agent
integration (Claude Code), the git backstop, and the MCP server. It deliberately proves both plug-in
axes with one real implementation each rather than multiplying either.

### Out of scope for 0001

Knowledge vault, project board, diff-review loop, the `spec` CLI itself, the executor surface, any
second agent integration, any second language analyzer, and any framework-specific rules
(Angular/NestJS/GraphQL/ORM/infra). Each gets its own spec.

### Provenance constraint (non-negotiable)

This project is a **rebuild, never a copy**. No file, rule implementation, fixture, or prose is carried
over from any prior private repository. Rules that share a name with a common lint concept are
implemented from the concept, and all guidance prose is authored fresh. No employer name, coworker
name, vendor name, internal document path, or internal project identifier appears anywhere in the
repository or its history. The repository is private today and public later; history is permanent, so
this holds from the first commit.

---

## Requirement 1 — Analyzer plug-in contract

**User story:** As a developer who works in a language other than TypeScript, I want to add support for
my language without modifying checkyourvibe's core, so that the project is useful beyond its first
implementation.

#### Acceptance criteria

1. WHEN the core loads an analyzer THEN it SHALL read a static manifest file without executing any
   analyzer code or booting any language toolchain.
2. The analyzer manifest SHALL declare `protocol`, `id`, `match` globs, optional `exclude` globs, its
   rule manifests, and an `exec` descriptor.
3. WHERE `exec.type` is `node`, the core SHALL import the module and invoke it in-process.
4. WHERE `exec.type` is `process`, the core SHALL spawn the command, write the request as JSON to
   stdin, and read the response as JSON from stdout.
5. Both execution shapes SHALL satisfy byte-identical request and response JSON Schemas.
6. WHEN an analyzer writes to stderr THEN the core SHALL capture it as diagnostics rather than
   discarding it.
7. WHEN an analyzer returns a malformed response THEN the core SHALL exit with code 2 (internal error)
   and name the offending analyzer.
8. The core SHALL provide `cyv verify-analyzer <path>`, a conformance suite that validates a
   third-party analyzer against the schemas without that analyzer being registered in any config.

## Requirement 2 — Agent plug-in contract

**User story:** As a user of Codex, Cursor, Gemini CLI, or Antigravity rather than Claude Code, I want
checkyourvibe to integrate with my agent, so that I am not forced onto a specific vendor.

#### Acceptance criteria

1. An agent plugin SHALL declare `id`, `name`, and a `surfaces` array drawn from
   `hook | instructions | guidance | mcp | executor`.
2. An agent plugin SHALL implement only the surfaces it declares, and the core SHALL NOT assume any
   surface is present.
3. WHEN the core generates agent configuration THEN it SHALL produce a *plan* of proposed writes and
   SHALL NOT write to disk as part of planning.
4. Each planned write SHALL carry a merge strategy of `create-if-absent`, `json-merge`, or
   `managed-block`.
5. WHERE the strategy is `managed-block`, regeneration SHALL replace only content between the
   checkyourvibe delimiters and SHALL preserve all surrounding user-authored content byte-for-byte.
6. WHERE the strategy is `json-merge`, regeneration SHALL add or update only checkyourvibe's own keys
   and SHALL preserve all other keys and their ordering.
7. WHEN `cyv init` runs THEN it SHALL display the planned changes and SHALL require confirmation
   before applying, unless `--yes` is passed.
8. Generated hook configuration SHALL invoke `cyv hook <agent-id>` and SHALL NOT embed
   agent-specific parsing logic in the generated config.
9. The `executor` surface SHALL be a declarable value in 0001 but SHALL NOT be implemented in 0001.

## Requirement 3 — Rule manifests and guidance

**User story:** As an AI agent that has just been told my code violates a rule, I want to know the
correct fix and which apparent fixes are themselves violations, so that I do not replace one violation
with another.

#### Acceptance criteria

1. Every rule SHALL be described by a manifest declaring `id`, `category`, `scope`, default `severity`,
   `summary`, `why`, `allowedFixes`, `notFixes`, and `examples`.
2. `scope` SHALL be `file` or `project`.
3. `notFixes` entries SHALL name a remediation that would trip another rule, together with the reason.
4. WHEN a `notFixes` entry references a rule id that does not exist THEN the core SHALL report a
   configuration error.
5. WHEN a violation is reported through any channel THEN its remediation guidance SHALL be included
   inline and SHALL NOT require a second lookup.
6. The core SHALL render a rule manifest to a human-readable terminal form via `cyv explain <rule-id>`.
7. The core SHALL render rule manifests into agent-consumable files through an agent plugin, and those
   renderers SHALL share templates with the terminal renderer so the three cannot drift.
8. Rules SHALL accept per-rule options validated against a JSON Schema declared in their manifest.

## Requirement 4 — Running checks

**User story:** As a developer, I want to check exactly the code I care about — one file, my staged
changes, my branch, or everything — so that checks are fast enough to run constantly.

#### Acceptance criteria

1. The core SHALL support these selections: explicit file paths, `--staged`, `--working`, `--branch`,
   `--all`, and `--watch`.
2. `--working` SHALL compare the working tree against the merge-base with the default branch.
3. `--branch` SHALL compare committed work only, against the merge-base with the default branch.
4. WHEN any mode resolves to zero files THEN the core SHALL report that prominently and SHALL NOT
   present the run as a clean pass.
5. WHEN a selection includes only file-scope rules because of the mode THEN the core SHALL state which
   project-scope rules were not run.
6. WHEN an analyzer reports skipped files THEN the core SHALL list them.
7. WHERE `--strict` is passed, skipped files SHALL cause a non-zero exit.
8. The core SHALL exit 0 for a clean run, 1 for violations, and 2 for configuration or internal errors.
9. `--json` SHALL emit machine-readable output on stdout with no human-formatted text interleaved.
10. `--watch` SHALL use the in-process execution path and SHALL retain analyzer state between runs.

## Requirement 5 — Configuration

**User story:** As a developer adopting checkyourvibe, I want one config file that declares what runs
and how, so that behaviour is reproducible across my machine, my teammates', and CI.

#### Acceptance criteria

1. Configuration SHALL live at `checkyourvibe.json` in the repository root.
2. A JSON Schema for the configuration SHALL be published in the repository.
3. Configuration SHALL declare enabled analyzers, enabled rule packs, per-rule severity and option
   overrides, enabled agent integrations, and strictness.
4. WHEN configuration is absent THEN the core SHALL report a clear error naming `cyv init` rather than
   silently applying defaults.
5. WHEN configuration fails schema validation THEN the core SHALL exit 2 and report the failing path.
6. WHEN a severity override names an unknown rule THEN the core SHALL report a configuration error.

## Requirement 6 — Git backstop

**User story:** As a developer, I want a check that runs no matter which agent wrote the code, so that
my standards do not depend on an agent choosing to cooperate.

#### Acceptance criteria

1. The core SHALL provide `cyv install-hooks`, installing a `pre-commit` hook running
   `cyv check --staged --strict`.
2. WHERE husky or lefthook is already present, `cyv install-hooks` SHALL integrate with it rather than
   overwrite `.git/hooks`.
3. WHEN an existing `pre-commit` hook is present and unmanaged THEN `cyv install-hooks` SHALL NOT
   overwrite it without confirmation.
4. The repository SHALL ship a GitHub Actions workflow running the same check.
5. Documentation SHALL state plainly that `--no-verify` bypasses the local hook and that CI is the
   non-bypassable layer.

## Requirement 7 — MCP server

**User story:** As any MCP-capable agent, I want to query checkyourvibe on demand, so that I get
current rules without a large instruction blob in my context.

#### Acceptance criteria

1. The core SHALL provide `cyv mcp`, an MCP server over stdio.
2. It SHALL expose `check_files`, `check_working_tree`, `explain_rule`, and `list_rules`.
3. `check_*` results SHALL embed remediation guidance inline per Requirement 3.5.
4. WHEN the server encounters an internal error THEN it SHALL return an MCP error rather than exiting.

## Requirement 8 — Failure behaviour

**User story:** As a developer mid-edit, I want a broken integration to get out of my way, while a
broken gate stops me, so that failures degrade in the direction that matches their purpose.

#### Acceptance criteria

1. WHEN `cyv hook <agent-id>` cannot parse its stdin payload THEN it SHALL emit a warning and exit 0.
2. WHEN `cyv hook <agent-id>` encounters an internal error THEN it SHALL emit a warning and exit 0.
3. WHEN `cyv check --strict` encounters any error condition THEN it SHALL exit non-zero.
4. The distinction in 8.1–8.3 SHALL be documented as deliberate: the advisory loop degrades, the
   backstop does not.

## Requirement 9 — Starter rule pack

**User story:** As a new user, I want useful checks immediately, so that I can evaluate the tool
without authoring rules first.

#### Acceptance criteria

1. The TypeScript analyzer SHALL ship a `core-ts` pack containing `no-any`, `no-as-cast`,
   `no-non-null-assertion`, `no-ts-comment`, `no-json-parse-cast`, `no-useless-types`, and `no-console`.
2. Every rule SHALL be framework-agnostic and SHALL NOT assume any web framework, ORM, cloud provider,
   logging vendor, or repository layout.
3. `no-console` SHALL accept an `allowedMethods` option rather than naming any specific logging library.
4. `no-any` SHALL detect inferred `any`, not only explicit `any` annotations.
5. Every rule SHALL have fixture pairs asserting both detection and absence of false positives.

## Requirement 10 — Self-application

**User story:** As the maintainer, I want checkyourvibe checked by checkyourvibe, so that the tool is
proven against real code rather than only fixtures.

#### Acceptance criteria

1. The repository SHALL contain a `checkyourvibe.json` configuring itself.
2. CI SHALL run checkyourvibe against its own source.
3. The self-check SHALL pass, with any deliberate exemption recorded in configuration with a reason.
