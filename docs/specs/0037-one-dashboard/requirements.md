# 0037 — One dashboard

**Status:** active
**Created:** 2026-08-31
**Supersedes the surface of:** 0034, 0035
**Depends on:** 0006, 0011, 0036

## Introduction

There are two dashboards.

`cyv dashboard` serves on 4300 from `packages/core/`. It is the product: it
ships, it knows rules, the interlock graph, trend, file heat, baseline,
suppressions, and — uniquely — executor lanes, cooldown and dispatch state.

`tools/review/server.mjs` serves on 4180 from the repository's own tools
directory. It is the one actually used: specs, tasks, comments, git activity,
guarded editing, phone-first. It ships to nobody, and it knows nothing about
lanes — it parses `_Exec:` lines to learn a task's *declared* executor and never
reads a dispatch record.

The split is not a design. It is two things built at different times for
different readers, and it now costs three ways. Work aimed at users lands on the
tool that ships to nobody: specs 0034 and 0035 are both written against 4180,
and 0035's own justification is a complaint about what a *user* sees when they
open the dashboard. The orchestration surface — one of this project's two
headline features — is rendered on 4300, which is not the page anyone opens.
And every improvement has to be made twice or abandoned on one side.

This spec makes one dashboard: the shipped one, on 4300, carrying everything
4180 does today.

### The second problem: it reads as generated

The stylesheet is not the problem. It is principled and its reasoning is written
down in the sheet itself — green means measured rather than good, orange appears
at most twice, no cards because this is one narrative rather than a pile of
equal objects. Those are real decisions and this spec keeps them.

The problem is that the page does not act on them. Every section renders as the
same object: a hairline rule, an uppercase monospace micro-label, a right-aligned
count, and a list of rows. Repeated five times down a single column. Uniform
rhythm with no hierarchy is the specific thing that makes a page read as
generated — not the colours, and not the typeface.

And the front page's most prominent element is currently four em-dashes: the
headline says *"Not measured yet"* while three of four statistics render as
`--`. An empty state is a state a user is in, and it was never designed.

## Requirement 1 — One surface

1.1. Every capability `tools/review/server.mjs` serves today SHALL be available
   from `cyv dashboard`: specs and their tasks, documents, comments, git
   activity, the verdict and needs-you panels, and guarded editing.

1.2. `tools/review/server.mjs` SHALL be removed once 1.1 holds, and SHALL NOT be
   left in place as a second implementation. Two surfaces drifting apart is the
   condition this spec exists to end.

1.3. The consolidated dashboard SHALL keep the zero-runtime-dependency property
   both surfaces have today. Nothing here requires a framework, a build step, or
   a package the tool does not already depend on.

1.4. The consolidated dashboard SHALL remain phone-first. It is read away from
   the machine to answer whether anything needs a person, and that is its
   primary use, not a secondary one.

1.5. Migration SHALL preserve existing recorded state: the comment store,
   including the `kind` and `refs` fields added by 0034 T34001, and the project
   registry added by 0035 T35001, SHALL be readable by the consolidated surface
   without a conversion step that can fail silently.

## Requirement 2 — The page is about projects, not about this checkout

Carried forward from 0035, re-pointed at the surface that ships.

2.1. The dashboard SHALL show every registered project and SHALL NOT privilege
   the repository it is installed in. A user running cyv on their own project
   SHALL NOT be shown checkyourvibe's own self-check.

2.2. Registration SHALL be explicit. Nothing scans a disk and nothing infers a
   project from activity.

2.3. A registered path that no longer exists, or no longer holds a
   `checkyourvibe.json`, SHALL be reported as such and SHALL NOT be silently
   dropped. The report SHALL distinguish "the directory is gone" from "the
   directory is there and the configuration is not", because the remedies
   differ.

2.4. One server SHALL serve every registered project. A port per project is the
   condition being removed.

## Requirement 3 — The exchange is the content

Carried forward from 0034, re-pointed at the surface that ships.

3.1. A project's page SHALL present the exchange between the owner and the
   agent — what was asked, what was done, what is proposed — in order, most
   recent first.

3.2. An entry SHALL state who wrote it, and an agent's entry SHALL be
   distinguishable from the owner's at a glance, from recorded authorship rather
   than from inference.

3.3. The owner SHALL be able to write back a paragraph, not a line.

3.4. A recorded turn SHALL NOT appear as something waiting on a person.

## Requirement 4 — Orchestration is visible

4.1. The dashboard SHALL show executor lanes: which are available, which are at
   cap, which are in cooldown, and which are idle. Idle paid-for capacity is the
   waste this project exists to surface and it SHALL be legible at a glance.

4.2. The orchestrating lane SHALL be shown among them, marked as the
   orchestrator, carrying its self-reported state with self-reported
   attribution and showing unknown where there is no report (0036 R7.1, R7.2).

4.3. A stall SHALL be shown as an attention state naming the idle lanes it
   found (0036 R7.3), and SHALL NOT be worded as an accusation about a cause
   (0036 R4.2).

4.4. Dispatches judged abandoned or undetermined SHALL be shown as needing a
   person rather than filed among completed work (0036 R7.4).

4.5. No surface SHALL render a percentage, meter, remaining-token count or
   projected time-to-exhaustion for any lane (0011 R7.1, R10.5, 0036 R3.5).

## Requirement 5 — Hierarchy, and the states the page is actually in

These are the checkable half of "it should not read as generated". Taste is not
a requirement; the absence of hierarchy is a defect and can be stated as one.

5.1. Sections SHALL be differentiated by role rather than rendered as one
   repeated block. A thing needing a decision, a thing being measured, and a
   thing that is reference material SHALL NOT share one visual treatment.

5.2. The page SHALL have a single primary element, and it SHALL be whatever most
   recently changed or most needs a person — not a fixed slot that renders
   whatever is available.

5.3. Every panel SHALL have a designed empty state naming what would populate it
   and how. A row of `--` is not an empty state.

5.4. A number SHALL carry its evidence: measured this session, recorded earlier,
   or unknown. The three SHALL be visually distinct, and unknown SHALL NOT
   resemble zero. This is the existing `.ev` treatment, and it SHALL be applied
   everywhere a number appears rather than only in the verdict.

5.5. The typographic scale SHALL express hierarchy. A page whose every label is
   the same 10px uppercase monospace has no hierarchy to express, whatever its
   content.

5.6. The design decisions recorded in the stylesheet's own header — green means
   measured rather than good, orange at most twice, no cards — SHALL be carried
   forward, and any departure SHALL be argued in `design.md` rather than made
   silently.

## Requirement 6 — It is verified by being looked at

6.1. The consolidated dashboard SHALL be exercised against real state before
   this spec closes: several registered projects, at least one of them not
   checkyourvibe, at least one dispatch in flight, at least one lane in
   cooldown, and at least one abandoned dispatch.

6.2. It SHALL be looked at on a phone-width viewport, because R1.4 claims that
   is its primary use and no other check tests the claim.

6.3. Every panel's empty state SHALL be seen, not reasoned about. The empty
   states are the ones that ship broken, because they are the ones nobody opens
   on a machine with data.

## Requirement 7 — Markdown is read formatted, and commented in place

What exists today already does most of this and SHALL be carried across rather
than rebuilt: `/view` splits a document into sections by heading, renders each
through a vendored `marked.min.js`, and anchors a comment thread to each
section's slug.

7.1. A markdown document SHALL be displayed formatted, not as raw source.

7.2. A comment SHALL attach to a section of a document, identified by a stable
   anchor, rather than only to the document as a whole. Commenting on a spec
   means commenting on a requirement.

7.3. Markdown SHALL be rendered with the existing hardening intact: raw HTML in
   a document is escaped and never rendered as live markup, and link and image
   targets are restricted to safe schemes. Documents in this tool are written by
   agents, so a document is untrusted input, and rendering one must not let it
   execute.

7.4. The renderer SHALL remain vendored rather than fetched at runtime, per
   R1.3. `tools/vendor/marked.min.js` moves with the rest of the port.

7.5. A document SHALL be readable when the formatted render is unavailable.
   Rendering currently happens client-side after load, so a reader with no
   script gets the source text — acceptable, but the fallback SHALL be a
   deliberate state rather than an accident, and SHALL NOT be an empty panel.

7.6. Editing SHALL keep the existing save protections. A document changed on
   disk since it was opened SHALL NOT be blind-overwritten (principle 4: the
   user's files are theirs).

## Requirement 8 — Diffs are reviewed, not rebuilt

`tools/review/difit.mjs` already wraps `difit` (yoshiko-pg/difit) over npx,
running three instances — working tree, staged, and branch — because each
answers a different question and one diff cannot serve all three.

8.1. The dashboard SHALL keep an integrated diff review surface, and SHALL keep
   the three-instance distinction. Collapsing them into one diff loses the
   commit gate.

8.2. A diff viewer SHALL NOT be written from scratch for this project. Syntax
   highlighting, large-file handling, intra-line diffing and per-line comments
   are a large surface with mature implementations, and building one would spend
   the project's effort where it has no claim to make.

8.3. The incumbent SHALL be judged on a phone before it is either kept or
   replaced (R6.2). The published description of it as responsive is a claim
   about the tool, not a measurement of it at phone width, and this project does
   not accept a claim in place of a look.

8.4. WHERE the incumbent is found wanting on a phone, the response SHALL be to
   evaluate alternatives or to contribute upstream, in that order. 8.2 stands
   regardless of the outcome.

8.5. The integration SHALL NOT modify the index to render a diff. The existing
   refusal to pass `--include-untracked`, because it runs `git add -N` on every
   untracked file and makes the change list misrepresent what is about to be
   committed, is carried forward as a requirement rather than left as a comment.

## Open questions

- **Does the review UI's guarded editing belong in a shipped tool?** Editing a
  spec from a phone is useful here and is a different proposition in someone
  else's repository. R1.1 carries it across; whether it ships enabled is not
  settled.

- **What happens to `.cyv-review/`?** The comment store is a dotfile in the
  repository it describes. For a multi-project dashboard, per-project storage
  is right and a shared store is a different answer. R1.5 requires it not be
  lost; where it lives is 0037's design decision.
