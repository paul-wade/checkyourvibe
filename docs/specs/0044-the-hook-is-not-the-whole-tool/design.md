# 0044 — Design

## Why a generated shared surface, not six hand-maintained templates

Each of the six adapters already writes its own literal capability paragraph:
`workflowBody` in `packages/adapter-claude-code/src/index.ts` (5 lines),
and the equivalent arrays in `adapter-codex`, `adapter-antigravity`,
`adapter-devin` (each with its own "Body for the shared workflow block" —
their own words, describing the same three facts: hook, `cyv explain`,
not-fixes). `adapter-cursor` and `adapter-gemini` follow the same pattern.
Every one of these already differs slightly in exit-code prose because the
underlying hook contracts genuinely differ (Claude Code's `PostToolUse` exits
2 to block; Antigravity's and Codex's exit 0 and carry findings in stdout
JSON, each adapter's own comment says so) — which proves these five files are
independently authored today, not copies of one text. They have not drifted
on the capability list only because the capability list has never said
anything beyond "there is a hook." The moment Requirement 1 asks for four
capabilities named consistently across six files, five independently-edited
copies is exactly the condition that has already produced a documented
failure in this project once: `docs/STATUS.md` records a rule's source and
its manifest JSON holding two descriptions of the same guidance that "could
differ between the two surfaces with nothing detecting it," found only
because a hole was looked for. Six files stating what checkyourvibe is, each
edited by whoever last touched that adapter, is the same failure shape at
double the count. A shared definition — one array of `{name, commands,
sentence}` (or equivalent) that every `plan()` renders through — makes the
five-way drift structurally impossible rather than merely discouraged, the
same argument 0032 Requirement 1.4 already makes for rule-guidance renderers:
"a surface SHALL NOT introduce a second one."

**Not taken: leave each adapter's paragraph as its own prose, reviewed for
consistency by hand.** This project's own history is the argument against it
— the rule-guidance parity gap existed for a stretch of real development
specifically because nothing mechanical checked five things said the same
thing. Review catches what someone thought to look at.

## Why brevity plus a pointer, not the full capability list inline

The block this spec grows is not read the way a dashboard page or a published
guidance site is read — those are opened when someone chooses to open them.
`CLAUDE.md`/`AGENTS.md` is loaded into context every session, by every agent,
whether or not that session ever touches the dashboard, dispatches work, or
reads a note. Every word in it is a recurring cost paid regardless of
relevance — the same shape of argument the roadmap's "Subscriptions, not
metered APIs" principle makes for money (nothing in this project may spend a
token on the user's behalf that was not asked for), applied here to context
budget instead of dollars. 0032 Requirement 5 keeps rule guidance itself free
of per-read cost because it is read on demand; this block cannot lean on that
same argument, because it is not read on demand — it is read unconditionally.
That makes it the one surface in this project that has to be cheaper than the
guidance it points at, not equally thorough with it.

Requirement 5.1's 200-word budget is deliberately not "enough to explain
dispatch ownership or gate semantics" — it is enough to state four facts exist
and name the command that reaches each. Everything past that (what `cyv
dispatch` needs declared before it runs, what a lane's cooldown state means,
how the exchange's cursor works) is exactly the kind of detail Requirement 2
of spec 0011 and Requirement 4 of spec 0037 already wrote at length, and
restating it here would be the second copy Requirement 2 of this spec exists
to prevent, at a location that cannot afford a second copy of anything.

## Why the delivery mechanism is the written block plus a reachable reference file, not a new MCP tool

The MCP recon for this spec is concrete: `packages/core/src/mcp/tools.ts` and
`server.ts` register exactly four tools — `list_rules`, `explain_rule`,
`check_files`, `check_working_tree`. None of them reach the dashboard,
`cyv projects`, or executor/dispatch state. An MCP-connected agent has no
route to any of it today, informed or not — so adding a fifth tool that
exposes dashboard/executor state would be new product surface, not a fix to
the teaching gap this spec exists to close. It is also not what caused the
observed failure: catburgler's agent used `Bash`/`Glob`-shaped tools (grep,
list, read), not MCP, to search for a dashboard and conclude wrongly that none
existed. The channel that produced the wrong belief was the always-loaded
instructions file; that is also the channel proven to be read, because the
agent correctly followed its `cyv explain <rule-id>` instruction earlier in
the same file. The fix belongs in the channel that already has the agent's
attention, not in a channel it was never using.

So: the primary delivery is the written managed-block content Requirement 1
requires, generated per Requirement 2, through the same `plan()` /
managed-block mechanism (`ownershipMarker`, `blockId`, `json-merge`,
`managed-block`, `create-if-absent` — all already defined in the `PlannedWrite`
contract spec 0003 built) that already writes the misleading text today. This
is not a new mechanism; it is the existing one, corrected.

For the depth Requirement 5.2 defers, two things already exist and a third is
worth adding, in that order of preference:

1. **Existing self-documenting commands** — `cyv --help` already lists every
   command with a one-line summary read straight from the `COMMANDS` table
   (`packages/core/src/cli/index.ts`); `cyv dashboard --help`,
   `cyv dispatch --help`, and `cyv explain <rule-id>` already exist and need
   no new code. Pointing the block at these costs nothing to build.

2. **A generated reference file, reusing an existing pattern.** This project
   already has a proven answer to "brief pointer in the always-loaded file,
   full detail in a file reachable on demand": `adapter-claude-code` writes
   one file per rule to `~/.claude/agents/cyv-<rule>.md` via the
   `create-if-absent` strategy (`packages/adapter-claude-code/src/index.ts`,
   `renderRuleAgent`), and `adapter-antigravity`/`adapter-codex` write an
   equivalent single skill file (`.agents/skills/checkyourvibe-rules.md`,
   `.codex/checkyourvibe-rules.md` — both named directly in the very
   `AGENTS.md` text this spec is fixing). Extending that same mechanism with
   one more generated file — what checkyourvibe is, one level deeper than the
   200-word block — is a smaller change than inventing a new delivery
   channel, and it is the channel this project has already verified agents
   read, because it is how rule guidance already reaches them.

3. **Not now: an MCP tool.** Explicitly deferred (Non-goals, Open question 2).
   Building one would close the MCP-only-agent gap the recon surfaced, but
   that gap is orthogonal to the observed failure and is real new product
   work — a `describe_capabilities`-shaped tool would itself need to consume
   Requirement 2's shared definition to avoid becoming a sixth-plus copy, and
   deciding its shape belongs to whichever spec first has an MCP-only agent as
   its motivating case, not this one.

## Why a confident false negative is worse than not knowing

An agent that does not know whether checkyourvibe has a dashboard has two
honest moves: say so, or go look. Catburgler's agent did look — briefly,
inadequately (a `package.json` script grep and a glance at `site/`) — and then
stopped looking and reported the negative as fact: *"checkyourvibe has no
dashboard and no server,"* with an offer to build one. That is not a gap in
knowledge reported as a gap; it is misinformation stated with the same
confidence as a verified fact, delivered to the person who owns the tool and
is least equipped to catch it wrong, because they are the one asking in order
to *avoid* having to check themselves. Had the owner not personally known "check
your vibe 100% has a server," the next step was building a second,
worse dashboard beside an existing four-region one (spec 0040) that already
does everything the ask required — hours of duplicated work whose only cause
was an install that taught the agent one-quarter of the truth confidently
enough that a shallow search read as confirmation rather than as a reason to
look further.

This is why Requirement 1.3 is written as a falsifiability test rather than a
completeness test: the fix is not that the block must contain every fact
about the dashboard, it is that the four facts of existence must be stated
plainly enough that no shallow search can be mistaken for a disproof of any of
them. A single sentence — "checkyourvibe also runs `cyv dashboard`,
`cyv dispatch`, and `cyv comments`; see `cyv --help`" — inside the 200-word
budget would have ended the catburgler incident at the first grep, without
requiring the agent to read anything more than it already does.

## Open

- Whether `cyv init` auto-registers a project (Requirement 3.1's first
  option) or instructs the agent to run `cyv projects --add` itself (its
  second option) is not decided here — see requirements.md Open question 1.
  Auto-registration is simpler and consistent with `cyv init` already writing
  outside the repository root for hooks and per-rule agent files; the
  counter-argument is that those writes configure *this machine's* agent to
  behave differently, while `~/.cyv/projects.json` makes a project *visible on
  a dashboard a person may open on a phone*, which is a different kind of
  exposure even though it grants no write access. Left to the implementing
  task to weigh against 0011 Requirement 5's precedent for treating dashboard
  visibility and write access as separate consents, if it decides that
  precedent applies here at all.
- Whether the generated reference file (delivery option 2 above) is one file
  shared by every adapter or one per adapter matching each adapter's existing
  per-rule-file convention — the existing precedent is inconsistent between
  adapters already (`create-if-absent` per file for Claude Code, one combined
  skill file for Antigravity/Codex), so this spec does not resolve which
  existing pattern the new file should follow.
- The exact mechanism enforcing Requirement 5.1's 200-word budget — a test
  that counts words in the shared definition's rendered output, or author
  discipline checked at review time — is left to the implementing task.
