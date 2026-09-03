# 0001 — Core Vertical Slice: Design

**Status:** active
**Created:** 2026-08-26

## Overview

Three plug-in axes, one core. Two are implemented in 0001; the third is declarable only.

- **Analyzers** — one per language. Own parsing, type resolution, and rule execution.
- **Agent plugins** — one per AI coding CLI. Own that agent's config format, hook payload shape, and
  exit-code conventions.
- **Executors** — one per agent that can be given work. Declarable via `surfaces` in 0001; not built.

The core owns everything neither of those should know about: configuration, file discovery, routing
files to analyzers, invoking analyzers, aggregating results, rendering reports and guidance, the MCP
server, the CLI, and the git backstop.

**The core's language is an implementation detail.** Because analyzers and agent plugins communicate
across a process boundary with a versioned JSON contract, a future core in another language would not
break either. TypeScript on Node is chosen for 0001 because ts-morph is Node, the MCP SDK is strongest
in TypeScript, and the audience already runs Node for their agent CLI.

## Repository layout

```
checkyourvibe/
  package.json                 pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  checkyourvibe.json           self-application config (Requirement 10)
  LICENSE                      MIT
  .github/workflows/ci.yml
  docs/
    specs/0001-core-vertical-slice/{requirements,design,tasks}.md
    protocol/
      analyzer-manifest.schema.json
      analyze-request.schema.json
      analyze-response.schema.json
      rule-manifest.schema.json
      config.schema.json
  packages/
    core/
    analyzer-typescript/
    adapter-claude-code/
```

Three packages, not five. Enough to make the plug-in boundary real and to establish the naming pattern
a third party would follow (`cyv-analyzer-csharp`), without ceremony that 0001 cannot justify.

## Protocol types

These are the contract. Everything downstream codes against them; they are authored once and not
edited by implementation tasks.

```ts
// packages/core/src/protocol/violation.ts
export type Severity = 'error' | 'warning';

export interface Violation {
  file: string;          // absolute path
  line: number;          // 1-based
  column: number;        // 1-based
  endLine?: number;
  endColumn?: number;
  ruleId: string;
  message: string;
  snippet: string;       // offending source, truncated to 200 chars
  severity: Severity;
  guidance?: RuleGuidance;   // populated by core, not by analyzers
}

export interface SkippedFile { file: string; reason: string; }
export interface Diagnostic { level: 'info' | 'warn' | 'error'; message: string; }
```

```ts
// packages/core/src/protocol/rule-manifest.ts
export interface NotFix { pattern: string; because: string; rule?: string; }

export interface RuleGuidance {
  summary: string;
  why: string;
  allowedFixes: string[];
  notFixes: NotFix[];
  examples: { bad: string; good: string };
}

export interface RuleManifest extends RuleGuidance {
  id: string;
  category: string;
  scope: 'file' | 'project';
  severity: Severity;              // default; config may override
  optionsSchema?: object;          // JSON Schema for this rule's options
}
```

```ts
// packages/core/src/protocol/analyzer.ts
export const PROTOCOL_VERSION = 1;

export interface AnalyzerManifest {
  protocol: 1;
  id: string;
  match: string[];
  exclude?: string[];
  rules: RuleManifest[];
  capabilities?: { session?: boolean };   // reserved; unused in 0001
  exec:
    | { type: 'node'; module: string }
    | { type: 'process'; command: string; args?: string[] };
}

export interface AnalyzeRequest {
  protocol: 1;
  repoRoot: string;
  mode: 'file' | 'project';
  files: string[];                                   // absolute paths
  rules: Record<string, { severity: Severity } & Record<string, unknown>>;
  options?: Record<string, unknown>;                 // analyzer-specific, from config
}

export interface AnalyzeResponse {
  protocol: 1;
  violations: Violation[];
  skipped: SkippedFile[];
  diagnostics: Diagnostic[];
}

/** What an `exec.type: 'node'` analyzer module must default-export. */
export type AnalyzeFn = (req: AnalyzeRequest) => Promise<AnalyzeResponse>;
```

```ts
// packages/core/src/protocol/agent.ts
export type AgentSurface = 'hook' | 'instructions' | 'guidance' | 'mcp' | 'executor';
export type MergeStrategy = 'create-if-absent' | 'json-merge' | 'managed-block';

export interface PlannedWrite {
  path: string;                     // absolute
  strategy: MergeStrategy;
  content: string;                  // full content, or block body for managed-block
  blockId?: string;                 // required for managed-block
  description: string;              // one line, shown in the init diff
}

export interface HookPayload { files: string[]; event: string; }

export interface HookResult { stdout: string; stderr: string; exitCode: number; }

export interface AgentPlugin {
  id: string;
  name: string;
  surfaces: AgentSurface[];
  detect(ctx: DetectContext): Promise<boolean>;
  plan(ctx: PlanContext): Promise<PlannedWrite[]>;
  parseHookPayload(raw: string): HookPayload;      // throws on malformed input
  formatResult(violations: Violation[], ctx: FormatContext): HookResult;
}
```

`Violation.guidance` is populated by the **core**, not the analyzer. Analyzers report facts; the core
attaches guidance from the rule manifest. This keeps analyzers small and guarantees Requirement 3.5
holds identically across every channel and every analyzer.

## Managed-block format

```
<!-- checkyourvibe:start:<blockId> -->
...generated content...
<!-- checkyourvibe:end:<blockId> -->
```

Rules: replace only between delimiters; if absent, append with a leading blank line; if the end
delimiter is missing, treat the file as corrupted and fail rather than guess. For JSON targets the
strategy is `json-merge` instead — parse, set only checkyourvibe's keys, re-serialize preserving
existing key order.

## Execution flow

```
cyv check --staged
  → load + validate config                     (exit 2 on failure)
  → resolve file set from git                  (report loudly if empty)
  → route files to analyzers by match/exclude globs
  → for each analyzer: build AnalyzeRequest with enabled+configured rules
      exec.type node    → import module, call in-process
      exec.type process → spawn, write stdin, read stdout, capture stderr
  → attach guidance to each violation from rule manifests
  → aggregate violations + skipped + diagnostics
  → report (text or json)
  → exit 0 / 1 / 2
```

Routing is glob-based and a file may match exactly one analyzer in 0001; ambiguity is a configuration
error rather than a silent first-match win.

## TypeScript analyzer

One ts-morph `Project` per invocation, created from the nearest `tsconfig.json` so type resolution is
real. In `--watch`, the `Project` is retained and only changed source files are refreshed — rebuilding
it per keystroke is the thing that makes watch mode unusable.

Each rule is a module exporting a manifest and a check function:

```ts
export interface TsRule {
  manifest: RuleManifest;
  check(sourceFile: SourceFile, options: Record<string, unknown>): Violation[];
}
```

The package exposes both execution shapes over one implementation: an `AnalyzeFn` default export for
in-process use, and a `bin/analyze.ts` that reads a request from stdin and writes a response to
stdout. The subprocess path is therefore exercised by the reference implementation from day one and
cannot rot before the first non-Node analyzer exists.

**Starter pack (`core-ts`), all framework-agnostic:**

| Rule | Catches | Notes |
|---|---|---|
| `no-any` | explicit and **inferred** `any` | inferred detection is the differentiator; needs type resolution |
| `no-as-cast` | `x as T`, `<T>x`, and `x as unknown as T` | double-cast reported at higher severity |
| `no-non-null-assertion` | `x!`, `x!.y`, `f()!`, `class { x!: T }`, `let x!: T` | field-declaration form included |
| `no-ts-comment` | `@ts-ignore`, `@ts-expect-error` | all comment styles |
| `no-json-parse-cast` | `JSON.parse(...) as T` | parse does not validate |
| `no-useless-types` | `: object`, `: Function`, `: {}` | |
| `no-console` | `console.*` | `allowedMethods: string[]` option; names no vendor |

The `notFixes` graph across this pack is what makes it more than seven independent checks: `no-any`
names `unknown`-widening and `as`-casting as non-fixes, `no-as-cast` names `@ts-ignore` as a non-fix,
and so on. An agent that reads the guidance cannot walk from one violation to another.

## Claude Code agent plugin

`surfaces: ['hook', 'instructions', 'guidance', 'mcp']`.

- **detect** — `~/.claude/settings.json` exists, or `claude` resolves on PATH.
- **plan** — a `json-merge` into `~/.claude/settings.json` adding a `PostToolUse` hook matching
  `Edit|Write` that runs `cyv hook claude-code`; a `managed-block` in the project `CLAUDE.md`
  describing the workflow; and one generated subagent file per enabled rule under `~/.claude/agents/`,
  rendered from the rule manifests.
- **parseHookPayload** — reads `tool_input.file_path`; tested against a committed real payload fixture.
- **formatResult** — violations to stderr, exit 2 (Claude Code feeds stderr back to the model on 2);
  clean, exit 0.

Because the generated hook command is `cyv hook claude-code` and nothing more, the generated config is
a two-line stanza and every agent-specific behaviour above is unit-testable without Claude Code
installed.

## Error handling

| Condition | Behaviour |
|---|---|
| config missing | exit 2, name `cyv init` |
| config invalid | exit 2, report failing schema path |
| unknown rule in override | exit 2 |
| `notFixes` names unknown rule | exit 2 |
| analyzer malformed response | exit 2, name the analyzer |
| analyzer skipped files | listed; exit non-zero only under `--strict` |
| zero files resolved | reported prominently; never a silent green |
| project rules not run due to mode | stated in output |
| hook payload unparseable | warn, **exit 0** |
| hook internal error | warn, **exit 0** |

The last two rows invert the others deliberately, and the docs say so: the advisory loop degrades so a
vendor's schema change never blocks editing; the backstop never degrades because it is the guarantee.

## Testing

- **Rules** — fixture pairs `<rule>.bad.ts` / `<rule>.ok.ts`, table-driven, asserting rule id and line
  numbers, not just counts. `.ok.ts` files are the false-positive guard and matter as much as `.bad.ts`.
- **Protocol** — every request and response validated against the published JSON Schemas in tests.
- **Conformance** — `cyv verify-analyzer <path>` drives an analyzer through a scripted set of requests
  and validates every response. This is what makes third-party analyzers viable, so it ships in 0001.
- **Agent plugin** — committed payload fixtures for `parseHookPayload`; golden-file tests for `plan()`
  output; merge-strategy tests proving user content survives regeneration byte-for-byte.
- **E2E** — build a temp git repo, `cyv init --yes`, `cyv install-hooks`, write a violating file,
  assert the hook fires and the commit is refused; assert `--no-verify` bypasses it.
- **Self-application** — CI runs `cyv check --all` against this repository.

## Milestone

The commit where CI first runs `cyv check --all` against checkyourvibe's own source is the point at
which the vertical slice is real. It is task T027 and it gates the spec being considered done.
