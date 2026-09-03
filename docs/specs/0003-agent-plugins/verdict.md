# 0003 — Verdict: did the agent plugin abstraction hold?

**Requirement 7 asks for this in writing, whether or not it flatters the design.**

Five agent plugins now exist: Claude Code, Cursor, Gemini CLI, Antigravity CLI, Codex CLI. The
`AgentPlugin` contract was designed against one of them. This records what the other four cost.

## What changed

| # | Change | Kind | Forced by |
|---|---|---|---|
| 1 | `HookPayload.scope` — `files` \| `working-tree` | new field | Codex, Gemini, Antigravity not naming the edited path |
| 2 | `toml-merge` strategy + `PlannedWrite.tomlTableArrayPath` | new strategy | Codex storing config as TOML |
| 3 | `parseHookPayload` — the throw-vs-working-tree rule | documentation | Cursor and Gemini drawing the line differently for what looked like the same case |
| 4 | `blockId` namespaced by plugin id | **defect** | Two plugins choosing the same id for the same shared file |
| 5 | Merge helpers exported from the core barrel | API gap | Codex needing `quoteTomlString` from outside the package |
| 6 | *(open)* a way to declare a surface unverified | gap | Antigravity, built on stacked guesses |

## The verdict

**The abstraction held.** Not because nothing changed — six things did — but because of *what kind* of
changes they were.

Every one was **additive**: a new optional field, a new strategy in an existing union, a clarified
doc comment, a widened export. Not one required restructuring the interface, and no plugin needed an
escape hatch around it. The four operations chosen up front — `detect`, `plan`, `parseHookPayload`,
`formatResult` — were the right four, and they are still the right four at five agents.

Two decisions in particular paid for themselves repeatedly:

**`plan()` must not touch the filesystem.** Every plugin returns proposed writes and the core applies
them. That made a combined multi-agent diff possible without any plugin knowing other plugins exist,
and it made every plugin testable against temp directories with an assertion that nothing was written.
Had `plan()` been allowed to apply its own changes, five plugins would mean five independent
implementations of "do not clobber the user's file", and at least one would be wrong.

**Merge strategies as data rather than behaviour.** `create-if-absent`, `json-merge`, `managed-block`,
`toml-merge` are declared by a plugin and executed by the core. Adding TOML support meant adding one
strategy in one place, and all five plugins inherited the guarantee that a user's foreign keys,
comments and other tools' entries survive. That guarantee is the hardest thing in this codebase to get
right, and it exists once.

## Where it did not hold

**Change 4 is a genuine defect, not a design evolution.** I specified `blockId: 'checkyourvibe-workflow'`
for both the Antigravity and Codex plugins, both writing into `AGENTS.md`. Installing both agents would
have left one silently overwriting the other. The contract permitted it because nothing said a
`blockId` must be unique per plugin. It says so now. The lesson is not "namespace your ids" — it is
that **a shared resource with no ownership rule in the contract will be collided on**, and the contract
is where that rule belongs, not each plugin's judgement.

**Change 6 remains open, and it is the most interesting one.** The Antigravity plugin is built on seven
documented guesses, two of which stack: the field carrying the edited path, and the field carrying
feedback back to the model. Both are undocumented by the vendor. The plugin degrades correctly if
wrong — it exits 0 and the model simply never sees the feedback — but *the user is never told their
integration is best-effort*. The contract can express "this agent does not support this surface"; it
cannot express "this surface is implemented on an educated guess". Those are different claims and a
user deserves the distinction.

## What made this cheap

The changes were found by **reading vendor documentation before writing plugin code**, not by
discovering breakage afterwards. Three of the six were known before a line of the Cursor plugin
existed. That ordering is the reason four plugins cost six additive changes rather than a redesign.

The counterfactual is worth stating: had the plugins been written first and the docs consulted when
something failed, `scope` would have arrived as a patch after someone's Codex hook silently checked
nothing, and the TOML gap would have surfaced as "Codex support is impossible" rather than as one new
strategy.

## Recommendation

Close 0003 with the contract as it stands, and treat change 6 as required before a sixth agent. Every
agent added from here should ship with an explicit statement of which of its surfaces are verified
against vendor documentation and which are inferred — because the honest answer for two of the current
five is "partly inferred", and that fact currently lives only in source comments where no user will
ever read it.
