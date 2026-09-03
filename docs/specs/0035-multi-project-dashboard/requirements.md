# 0035 — One dashboard, several projects

**Status:** draft
**Created:** 2026-08-31

The review UI is hardwired to one repository: `REPO` is resolved from the
server's own location, so it can only ever report on the checkout it lives in.

That is wrong for how it is used. A developer has several projects open, may
have an orchestrator running in more than one, and wants to see all of them
without a server per project and a port to remember for each.

It also makes the home page report the wrong thing. Someone using checkyourvibe
on their own project opens the dashboard and is shown checkyourvibe's own
self-check — a number about the tool, not about their work.

## Requirement 1 — The page is about projects, not about this checkout

1.1. The dashboard SHALL show every registered project, and SHALL NOT privilege
   the repository it happens to be installed in.

1.2. WHERE only one project is registered, the page SHALL read as that
   project's page and SHALL NOT show grouping machinery that earns nothing.

1.3. The tool's own self-check SHALL be one project among the others, or absent.
   It SHALL NOT be the headline of a page about somebody else's work.

## Requirement 2 — What a project is

2.1. A project is a directory holding `checkyourvibe.json`. Its state is already
   under `.cyv-review/` in that directory: the last run, the dispatch log, the
   comments, the recorded health.

2.2. Registration SHALL be explicit. The dashboard SHALL NOT scan a disk looking
   for projects, and SHALL NOT infer one from recent activity.

2.3. A registered project that has moved or been deleted SHALL be reported as
   such and SHALL NOT remove itself. A missing project is a fact worth showing,
   not a tidy-up to perform.

## Requirement 3 — Several orchestrators at once

3.1. Each project's in-flight work SHALL be read from that project's own
   dispatch log. Nothing is shared between projects.

3.2. The overview SHALL make it possible to see, without opening each project,
   which have work in flight, which need a person, and which are failing.

3.3. WHERE two projects are being worked on at once, neither SHALL be able to
   make the other's state look stale or current. Each carries its own
   measurement time.

## Requirement 4 — Comments belong to a project

4.1. A comment SHALL be recorded against the project it concerns, in that
   project's own store.

4.2. The watcher SHALL be able to report new comments across every registered
   project, so an agent working in one is not blind to a note left on another.

4.3. An existing single-project store SHALL keep working unchanged.

## Requirement 5 — Reading it from a phone

5.1. The overview SHALL fit the smallest useful screen. Several projects each
   showing a full status panel is a scroll, not an overview.

5.2. A project's row SHALL carry enough to decide whether to open it: whether
   anything needs a person, whether work is in flight, and when it was last
   measured.

## Requirement 6 — A number on the page must earn its place

Raised by review comment #17, asking whether the headline panel matters at all.
It reads:

    Clean against itself. Last measured a while ago — re-measure before
    trusting it.
    215 files   19 rules   944 tests pass   99/114 tasks

6.1. The page SHALL be built around the three questions someone opens it to ask:
   does anything need me, what is happening now, and is it broken. A number
   answering none of those SHALL NOT occupy the top of the page.

6.2. Judged against that: `944 tests pass` answers "is it broken" and stays.
   `99/114 tasks` answers "how far along" and stays. `215 files` and `19 rules`
   are configuration facts that do not change between runs and answer nothing —
   they belong where configuration is reported, not in a status headline.

6.3. "Clean against itself" describes the tool checking the tool. On a page
   about someone else's project it is the wrong subject, and it is the specific
   thing Requirement 1.3 forbids.

6.4. A measurement SHALL still carry its age (this is why the panel exists), but
   age SHALL NOT be the loudest thing on the page when the measurement itself is
   the point.

## Open questions

- Where the registry lives. In the user's home directory it is per-machine and
  survives a reinstall; in a repository it is shareable but only describes one
  checkout's neighbours.
- Whether one server serves several projects, or one server per project with an
  index that links them. The first is fewer processes; the second cannot make
  one project's failure take down the view of another.
- Whether `cyv dashboard` (the rules browser, spec 0006) and this review UI
  should converge. They are two servers on two ports today.
