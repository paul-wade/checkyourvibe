# Roadmap

Each entry becomes its own spec under `docs/specs/`. Order reflects dependency and value, not
difficulty. Nothing here is a promise about dates.

## What this is, in two halves

Two features carry this project, and only one of them has been written down as a
headline.

**A compiler decides, not a model.** Deterministic standards enforcement, same
input and same verdict every run, with a rule pack whose dead ends cover each
other. This half is well documented and largely built.

**Work is planned across the subscriptions you already hold.** A task declares
its kind, a lane declares what it can run and at what concurrency, and the
orchestrator sends each unit of work to the smallest executor that can do it —
spreading load across accounts that are otherwise idle, and routing around a lane
that starts refusing work. This half is built (0011) and has been described here
as a supporting mechanism rather than as the feature it is.

The second half has a single point of failure the first does not: the
orchestrating session itself. Every dispatched lane can be healthy and idle while
the one subscription driving the run is exhausted, and cyv cannot see it happen —
it is invoked *by* the orchestrator, so an exhausted caller simply stops calling.
Spec 0011 identified this and deferred it. **Spec 0036 is where it is resolved,
and it takes priority over everything else on this list**, because every other
item is executed through the mechanism it protects.
## How specs are numbered

An entry here and a folder under `docs/specs/` share one number. The number is
allocated when the folder is created, from **one above the highest folder that
exists** — never from a gap, and never from a number this file has merely
reserved in prose.

That rule is written down because it was broken. Five entries in the backlog
below were given the numbers 0029 and 0031 through 0034 while they were still
prose; those numbers were later taken by folders holding different work, and for
a while this file's cross-references pointed at specs that had nothing to do with
what it was describing. Folders won the collision — they are cited by task ids,
commit messages and each other, while a backlog entry is cited by nothing but
this file. The affected entries were retired where the work had already shipped
under another number.

The rest were not renumbered, because handing them fresh numbers would repeat
the mistake with different digits. **A backlog entry carries no number.** It gets
one when its folder is created, and not before; until then it is referred to by
name, which is how the specs worth reading are referred to anyway. A number in
this file therefore means one of three things: a folder exists, the entry was
retired, or the line says outright that the folder does not exist yet.

**Next free: 0047.**

## Shipped

Numbers are folders under `docs/specs/`. "Landed" means every task in that
folder's `tasks.md` is checked off.

| Spec | What it delivered | Evidence |
|------|-------------------|----------|
| 0001 | Core vertical slice | 31/31 tasks |
| 0002 | Self-compliance | 7/7 tasks |
| 0003 | Agent plugins | 12/12 tasks; six adapters — Claude Code, Codex, Cursor, Gemini, Antigravity, Devin |
| 0004 | C# analyzer (Roslyn) | 9/9 tasks; `analyzer-csharp`, `core-cs` pack |
| 0006 | Web dashboard | 8/8 tasks; superseded in shape by 0040, which kept its data path |
| 0007 | Rule packs | 10/10 tasks; `core-ts` and `strict-boundaries` |
| 0008 | Adoption on an existing codebase | 9/9 tasks; `cyv baseline`, suppressions carrying a reason and an expiry |
| 0035 | One dashboard, several projects | 6/6 tasks |
| 0038 | `no-module-augmentation` | 4/4 tasks |
| 0040 | A dashboard that makes sense | 16/16 tasks; one server on 4300, `/rules`, `cyv projects`, `cyv comments` |

### Shipped before the spec process existed

Six things work today and no `tasks.md` records how they were built, because they
arrived in the root commit, before specs were how work was planned. They are
listed so that "no spec" is not read as "not built", and so nobody writes a spec
for work that is already done.

| Feature | Where it lives |
|---------|----------------|
| Python analyzer | `packages/analyzer-python`, `core-py` pack |
| Rust analyzer | `packages/analyzer-rust`, `core-rust` pack |
| SARIF output | `packages/core/src/report/sarif.ts` |
| `cyv new-rule` | `packages/core/src/cli/new-rule.ts` |
| `cyv metrics` | `packages/core/src/metrics/` |
| `cyv explain <rule>` | `packages/core/src/cli/explain.ts` |

The folders numbered 0009, 0010, 0012, 0016 and 0018 hold requirements for five
of these and nothing else. They were written after the fact and describe what
exists. Treat them as documentation, not as plans.

## Blocked on the owner

**0005 — Distribution.** Thirteen of fourteen tasks are done. The remaining one
is not code:

> **T5010** Decide what becomes public. Removing `private: true` is a release
> decision, not a code change, and it is the last thing to do — an accidental
> publish cannot be unpublished.

Until it is made, every package stays `private: true` with `workspace:*`
dependencies, and the consequence reaches past this repository: a project that
adopts checkyourvibe cannot run it in CI, because CI has no way to install it. A
local pre-commit hook is the only guarantee layer such a project has. This is the
single decision standing between the tool working here and the tool working
anywhere.

## In flight

**0036 — The orchestrator's own survival.** *(Active — highest priority. 10 of 17
tasks.)* Resolves the question 0011 left open. Keeps the orchestrating lane from
spending its own quota on dispatched work, makes an abandoned dispatch
distinguishable from a running one, adds a stall signal derived from the dispatch
log, and lets a second orchestrator on a different subscription pick up a run from
disk alone. Also corrects this machine's lane declarations.

**0039 — The landing page.** *(4 of 7 tasks.)* `site/` serves it, with the
project's three songs carrying the half of the argument prose is bad at.

**0041 — The orchestrator knows it is the orchestrator.** *(Complete,
2026-09-02. 7 of 7 tasks.)* The orchestrating session is briefed from the
configuration by one function every adapter writes; a sole subscription executes
by sub-agent through `cyv dispatch` / `--close`, judged by observed effect;
`executor.maxConcurrentDispatches` caps a run across every lane; `cyv plan`
makes the waves explicit. Verification found what the tests could not — `init`
read the config through a lenient parser that drops `executor`, so no brief was
ever planned, silently. See `STATUS.md`.

**0042 — The exchange reaches the agent.** *(Complete, 2026-09-03. 5 of 5 tasks.)* Notes
delivered through the agent hook the way findings are, a `Stop` hook that refuses
to end a turn with a note unread, and `cyv comments --watch`. Until it lands, a
monitor polls the command every twenty seconds — the project's own lesson about
advisory prose, one layer up.

### Stalled part-done

Both were dispatched before the three-file rule was enforced, and both stopped.

**0033 — Unreal Engine module.** *(1 of 8 tasks.)* `packages/analyzer-unreal` and
the `unreal-gc` pack exist and have been measured against real code. The remaining
seven tasks were written after the first attempt was unwound.

**0034 — The dashboard as the conversation.** *(1 of 6 tasks.)* Largely overtaken
by 0040. It needs a disposition — carried, retired, or rewritten — the way 0037
got one.

### Superseded

**0037 — One dashboard.** Superseded by 0040 on 2026-09-01. Its `tasks.md` carries
a task-by-task disposition; the thirteen boxes still unchecked there are recorded
as delivered elsewhere or carried by 0040, not as work outstanding.

## Written, not yet dispatchable

Three specs have requirements and design and no `tasks.md`, which under the rule
in `AGENTS.md` means none of them can be dispatched. Writing those task files is
the work that unblocks all three. All three came out of using the tool to
orchestrate its own build, which is the source that has produced every finding
worth having.

**0043 — What each agent can actually do.** Requirements only; the design is still
to write.

**0044 — The hook is not the whole tool.**

**0045 — The editor nothing supervises.** Its one open question — whether there is
a shutdown tool — was answered on 2026-09-02: there is not.

**0046 — The lane is not the record.**

## Backlog

Sequenced by value, not difficulty. Each becomes its own folder when it is
written. Several are independent; the dependencies noted are real.

### The barriers

**0013 — Caching and performance.** The C# analyzer costs ~500ms per invocation
because the one-shot protocol cannot hold a warm compilation. Either a `session`
capability (the manifest flag is already reserved) or a content-addressed result
cache. Measure before building either.

**0014 — Editor diagnostics via LSP.** Hooks report after an edit; an LSP reports
during one. The shared analyzer contract should make this mostly a transport
question, which is exactly the claim worth testing.

**0015 — Shareable configuration presets.** `extends` in `checkyourvibe.json`, so
a team can publish a posture once. Depends on 0005 — specifically on T5010,
because a preset nobody can install is a file.

**0017 — Third-party analyzer template.** A repository skeleton plus the
conformance suite as a published check. The C# analyzer proved the protocol is
*sufficient*; this makes it *inviting*. The suite exists; the skeleton does not.

**0019 — CI integrations beyond GitHub Actions.** Partially delivered:
`cyv install-ci` generates GitHub Actions and Azure Pipelines, and `ci/detect.ts`
recognises a GitLab repository without yet being able to write its config. GitLab,
CircleCI and Jenkins remain. Dull, and the reason a tool gets ruled out in
procurement.

**0020 — Monorepo ergonomics.** Partially delivered by per-path overrides.
Per-package configuration inheritance and affected-package detection remain.

**Installers and first-run experience.** *(Was numbered 0033 here; that number
belongs to the Unreal module. Unnumbered until its folder exists.)* Beyond
0005's packaging: a first run that ends with the user knowing what to do next
rather than with a wall of findings. The highest-leverage thing on this list for
adoption, and the least technically interesting.

### More analyzers

**0021 — Go.** *(Parked: no Go toolchain on this machine. The analyzer was
dispatched and correctly refused to scaffold a package it could not build, test,
or claim conformance for — 0029 requires a real-codebase run before any analyzer
ships, and a package nobody can run is worse than none. Install Go to unblock.)*
The strongest candidate after the five that exist. `go/ast` and `go/types` are in
the standard library, so an analyzer needs no third-party parser, and the language
has a genuine escape hatch worth policing: `interface{}` / `any`, unchecked type
assertions, and ignored `error` returns. Unlike Rust, the compiler does *not* stop
you dropping an error, so the rules have somewhere to bite.

**Java and Kotlin.** *(No folder yet.)* One analyzer or two is the first
question. A shared JVM process with a warm compiler would exercise the reserved
`session` capability (0013) harder than anything else here, because a cold JVM is
the worst startup cost of any toolchain on this list — which makes this the honest
test of whether the one-shot protocol survives the languages people actually have
in production.

**0023 — Swift.** SwiftSyntax is a real parser with a real API, and the language
has force-unwrap (`!`) and force-cast (`as!`) — near-exact analogues of
`no-non-null-assertion` and `no-as-cast`. That makes it the best available test of
whether a *rule pack* transfers across languages, or whether every pack has to be
written from nothing. If the TypeScript pack's `notFixes` graph maps onto Swift
with the names changed, that is a discovery about the model. If it does not, that
is a bigger one.

**Wrap ruff and clippy as conforming analyzers.** *(No folder yet.)* See "The
socket" below: an analyzer that shells out to ruff or clippy and maps their
findings into `Violation` conforms to exactly the contract `analyzer-csharp`
does, and cyv supplies the guidance those tools do not carry. Blocked on
relaxing the analyzer-local `notFix` constraint. Ranked above 0024 and 0025:
it turns two thin packs into deep ones without writing a rule.

**0024 — Ruby and PHP.** Dynamically typed, like Python, and therefore mostly
`evidence: syntax`. Worth doing only once the Python analyzer has been pointed at
a real codebase and its syntax-only findings have been judged useful or not.
Building two more analyzers with the same limitation before answering that
question would be building on an untested assumption.

**0025 — SQL and schema migrations.** Different in kind from every other analyzer:
the unit is a migration, not a file, and the interesting rules are about
*irreversibility* — a dropped column, a non-concurrent index build, a `NOT NULL`
added without a default. It does not fit the file-scoped protocol cleanly, and
finding out exactly where it breaks would tell us more about the protocol than
another well-fitting language would.

**Infrastructure-as-code and configuration.** *(No folder yet.)* Terraform,
Kubernetes manifests, workflow files. Mostly a data-shape question rather than a
language one, and it drags in a constraint the rest of the project does not have:
the "codebase" is partly generated. Deferred until there is a reason beyond
completeness.

### The socket, and what varies through it

Recorded 2026-09-02, after working out whether the four packs each have a reason
to exist. The conclusion was that they do not need the same one.

**Parity between packs is not a goal and never was the product.** `unreal-gc`
catches a failure nothing else on earth looks for; `core-py`'s four rules are
four ruff rules, two of them enabled by ruff's default configuration. Those are
not the same claim and should stop being written as though they were.

What is identical across all of them is **how a pack plugs in** — eleven checks
in `conformance/suite.ts`, of which the last is load-bearing:

> violations returned by the analyzer do not populate guidance

**The analyzer answers "where". The manifest answers "why, and what not to do
instead."** An analyzer is forbidden from carrying guidance; the core attaches it
from the rule manifest. That separation is the socket, and everything else about
a pack is free to vary through it: which language, how deep, syntax or semantic,
written here or wrapped from somewhere else.

Which resolves a question that looked like a compromise and is not one. **A
wrapped third-party tool is a conforming analyzer, not a lesser one.** ruff and
clippy answer "where" superbly and have no opinion about remediation, which is
exactly the half the socket asks an analyzer for. Routing them through cyv would
give their findings the `why`, the `allowedFixes`, the `notFixes` graph and the
evidence class they do not have — and 0004 already proved a subprocess analyzer
conforms, using Roslyn.

| Pack | Answers "where" | Answers "why" |
|------|-----------------|---------------|
| TypeScript | cyv — ts-morph, 8 of 15 rules semantic | cyv |
| Unreal | cyv — nothing else models `UPROPERTY` | cyv |
| C# | cyv — Roslyn, 2 of 4 semantic | cyv |
| Python, Rust | **candidate: ruff, clippy** | cyv |

**One conformance check blocks this**, and it is the deferred decision
`registry/load.ts` predicted:

> every notFix's rule reference resolves to a rule in this analyzer

The interlock is analyzer-local by conformance. A wrapped ruff would emit
findings under ruff's ids, and no cyv rule could declare a dead end pointing at
them, which is the entire reason to route them through cyv rather than let a
user run ruff directly. `registry/load.ts` left rule ids unqualified on the
stated expectation that "the pressure would come from a third-party analyzer
whose author cannot see our names — and when that happens the loud error is what
tells us, at which point qualification can be added knowing what it is for."
This is that pressure, arriving from the predicted direction.

Note the distinction that makes this worth doing, because a weaker version of
the same idea was considered and rejected the same day. Declaring interlock
edges against a tool the user runs *separately* — ESLint, say — is redundant:
that tool reports its own findings, so the edge duplicates a warning the user
already receives, and buys only a few seconds of timing in exchange for a
permanent rot liability. A wrapped analyzer is different in kind, because cyv
*is* the reporting surface. An edge between a wrapped ruff rule and a cyv rule
is an edge inside one report.

### More rule packs

**The test a new pack has to pass.** Sorting every existing rule by "is anything
else silent here?" does not sort them by language. It sorts them by whether the
failure is characteristic of *machine-written* code.

Earning their place: `unreal-gc` — silent until a GC pass frees a live object
and something crashes far from the cause. `no-any` on an inferred binding —
silent type erosion, reported by ESLint only downstream at a use site and only
with type-aware linting switched on. `no-editorial-comment` — a comment that
argues instead of describing; humans do this occasionally and models do it
constantly. `no-tautological-assertion` — an assertion that cannot fail, which
is what a confident generator writes when a lazy human would have written
nothing. And T7007's `.catch(() => {})`, a non-fix that `no-floating-promise`'s
own guidance recommended.

Not earning it: bare `except`, `import *`, mutable default arguments,
`.unwrap()`. Well-known *human* habits, codified by mature linters a decade ago
and enabled by default in the tools those communities already run.

So the question for a proposed rule is not "does another tool have this one." It
is: **is this a failure mode mature linters never had a reason to target,
because humans did not produce it at scale?** By that test `core-py` looks
redundant and `comment-quality`, at one rule, looks underbuilt — roughly the
opposite of what rule counts suggest.

**Retire the parity argument in `core-py` and `core-rust`.** Both packs should
say plainly in their READMEs which ruff and clippy rules already cover their
ground. `0010` already concedes the Rust pack is "worth having for consistency
with every other pack, not for its coverage"; with parity abandoned that
sentence argues for retiring it, not keeping it. Saying so costs nothing and is
the same honesty the tool demands of a finding.

**0027 — Packs as a published posture.** Today a pack is a string on a rule. It
should be a thing a team can adopt, describe and disagree with: a name, a stated
intent, and an explicit list. `strict-boundaries` already showed the missing half
— moving three rules into a new pack silently disabled them here, and nothing
reported it. The test above is what a pack's stated intent should be written
against.

**0028 — A concurrency and async pack.** `no-floating-promise` found a real
unhandled-rejection bug on its first run against this repository, which is the
strongest evidence any rule here has produced. Unawaited work, missing
cancellation, and races on shared mutable state are where this class of rule earns
its keep across every language on the list.

**0030 — A test-quality pack.** *(Begun: the pack exists, with one rule.)*
Assertions that cannot fail, tests that pass when the code under test is deleted,
mocks asserted against themselves. Harder than it sounds and easy to get wrong; a
false positive here trains people to ignore the tool. One rule is a start, not a
posture.

**A boundary-validation pack.** *(Was numbered 0029 here; that number belongs to
analyzer prerequisites. Unnumbered until its folder exists.)* Everything that
enters a program from outside it: request bodies, environment variables, file
contents, subprocess output. `no-json-parse-cast` is one rule of what should be a
family. The constraint from the founding principles applies with full force — the
guidance must name no validation library, because the point is that the boundary
is checked, not that a particular package is installed.

### Tooling and the web surface

**0031 — A dashboard worth leaving open.** *(Retired. Delivered by 0040.)* What it
asked for — history worth watching, per-file heat, which rules a team suppresses
most — is now either on the dashboard or carried by `cyv metrics`.

**0034 — `cyv explain <rule>`.** *(Retired. Shipped in the root commit.)*

**A public documentation site.** *(Was numbered 0032 here; that number belongs to
guidance surfaces. Unnumbered until its folder exists.)* Generated from
the rule manifests rather than written beside them, so a rule's guidance cannot
drift from the rule. Distinct from 0039's landing page, which argues the case
rather than documenting the rules. The manifests are already static and readable
without executing anything, which is exactly what makes this cheap — and is the
second time that decision has paid for itself.

## Pacing

Deliberate constraint on execution, not on scope: at most a couple of delegated tasks at a time, with
the free executor lane preferred for well-specified implementation work. Saturating the orchestration
budget to run six things at once trades the ability to plan, review and integrate for a marginal gain
in throughput — and the reviewing is where the defects have actually been found. Everything of value
tonight came from reading a report carefully, not from starting one more task.

## Subscriptions, not metered APIs

A deliberate constraint on everything below: **checkyourvibe must never require an API key, and must
never add per-token cost.**

The analysis is deterministic — a compiler and a set of rules. The remediation guidance is text written
once into a rule manifest, not text generated per violation. So the only tokens ever spent are the ones
the user's own agent spends reading a finding, inside a subscription they already pay for. A developer
running a handful of $20/month agent subscriptions gets the entire feedback loop at no marginal cost,
and there is no usage meter to watch.

This is why the integration surfaces are hooks and MCP rather than a hosted service: both run *inside*
the agent the developer is already paying for. It also rules out a whole category of feature — anything
that would call a model to explain, summarise, or triage a finding. If a finding needs explaining, the
explanation belongs in its rule manifest where it is written once, reviewed, and free.

**Consequence for the `executor` surface** (declared in 0001, unimplemented): when it lands, it
dispatches work to *subscription-backed agent CLIs* — Claude Code, Codex, Cursor, Gemini, Antigravity —
not to metered API endpoints. The value is spreading work across subscriptions a developer already
holds, not consuming credits. Any executor requiring a metered key must be opt-in, clearly labelled as
billed, and never a default or an automatic escalation target.

## Principles carried forward

1. **Verify against reality, not fixtures.** Every spec ends by pointing the tool at something real.
2. **Silence is the enemy.** A skipped file, a disabled rule, an unparsed payload, a rule pack that
   expands to nothing — each must be reported. Most defects found so far were silent successes.
3. **Degrade in the right direction.** The advisory loop may fail open; the backstop may not.
4. **The user's files are theirs.** Never blind-overwrite, never delete another tool's configuration.
5. **No vendor in a rule.** Rules take options; the option's default names nothing.
6. **No metered cost.** Nothing in the tool may require an API key or spend tokens on the user's
   behalf. Guidance is written once into a manifest, not generated per finding.
