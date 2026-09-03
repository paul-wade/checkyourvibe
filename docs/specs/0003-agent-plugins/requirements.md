# 0003 — Agent plugin expansion: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

Four more agent plugins: **Codex CLI**, **Cursor CLI**, **Gemini CLI**, and **Antigravity CLI**.

The point is not four integrations. It is to answer whether the plugin contract designed against a
single agent survives contact with four more. If a fifth agent needs the contract changed, the
abstraction was wrong, and learning that at four is much cheaper than learning it at ten.

## What the research already established

Vendor documentation was read before this spec was written, and it disproved two assumptions the
contract was built on.

**Assumption 1: every agent names the file it edited. False.**

| Agent | Post-edit event | Where the edited path lives |
|---|---|---|
| Claude Code | `PostToolUse` | `tool_input.file_path` — direct |
| Cursor | `afterFileEdit` | `file_path` — direct, absolute |
| Gemini CLI | `AfterTool` | somewhere inside `tool_input`; field name not documented |
| Codex CLI | `PostToolUse` | **nowhere** — for `apply_patch` the path is embedded in `tool_input.command` as patch text |
| Antigravity | `PostToolUse` | somewhere inside `toolCall.args`; field name not documented |

Only two of five reliably name the path. Parsing a patch body to recover a filename would be fragile
and would rot the first time the patch format changed.

**Assumption 2: agents report back the same way. False.**

| Agent | How a hook returns information to the model | Meaning of exit 2 |
|---|---|---|
| Claude Code | stderr, with exit 2 | feed stderr to the model |
| Cursor | stdout JSON — `additional_context` | **block the action** |
| Gemini CLI | stdout JSON — `hookSpecificOutput.additionalContext` | block; stderr becomes the reason |
| Codex CLI | stdout JSON — `hookSpecificOutput.additionalContext` | block; stderr becomes the reason |
| Antigravity | stdout JSON | block |

Claude Code is the outlier. On three of the others, the exit code checkyourvibe currently uses to
report violations would **block the agent's edit** rather than inform it.

**Assumption 3: agent config is JSON. False.** Codex uses `config.toml`. There is no TOML merge
strategy, so Codex cannot be configured by the existing merge layer at all.

## Requirement 1 — Payload scope

**User story:** As a user of an agent whose hook payload does not name the edited file, I want the
check to run anyway, so that my agent is not silently unsupported.

1. `HookPayload` SHALL carry a `scope` of `'files'` or `'working-tree'`.
2. WHERE a plugin can extract explicit paths, it SHALL return `scope: 'files'` with those paths.
3. WHERE a plugin cannot reliably determine the edited paths, it SHALL return `scope: 'working-tree'`
   and an empty `files` array.
4. WHEN scope is `'working-tree'` THEN the hook SHALL check uncommitted changes instead.
5. A plugin SHALL NOT parse a patch body, diff, or command string to recover a filename. That is a
   guess dressed as a fact, and it fails silently when the format changes.
6. WHEN a plugin falls back to working-tree scope THEN that SHALL be visible in `cyv doctor`, so a
   user understands why their hook is slower than another agent's.

## Requirement 2 — Result shaping

**User story:** As a user, I want a reported violation to inform my agent, not cancel my edit.

1. Each plugin's `formatResult` SHALL produce the stdout, stderr, and exit code that its agent
   interprets as *feedback*, not as a block.
2. WHERE an agent expects structured stdout, the plugin SHALL emit valid JSON and nothing else on
   stdout.
3. A plugin SHALL NOT return an exit code its agent interprets as blocking, unless blocking is the
   deliberate configured behaviour.
4. Guidance and `notFixes` SHALL be present in whatever field that agent surfaces to the model.
5. Each plugin SHALL document, in its source, which vendor behaviour its exit codes rely on.

## Requirement 3 — TOML support

**User story:** As a Codex user, I want my `config.toml` updated without losing my settings.

1. A `toml-merge` strategy SHALL be added to `MergeStrategy`.
2. It SHALL preserve keys, tables, and ordering the tool does not own, matching `json-merge`'s
   guarantees.
3. It SHALL support `ownershipMarker` so re-running does not duplicate our entry and does not delete
   another tool's.
4. WHERE a TOML file cannot be parsed, it SHALL fail loudly and write nothing.
5. No TOML library SHALL be added without justification recorded in the design; a narrow
   read-modify-write for the subset actually needed is preferred over a general-purpose parser.

## Requirement 4 — Detection and configuration

1. Each plugin SHALL detect its agent without executing it, via config-file presence or a binary on
   PATH.
2. `cyv init` SHALL plan for every detected agent in one run and present one combined diff.
3. `cyv init` SHALL NOT fail the whole run because one plugin's planning failed; it SHALL report that
   plugin as unavailable and continue with the rest.
4. `cyv doctor` SHALL report per-agent status, including agents that are installed but not configured
   and agents configured but no longer installed.

## Requirement 5 — Payload fixtures

**User story:** As a maintainer, I want a vendor's schema change to fail one named test rather than
silently disable an integration.

1. Each plugin SHALL ship a recorded payload fixture for its post-edit event.
2. WHERE the payload shape is not documented by the vendor, the fixture SHALL be marked as
   **unverified** with a comment naming the source it was constructed from.
3. Each plugin SHALL accept a documented list of candidate path fields and, when none match, fall
   back to working-tree scope rather than guessing.
4. WHEN a payload cannot be parsed at all THEN the shim SHALL warn and exit 0, per 0001's rule that
   the advisory layer degrades and never obstructs editing.

## Requirement 6 — Guidance rendering per agent

1. Each plugin SHALL render rule guidance into the format its agent consumes: Claude Code subagent
   files, Cursor rules, Gemini and Antigravity skill files, and Codex's equivalent.
2. All renderings SHALL derive from the same rule manifests through the shared guidance templates.
3. WHERE an agent has no packaged-guidance surface, the plugin SHALL declare that surface absent
   rather than writing files the agent will ignore.

## Requirement 7 — The contract verdict

**User story:** As the maintainer, I want to know whether the plugin abstraction actually held.

1. This spec SHALL record, in writing, every change the four new plugins forced on the shared
   contract.
2. WHERE a plugin needed a special case that could not be expressed through the contract, that SHALL
   be recorded as a contract defect rather than hidden inside the plugin.
3. The verdict SHALL be written even if it is unflattering. Two contract changes were already forced
   before a line of plugin code was written; more would be a signal to redesign, not to persevere.

## Non-goals

The `executor` surface. Remote agents. Blocking behaviour as a default. IDE extensions that are not
CLIs.
