# 0006 — Web dashboard: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

`cyv dashboard` — a local, zero-dependency web view of a project's standards posture.

The obvious version of this is a table of violations, which a terminal already does better. The
version worth building shows three things a terminal cannot:

1. **The rule interlock.** `notFixes` is what makes this more than a pile of independent checks —
   `no-any` points at `no-as-cast` and `no-ts-comment` as dead ends, and those point back. That is a
   graph, and a graph is the one thing a scrolling report cannot convey. Seeing it is how a user
   understands the design in ten seconds instead of ten minutes of reading.
2. **Rules that never fire.** A rule that has never produced a finding is either redundant, wrong, or
   silently broken — and the third case is invisible everywhere else. This project has already shipped
   a rule pack that silently expanded to nothing; a view that says "six of seven rules have never
   fired" would have caught it instantly.
3. **Direction of travel.** Whether the count is falling, and which rules are driving it.

## Requirement 1 — Zero dependencies and zero cost

1. The dashboard SHALL be served by the CLI with no runtime dependency beyond Node's standard library
   and assets vendored into the repository.
2. It SHALL NOT call any network service, model, or telemetry endpoint. Per the project's
   zero-token-cost constraint, nothing here may spend a user's tokens or require a key.
3. It SHALL work fully offline.
4. It SHALL bind to localhost by default, and SHALL require an explicit flag to bind to a LAN address.
   A tool that exposes a repository's source to the network by default is a hazard, not a convenience.

## Requirement 2 — Rule browser

**User story:** As someone evaluating checkyourvibe, I want to read every rule and its guidance without
running an analysis or installing anything.

1. It SHALL list every rule from every configured analyzer's static manifest.
2. It SHALL render each rule's `summary`, `why`, `allowedFixes`, `notFixes`, and both examples.
3. It SHALL read manifests WITHOUT executing any analyzer, so browsing rules costs no toolchain
   startup — the reason manifests are static in the first place.
4. It SHALL support filtering by analyzer, pack, category, and severity, and free-text search.
5. WHERE a rule declares `optionsSchema`, its options SHALL be shown with their defaults.

## Requirement 3 — The interlock graph

**User story:** As a developer, I want to see how the rules constrain each other, so that I understand
why I cannot escape one by triggering another.

1. It SHALL render rules as nodes and `notFixes` entries as directed edges.
2. An edge SHALL be labelled with the `pattern` and, on inspection, its `because`.
3. A `notFix` with no `rule` field SHALL be shown as a terminal dead end rather than omitted — those
   are the escapes that are simply bad ideas rather than other violations, and they matter.
4. It SHALL highlight rules with no inbound or outbound edges. An isolated rule is not wrong, but it
   is not participating in the interlock, and that is worth seeing.
5. It SHALL be rendered with vendored assets or hand-written SVG. No CDN.

## Requirement 4 — Results and trend

1. It SHALL read `cyv check --json` output.
2. `cyv check` SHALL gain an opt-in flag to append a run summary — timestamp, commit, per-rule counts,
   files checked — to a history file under the review directory.
3. The history file SHALL be newline-delimited JSON, append-only, and gitignored by default.
4. It SHALL chart total violations over time and per-rule counts over time.
5. WHERE fewer than two runs exist, it SHALL say so plainly rather than drawing a chart of one point.

## Requirement 5 — Never-fired rules

1. It SHALL list every enabled rule that has produced no finding across recorded history.
2. It SHALL distinguish *never fired* from *not enabled*, because they look identical in a report and
   have opposite meanings.
3. It SHALL state plainly that a never-fired rule is either redundant, mis-targeted, or broken, and
   SHALL NOT present it as a success.

## Requirement 6 — Shared foundation with the review UI

1. `tools/review/` already serves a phone-first markdown and comment UI over this repository. Its
   server shell, styling, and safety properties — symlink-aware path containment, escaped rendering,
   no CDN, theme-aware, mobile-first — SHALL be factored into something both it and the dashboard use.
2. The dashboard SHALL be mobile-legible. A graph and charts on a phone are harder than a table, and
   that is a design requirement rather than an excuse.
3. Neither surface SHALL be able to write to a path outside the repository.

## Requirement 7 — Honest empty states

1. WHERE no configuration exists, it SHALL say so and name `cyv init` rather than rendering an empty
   dashboard that looks like a clean bill of health.
2. WHERE analysis has never been run, the results view SHALL say so rather than showing zero.
3. Zero violations SHALL be visually distinguishable from no data. Conflating them is the same class
   of failure this project exists to prevent.

## Non-goals

Hosting. Multi-project aggregation. Authentication. Writing to source files from the browser. Any
model-backed feature.
