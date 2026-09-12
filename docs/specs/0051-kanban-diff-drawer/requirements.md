# 0051 — Dashboard Workbench, Diff Drawer and Spec Editing

**Project:** dashboard  
**Status:** active
**Created:** 2026-09-06
**Revised:** 2026-09-06 — folds spec 0047 into this one
**Depends on:** 0011, 0040, 0041, 0042
**Supersedes:** 0047 (Stitch Dashboard Workbench)

## Introduction

Spec 0047 and the first draft of this spec both replaced the dashboard, in
different words, from the same Stitch design templates. They are one design.
This spec is the merged one; 0047 is superseded and its partial
implementation, the design-token stylesheet and the three touched dashboard
modules, is the foundation this builds on rather than work to discard.

The dashboard is the primary interface. It is not a viewer bolted onto a CLI.
A developer completes a request end to end from it, including from a phone,
without sitting at their machine.

The design templates under `.cyv-review/designs/stitch-17590787663427686906/`
are normative: `desktop-workbench.html` for the desktop layout,
`waves-task-pipeline.html` for the drawer, `needs-you-triage-deck.html` and
`glance-status-hub.html` for the phone.

## Decisions this spec records

Three questions were open. They are settled here so no task has to guess.

1. **Diff content comes from difit.** The executor's snapshots store a sha256
   digest per path, not content (`packages/core/src/executor/snapshot.ts`), and
   no snippet data exists anywhere. So the board renders the scope
   classification natively, which it can compute from digests, and hands
   line-level content to difit, which already exists and is already run. No new
   content storage. The consequence is explicit: inline per-line comments do
   not live in this drawer. They live on difit's surface, which the comment
   bridge already watches.
2. **The dashboard writes.** Anything achievable from the CLI is achievable
   from the dashboard. The earlier read-only restriction is withdrawn.
3. **The system is stateful.** It persists real state. The rule is not that
   there is no new store; it is that every fact has exactly one owner.

## Requirement 1 — The dashboard is the primary interface

1.1. Anything achievable from the CLI SHALL be achievable from the dashboard:
editing specs and task files, dispatching work, replying to an agent's
question, authoring a rule, approving, acknowledging, and stopping a run.

1.2. Every capability in 1.1 SHALL work on a phone. The phone is not a
read-only triage deck; it originates work.

1.3. The dashboard SHALL write to the same files the CLI reads, so the two
surfaces cannot disagree.

## Requirement 2 — A kanban board with the drawer docked

**Corrected 2026-09-07.** The previous revision replaced the kanban with a
three-column workbench, on the grounds that `desktop-workbench.html` is a
workbench. That was the wrong call: the kanban is the point, it is what
distinguishes this from a session-list product, and the correction dropped the
docked drawer along with it. `waves-task-pipeline.html` is the template that
carries the drawer. Both templates are normative; neither alone is the design.

2.1. The board SHALL be a kanban. Columns, left to right: **Needs You**,
**In Progress**, **Review**, **Done**. Lane status is a compact strip.

2.2. **In Progress is what the AI is working on right now** — not a backlog and
not a staging area. A card enters it when a dispatch opens and leaves it when
that dispatch closes.

2.3. A card SHALL carry live status: what the agent is doing, how long it has
been doing it, which lane it runs on, and its scope so far — files changed, and
whether any fall outside what it declared. The card is where the run is
watched, so it updates from the event stream rather than on reload.

2.4. **Backlog is not a column.** An undispatched task belongs on the spec and
task pages, which is where those files are edited. The board is about the run.

2.5. The **difit drawer SHALL be docked at the bottom of the board at all
times**, not opened and closed per card. Its purpose is reviewing changes
before they become a pull request, so it is a permanent working surface rather
than a modal. Selecting a card fills it; selecting another replaces its
contents; it does not disappear.

2.6. The drawer SHALL show the three-way scope split — in scope, out of scope,
declared but unchanged — beside the line-level content difit renders. The
classification is cyv's; the lines are difit's.

2.7. On a viewport under 1024px the columns collapse to sections with Needs You
open, and the drawer becomes a full-screen sheet reachable from any card.

2.8. A card SHALL show the task id, a one-line description, its lane, the
outcome kind in words a person can act on, a timestamp, and an open-note badge.

## Requirement 3 — The diff drawer

3.1. Selecting a card SHALL open a bottom drawer covering roughly the lower
60% of the viewport, full screen on a phone. It stays open until closed;
selecting another card replaces its content.

3.2. The drawer SHALL render, natively, the three-way scope split computed
from the dispatch's snapshots: **in scope** (changed and declared), **out of
scope** (changed and not declared, the `outOfScopePaths` from `outcome.ts`),
and **declared but unchanged**.

3.3. The drawer SHALL show the outcome classification and the gate results
that produced it.

3.4. Line-level content SHALL be reached through difit, not rendered by the
drawer. The drawer links or embeds difit for the dispatch's stable state.

3.5. The drawer SHALL only offer content for a dispatch that has reached
Review or Done. A dispatch mid-turn has a moving working tree and SHALL NOT be
presented as reviewable.

## Requirement 4 — Editing specs from the dashboard

4.1. The dashboard SHALL provide a markdown editor for any file under
`docs/specs/**`, usable on a phone.

4.2. An edit SHALL write to the file itself, in place.

4.3. A spec or task file SHALL NOT be editable while an agent holds it, and an
agent SHALL NOT be dispatched against a file a user holds open. This is
mutual exclusion, and it is enforced by the server rather than requested of
the agent.

## Requirement 5 — State ownership

5.1. The system SHALL persist state. Every fact SHALL have exactly one owner,
so no fact is writable from two places.

5.2. State the dashboard's store owns exclusively, because nothing else can:
  - the **session registry**: which sessions exist, per project, against which
    CLI, in what state, and when each was last resumed
  - **card-to-session assignment**, the mutual exclusion that stops two agents
    on one card or one working tree
  - the **decision record**: rulings a human has made, in enforceable form, so
    a question asked once is not asked again
  - **draft comments**, a state ahead of open and addressed, so a batch review
    can be composed without a watching agent reacting mid-compose
  - **spec and task edit locks** (Requirement 4.3)
  - **quota state per subscription**: what is spent and when it resets

5.3. State that already has an owner keeps it, and the dashboard writes it
directly: the dispatch log, the comment store, lane declarations, and the spec
and task files.

## Requirement 6 — Quota is a first-class state

6.1. A subscription's exhausted quota SHALL appear in Needs You, naming the
lane and the reset time. Every card on that lane stops moving until it clears,
and nothing else in the system explains why.

6.2. A 429 from a lane SHALL park its work rather than consume attempts
retrying against a budget that is already spent.

## Requirement 7 — Design system

7.1. The board SHALL use the design tokens already implemented in
`packages/core/src/dashboard/styles.ts`, which carries 59 custom properties
from the Stitch design system: dark surfaces, violet primary, green secondary,
amber tertiary, red destructive.

7.2. Tokens SHALL remain CSS custom properties in one stylesheet, not
scattered into inline styles.

## Non-goals

- Rendering line-level diffs natively. That is difit's job (Decision 1).
- Inline per-line comments in the drawer (Decision 1).
- Progress bars, percentage meters, or token counts for a lane. A turn has no
  percent-complete signal; rendering one would be inventing data.
- Test counts as a headline. cyv has no opinion on whether a project has
  tests; a test is one gate a task may name.

## Deferred deliberately

Authentication on `--host`. The dashboard now writes spec files and dispatches
agents, so binding it to the LAN without auth lets anyone on the network do
both. Raised 2026-09-06 and deferred by the author as not a concern for now.
Recorded so it reads as a decision rather than an oversight.
