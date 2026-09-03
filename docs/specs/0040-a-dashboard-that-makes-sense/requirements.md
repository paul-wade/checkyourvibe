# 0040 — A dashboard that makes sense

**Status:** active
**Created:** 2026-09-01
**Supersedes the surface of:** 0037 (and through it 0034, 0035)
**Depends on:** 0011, 0036

## Introduction

cyv does two things: a compiler enforces the standards, and work is planned
across the subscriptions the user already holds. The dashboard exists for one
reason on top of those: so a developer can walk away and still know things are
in motion, and can step back in easily to stop a mistake they see.

Spec 0037 chose the right destination — one server, port 4300, the shipped
package — and the wrong content. `cyv dashboard` today opens with a paragraph
explaining what it refuses to draw, then a rule browser, an interlock graph,
trend charts, baseline tables and suppression tables. At phone width the page is
seventy-nine thousand pixels tall. None of it answers the question the page is
opened to ask.

The review UI on 4180 answers it, in four screens, and knows nothing about
lanes. This spec takes 4180's shape and honesty, gives it the executor state
only 4300 has, and deletes everything else.

### What the page is not

- It is not a rule browser. Rules, the interlock graph, trend, file heat,
  baseline and suppressions describe the rule pack and its history. They move
  off the page to `/rules`, one link away, unchanged.
- It is not a test dashboard. cyv has no opinion on whether a project has
  tests. A test suite is one thing a task may name as a gate. No test count
  appears on the page.
- It is not a chat with a model. The exchange is recorded turns, written
  deliberately (0034 R3, R4).
- It draws no meter, percentage, token count or projection for any lane (0011
  R7.1, R10.5; 0036 R3.5).

## Requirement 1 — One page, four regions, in this order

1.1. The page SHALL consist of a top bar and four regions, and nothing else:
   **needs you**, **in motion**, **lanes**, **exchange**.

1.2. The top bar SHALL carry: a project selector (a dropdown when more than one
   project is registered, the project name alone when one is); the state of
   the last `cyv check` — findings count with its evidence and age, or
   "running", or "never" — and tabs to **diff**, **docs** and **rules**.

1.3. No region SHALL open with prose about what it does not show. A panel shows
   the fact, its evidence, and the one action that would change it.

1.4. Every region SHALL have a designed empty state that names what would
   populate it and how. No panel disappears when empty (0037 R5.3).

1.5. The page SHALL be phone-first, server-rendered, zero runtime dependency
   (0037 R1.3, R1.4), and SHALL re-read its state on a poll without a reload
   that discards a half-typed reply.

## Requirement 2 — Needs you

2.1. The region SHALL list everything waiting on a person, each with what it is
   and where to go: a dispatch that closed needing attention (0011 R10.4), a
   dispatch judged abandoned or undetermined (0036 R7.4), a stall (0036 R7.3),
   an open note the owner wrote that no one has addressed, a task whose
   `_Exec:` names `executor=user`, and a roadmap entry marked blocked.

2.2. A recorded turn SHALL NOT appear here (0034 R3.4).

2.3. Empty SHALL say, in one line, that nothing is waiting.

## Requirement 3 — In motion

3.1. The region SHALL name the spec being worked — the one with open tasks and
   the most recent dispatch — with its done-of-total, or say no spec has open
   tasks.

3.2. **Running now** SHALL list every open dispatch: the task it carries, the
   lane and model, when it started, and its liveness judgement (0036 R5) with
   the reason. Each running dispatch SHALL carry a link to the working-tree
   diff and a **stop** control (Requirement 6).

3.3. **Next up** SHALL list the open tasks of the active spec whose stated
   dependencies are done, grouped into what can run at the same time: tasks
   whose declared file scopes do not overlap form one wave. Each names its
   declared lane and files.

3.4. **Just finished** SHALL list recent closed dispatches with the task, lane,
   outcome and failed gates, failures visibly apart from successes.

3.5. WHEN open work exists, a lane is free, and no dispatch has opened within
   the stall interval (0036 R4) THEN the region SHALL say so and name the idle
   lanes. It SHALL NOT name a cause (0036 R4.2).

3.6. Uncommitted changes SHALL be shown as a count with the most recently
   touched files, because they are the only sign of work that no dispatch
   record carries.

## Requirement 4 — Lanes

4.1. One row per declared lane: running N of cap, and one of **free**,
   **busy**, **cooling**, **unavailable**, or **reserved** (the orchestrating
   lane that does not accept dispatch). The orchestrator is marked as such.

4.2. A cooling lane's row SHALL say how cooldown clears (0036 R10.6).

4.3. An unavailable lane SHALL name the program that was not found (0036 R2.2).

4.4. The orchestrating lane SHALL show its self-reported state, attributed as
   self-reported, and **unknown** when there is no report (0036 R3.3, R3.4).

4.5. Installed agent CLIs no lane names SHALL be listed as unused (0036 R2.3).

## Requirement 5 — Exchange

5.1. Recorded turns and notes, newest first, each with author and time; an
   agent's entry distinguishable from the owner's by recorded authorship
   (0034 R1.2).

5.2. A textarea that accepts a paragraph, posting to the comment store the
   watcher already reads (0034 R2). It MAY name a task id or file.

5.3. An owner's note SHALL be markable addressed from the page.

## Requirement 6 — Stop

6.1. A running dispatch SHALL be stoppable from the page. Stopping SHALL end the
   supervising cyv process and its executor, and SHALL append a `closed` entry
   whose outcome is `did-not-complete` with a detail stating it was stopped
   from the dashboard. No success or failure of the work is invented (0011
   R11.2).

6.2. Stop SHALL be refused, with the reason shown, when the dispatch was opened
   on another host or its process cannot be identified (0036 R5.4).

6.3. Stop SHALL require two taps: the first arms, the second sends. A page read
   on a phone must not stop a dispatch by being scrolled.

6.4. This narrows 0011's non-goal that the view is read-only. Reading state and
   stopping a mistake are the two halves of walking away.

## Requirement 7 — Diff, docs, rules

7.1. The **diff** tab SHALL carry the difit integration across unchanged: three
   instances (working, staged, branch), start-on-demand, comments read back,
   and the refusal to pass `--include-untracked` (0037 R8).

7.2. The **docs** tab SHALL carry the document browser, section-anchored
   comments, the vendored markdown renderer with its hardening, and guarded
   editing (0037 R7).

7.3. The **rules** tab SHALL serve the existing rule browser, interlock graph,
   trend, file heat, baseline and suppressions, as they render today.

## Requirement 8 — One server, and the old one goes

8.1. `cyv dashboard` SHALL serve every registered project; `cyv projects` SHALL
   list, add and remove them (0035 R2).

8.2. `cyv comments` SHALL replace `watch-comments.mjs`: new comments across
   every registered project, with `--peek` and `--reset`.

8.3. Existing `.cyv-review/comments.json` stores and `~/.cyv/projects.json`
   SHALL load unchanged (0037 R1.5).

8.4. `tools/review/` SHALL be deleted once 1 through 7 hold, and every
   reference to port 4180 with it (0037 R1.2).

## Requirement 9 — Looked at, not reasoned about

9.1. Before this spec closes the page SHALL be opened at phone width with real
   state: a dispatch in flight, a lane in cooldown, an abandoned dispatch, and
   every region's empty state. What was seen is recorded in `docs/STATUS.md`.
