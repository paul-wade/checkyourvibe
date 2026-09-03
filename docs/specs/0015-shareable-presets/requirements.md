# 0015 — Shareable configuration presets: Requirements

**Status:** active
**Created:** 2026-08-28
**Depends on:** 0001, 0005, 0027

## Introduction

`checkyourvibe.json` today is written once per repository. A team running this tool across several
repositories re-derives the same `packs`, the same per-rule severities, the same `overrides` for "this
directory writes to stdout, that one is generated" — by hand, in each one, with no way to tell later
whether repository B's config is "the same posture as A, copied," "the same posture, edited," or an
independent decision that happens to look similar. `extends` in `checkyourvibe.json` lets a team publish
that posture once, as a **preset**, and name it from every repository that adopts it.

The roadmap (`docs/ROADMAP.md`, "0015 — Shareable configuration presets") ties this explicitly to 0005:
"a preset nobody can install is a file." T5011 and T5012 (`docs/specs/0005-distribution/tasks.md`) sharpen
that: a first release ships **core and the TypeScript analyzer only**, and a published core does not yet
reach a single agent adapter by default. A preset that names an analyzer, a pack, or an agent the adopter
has no way to obtain is not a convenience — it is a configuration that resolves to less than it claims,
in exactly the shape `configNotice` (`packages/core/src/report/config-notice.ts`) already exists to catch.
Every requirement below is written against that failure mode as much as against the feature request.

**Why this cannot just be 0027's packs.** 0027 turned a pack from a bare string into a declared,
versioned, single-analyzer object — and drew its own boundary against this spec explicitly (0027,
"Relationship to 0015"): a pack is authored by whoever writes the analyzer, scoped to that analyzer's own
rules, and has no field for an override, an exclude, or a second analyzer (0027 Requirement 5.5 bans
cross-analyzer packs outright; Requirement 1.2 restricts authorship to the analyzer, not user
configuration). A team publishing "how we check TypeScript and C# together, with these three rules raised
to error and this one directory excepted" needs something cross-analyzer, team-authored, and override-
capable — precisely what 0027 refused to let a pack become, on purpose. Packs and presets therefore sit at
different layers by design, not by oversight: this spec does not reopen anything 0027 decided, it fills the
slot 0027 left open. Where the two overlap, this document defers to 0027 and says so at each point.

## Verified state before writing this spec

- `CheckYourVibeConfig` (`packages/core/src/config/types.ts`) has no `extends` field today. Its shape is
  `$schema`, `packs`, `analyzers`, `agents`, `rules`, `overrides`, `suppressions`, `strict`, `exclude`.
- `AnalyzerConfig.package` (same file) is "opaque to the core: it is either an npm-style specifier or a
  path to the analyzer manifest, and it is resolved by the registry later." `packages/core/src/registry/
  load.ts` implements that resolution: `isPathLike` treats a leading `./`, `../`, `/`, an absolute path, or
  a `.json` suffix as a path; anything else is resolved as a bare specifier by `resolvePackageManifestPath`,
  which builds a synthetic `require` rooted at the repo and walks `node_modules` for
  `<specifier>/analyzer.manifest.json` (falling back to `<specifier>/package.json`'s directory). Nothing in
  this path touches the network — it only ever reads files already on disk after `npm install` completed.
- `resolveFromMergedRules` and `mergeRuleLayers` (`packages/core/src/config/resolve.ts`) already implement
  ordered, last-write-wins layering for `rules`, applied as: base `rules`, then each matching `overrides`
  entry in array order. `resolveRules` and `resolveRulesForFile` are the two call sites.
- `configNotice` (`packages/core/src/report/config-notice.ts`) is the project's existing, unconditional
  reporting surface for "what did configuration actually resolve to": rules enabled vs. available, unknown
  packs, analyzers contributing zero rules, and a hard line when the total is zero. `RunReport`
  (`packages/core/src/report/types.ts`) carries the structured fields it reads.
- 0008 Requirement 1.2 and 3.1 already establish this project's standard for a distributable-but-honest
  artifact: committed to the repository, reviewable in a diff, never a silent side effect. 0027 Requirement
  3 establishes the same standard for a *changing* one: a version integer, an acknowledgment record, and a
  report that does not stop until acknowledged. Both are precedent this spec reuses rather than re-derives.

## Requirement 1 — What a preset is and how it resolves

**User story:** As a team publishing a posture, I want `extends` to point at something concrete and
inert, so that running `cyv check` never depends on anything other than what is already on disk.

1. A preset SHALL be a static JSON document, matching a published `preset.schema.json` (a new sibling of
   `docs/protocol/config.schema.json`), validated at load time exactly as `checkyourvibe.json` is validated
   today. It SHALL NOT be a `.js`/`.ts`/`.mjs` module, and resolving it SHALL never `import()`, `require()`,
   or otherwise execute a file — only read it and `JSON.parse` it. This is Requirement 6 stated as a shape,
   not only as policy.
2. A preset SHALL be named in configuration the same way an analyzer already is: either a path (relative to
   the repository root, or absolute) to a preset JSON file, or a bare npm-style specifier resolved from
   `node_modules` by the same mechanism `resolvePackageManifestPath` already uses for
   `AnalyzerConfig.package` — a bare specifier resolves to `<specifier>/checkyourvibe-preset.json` (falling
   back through the package's own `package.json` location the same way an analyzer manifest does). Reusing
   this mechanism rather than inventing a second one means there is exactly one answer in this codebase to
   "how does a string in configuration become a file," and it means a preset inherits, for free, the
   property that already matters most here: resolution only ever walks `node_modules` and the filesystem,
   never the network.
3. `extends` SHALL be an array of such specifiers on `CheckYourVibeConfig`, resolved in order (Requirement
   2). An empty or absent `extends` SHALL behave exactly as today.
4. A preset specifier SHALL NOT be a URL of any scheme, and resolution SHALL NOT make a network request
   under any circumstance, including a first-time "fetch and cache" resolution. **A check that behaves
   differently because a server changed is not a check** — the entire value of `cyv check` is that the same
   configuration and the same source produce the same result on a disconnected laptop as they do in CI. A
   remotely-fetched preset would also reintroduce, one layer up, the exact cost model the roadmap's
   "Subscriptions, not metered APIs" section rules out for LLM calls: a `cyv check` whose availability,
   latency, or content depends on an external service the developer does not control and did not choose to
   depend on that day. Publishing a preset is therefore identical, mechanically, to publishing an analyzer
   (0005): put it in an npm package, or a path inside the repository, and let the adopter's own install step
   — one they already ran, for a reason they already had — be the only thing that ever reaches the network.
5. A preset specifier that fails to resolve (package not installed, path not found, file not valid JSON,
   file not valid against `preset.schema.json`) SHALL be a configuration error at load time, naming the
   specifier, the preset chain that referenced it (Requirement 2.4), and — mirroring the existing message in
   `registry/load.ts` — what to do about it ("install it, or use a path"). It SHALL NOT silently resolve to
   an empty layer; that is exactly the T7006 failure 0027 was written to close, recurring one layer up.

## Requirement 2 — Composition and precedence

**User story:** As someone reading a `checkyourvibe.json` with three `extends` entries, I want one rule I
can hold in my head for "what wins," not a case-by-case investigation.

1. **The rule:** *presets apply left to right in `extends`, the local file applies last, and for any given
   rule, pack, or override, whichever layer sets it last wins.* Nothing here lets an earlier layer reach
   back and change a later one, and nothing lets a preset ever win over the file that named it.
2. Concretely, this is `mergeRuleLayers`'s existing last-write-wins algorithm (`packages/core/src/config/
   resolve.ts`) with one more class of layer added ahead of the two it already has: each resolved preset's
   `rules`, in `extends` order, then each resolved preset's `overrides` in the same order, then the local
   file's own `rules`, then the local file's own `overrides` — the same layer ordering `resolveRulesForFile`
   already applies to `overrides` today, extended outward. `packs` combine as a plain union across every
   preset and the local file, with no precedence, matching 0027 Requirement 4.1's existing rule for multiple
   packs named directly in `config.packs` — this spec does not add a second composition rule where 0027
   already settled one.
3. A preset MAY itself declare `extends`, referencing further presets, resolved recursively before the
   referencing preset's own layer is applied. A cycle in this graph (a preset that transitively extends
   itself) SHALL be a configuration error at load time, naming the cycle.
4. Every requirement above lives in one place — the ordered `extends` array plus the local file — which is
   the property that makes this different from the mechanism 0020 rejected for per-package configuration.
   0020 Requirement 1.4 refused to let a package config disable a rule because two files that can each
   disable the same rule, potentially owned by different people, turn "why didn't this fire here" into a
   search across every package on the path to the root. `extends` does not reintroduce that: the full chain
   is declared in one file, in a fixed, visible order, and Requirement 4 makes the winning layer for any
   given rule a thing `cyv check` states outright rather than a thing a reader has to reconstruct. A preset
   *can* loosen a rule the way `overrides` already can (2.2) — the risk 0020 was guarding against was
   distributed, unauditable ownership, not loosening itself, and Requirement 4 is what keeps that risk from
   recurring here.
5. A pack or rule id a preset names SHALL still resolve against the *adopting* repository's own configured
   `analyzers` (Requirement 3.1 forbids a preset from declaring its own). WHEN a preset selects a pack or
   rule id that no analyzer configured by the adopter provides THEN configuration resolution SHALL fail
   exactly as 0027 Requirement 2.2 already fails for an unrecognized pack in `config.packs` — extended to
   name which preset introduced the reference, so the adopter is not left tracing an unfamiliar id back
   through a chain of extended presets by hand.

## Requirement 3 — A preset must not be able to hide things

**User story:** As someone adopting a preset I did not write, I want a hard guarantee that adopting it can
only change *what gets checked*, never *what gets reported once found* — because the second one is a hole
I would never think to look for.

0027's own framing of this boundary says a preset "can bundle anything a full configuration can express —
pack selections from one or several analyzers, individual rule overrides, per-path overrides, excludes,
suppression policy." That sentence was written to establish 0027's boundary against *this* spec, not to
settle this spec's own field list — this document is where that list is actually decided, field by field,
and it is narrower than 0027's shorthand suggests. Reconciling the two: 0027 is right that a preset can
express *most* of what a configuration can; this requirement is the enumerated exception.

1. **`packs` — allowed.** This is the feature's core purpose: selecting a posture.
2. **`rules` — allowed**, including disabling a rule the adopter's own analyzers would otherwise enable
   through a selected pack. Unlike a suppression, a disabled rule is repository-wide, uniform, and shows up
   directly in Requirement 4's "N of M rules enabled" accounting with the preset named as the reason — it
   cannot be adopted silently, only unnoticed if the adopter never looks at output the tool already prints
   on every run.
3. **`overrides` — allowed**, carrying the same required, non-empty `reason` `ConfigOverride` already
   requires (`packages/core/src/config/types.ts`). A path-scoped override is auditable the same way a
   rule-wide one is (Requirement 4), and a preset author has a legitimate reason to want one — "generated
   code" or "test files" are patterns that generalize across repositories in a way a specific violation
   never does.
4. **`suppressions` — forbidden.** A suppression targets one specific, already-found violation in one
   specific repository (0008 Requirement 3). A preset author cannot have found that violation in the
   adopter's repository — they were not looking at it — so a suppression shipped in a preset is either inert
   (matches nothing) or, worse, matches a violation the adopter's own code happens to share the shape of and
   silently defers it without the adopter ever choosing to. That is a third party deciding what gets hidden
   in a repository they do not own, which is precisely what this requirement exists to prevent.
5. **`exclude` — forbidden**, for the same reason 0020 Requirement 1.5 already forbids it in a per-package
   config: excluding a path is "equivalent in effect to disabling every rule for a path." A glob supplied by
   a preset author who has never seen the adopter's directory layout is either useless or dangerously broad
   — `**/generated/**` written for the author's repository can just as easily swallow a hand-written
   directory the adopter happens to name the same way, with no way for the adopter to know it happened short
   of noticing files that are never checked.
6. **A baseline — not applicable, by construction.** A baseline is not a `checkyourvibe.json` field at all
   (0008 Requirement 1): it is a separate file, recorded against a specific commit of a specific repository
   (0008 Requirement 1.5). A preset has no field to carry one, and even if it did, "the violations that were
   already present in the preset author's repository on some date" is a fact about the wrong codebase.
7. **`analyzers` — forbidden.** Symmetrically with 0027's own reasoning for why a pack cannot span analyzers
   (0027 Requirement 5.5), a preset SHALL NOT declare its own `analyzers` list. Allowing it would recreate
   T5011/T5012 one layer up: a preset naming, say, the C# analyzer would silently require a `.NET` toolchain
   the adopter may not have, and — because only core and the TypeScript analyzer ship as installable npm
   packages today (T5011) — naming almost any other analyzer in a published preset would be naming something
   most adopters have no supported way to obtain. A preset MAY only select packs and rules belonging to
   analyzers the adopter has already configured themselves (Requirement 2.5); it can shape an existing
   toolchain's posture, never conjure a new one.
8. **`agents` — forbidden.** Which agent integrations are enabled shapes what runs in the adopter's own
   editor or CI, not what their code is checked against; a preset dictating that reaches past "posture on
   code" into the adopter's own tooling environment, which this spec declines to let a preset touch.
9. **`strict` — forbidden.** Whether a non-fatal condition (a skipped file, a degraded run) fails a build is
   an operational decision about the adopter's own CI, not a statement about code quality — the same
   distinction Requirement 3.8 draws for `agents`, applied to build behavior instead of tooling.
10. `$schema` is meaningless inside a preset document and SHALL be rejected by `preset.schema.json`'s own
    `additionalProperties: false`, the same way it is a real field only at the top of `checkyourvibe.json`.

## Requirement 4 — Auditability

**User story:** As someone running `cyv check` in a repository that extends two presets, I want the same
run to tell me what the effective configuration is and which layer contributed each part of it — not a
separate command I have to remember to run before I trust the first one.

1. `RunReport` (`packages/core/src/report/types.ts`) SHALL gain the preset chain actually resolved
   (`presetsApplied: { id: string; source: string; version?: number }[]`, in resolution order including
   transitively extended presets) and, for every enabled rule and every active per-path override, which
   layer last set it (`local`, or a preset id). This is additive to the fields `configNotice` already reads
   (`rulesEnabled`, `rulesAvailable`, `unknownPacks`, `zeroContributionAnalyzers`) — it does not replace them.
2. `configNotice` (`packages/core/src/report/config-notice.ts`) SHALL be extended to print this, not
   superseded by a second, parallel reporting path. This project already has exactly one place a run states
   what its configuration resolved to; a preset chain is more configuration to state, not a reason to state
   it twice. Printed unconditionally on every text-output run, mirroring 0027 Requirement 2.1's reasoning —
   a team that has forgotten which preset disabled which rule is worse off than one that never adopted a
   preset, believing a clean run means something it does not.
3. Every count and attribution added by 4.1 SHALL appear in `--json` output as structured fields, mirroring
   0027 Requirement 2.5, so CI can gate on "this preset silently disabled a rule I expected" the same way it
   already gates on violation counts.
4. A rule or pack a preset resolves that the local file never mentions SHALL be attributable to the specific
   preset that contributed it, not merely to "a preset" — with two or more `extends` entries, "some preset
   did this" is not an answer a reviewer can act on.

## Requirement 5 — Versioning and drift

**User story:** As a team with `extends: ["@ourteam/posture"]` committed, I want to know the moment a new
release of that preset changes what it resolves to, the same guarantee 0027 already gives when a pack's
membership changes underneath a `packs` entry.

1. A preset document SHALL declare its own `version`: a positive integer its author increments whenever the
   preset's *resolved content* changes — any addition or removal across its `packs`, `rules`, or `overrides`
   (including a change inherited from a preset it itself extends). This mirrors 0027 Requirement 1.1 and 3.1
   exactly, on purpose, rather than introducing a different shape: 0027 already established that a
   containing package's own npm semver bumps for reasons unrelated to what the tool enables (a dependency
   patch, a typo fix), so a dedicated field is required there — the identical argument applies to a preset,
   which is just as often shipped inside an npm package with its own, differently-motivated version.
2. This is a **new instance of 0027's mechanism, applied to a new object, not a duplicate of it** — the two
   meet, and stay distinct, as follows: 0027 Requirement 3 detects drift in a *pack's* `members` between two
   analyzer releases; this requirement detects drift in a *preset's* own resolved content between two
   installs of that preset. A single `pnpm update` of a preset's package can trigger both at once — the
   preset's own `version` moved, and separately one of the packs it selects also moved — and both SHALL be
   reported distinctly, never collapsed into a single notice, so a reader can tell which thing actually
   changed.
3. The tool SHALL persist, per repository, the preset version last acknowledged for every preset currently
   named (directly or transitively) in `extends` — committed to the repository and reviewable in a diff, the
   same posture 0027 Requirement 3.2 already requires for acknowledged pack versions. This spec does not
   pick a file or location 0027 has not yet picked (0027's own "Open questions" leaves this open); wherever
   0027 lands its acknowledgment record, a preset's entries live there too, in the same shape, rather than in
   a second file this spec invents.
4. WHEN a named preset's live `version` differs from its acknowledged version THEN `cyv check` SHALL report
   it by id on every run until acknowledged, naming which packs and rules were added or removed between the
   two versions — computable directly, the same way 0027 Requirement 3.3 computes it for a pack, since both
   are static, resolved documents. Acknowledging SHALL be an explicit action, never a side effect of
   `cyv check` (0027 Requirement 3.4).
5. A preset named for the first time SHALL record its current version as acknowledged immediately, without a
   notice — there is nothing yet to have drifted from (0027 Requirement 3.5).

## Requirement 6 — Trust

**User story:** As someone about to add `extends` to my configuration, I want a guarantee that doing so
cannot run anything I did not already choose to run by installing the package.

1. Resolving a preset SHALL never execute code the preset supplies. This is a hard constraint, not a
   default posture that a future capability flag relaxes: there is no `session`-style opt-in for presets the
   way the analyzer protocol reserves one for a warm process (0013). A preset is data, consumed by
   `JSON.parse` and schema validation, in every version of this feature that will ever exist.
2. The only code that ever runs on the way to resolving `extends` is `cyv`'s own, already-audited loader and
   whatever ran during `npm install` of the package that carries the preset — a risk that already exists for
   any npm dependency and is unchanged by this feature. This spec adds no new install-time trust surface; it
   only refuses to add a second, check-time one on top of it.
3. A preset SHALL NOT be able to name an `exec` command, a script, a path to an executable, or anything else
   the core would later invoke. `preset.schema.json` enforces this the same way `additionalProperties: false`
   already keeps `checkyourvibe.json` from carrying a field the loader was not built to expect.

## Non-goals

A preset registry, marketplace, or `cyv init` discovery flow for finding published presets — worth
revisiting once at least one team has published one by hand. Automatic or fuzzy conflict resolution beyond
Requirement 2's last-write-wins ordering — the ordering is the feature; a smarter merge would make the
one-sentence rule untrue. An "important" or force-override marker that lets a preset resist being overridden
by the local file — Requirement 2.1's guarantee that local always wins is unconditional on purpose. Signing
or provenance verification of a published preset beyond what npm's own supply chain already provides — a
real question, deliberately left to whatever project-wide answer 0005 eventually gives every published
package, not reinvented here for one artifact type. Cross-repository preset dependency graphs beyond simple
preset-of-presets (Requirement 2.3) — a cycle is rejected, but no attempt is made to detect a *diamond*
(two extended presets sharing a common ancestor) as anything other than ordinary last-write-wins layering.
Automatically enforcing the quality of a preset's rationale, the way 0027 Requirement 5.2 requires but does
not police an `intent` string's honesty — this spec does not even require a preset to carry prose, since a
preset composes existing rules and packs that already carry their own `why`.

## Open questions

- **Where does the preset-version acknowledgment record live?** Requirement 5.3 defers entirely to
  wherever 0027 resolves its own open question (a new file alongside the baseline, or a new section of
  `checkyourvibe.json`). This spec should not answer a question 0027 has explicitly left open — but it also
  cannot be built before that question is, since the two mechanisms are meant to share one record.
- **Should a preset be allowed to require a minimum version of an analyzer's pack**, e.g. "this posture
  assumes `strict-boundaries` version 2 or later, where `no-unsafe-index-access` joined it"? Nothing above
  adds this; without it, a preset silently gets a weaker pack until the adopter separately acknowledges the
  pack's own drift (0027 Requirement 3), and there is no way for the preset author to have signaled they
  were relying on the newer set. Left open because it would mean a preset consulting the *acknowledged* pack
  version record (Requirement 5.3) at resolution time, which is machinery this spec has not designed.
- **Does `cyv doctor` surface preset-version drift**, consistent with 0027's identical open question about
  packs and with `doctor` already being the home for the absolute-path drift 0005 assigns it — or does
  `cyv check`'s `configNotice` (Requirement 4) own this alone? Left open here, deliberately in step with
  0027 rather than answered independently.
- **Should Requirement 3's field list be revisited once a real preset has been published and used**, the
  same way 0009's rule choices were validated only by being pointed at real code? Nothing here has been
  tested against an actual team trying to publish an actual posture; the list is argued from the same
  hiding-things principle this project already applies everywhere else, not from field experience.
- **Should an unresolvable preset (Requirement 1.5) degrade the same way a missing `.NET` toolchain does for
  the C# analyzer** — reported clearly, `check` continues without it — **or fail closed**, the way an
  unknown pack id already does? This spec has assumed fail-closed throughout, on the reasoning that a
  configuration silently missing an entire preset is a worse lie than a run that refuses to start, but the
  question was not stress-tested against T5005's "toolchain missing" precedent, which chose the opposite
  answer for a comparable failure. Recorded on review rather than by the author.
