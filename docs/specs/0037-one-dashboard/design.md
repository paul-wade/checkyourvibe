# 0037 — Design

## Decision 1 — The merge runs into core, and the review UI is the thing that moves

The direction is not obvious from size. `tools/review/` is 2,460 lines and
carries the features people actually use; core's dashboard is the one nobody
opens. Moving the bigger, better-used surface into the smaller one looks
backwards.

Three things settle it.

**Core ships and the review UI does not.** Every user-facing requirement in 0035
— a developer opening the dashboard and being shown the wrong project's numbers
— describes someone who has `cyv` installed and has never seen `tools/review/`.
Building multi-project support into a file that reaches no user answers the
complaint in the wrong building.

**Core already knows about lanes.** `dashboard/executor-view.ts` folds dispatch
records into lane runtimes, cooldown and in-flight counts, and `dashboard/render.ts`
draws them. The review UI would have to acquire all of it. The features moving
the other way — specs, comments, git activity — depend on nothing but the
filesystem and git.

**The review UI is exempt from this project's own rules, and that is the
argument that decides it.** The TypeScript analyzer's manifest matches `**/*.ts`
and `**/*.tsx`. `tools/review/` is `.mjs`. So the largest single body of code in
this repository outside the packages is the one body cyv does not check — no
`no-any`, no `no-swallowed-catch`, no `no-floating-promise`, none of the
nineteen. Spec 0002's premise was that *"a tool that exempts itself has no
standing to enforce anything"*, and closed the violations cyv reported against
its own source. This is the same exemption, hiding in a file extension rather
than in a config.

Porting it to TypeScript in `packages/core/` subjects 2,460 lines to the rules
for the first time. That will produce findings. Those findings are the point,
not a cost of the move — and by this project's own repeated experience, pointing
the tool at code it has never checked is where every real defect has come from.

**Cost, stated plainly:** the port is the largest single task in this spec, the
findings it surfaces are unbudgeted because nobody has run the rules over that
code, and until it lands there is a period with two surfaces. R1.2 requires the
old one be deleted rather than left running, so the period ends.

## Decision 2 — Project state stays with the project; only the registry is global

`~/.cyv/projects.json` holds absolute paths and nothing else — that is 0035
T35001's shipped behaviour and it is right. Everything else a project accumulates
stays inside it: `.cyv-review/` for the exchange, its own baseline, its own
history.

The alternative, a central store keyed by project path, was rejected because it
breaks the property that makes the current one trustworthy: a project's record
travels with the project. Clone it elsewhere and the conversation comes too;
delete it and nothing is orphaned in a home directory. A central store also has
to answer what happens when two machines disagree, which is a synchronisation
problem this project has no reason to acquire.

The registry is global because it is a statement about *this machine*: which
checkouts this developer wants watched. It is the only thing that is.

**Consequence for R2.3:** a registered path can fail two different ways and the
current implementation conflates them — `listProjects` reports `exists: false,
hasConfig: false` for every not-ok path, including a directory that exists and
merely lacks a `checkyourvibe.json`. Reporting a directory as absent when it is
present is the tool asserting something it did not measure. The port fixes it;
the requirement says why.

## Decision 3 — Hierarchy comes from role, and there are exactly three roles

R5.1 forbids one repeated block. What replaces it has to be principled or it
becomes decoration, so the page is built from three treatments and no more:

- **Decision** — something is waiting on a person. Loud, at most one region,
  carries the existing orange. This is the reason the page is opened.
- **Measurement** — a fact the tool established, always wearing its evidence
  (R5.4): measured, recorded, or unknown.
- **Reference** — specs, documents, history. Quiet, dense, scannable, and never
  competing with the other two.

Every panel declares which of the three it is, and the treatment follows from
that rather than from where it sits on the page. A count of open tasks is
reference; a task waiting on `executor=user` is a decision; a lane in cooldown
is a measurement. The current page renders all three identically, which is
exactly why it reads as generated: the visual language carries no information.

This also settles R5.2. The primary element is not a fixed slot — it is whichever
decision is newest, or, when there are none, the most recent measurement. A page
with nothing to decide should look different from a page with something to
decide, and today they look the same.

**Carried forward unchanged** (R5.6): green means measured rather than good,
orange at most twice, no cards. Those decisions are in the current stylesheet's
own header and they are correct. Nothing here departs from them; the three roles
are how they finally get applied.

## Decision 4 — Empty states are designed before the populated ones

R5.3 and R6.3 exist because of what the front page renders right now: a headline
reading *"Not measured yet"* over three statistics showing `--`. That is the
first thing a new user sees, on a fresh checkout, before any run — the highest
traffic state the page has, and the only one nobody designed.

So each panel's empty state is built first and names what would fill it and how
to make that happen. "No runs recorded — `cyv check --all` writes the first one"
is a page doing its job. `--` is a page that has given up.

**Not taken: hiding empty panels.** A panel that vanishes when empty teaches the
reader the page is complete when it is not, and this project's second principle
is that silence is the enemy. An empty panel that says why is information; an
absent one is a gap the reader cannot see.

## Decision 5 — The visual design is drawn before it is implemented

The failure this spec is fixing is a design failure, and it was produced by
writing markup directly — each section added by extending the pattern already
there, which is how a page ends up as five copies of one block.

So T37003 draws the three treatments of Decision 3 as artboards, against real
content in all three of R5.4's evidence states and in the empty states of
Decision 4, before any implementation. It is dispatched to a judgment lane and
its output is reviewed by a person, because "does this read as generated" is a
question with no gate.

**Not taken: adopting a component library or CSS framework.** R1.3's
zero-dependency property is worth more than the head start. It is also what
forces the design to be a set of decisions rather than a set of defaults — and
defaults are what the page currently looks like.

## Decision 6 — Orchestration is a first-class region, not a tab

R4 puts lanes on the page a person actually opens. The temptation is to give it
its own route, which is what core does today and why nobody has looked at it.

Idle paid-for capacity is one of this project's two headline claims. A user
glancing at their phone should see that three subscriptions are sitting idle
while one is in cooldown, without navigating. It is a measurement region under
Decision 3, and a stall (0036 R4) promotes to a decision region, because a
stalled run is waiting on a person even though nothing said so.

R4.5 restates the prohibition that governs all of it: no meters, no percentages,
no projections. A lane shows what it is doing and what it is declared to allow.
Anything that implies the account's real headroom is known is the fabricated
precision this project refuses everywhere else.

## What this spec does not resolve

- **Whether guarded editing ships enabled.** Editing a spec from a phone is
  useful in this repository and is a different proposition in someone else's.
  R1.1 carries the capability across; the default is left open.

- **Authentication.** Both surfaces bind to a LAN address today and neither
  authenticates. One dashboard serving several projects widens what a request
  reaches, and that is worth its own spec rather than a decision made in passing
  here.
