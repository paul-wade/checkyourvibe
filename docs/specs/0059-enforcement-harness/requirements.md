# 0059 — The enforcement harness

**Status:** active
**Created:** 2026-09-07

## What this fixes

cyv installs one hook: `PostToolUse`. A probe run on 2026-09-06 established
what that buys and what it does not
(`docs/specs/0056-hook-write-attribution/probe-result.md`). The hook fires, the
model reads the guidance, and then decides. Its own words: "The hook's exit
status does not undo the write, so the file stands as requested."

So today cyv notifies. It does not enforce. Every claim this project makes
about making a violation impossible to leave in place is true only in the sense
of impossible to leave in place *unnoticed*.

The harness below closes that, using events the runtime already provides.

## Requirement 1 — Deny the edit, do not report it afterwards

1.1. cyv SHALL run as a `PreToolUse` hook on the file-editing tools, where a
non-zero exit denies the call before it executes.

1.2. It SHALL use the structured decision protocol rather than exit codes
alone: `permissionDecision` of `deny` with the remediation guidance as the
reason, so the model receives the rule text at the moment it is stopped.

1.3. `PostToolUse` SHALL remain, as the record of what happened. Enforcement
and evidence are different jobs and both are wanted.

## Requirement 2 — Cover writes that never touch a write tool

2.1. A `PreToolUse` hook matching only the edit tools does not see
`echo ... > file.ts`. An agent writing through the shell bypasses enforcement
entirely. This is an escape route in exactly the sense this project's notFixes
describe, and it is unguarded today.

2.2. Coverage SHALL therefore span: the editing tools, `Bash` with inspection
of file-modifying commands, and `FileChanged` for edits made outside the
session.

2.3. A write cyv cannot classify SHALL be reported, not ignored. Silence about
an unclassifiable write is the failure mode this project exists to distrust.

## Requirement 3 — The rules must not be editable by what they govern

3.1. cyv SHALL run as a `ConfigChange` hook and block a change to its own
enforcement configuration, which the runtime supports refusing.

3.2. A blocked attempt SHALL be recorded and surfaced as a needs-you item. An
agent trying to disable its own gate is the single most informative event this
system can observe.

## Requirement 4 — Refuse to finish dirty

4.1. cyv SHALL run as a `Stop` hook and refuse to let a turn end while a
violation it introduced stands.

4.2. The runtime caps consecutive Stop blocks at eight, after which it
overrides. The harness SHALL therefore treat Stop as bounded pressure, not an
absolute gate, and SHALL surface a turn that ended over its objection rather
than pretending it was clean.

4.3. Subagent work escapes this: `SubagentStop` fires after the subagent has
finished and cannot block. A turn-scope gate does not cover what a spawned
agent did, and the harness SHALL say so rather than implying coverage it lacks.

## Requirement 5 — Inject what the agent must know, every turn

5.1. Rules and the decision record SHALL be injected via `SessionStart` and
`UserPromptSubmit`, which the runtime runs regardless of the agent.

5.2. Injection SHALL be repeated after compaction, using the `compact` source,
because a compacted session has lost what it was told.

5.3. Nothing in this requirement SHALL be delivered by asking the agent to
remember. A rule that depends on the agent recalling it is not enforced.

## Requirement 6 — Schema what the agent authors

Structured output constrains shape, never truth. It is therefore used only for
artifacts the agent produces, never for its account of what it did, which is
derived from the filesystem and the gates.

6.1. A rule authored by an agent SHALL be constrained to
`docs/protocol/rule-manifest.schema.json`, so it cannot be malformed. Its
truth is established separately by the closure check and by a dry run counting
how often it fires on the repository.

6.2. A dispatch proposed by an agent SHALL be constrained to a declaration
schema covering lane, kind, owned paths and gates, so an ownership set cannot
be omitted.

6.3. A question an agent asks a human SHALL be constrained to a schema carrying
the blocking problem, the options, and what each implies, so the dashboard can
render it as a decision with actions rather than as prose.

## Non-goals

- Getting an agent to comply 100% of the time. The probe showed a model can
  read a rule, understand it, and decline. What is achievable is that the
  action is prevented, or that it is always visible.
- Replacing `PostToolUse`. The record stays.
