# 0063 — Declared ownership is a gate, not a verdict

**Project:** orchestration  
**Status:** implemented 2026-09-08 on agents with a pre-tool hook (Requirements 1-4). Requirement 5 attempted and reported below.
**Created:** 2026-09-08
**Constrained by:** 0011 Requirement 2.5 — an out-of-scope write fails the dispatch
**Evidence:** `.cyv-review/finding-dispatches-leave-scratch.md`

## What this is

A dispatch declares the paths it may write before it runs. Today that
declaration is checked *afterwards*: `classifyOutcome` compares the changed-path
set against it and records `out-of-scope-write`. The write has already landed,
the gates have already run over it, and the outcome already says failed.

This makes the declaration enforceable at the moment of the write, using the
gate that already inspects every proposed edit.

## Why

Three dispatches in one day left scratch files in the repository — two lanes,
two models, three separate occasions. One of them, w28, produced sound work and
was recorded as a failure because two throwaway drafts it never deleted carried
sixty-eight `no-any` findings into its own `cyv-check`.

The project already makes this argument about rules: a `PostToolUse` hook
records what happened and a `PreToolUse` hook refuses the call, and the second
is the one that changes outcomes. Ownership is currently enforced the first way.
It should be enforced the second way, because nothing has to be discovered to do
it — the declaration exists before the agent starts, and the gate already sees
every proposed write before it lands.

## Requirement 1 — The gate knows what the dispatch declared

1.1. A dispatch SHALL make its declared paths available to the hook that runs
inside it, in a form the hook can read without being told which dispatch it is.

1.2. A session running no dispatch has no declaration, and the gate SHALL NOT
constrain writes on that basis. A person editing their own repository is not a
dispatch.

## Requirement 2 — A write outside the declaration is refused

2.1. When a dispatch is in force, a proposed write to a path no declared path
covers SHALL be denied before it lands, and the reason SHALL quote the
declaration so the agent can see what it may write.

2.2. The refusal SHALL name the nearest declared path, so an agent that meant
to write inside its scope and mistyped can see the difference.

2.3. A dispatch that declares the repository root constrains nothing, and the
outcome already records `scopeUnchecked` for that case. The gate SHALL behave
the same way: nothing to enforce, said plainly rather than silently allowed.

## Requirement 3 — Reading is not writing

3.1. Only write-capable tools SHALL be constrained. An agent must be free to
read anything in the repository to do its work; the benchmark already learned
this the hard way, having once scored a `Read` as an out-of-scope write.

3.2. A shell command that writes SHALL be constrained the same as an edit tool,
because the existing gate already inspects shell command lines for exactly this
reason.

## Requirement 4 — Scratch space exists and is somewhere else

4.1. The refusal message SHALL name a directory the agent may write to freely —
the system temp directory — because an agent that needs to think in a file will
otherwise keep choosing the repository.

4.2. Nothing in the repository SHALL be nominated as scratch space. A path
inside the working tree is a path the analyzer checks and the snapshot counts.

## Requirement 5 — This is measured, not assumed

5.1. The claim is that refusing the write removes a class of failed dispatch.
That SHALL be measured: out-of-scope-write outcomes per dispatch before and
after, from the dispatch log this repository already keeps.

5.2. If dispatches begin failing for a new reason instead — an agent blocked
from a path it genuinely needed — that SHALL be reported rather than explained
away. The declaration being too narrow is a real failure mode and the honest
answer may be that briefs must declare more.

## What the implementation found

Enforcement needs a pre-tool hook, and only the Claude Code adapter registers
one. Every other adapter that ships with cyv registers `PostToolUse` alone,
because the vendor facts they are built from name no pre-tool event. On those
agents a dispatch's ownership is judged after it closes, exactly as before.

Every dispatch in this repository runs on the `antigravity-cli` lane, so the
gate has never fired inside one. `cyv doctor` now says so per lane rather than
leaving a reader to assume enforcement they are not getting.

## Requirement 5, attempted

Out-of-scope writes among dispatches that changed something: 16 of 60 (27%)
before the gate landed, 0 of 2 after.

That is not evidence about the gate. The two dispatches after it ran on a lane
with no pre-tool hook, and `.cyv-review/decisions.jsonl` records no ownership
denial from any dispatch — the only one is a synthetic check made against the
binary by hand.

The measurement stands as unmade. It can be made when a dispatch runs on a lane
whose agent has a pre-tool event, and not before.
