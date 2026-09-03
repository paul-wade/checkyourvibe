# 0044 — The hook is not the whole tool: Requirements

**Status:** draft
**Created:** 2026-09-01
**Depends on:** 0003, 0011, 0032, 0040

## Introduction

`R:\gamedev\catburgler` is an Unreal Engine 5 Lyra project with checkyourvibe
installed into it. The install wrote, into that project's `CLAUDE.md`, exactly
this — the full text of the `claude-code-workflow` block, verbatim from
`packages/adapter-claude-code/src/index.ts`'s `workflowBody`:

> checkyourvibe hooks into Claude Code after each TypeScript edit. If the
> analyzer finds violations, the hook exits with code 2 and writes the
> remediation guidance to stderr so Claude Code can act on it before the user
> does. Before choosing a fix, run `cyv explain <rule-id>` to read the full
> rule guidance. Pay special attention to the listed not-fixes: those are
> changes that would trade one violation for another.

`AGENTS.md` carries the same shape for the other three adapters that write to
it (`antigravity-workflow`, `codex-workflow`, `devin-workflow` blocks): hook,
exit code, `cyv explain`, not-fixes. Nothing else.

A Claude Code session working in catburgler was asked by the project owner to
bring up "the cyv dashboard" so they could read it on their phone. The agent
searched the root `package.json` for a `serve`/`dashboard` script, found none,
listed `R:\checkyourvibe`'s top level, looked inside `site/`, found a static
landing page, and told the owner outright that **checkyourvibe has no
dashboard and no server**, offering to build one from scratch. The owner
corrected it — "check your vibe 100% has a server" — and only then did the
agent grep `packages/` and find `packages/core/src/cli/dashboard.ts`: a
four-region dashboard (needs you / in motion / lanes / exchange, per spec
0040), reachable with `cyv dashboard --host` for a phone on the LAN, polling
`/api/state` so a reader does not have to pull to refresh; `packages/core/src/
cli/projects.ts` for multi-project registration; and an executor/lane surface
(`cyv dispatch`, `packages/core/src/executor/`) built by spec 0011. The agent
was, at the same moment, mid-way through hand-rolling its own ad hoc subagent
lanes for a build task, while asked to "orchestrate using cyv" — cyv's own
lane machinery sat unused because the agent did not know it existed. The
owner's verdict: *"its wired into your install.. you should have known the
dashboard inside and out."*

The cause is legible in the code, not a one-off model mistake. Every one of
the six adapters (`packages/adapter-claude-code`, `-codex`, `-antigravity`,
`-devin`, `-cursor`, `-gemini`) writes its own literal paragraph into the
agent's instructions file through its `plan()` function, and every one of
those paragraphs describes the hook and nothing past it. `cyv init` never
calls `cyv projects --add`: nothing registers a freshly-installed project with
the dashboard's registry (`~/.cyv/projects.json`, `packages/core/src/
dashboard/projects.ts`), so even an agent that did know to look would have
found catburgler absent from `cyv projects` until someone added it by hand.
And the MCP surface (`packages/core/src/mcp/server.ts`, `tools.ts`) exposes
exactly four tools — `list_rules`, `explain_rule`, `check_files`,
`check_working_tree` — none of which touch the dashboard, projects, or
executor state, so an agent restricted to MCP has no route to any of it
either, informed or not.

### What this is not

**Not 0032 (guidance surfaces).** 0032 makes a rule's `summary`/`why`/
`allowedFixes`/`notFixes`/`examples` consistent across `cyv explain`, the
dashboard, and a published site — one manifest field, many readers. This spec
is not about a rule's guidance; it is about the paragraph an adapter writes
into an agent's own instructions file describing what checkyourvibe itself is.
0032 never touches `plan()` or the managed-block content in `CLAUDE.md`/
`AGENTS.md`; this spec is entirely about that content. The two share a
principle — one written definition, many readers, no independent restatement
— and this spec's Requirement 2 applies it to a different surface than 0032
covers, rather than duplicating 0032's scope.

**Not 0042 (the exchange reaches the agent).** 0042 is about *live* data — an
owner's note — reaching a *running* session through a hook, because polling is
unreliable under load. This spec is about *static* self-knowledge — what
capabilities exist at all — reaching *every* session from the moment it
starts, through the same managed-block mechanism that already (mis)informed
catburgler's agent. Different content, same lesson already learned once in
this project: an instruction in prose that the agent has to remember to act on
does not hold, so it has to be built into a mechanism the agent cannot skip
reading — for 0042 that mechanism is a hook; for this spec it is the
instructions file every agent reads before doing anything at all.

**Not 0043 (what each agent can actually do).** The title is close enough to
invite confusion, and it should not: 0043 is cyv discovering facts *about* the
agent CLIs it can dispatch to (installed? authenticates? which models, at
what price) so the orchestrator can schedule correctly. The knowledge flows
from cyv, about other agents, for cyv's own use. This spec is the opposite
direction: knowledge flows from cyv, about cyv, for an agent's use. The two
are unrelated beyond the coincidence of both sentences containing the word
"agent."

### Is this already planned?

`docs/ROADMAP.md`'s "0033 — Installers and first-run experience" describes
"a first run that ends with the user knowing what to do next, rather than
with a wall of findings" — close in spirit, but it is about the *human*
reading `cyv init`'s terminal output once, not about the *agent's* persistent,
every-session context. That roadmap entry was also never carried into a spec
under that number — `docs/specs/0033-unreal-module` is a different topic
entirely — so as of this writing nothing in `docs/specs/` covers either the
human first-run experience or the agent-facing gap this spec describes. This
is genuinely open territory.

## Requirement 1 — The surface names what checkyourvibe is

**User story:** As an agent reading the instructions an install wrote into my
own project, I want to learn that checkyourvibe is an analyzer, a dashboard, an
executor, and an exchange — not only the one of those four that happens to run
on every edit — so that I never tell a project owner a capability does not
exist when it does.

1.1. The block every adapter writes into an agent's instructions file SHALL
   name all four things checkyourvibe is: the analyzer enforced through the
   edit hook (what is written today), the dashboard (`cyv dashboard`), the
   executor/lane surface (`cyv dispatch`, spec 0011), and the exchange
   (`cyv comments`, spec 0042).

1.2. It SHALL name the commands that reach each: at minimum `cyv dashboard`,
   `cyv projects`, `cyv dispatch`, `cyv comments`, alongside `cyv explain`,
   which is already named today.

1.3. It SHALL NOT be possible for an agent that has read only this surface to
   reach the conclusion catburgler's agent reached — that a capability
   (concretely: the dashboard, in the observed incident) does not exist. The
   test is not exhaustiveness; it is that the existence of each of the four
   is stated plainly enough that a shallow search (a `package.json` script
   grep, a look inside `site/`) cannot be mistaken for a disproof.

## Requirement 2 — One generated definition, six adapters

**User story:** As the maintainer of six adapters that each write their own
paragraph describing checkyourvibe, I want one definition of what to say, so
that fixing this gap in one adapter does not leave it open in the other five.

2.1. The capability description required by Requirement 1 SHALL be generated
   from a single shared definition, consumed by all six adapters' `plan()`
   functions (`packages/adapter-claude-code`, `-codex`, `-antigravity`,
   `-devin`, `-cursor`, `-gemini`). No adapter SHALL hardcode its own prose
   restating what checkyourvibe is, the way `workflowBody` in
   `packages/adapter-claude-code/src/index.ts` and its four siblings do today.

2.2. What legitimately differs per adapter — how its hook reports a violation,
   its event name, its exit-code convention (Claude Code's `PostToolUse`
   exiting 2 versus Antigravity and Codex's advisory exit 0 with findings in
   stdout JSON, as the two adapters' own code comments explain) — SHALL remain
   adapter-specific and SHALL NOT be forced through the shared definition.
   Requirement 2.1 governs only the part that should not differ: the
   capability list.

2.3. The shared definition SHALL be derived from, or checked against, the real
   command table (`COMMANDS` in `packages/core/src/cli/index.ts`) rather than
   hand-copied prose, so that a command added to that table does not have to
   be separately remembered by whoever next edits six adapter files.

## Requirement 3 — A newly-installed project is not invisible

**User story:** As the owner of a project I just ran `cyv init` in, I want
the dashboard to know my project exists, so that the agent I ask to open it
does not have to discover — as catburgler's agent eventually did by hand —
that the project was never registered.

3.1. A project SHALL be registered with the dashboard's project registry
   (`cyv projects`, `~/.cyv/projects.json`) by the time `cyv init` finishes,
   OR the surface required by Requirement 1 SHALL instruct the agent to run
   `cyv projects --add` itself. `cyv init` today does neither: it never calls
   `addProject`, and the observed incident is the direct consequence — the
   project was installed, unregistered, and the agent had no route to learn
   either fact from what was written into `CLAUDE.md`.

3.2. Whichever half of 3.1 is chosen SHALL be visible from the generated
   surface itself, not left implicit — an agent reading the block SHALL be
   able to tell whether registration already happened or is still its job to
   do.

## Requirement 4 — Something keeps the surface honest as commands are added

**User story:** As the maintainer of a tool whose command list grows, I want
the agent-facing surface to fail loudly when it falls behind the real command
list, the way this project's other duplicated-description defects have been
caught, rather than silently drift the way the rule-guidance parity gap did
before it was found.

4.1. There SHALL be a check, run as part of this project's own self-compliance
   discipline (in the spirit of `docs/specs/0002-self-compliance`), that fails
   when the shared definition required by Requirement 2 names a command that
   is absent from `COMMANDS` in `packages/core/src/cli/index.ts`, or omits a
   command from that table that Requirement 1 requires be named. This is the
   same shape of gap `docs/STATUS.md` already records once for rule guidance:
   two copies of the same fact (a rule source and its manifest JSON) that
   could differ with nothing detecting it, found only because someone went
   looking.

4.2. `cyv doctor` (`packages/core/src/cli/doctor.ts`) already recomputes each
   configured adapter's `plan()` output and reports drift against what is
   written on disk. Once the capability description is generated per
   Requirement 2, that existing drift check SHALL cover it: a project whose
   installed `CLAUDE.md`/`AGENTS.md` block no longer matches what the current
   generator would write SHALL be reported by `cyv doctor` exactly as any
   other adapter drift is today. This requirement states that outcome as a
   property to be verified, not as new drift-detection machinery to be built —
   `doctor` gets this for free from Requirement 2 landing inside the existing
   `plan()`/managed-block path.

4.3. Requirement 4.2 alone is not sufficient: `doctor` catches a project whose
   disk content disagrees with what the *current* generator produces, not a
   generator whose own list has quietly fallen behind the real command table
   with every installed project agreeing with it. Requirement 4.1 is the check
   that covers that second gap, and it SHALL run independent of any installed
   project's state.

## Requirement 5 — The budget: brief, with depth reachable on demand

**User story:** As an agent whose context is finite and is spent again in
every session against every project this text is installed into, I want the
capability surface to state the essential facts in a handful of lines and
point me to more detail only when I need it, not spend my context on detail I
may never use.

5.1. The generated block required by Requirements 1 and 2 SHALL NOT exceed
   200 words (excluding the `<!-- checkyourvibe:start/end -->` marker
   comments) across everything it states — the four capabilities, the
   commands that reach them, and the registration fact — a little over twice
   today's ~85-word block, which currently states only one of the four.

5.2. Anything beyond that budget — full command flags, what each dashboard
   region shows, how dispatch declares ownership and gates — SHALL be
   reachable on demand rather than inlined: through a command an agent can run
   (`cyv --help`, `cyv dashboard --help`, `cyv explain <rule-id>`, all of
   which already exist and are self-documenting) or a generated reference file
   the agent can read (design.md decides which). It SHALL NOT be added to the
   block itself merely because it would be useful to know.

## Non-goals

Redesigning the dashboard's content or regions (0040 owns that). Changing a
hook's exit-code semantics or event contract per adapter (0003 owns that).
Adding new MCP tools exposing dashboard, projects, or executor state — the
recon for this spec found the MCP surface exposes none of it today
(`packages/core/src/mcp/tools.ts`), and closing that gap is a product decision
beyond teaching an agent what already exists; see Open questions. Changing
what an executor is or how dispatch is judged (0011 owns that). Changing how
owner notes are delivered into a running session (0042 owns that). Changing
how cyv discovers facts about other agent CLIs (0043 owns that, and is the
reverse of this spec's direction).

## Open questions

1. **Does `cyv init` writing to `~/.cyv/projects.json` unprompted cross a
   consent line?** `cyv init` already writes outside the repository root
   (`~/.claude/settings.json`, `~/.claude/agents/cyv-<rule>.md`), so
   Requirement 3.1's auto-registration option may be no different in kind —
   but 0011 Requirement 5 draws an explicit, separate consent line for
   granting write access to the repository itself, and whether registering a
   project with a dashboard (which is read-only about the project, and does
   not grant the dashboard write access to it) needs its own consent step is
   left to design.

2. **MCP-only agents.** An agent connected only over MCP, with no shell
   access, cannot act on an instruction to run `cyv dashboard` even after this
   spec closes — it would know the capability exists and still have no route
   to it. This spec does not resolve that; Requirement 4 of 0011's non-goals
   and this spec's own Non-goals both leave MCP parity for dashboard/executor
   state undecided.

3. **Exact wording of the block.** This spec fixes what must be true of the
   generated text (Requirements 1, 2, 5) and not its literal wording — that is
   for the implementing task, checked against the word budget and the shared
   definition rather than approved by re-reading English prose.

4. **Where the shared definition and the generated reference file
   (Requirement 5.2) live in the package layout.** Left to design/the
   implementing task; this spec requires that they exist and that all six
   adapters consume them, not their file paths.
