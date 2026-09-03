# Writing an agent plugin

An agent plugin adds support for an AI coding CLI — how it takes a hook payload, how its
configuration files are shaped, and how it wants to receive violations. This document
describes the `AgentPlugin` interface (`packages/core/src/protocol/agent.ts`) well enough to
implement one against a CLI other than the one checkyourvibe ships support for today.

## The `AgentPlugin` interface

```ts
export type AgentSurface = 'hook' | 'instructions' | 'guidance' | 'mcp' | 'executor';
export type MergeStrategy = 'create-if-absent' | 'json-merge' | 'managed-block';

export interface AgentPlugin {
  id: string;
  name: string;
  surfaces: AgentSurface[];

  detect(ctx: DetectContext): Promise<boolean>;
  plan(ctx: PlanContext): Promise<PlannedWrite[]>;
  parseHookPayload(raw: string): HookPayload;
  formatResult(violations: Violation[], ctx: FormatContext): HookResult;
}
```

`id` and `name` identify the plugin (`id` is what a user writes in `checkyourvibe.json`'s
`agents` list and what `cyv hook <agent-id>` dispatches on). `surfaces` is the contract for
everything else in this document: declare only what you actually implement, and the core will
never call into a capability you didn't declare.

## The five surfaces

A plugin declares a subset of:

- **`hook`** — this agent can run a command after (or before) an edit, so `parseHookPayload`
  and `formatResult` are meaningful for it.
- **`instructions`** — this agent reads a project-level instructions file (the kind of file
  that becomes ambient context for every request), so `plan` may propose a `managed-block`
  write into one.
- **`guidance`** — this agent can be handed per-rule reference material as files (for example,
  one generated file per rule) rather than only inline text.
- **`mcp`** — this agent can be pointed at an MCP server for on-demand queries instead of
  needing everything pushed into its context up front.
- **`executor`** — this agent can be dispatched actual work, not just told about violations.
  This surface is declarable today and validated as a value, but nothing in checkyourvibe
  implements it yet; declaring it is how a plugin reserves the lane without the interface
  needing to change shape when an implementation does land.

A cloud-hosted agent with no local edit loop has no way to satisfy `hook`, and should not
declare it — it can still declare `mcp` or `executor` and be entirely useful through those. The
core never assumes a surface a plugin didn't list; code that wants to use a surface must check
`surfaces` first.

## The four operations

### `detect(ctx: DetectContext): Promise<boolean>`

```ts
export interface DetectContext {
  repoRoot: string;
  homeDir: string;
}
```

Answers "is this agent present?" — for example, by checking whether the agent's settings file
exists under `ctx.homeDir`, or whether its binary resolves on `PATH`. `cyv init` uses this to
decide which plugins to even offer.

### `plan(ctx: PlanContext): Promise<PlannedWrite[]>`

```ts
export interface PlanContext {
  repoRoot: string;
  homeDir: string;
  cyvCommand: string;               // absolute path to the cyv entry point to invoke
  rules: RuleManifest[];            // rules to render into agent-consumable guidance
}

export interface PlannedWrite {
  path: string;                     // absolute
  strategy: MergeStrategy;
  content: string;                  // full content, or block body for managed-block
  blockId?: string;                 // required for managed-block
  description: string;              // one line, shown in the cyv init diff
}
```

`plan` returns a description of writes — it must not touch the filesystem itself. No reading
existing files to decide what to do beyond what `ctx` already gives you, and absolutely no
writing. This is what lets `cyv init` show the user a diff of everything that would change and
require confirmation before any of it actually happens (unless `--yes` is passed) — a
guarantee that only holds if planning genuinely has no side effects. The core takes the
`PlannedWrite[]` your plugin returns and applies each one against the current file (or lack of
one) itself, using the merge strategy you named. If `plan` peeked at the filesystem and baked
a decision into `content` that depended on a file it also intends to write, the diff `cyv
init` shows the user would already be wrong before anything was applied.

### `parseHookPayload(raw: string): HookPayload`

```ts
export interface HookPayload {
  files: string[];   // absolute paths the agent just touched; may be empty
  event: string;      // the agent's own event name, retained for reporting
}
```

Takes whatever your agent's hook mechanism hands you on stdin — usually JSON, but the
signature only promises a string — and extracts the files to check. Throw on anything you
cannot parse; do not return a best-effort guess. The `cyv hook <agent-id>` shim is what decides
what an unparseable payload means for the user (see the last section), and it can only do that
correctly if `parseHookPayload` fails loudly rather than returning something like `{ files: []
}` for input it didn't understand.

### `formatResult(violations: Violation[], ctx: FormatContext): HookResult`

```ts
export interface FormatContext {
  files: string[];   // files the hook checked, for reporting when there are no violations
}

export interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

Turns violations into whatever your agent's hook mechanism expects back, including the exit
code it should react to. Exit-code conventions are agent-specific by design — one agent might
treat a particular non-zero code as "feed stderr back to the model," another might treat the
same code as a hard block — so the plugin, not the core, decides. This is also the place to
render guidance in the agent's native format: walk each violation's `guidance` (summary, why,
allowed fixes, and — critically — `notFixes`, so the agent sees which apparent fixes are
themselves violations) into whatever text or structure that agent reads best.

## The three merge strategies

Every planned write targets a file the user owns and already has opinions about — their agent
settings, their instructions file — so nothing is ever blindly overwritten. Pick the strategy
that matches what you're writing to:

- **`create-if-absent`** — write the full `content` only if nothing is there yet; an existing
  file is left completely untouched. Use this for a file that is entirely checkyourvibe's own
  (nothing else is expected to write there) but that a user might reasonably want to edit
  afterward — a generated per-rule guidance file is the case in the current Claude Code plugin.
- **`json-merge`** — parse the existing file as JSON, set only the keys `content` describes,
  and re-serialize preserving every other key and its original ordering. Use this for a
  settings file you share with the rest of the agent's own configuration, where clobbering
  unrelated keys (or reordering them) would be an obviously hostile diff to the user.
- **`managed-block`** — replace only the text between a pair of delimiters (see below),
  leaving everything else in the file byte-for-byte untouched. Use this for a prose or
  markdown file — a project instructions file the user is also writing in by hand — where you
  need to own one section without touching anything they wrote around it.

## The managed-block delimiter format

```
<!-- checkyourvibe:start:<blockId> -->
...generated content...
<!-- checkyourvibe:end:<blockId> -->
```

`blockId` is required whenever `strategy` is `managed-block`, and it is what lets one file host
more than one independently-managed block. Regenerating a block replaces only the text between
its own start and end delimiters. If neither delimiter is present yet, the block is appended
(with a leading blank line if the file already has content). If the start delimiter is present
but the end delimiter is missing — the file was hand-edited into a state the format doesn't
allow — that is treated as corruption: the merge fails outright rather than guessing where the
block should end. Never repair a corrupt block silently; a guess here risks discarding
user-authored content that happened to sit past a deleted end marker.

## Recorded payload fixtures

`parseHookPayload` and `plan` are both tested against fixtures recorded from the real thing —
for the Claude Code plugin, a committed example is
`packages/adapter-claude-code/test/fixtures/post-tool-use.json`, a real `PostToolUse` payload
shape. This matters for a reason beyond ordinary test coverage: the payload shape is the
vendor's to change, not checkyourvibe's, and a vendor changing it will not announce the change
to this project. A recorded fixture turns that risk into an ordinary, loud test failure the
moment the shape actually changes, instead of a `parseHookPayload` that silently stops
extracting `files` correctly in production. When you write a new plugin, commit at least one
real payload your agent's hook mechanism actually produced, and assert `parseHookPayload`
against it — not only against a shape you wrote by hand from documentation.

## Hook shims degrade, they do not block

`cyv hook <agent-id>` is the shim that reads stdin, calls your plugin's `parseHookPayload`,
runs the check, and calls `formatResult`. Two failure modes are handled the same way on
purpose: if `parseHookPayload` throws because it was handed a payload it cannot parse, or if
anything else inside the shim fails unexpectedly, the shim emits a warning and exits `0`.

This is deliberate, and it is the opposite of how the git backstop behaves. The hook is the
fast, advisory loop sitting inside someone's live editing session; if a vendor changes a
payload shape, or the shim hits a bug, the correct behavior is to get out of the way of the
person editing, not to jam their workflow closed over an integration failure that has nothing
to do with whether their code is any good. The backstop — the git hook `cyv install-hooks`
installs, and CI — is what actually cannot be bypassed by an internal error, precisely because
it is the layer this project is built to guarantee. A plugin implementation must not try to
be clever here: an unparseable payload or an internal error in your plugin's own code should
propagate up through the shim as a normal thrown error, and let the shim's warn-and-exit-0
behavior handle it, rather than swallowing it inside the plugin and returning a fabricated
clean result.
