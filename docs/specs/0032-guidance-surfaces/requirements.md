# 0032 — Guidance surfaces: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001. Builds on 0006 (the dashboard already exists) and the existing `cyv explain`
command. Supersedes the roadmap's separate 0032 ("a public documentation site") and 0034
(`cyv explain <rule>`) entries — see below.

## Introduction

The roadmap lists these as two items: a documentation site (0032) and `cyv explain` (0034). They are
one problem wearing two roadmap numbers.

A rule's guidance — `summary`, `why`, `allowedFixes`, `notFixes`, `examples`, `evidence` — is written
once, into `RuleManifest`. It is already read by two surfaces that exist today: `cyv explain`
(`packages/core/src/cli/explain.ts`) prints it to a terminal, and `cyv dashboard`
(`packages/core/src/dashboard/render.ts`) renders it, plus the `notFixes` graph, as a web page. A
published site would be a third reader of the same data. The question this spec answers is not "how do
we build a site" or "how do we finish a CLI command" — both of those are almost done — it is "what does
every reader of a manifest owe the reader," so that adding a fourth surface later does not mean writing
a fourth prose description of what `notFixes` means.

Treating them separately invites exactly the failure this project exists to catch elsewhere: two specs,
each independently deciding what a `notFix` looks like when rendered, drift from each other the same way
two hand-written renderers of the same field already have (Requirement 1 documents a live instance of
this in the current code). One spec, one contract, three surfaces obeying it — `cyv explain`, the
dashboard, and the site — is the only version of this that keeps the promise the manifest makes: written
once, reviewed, and true everywhere it is read.

This spec does not restate 0006. The dashboard's history, trend, and never-fired views are run-scoped
and stay 0006's concern. What this spec adds to the dashboard is narrow: bring its rule-detail rendering
under the same contract as every other surface, and make its graph as navigable as this spec requires.

## Requirement 1 — One source, many surfaces

**User story:** As a reader of a rule's guidance, I want the same answer regardless of whether I typed
`cyv explain no-any`, opened the dashboard, or found the rule on a published site — because a difference
between them is not a style choice, it is a guidance surface lying to whichever reader hit the thinner
one.

1. Every surface SHALL render a rule's guidance from `RuleManifest` fields only. No surface's source
   SHALL hardcode, restate, or paraphrase a rule's `summary`, `why`, `allowedFixes`, `notFixes`, or
   `examples` in its own words — every string a reader sees SHALL trace back to the manifest field it
   came from.
2. A field on `RuleGuidance` or `RuleManifest` SHALL be reachable from every surface once it exists, not
   opt-in per surface. `evidence` (added by spec 0009) is the concrete counter-example today: the
   dashboard shows it as a pill and in the search index; `cyv explain`'s human-readable output
   (`guidance/templates.ts` → `guidanceSections`) never mentions it. Same manifest, same field, one
   surface silent about it.
3. The failure mode this exists to prevent: a rule's `notFixes` entry is visible in one surface and
   absent from another. A reader who checks only the thinner surface learns nothing about a documented
   dead end and reaches for it believing it is clean — which is worse than no guidance, because it looks
   authoritative.
4. Rendering logic SHALL be shared, not merely field-complete per surface. Today it is not: `guidance/
   templates.ts` (`guidanceSections`) is the one function `cyv explain`'s terminal and markdown renderers
   both call, and `packages/core/src/dashboard/render.ts`'s `renderRule` independently re-derives the same
   sections with its own HTML and its own `notFix` phrasing (`would trip <code>${n.rule}</code>` there,
   `(violates ${notFix.rule})` in `guidanceSections`). Two implementations of "how to describe a
   `notFix`" already say it two different ways — the drift Requirement 1.1 forbids is not a hypothetical,
   it is these two strings. Any renderer added by this spec (site generation, `cyv explain`'s missing
   fields) SHALL consume a single shared section-building function; a surface SHALL NOT introduce a
   second one.

## Requirement 2 — What `cyv explain` is missing today

**What it does today**, read from `packages/core/src/cli/explain.ts`, `guidance/render.ts`, and
`guidance/templates.ts`:

- Called with no rule id, it lists the *enabled* rules (via `resolveRules`) as `id — summary`, one per
  line, sorted by id; `--json` prints the same set as an array of full `RuleManifest` objects. It works
  with no arguments — this part of the roadmap's framing is already met.
- Called with a rule id, it looks it up in the *full catalog* (`allRules(manifests)`, every configured
  analyzer's rules, regardless of enablement) and prints either `renderTerminal(rule)` or the raw JSON
  manifest. An unknown id prints an error plus the full catalog's ids.
- `renderTerminal` (via `guidanceSections`, shared with the markdown renderer) prints: the rule id,
  `Summary`, `Why`, `Allowed fixes`, `Not fixes` (each entry's `pattern — because`, plus
  `(violates <rule>)` when `notFix.rule` is set — this is already present, correctly), and the `bad`/
  `good` `Example` pair.
- `--json` output is the raw manifest object, so it already carries every field — `category`, `pack`,
  `scope`, `severity`, `optionsSchema`, `evidence` included. The gap below is specific to the
  human-readable path.

**What is missing**, stated as requirements:

1. The human-readable output SHALL show `evidence` (or "unspecified" when omitted, matching the
   dashboard's own rule for the omitted case), `pack` (or its absence), `category`, `severity`, `scope`,
   and `optionsSchema` with defaults WHERE the rule declares one. None of these appear in
   `guidanceSections` today; all of them are already computed correctly for the dashboard's rule cards.
2. It SHALL show which analyzer owns the rule. This is not currently possible without a code change:
   `catalog = allRules(manifests)` (registry/load.ts) flattens the per-analyzer structure away before
   `explain.ts` ever sees it, discarding the same id-to-analyzer association that `cyv dashboard` builds
   explicitly (`packages/core/src/cli/dashboard.ts`'s `ruleAnalyzers` map) for exactly this reason.
   `cyv explain` SHALL build or receive the same mapping rather than losing it a second time.
3. It SHALL be able to explain a rule that is in the catalog but not enabled by the current
   configuration, AND it SHALL say so explicitly. Today it silently does the first half: a direct
   `cyv explain <id>` looks the rule up in the full catalog and prints its guidance with no indication of
   whether that rule is active in this repository's config. A reader cannot tell, from the output alone,
   whether the guidance they are reading describes something currently enforced here.
4. The no-argument listing SHALL distinguish enabled rules from the rest of the catalog rather than
   showing only the enabled set. Today a rule that exists but is not enabled is invisible to someone who
   does not already know its id — they cannot discover it through `cyv explain` at all, only stumble into
   it by guessing an id correctly. WHERE the full catalog is large, the listing SHALL still make clear
   which subset is active without requiring a second command.
5. Inbound edges SHALL be discoverable from `cyv explain <id>`. Today it prints only the rule's own
   `notFixes` (outbound edges); it never states which *other* rules name this one as their `notFixes`
   target, even though it already loads the full catalog needed to compute that in the same call. A
   terminal cannot draw a graph, but it can enumerate one, and enumerating only half of it understates
   how constrained a rule actually is.

## Requirement 3 — The published site

**User story:** As someone deciding whether to adopt this tool, I want to read every rule's guidance in
a browser without cloning the repository or installing a language toolchain — the same promise the
dashboard already makes to someone who has cloned it.

1. The site SHALL be generated by a build step that reads manifests from disk exactly as
   `loadAnalyzerManifest` does today — JSON in, validated, never imported or executed. Generation SHALL
   NOT run an analyzer's `exec` entry, spawn a subprocess, or require network access.
2. Generated pages SHALL be plain static HTML, readable with JavaScript disabled. No client-side
   framework or further build step SHALL be required to view a page — the same "readable without
   installing a compiler" property that makes manifests cheap to browse in the first place is what makes
   a site generated from them cheap to host and to read.
3. It SHALL contain, per rule: id, category, pack, owning analyzer, severity, scope, evidence, summary,
   why, allowed fixes, `notFixes` (each rendered as a real hyperlink to its target rule's page when
   `notFix.rule` is set, and as a plainly marked terminal dead end when it is not — see Requirement 4),
   both examples, `optionsSchema` with defaults where declared, and the manifest/protocol version the
   page was generated from (Requirement 6). It SHALL also contain a browsable index equivalent to the
   dashboard's rule browser (filterable by analyzer, pack, category, severity) and one interlock graph
   per analyzer/pack.
4. It SHALL NOT contain: any call to a model, LLM, or network-dependent summarization service; any
   content computed per visitor or per request; a live "run this analyzer" playground; violation counts,
   trend data, or run history from any specific repository — those describe one adopter's project at one
   moment and have no place in guidance that is supposed to be the same for every reader; or a rule's
   guidance restated in different words from what its manifest fields already say.
5. It SHALL be servable as static files with no server-side runtime — consistent with the project's
   zero-dependency, zero-cost posture, and distinct from the dashboard, which is deliberately a local
   server because its results view needs to re-read a live history file per request.

## Requirement 4 — The interlock has to survive the transport

**User story:** As a developer reading guidance on whichever surface I happen to have open, I want to
see how a rule is constrained by the rest of its pack, not just the rule in isolation — because the
`notFixes` graph, not the rule list, is what tells me I cannot escape one violation by triggering another.

1. No surface SHALL drop a rule's `notFixes`. Terminal, dashboard, and site SHALL each render every
   entry, including ones with no `rule` field (Requirement 4.3).
2. Minimum per surface:
   - **Terminal** (`cyv explain`): each outbound `notFix` as `pattern — because`, naming its target rule
     when one exists (already true); PLUS, per Requirement 2.5, each inbound edge — every other rule
     whose `notFixes` names this one — as an equivalent line. A terminal cannot draw a graph, but it can
     print both directions of one.
   - **Dashboard and site**: the graph SHALL be genuinely navigable, not merely visible on the same page.
     This is not fully true of the dashboard today: `renderGraph`'s SVG nodes carry only a `<title>`
     hover tooltip, and `renderRule`'s rule cards have no `id` attribute for a node to link to — so even
     within one HTML page, clicking a graph node cannot jump to that rule's detail. Both the dashboard
     and the site SHALL fix this: a graph node SHALL be a real link (an in-page anchor on the dashboard,
     a page link on the site) to the rule it represents.
3. A `notFix` with no `rule` field SHALL be shown, on every surface, as a distinct kind of entry — a
   dead end that is a bad idea rather than another rule's violation — never silently omitted and never
   rendered identically to an edge that names a rule. The dashboard already distinguishes these
   (`danglingPatterns` vs `edges` in `dashboard/model.ts`); the terminal and the site SHALL match it.
4. The site's per-analyzer/per-pack graph SHALL be built from the same grouping logic the dashboard
   already uses (`buildInterlockGraph` in `dashboard/model.ts`) rather than a second implementation of
   "which edges belong in which graph" — this is Requirement 1.4 applied specifically to the graph.

## Requirement 5 — Zero cost

1. No surface governed by this spec — `cyv explain`, the dashboard, or the site, including anything
   added to any of them by this spec — SHALL call a model, LLM, or any network-dependent generation or
   summarization service to produce, alter, or supplement a rule's guidance. The guidance is text written
   once into a manifest, reviewed once, and free to read any number of times; generating or rephrasing it
   per reader would both cost money on every read and risk the explanation saying something the rule
   itself does not.
2. The site's build tooling SHALL NOT require a network call, an API key, or a metered service to run.
   Building the site is running `loadAnalyzerManifest` over files already on disk and writing HTML; it
   SHALL stay that cheap.
3. This is a requirement, not an aside, per the roadmap's "Subscriptions, not metered APIs": no part of
   this spec may be satisfied by having an agent read a manifest and write nicer prose per rule, per
   build, or per visitor. That reintroduces the exact per-token cost and drift risk — a rewritten
   explanation silently disagreeing with the rule it explains — that writing guidance once into the
   manifest exists to avoid.

## Requirement 6 — Versioning and drift

**User story:** As a reader of a published site, I want to know whether the page in front of me reflects
the current rule or a build from three releases ago — because a site, unlike a locally-run `cyv explain`,
has no way to know it has gone stale on its own.

1. Every rendered rule — on the site, and in `cyv explain --json` — SHALL state the package version and
   protocol version (`PROTOCOL_VERSION`) it was generated from or read from.
2. Site generation SHALL record, at build time, a fingerprint of the manifest set it was built from
   (something stronger than `PROTOCOL_VERSION` alone, which is a single integer shared across every
   manifest and bumps rarely — it cannot by itself distinguish "built from today's manifests" from "built
   six rule changes ago").
3. A generated site SHALL carry a visible generation timestamp, so "when was this built" is a fact on
   the page rather than something a reader has to infer.
4. It SHALL be possible to detect that a published site is stale relative to the manifests it claims to
   describe — comparing the recorded fingerprint (Requirement 6.2) against a fresh read of the same
   manifests SHALL be sufficient to answer "does this site need to be regenerated," even though this spec
   does not mandate which command performs that check (see Open questions).

## Non-goals

An interactive "try it" playground that runs an analyzer against pasted code. Comments or community
content on the site. Choice of hosting or deployment infrastructure. Authentication. Aggregating guidance
from multiple repositories' configurations into one site. Any natural-language summary of a rule beyond
its manifest's own `summary`/`why` text. Editing a manifest from a browser. Translation or localization.
A changelog or RSS feed. Any model-backed feature anywhere in this spec (Requirement 5 makes this a hard
constraint, not a scope note).

## Open questions

1. **Inbound edges in `cyv explain`.** Requirement 2.5 asks for them because the full catalog is already
   loaded for every invocation, so the cost is one loop, not a new load. Worth confirming that stays true
   once analyzer counts grow — if catalog loading ever becomes the expensive part of `cyv explain`,
   computing inbound edges for a single rule may want its own, narrower pass.
2. **Where the site lives.** This spec does not decide whether generation is a script inside this
   repository producing output under `docs/` (or a build artifact directory), a separate package, or
   something `cyv` itself gains a subcommand for (`cyv site build`, mirroring `cyv dashboard`). That
   decision belongs to the task that implements this spec, not to the requirements.
3. **Scope of "the site": this repository's posture, or every rule this project has ever shipped.** A
   site could describe only the rules this repository's own `checkyourvibe.json` configures (mirroring
   what the dashboard shows), or it could be a standing catalog of every rule across every analyzer this
   project ships, independent of any one adopter's configuration. These are different artifacts with
   different audiences, and the answer changes which manifests generation reads. This spec assumes the
   latter — a project-wide catalog, since that is what "a public documentation site" implies — but the
   task that implements it should say so explicitly rather than let the choice fall out of whichever
   manifests happened to be on disk at build time.
4. **What fingerprint Requirement 6.2 actually is.** A hash of the concatenated rule manifests is the
   obvious candidate and is deliberately not specified further here, so the implementing task can weigh
   it against alternatives (a per-manifest hash list, which localizes which rule went stale, versus one
   aggregate hash, which is simpler to display) without this spec having pre-decided.
5. **Whether staleness-checking is a `cyv doctor` responsibility or its own command.** `cyv doctor`
   already detects drift for generated agent glue (spec 0005); a published site going stale is the same
   shape of problem — a generated artifact silently disagreeing with its source — and may belong there
   rather than as a new command.
