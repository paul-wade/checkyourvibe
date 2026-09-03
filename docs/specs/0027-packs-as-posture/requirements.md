# 0027 — Packs as a published posture: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0007

## Introduction

`RuleManifest.pack` (`packages/core/src/protocol/rule-manifest.ts`) is a bare optional string. Its own
doc comment already carries the warning this spec exists to act on: pack membership "has to be
discoverable from the static manifest — otherwise `packs: ["core-ts"]` expands to nothing and the
config silently enables no rules at all." `packages/core/src/registry/load.ts` repeats the same warning
at the point where the field is parsed, because the tool has already lost this field once, silently,
before it was defended by a whitelist entry.

0007's `tasks.md` records the incident this spec is named for. T7001 moved three rules —
`no-json-parse-cast`, `no-unsafe-array-narrowing`, `no-unsafe-index-access` — into a new
`strict-boundaries` pack. `checkyourvibe.json` still read `packs: ["core-ts", "core-cs"]`. All three
rules went dark in this repository. Nothing reported it; a human reviewing the diff caught it, which is
recorded in T7006 as the specific failure this spec must close. T7004, in the same file, records the
opposite risk of overcorrecting: a rule shipped with an unproven premise fired 14 times against this
repository and was wrong 14 times, and disabling it rather than deleting it was the honest response. A
pack is the same trade at a larger grain — activating or deactivating several rules at once — so it
inherits both risks: it must never go dark silently, and it must never become a name a team adopts
without knowing what it turns on.

A bare string cannot carry a stated reason, cannot be looked up by a reader without grepping every rule
in an analyzer, and cannot be versioned, so there is nothing for configuration to check itself against
when the set changes. This spec turns a pack into a declared object with those three things — and,
mainly, closes the reporting gap that let T7006 happen without a report.

## Verified state before writing this spec

- `RuleManifest.pack?: string` is the entire pack model today (`packages/core/src/protocol/rule-manifest.ts`).
- `resolveFromMergedRules` (`packages/core/src/config/resolve.ts`) computes `rulePacks(rule)` — at most
  one entry — and activates a rule when that entry is in `new Set(config.packs)`. A `config.packs` entry
  that matches no rule's `pack` contributes zero rules and raises no error; this is exactly the state
  T7006 was caught in.
- `resolveFromMergedRules` already throws `ConfigError('UNKNOWN_RULE', ...)` for a rule id named in
  `config.rules` that no analyzer provides. No equivalent check exists for a pack id named in
  `config.packs`.
- `packages/core/src/registry/load.ts`'s `toRule` copies `pack` through an explicit whitelist, with a
  comment on the copy itself naming the earlier loss this spec is written against.
- `checkyourvibe.json` in this repository lists `"packs": ["core-ts", "strict-boundaries", "core-cs"]`
  today — the post-incident, corrected state. Nothing in the loader would have refused the pre-incident
  state; the fix was a human noticing a diff.
- `docs/protocol/analyzer-manifest.schema.json` and `docs/protocol/rule-manifest.schema.json` define the
  wire shape a pack would need to extend; `docs/protocol/config.schema.json` defines `packs` as a bare
  string array.

## Requirement 1 — A pack is a declared thing, not an inferred set

**User story:** As someone reading an analyzer's manifest, I want a pack's membership and its reason to
exist to be things I can read in one place, not a fact I have to reconstruct by scanning every rule for a
matching tag.

1. An analyzer manifest SHALL be able to declare a top-level `packs` array, sibling to `rules`. Each
   entry SHALL carry an `id`, a non-empty prose `intent` (Requirement 5), an explicit `members: string[]`
   of rule ids, and a `version` (Requirement 3).
2. A pack SHALL be declared by the analyzer, in its manifest, and not by user configuration. Two
   consequences follow and are both intended: `checkyourvibe.json`'s `packs: string[]` continues to
   *select* packs by id, and it SHALL NOT be able to define, rename, or redescribe one; and a pack's
   `intent` and `members` mean the same thing in every repository that adopts it, which is the whole
   point of it being a thing a team can "adopt, describe, and disagree with" rather than reinterpret.
   Declaring it in configuration instead would let two adopters disagree about what `strict-boundaries`
   *is* while agreeing they both enabled it — silent drift of exactly the kind this spec exists to
   remove, just moved one layer up.
3. A pack's manifest entry SHALL be validated the same way `docs/protocol/rule-manifest.schema.json`
   validates a rule today: statically, from the JSON alone, without executing the analyzer. This is the
   same requirement rule manifests already meet and for the same reason — a reader (and `cyv doctor`)
   needs to answer "what does this pack turn on" without running anything.
4. Every id in a pack's `members` SHALL name a rule present in that same manifest's `rules` array. A
   `members` entry naming a rule the manifest does not otherwise declare SHALL be a manifest validation
   error, following the same whitelist discipline the comment in `registry/load.ts` already documents.
5. A rule id SHALL appear in at most one pack's `members` list within a manifest. Appearing in two SHALL
   be a manifest validation error, not a warning — this is the load-time enforcement of Requirement 4's
   single-pack decision, not a separate feature.
6. `RuleManifest.pack` continues to exist as a single-string, loader-populated field — filled in from
   whichever pack lists the rule as a member — for any consumer that only needs one rule's pack without
   reading the whole `packs` array (the dashboard, an error message, `cyv explain <rule>`). Analyzer
   authors SHALL author membership once, in `packs[].members`; they SHALL NOT also set `pack` by hand on
   the rule, which would recreate the two-sources-of-truth problem this requirement exists to avoid.
7. A rule that belongs to no pack remains valid and enable-only-by-name, unchanged from today's behavior
   documented in `rule-manifest.ts`.
8. The TypeScript, C#, and Python analyzers' manifests SHALL be migrated to declare `packs[].members`
   explicitly as part of implementing this spec, since all three currently set `pack` per rule.

## Requirement 2 — Silence is the defect this spec exists to remove

**User story:** As someone whose configuration selects packs, I want to be told when that selection
expands to fewer rules than I expect, using the same channel that already tells me my baseline has
4,000 deferred violations — not left to notice a rule went missing in a code review.

1. `cyv check` SHALL report, on every text-output run, how many rules its configuration expanded to. This
   is the same reporting posture as `baselineNotice` in `packages/core/src/cli/check.ts`: printed
   unconditionally, not behind a flag, because a team that has forgotten its configuration expands to
   almost nothing is worse off than one that never adopted the tool, believing a clean run means
   something it does not.
2. WHEN `config.packs` names an id no loaded analyzer manifest declares THEN resolving the configuration
   SHALL fail with a configuration error naming every unrecognized pack id. This extends the existing
   `UNKNOWN_RULE` precedent in `resolveFromMergedRules` to pack ids: a renamed or removed pack is
   unambiguous drift, the same class of error an unknown rule id already is, and SHALL fail closed rather
   than silently activate zero rules.
3. WHEN an enabled analyzer contributes rules that belong to at least one pack, but none of the packs
   containing them are named in `config.packs` and none of those rules are enabled individually in
   `config.rules`, THEN `cyv check` SHALL report that analyzer by id as contributing zero active rules.
   This is the exact shape of the T7006 incident, generalized: an analyzer present in configuration whose
   rules are, in effect, invisible.
4. Requirement 2.3's report SHALL be advisory, not fatal — a team may deliberately configure an analyzer
   only for a handful of individually-named rules, which is legitimate. It SHALL NEVER be silent: from
   the outside, a deliberate zero and an accidental zero are indistinguishable unless the tool says which
   one this is.
5. Every count and name in this requirement SHALL appear in `--json` output as structured fields, not
   only in the human-readable notice, so CI can gate on them the way it gates on violation counts today.
6. A run that resolves to zero active rules across every configured analyzer SHALL fail loudly (a
   distinct non-zero exit condition) even when zero violations were found. A run that found nothing to
   check and a run that checked nothing SHALL never render the same.

## Requirement 3 — Migration when a rule changes pack

**User story:** As a user with `packs: ["core-ts"]` already committed, I want to know the moment a new
release of an analyzer moves a rule into or out of that pack, so my enabled rule set never changes
under me without my seeing it — the same guarantee `cyv upgrade` already gives when a rule's guidance
text changes.

A rule moving pack is a silent enable for every user who has the destination pack configured and a
silent disable for every user who has the source pack configured (or neither, if the rule leaves every
configured pack) — and it happens on nothing more than a `pnpm update` of an analyzer package. The tool
owes those users a version to compare against, a place that comparison is recorded, and a report that
does not stop appearing until someone has looked at it. This is one mechanism, not a choice among three:

1. A pack's `version` (Requirement 1.1) SHALL be a positive integer that its author increments whenever
   `members` changes, by addition, removal, or both.
2. The tool SHALL persist, per repository, the pack version last acknowledged for every pack currently
   named in `config.packs` — committed to the repository and reviewable in a diff, the same posture
   `cyv baseline` already requires of the baseline file (0008 Requirement 1.2), and for the same reason: an
   acknowledgment that lives on one machine cannot gate anything.
3. WHEN a configured pack's live version (read from the currently loaded analyzer manifest) differs from
   its acknowledged version THEN `cyv check` SHALL report the pack by name on every run until it is
   acknowledged, and SHALL name exactly which rule ids were added and which were removed between the two
   versions — computable directly, since both `members` lists are static.
4. Acknowledging a new pack version SHALL be an explicit action, never a side effect of `cyv check`,
   mirroring `cyv baseline`'s explicit regeneration (0008 Requirement 1.6). Running `cyv check` repeatedly
   SHALL NOT make the notice stop appearing on its own.
5. A pack named in `config.packs` for the first time SHALL record its current version as acknowledged
   immediately, without a notice — there is nothing yet to have drifted from.

## Requirement 4 — Composition

**User story:** As a team choosing a posture, I want to enable more than one pack without wondering
whether the tool silently reconciled a disagreement between them on my behalf.

1. Multiple packs named in `config.packs` SHALL combine as a plain union of rule ids — no precedence, no
   merge logic beyond activation. This is `resolveFromMergedRules`'s existing behavior, and this spec
   does not change it.
2. A pack SHALL NOT declare that it extends, includes, or overrides another pack. Composition happens
   once, in `checkyourvibe.json`'s own `packs` array. A second composition mechanism on the pack object
   itself would let the same posture be assembled two different ways with no way to tell, from the
   result, which one produced it — and simplicity here is worth defending, since a pack-inheritance
   graph, once adopted by real configurations, is expensive to unwind later.
3. Two rules from two different enabled packs recommending contradictory remediations is a rule-authoring
   defect, not a pack-composition defect, and this spec does not add machinery to detect it. It is caught
   — or not — by the `notFixes` interlock validation that already runs across every active rule
   regardless of which pack activated it (0007's founding requirement for the pack concept). Enabling two
   packs at once cannot introduce a contradiction that correct, individually-valid rules did not already
   contain; if it does, the rules are wrong, not the packs.
4. A rule SHALL continue to declare at most one pack, exactly as T7001 decided when `strict-boundaries`
   was created and multi-pack membership was "considered and rejected as a way of making the choice mean
   nothing." Requirement 1.5 makes that decision a load-time invariant instead of a convention. Nothing
   in this spec's motivating incident argues for revisiting it — the incident was caused by configuration
   not tracking a rule's one pack, not by a rule needing two.

## Requirement 5 — What a pack must not become

**User story:** As a developer asked to turn on "strict mode," I want to know what it actually turns on
before I turn it on — not after, in a diff someone else has to catch.

1. A pack's `intent` SHALL state, in terms specific to what its member rules actually check, why they
   belong together. A name or a claim to rigor standing in for a description — "strict", "recommended",
   "best practice" — SHALL NOT satisfy this requirement. "Rules governing data crossing into the program
   from outside it" is the expected shape; "makes your code strict" is not.
2. `intent` SHALL be required and non-empty for every pack a manifest declares, validated at load time
   the same way a rule missing `why` already fails `toRule` in `packages/core/src/registry/load.ts`.
3. Wherever a pack's id is shown to someone making an adoption decision — `cyv init` prompts, `cyv
   check`'s summary (Requirement 2.1), the dashboard, a future `cyv explain <pack>` — its `intent` text
   SHALL be shown alongside the id, not merely linked or left to separate documentation. A pack name a
   team can adopt without the tool ever showing them what it turns on is precisely the marketing-surface
   failure this requirement exists to prevent, and it is the same failure this project's guidance model
   already refuses at the rule level: no rule ships without `why`, `allowedFixes`, and `notFixes`
   attached to the finding itself rather than filed elsewhere.
4. Membership in a pack SHALL NOT relax a rule's own guidance requirements. Every rule in a pack still
   carries its full `RuleGuidance` — `summary`, `why`, `allowedFixes`, `notFixes`, `examples` — validated
   per rule exactly as today. A pack's `intent` is guidance about the grouping; it is never a substitute
   for the guidance already required on the rules inside it.
5. A pack's `members` SHALL be drawn from a single analyzer manifest's own `rules` array (Requirement
   1.4). A pack SHALL NOT span multiple analyzers. A cross-language "strict" bundle assembled to sound
   comprehensive is exactly the posture-by-reputation this requirement exists to prevent; a team wanting
   one composes it themselves in `checkyourvibe.json`, in the open, where the composition is reviewable
   (Requirement 4.2).

## Relationship to 0015 (shareable presets) and 0005 (distribution)

A pack and a preset sit at different layers and are owned by different people. A pack is authored by
whoever writes the analyzer, lives in that analyzer's manifest, is scoped to that analyzer's own rules,
and is versioned against that analyzer's release history (Requirements 1 and 3). A preset, as 0015
describes it, is authored by any team, lives in `checkyourvibe.json` via `extends`, and can bundle
anything a full configuration can express — pack selections from one or several analyzers, individual
rule overrides, per-path overrides, excludes, suppression policy. A preset can *select* packs; a pack can
never become a preset, because a pack has no field for an override, an exclude, or an opinion about a
second analyzer.

The boundary this draws: 0027 owns whether a rule grouping is honest, stable, and versioned. 0015 owns
whether a team can publish and distribute a specific combination — of packs and everything else — to
other teams. Publishing a *pack* to other teams happens by publishing the *analyzer* that declares it
(0005); publishing a *combination* of packs, overrides, and excludes happens through 0015's `extends`.
Neither spec should grow an `extends`-shaped mechanism to solve the other's problem: this spec explicitly
declines pack-level extension (Requirement 4.2) so that composition has exactly one place to happen, and
0015 is where it belongs.

0005 is the reason a pack's manifest has to stay static and self-contained: a pack shipped inside a
published, installed analyzer package must be readable and validatable without the installing repository
running anything, the same requirement 0005 Requirement 6 already places on rule guidance when `cyv
upgrade` re-resolves a changed manifest. Requirement 3's version-drift detection is the same mechanism
`cyv upgrade` needs generally when an analyzer's rules or guidance change between releases; this spec
does not duplicate that machinery, it gives `cyv upgrade` a pack-shaped fact to act on.

## Non-goals

Detecting or resolving semantic conflicts between two enabled packs' guidance (Requirement 4.3) — left to
the existing `notFixes` interlock validation. A pack `extends` or inheritance mechanism (Requirement
4.2). Cross-analyzer packs (Requirement 5.5). Publishing or distributing a specific combination of packs
and overrides to other teams — that is 0015's problem. Retroactively assigning every currently unpacked
rule to a pack; an unpacked rule remains enable-only-by-name. Automatically enforcing the *quality* of a
pack's `intent` prose beyond non-emptiness — a reviewer, not the loader, judges whether the reasoning is
honest. Any dashboard or CLI-output redesign beyond requiring that `intent` text be present wherever a
pack name is shown (Requirement 5.3) — the layout is 0006/0031's concern. Deciding the exact on-disk
format or location of the pack-version acknowledgment record (Requirement 3.2) — left to implementation,
the same way 0008 leaves the baseline file's exact format to its own tasks.

## Open questions

- **Should pack membership move from the rule to the pack at all?** This spec makes `packs[].members`
  the authored source of truth and turns `RuleManifest.pack` into a loader-derived read-only field.
  That inverts the existing model, changes the rule-manifest schema, and touches every analyzer
  manifest — a large surface for a problem whose observed symptom was a single silent disable.
  The cheaper alternative is to keep `pack` authored on the rule and add `packs[]` as declared
  metadata: a pack gets an id, an intent and a version, and its membership is *derived* from the
  rules that name it. That gives Requirement 2's reporting and Requirement 3's version drift
  without a migration, at the cost of not being able to validate membership from the pack's side.
  Whichever is chosen, decide it before any of this is built — it is the one decision here that is
  expensive to reverse. Recorded on review rather than by the author.

- Where does the acknowledged-pack-version record live — a new file alongside the baseline, or a new
  section of `checkyourvibe.json`? This spec requires that it be committed and explicitly written, not
  where.
- Does `cyv upgrade` (0005 Requirement 6) own writing pack-version acknowledgments as part of its
  existing re-planning pass, or does this need its own command? The two solve adjacent problems —
  re-resolving a changed manifest — and a second mechanism doing almost the same thing would itself be a
  source of drift.
- Should Requirement 2.3's "analyzer contributes zero active rules" report escalate to a hard failure
  under `--strict`, the way other advisory-only findings do in the backstop mode? Left open here.
- Is a bare positive-integer `version` (Requirement 3.1) enough, or does a pack eventually need to
  distinguish an additive change (arguably safe to auto-acknowledge) from a removal (never safe to
  auto-acknowledge)? This spec treats every version change identically and requires acknowledgment either
  way, which is simpler but may prove too coarse once a pack has shipped several versions.
- Should `cyv doctor` surface pack version drift (Requirement 3.3), consistent with it already being the
  home for other drift detection — the absolute-path drift 0005 already assigns it — rather than `cyv
  check` owning yet another category of drift report?
