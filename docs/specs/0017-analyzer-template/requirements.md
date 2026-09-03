# 0017 — Third-party analyzer template: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001, 0004

## Introduction

0004 proved the analyzer protocol is *sufficient*: a second analyzer, in a language that cannot import a
line of this project's code, built from the published documents alone and passing every conformance
check. That is a claim about capability. It says nothing about whether anyone who is not already
maintaining this repository would ever choose to act on it.

A protocol nobody outside this repository has implemented is a claim, not a contract. Sufficiency is
necessary but not the whole test — the real test is whether a stranger, reading only what is published,
gets from nothing to a passing `cyv verify-analyzer` run faster than they get discouraged. This spec is
about that distance. It ships four things: a template repository skeleton that starts in a conformant
state before a single rule exists, the conformance suite documented and framed as an external check
rather than an internal test, a versioning policy for the protocol itself, and an interlock that makes an
empty `notFixes` graph visible rather than a quiet default.

None of this touches rule *count*. A template with excellent rules and a confusing onboarding path fails
the actual goal; a template with zero rules and an unmistakable starting line succeeds at it.

### Out of scope

A hosted registry, index, or marketplace of third-party analyzers. See Non-goals.

---

## Requirement 1 — Conformant with zero rules

**User story:** As someone choosing my own language for a new analyzer, I want a starting point that
already passes the conformance suite, so that adopting the protocol and authoring my first rule are two
separate, independently completable steps — the first a copy-and-verify, the second real work.

#### Acceptance criteria

1. The template SHALL be a standalone repository skeleton, distributed and versioned independently of
   this monorepo's workspace tooling — not a package living under `packages/` here.
2. It SHALL ship an `analyzer.manifest.json` with an empty `rules` array, a valid `match` list, and an
   `exec` descriptor for the subprocess shape (`{ type: "process", ... }`), plus an entry point that reads
   one `AnalyzeRequest` from stdin and writes one `AnalyzeResponse` to stdout.
3. WHEN the entry point is invoked with any request and no enabled rules THEN it SHALL return
   `{ protocol: 1, violations: [], skipped: [], diagnostics: [] }` — the same shape `emptyResponse()`
   already names in the protocol module — without any rule-specific code path existing yet.
4. `cyv verify-analyzer` run against the unmodified template SHALL report every check passed, including
   `guidanceCompleteness` and `notFixReferences`, both of which are vacuously satisfied by an empty rule
   list.
5. The template's own README SHALL state this in as many words: a fresh checkout already passes
   conformance, and a first rule is added by extending exactly two places — the manifest's `rules` array
   and the entry point's dispatch — not by restructuring anything the skeleton already contains.
6. The template SHALL document the minimum surface a subprocess analyzer must reproduce in any language
   capable of reading stdin and writing stdout as JSON, citing `packages/analyzer-csharp` and
   `packages/analyzer-python` in this repository as evidence of what that minimum looks like in practice,
   without committing this spec to shipping a specific second reference language itself.
7. WHERE a third party's language also runs on Node, the template SHALL document the in-process `exec.type:
   "node"` path as an available alternative, but SHALL NOT present it as the default — the subprocess path
   is the one every language can reach, and the template's headline claim is portability.

## Requirement 2 — Conformance suite as a published, runnable check

**User story:** As a third party, I want to run the exact check this project runs on its own analyzers,
against my manifest, before I trust my own reading of the schemas — and I want to know precisely what a
passing result does and does not tell me.

#### Acceptance criteria

1. `cyv verify-analyzer <path>` SHALL behave identically whether the target manifest lives inside this
   repository or entirely outside it, and SHALL continue to require nothing about the analyzer being
   registered in any `checkyourvibe.json` — verifying and adopting remain two separate acts.
2. Every check the suite performs SHALL be documented by name, in the suite's own order and wording, in a
   published document (`docs/writing-an-analyzer.md` or a dedicated `docs/conformance.md`), so a failure
   message can be looked up without reading `conformance/suite.ts`.
3. That document SHALL contain a single, explicit section stating what a passing result guarantees:
   manifest and rule shapes match the published schemas, a malformed request never produces a stack trace
   on stdout, an unreadable file is reported in `skipped` rather than dropped, an unknown rule id does not
   crash the analyzer, and no violation arrives with `guidance` pre-populated.
4. The same section SHALL state, with equal weight, what a passing result does NOT guarantee: that any
   rule's findings are correct, that its fixture pairs (if any) actually distinguish true from false
   positives, that its `why` or `allowedFixes` prose is useful, that it is fast enough for an editor hook,
   or that its rules are internally consistent beyond the `notFixReferences` and `notFixCoverage` checks
   (Requirement 4) checking what they check and nothing more.
5. WHERE a third party disputes a specific check's behavior, the documentation SHALL point at the
   corresponding acceptance criterion in this project's own specs (0001 Requirement 1; 0004) that the
   check encodes, so a dispute is about a stated requirement rather than suite internals.

## Requirement 3 — Protocol versioning: fail loudly, never skip silently

**User story:** As a third-party analyzer pinned to a protocol version, I want to be told unambiguously
the day that version stops being understood, rather than discovering later that my checks quietly stopped
running.

#### Acceptance criteria

1. The core SHALL maintain an explicit set of supported protocol versions, distinct from the single
   version it currently emits. Today that set is `{1}`; nothing in this requirement mandates a version 2
   exist yet.
2. WHEN a manifest declares a `protocol` value outside the supported set THEN the registry SHALL reject
   it, naming the analyzer's declared version, the supported set, and where to read the upgrade path —
   generalizing today's exact-equality check into a set-membership check without weakening it.
3. This rejection SHALL occur at manifest-load time, before file routing. An analyzer with an unsupported
   protocol SHALL cause `cyv check` to exit non-zero as a configuration error, never exit 0 having silently
   run zero analyzers over the files that analyzer's `match` globs claimed. A clean report over files
   nobody actually checked is the exact failure mode this project exists to prevent, and an unsupported
   protocol version is exactly such a case if it is ever allowed to degrade into a routing no-op.
4. `cyv doctor` SHALL report "unsupported protocol version" as a distinct finding from "manifest not
   found" and "manifest failed to parse," because the fix differs in each case: upgrade one side, reinstall
   the package, or fix a typo.
5. `cyv verify-analyzer` run against a manifest declaring an unsupported protocol SHALL fail the
   protocol-version check with a message naming both the declared value and the full supported set, not
   merely the single expected value.
6. A published changelog for the protocol (for example `docs/protocol/CHANGELOG.md`) SHALL record every
   version change: what changed, whether it was additive or breaking, and — for a breaking change — how
   long the previous version remains in the supported set before it is removed.
7. An additive, backward-compatible change (a new optional field on a request, response, or manifest
   shape) SHALL NOT require a protocol version bump. Only a change an already-conformant analyzer could not
   safely ignore SHALL bump it.
8. The template's own request-parsing code SHALL ignore unrecognized top-level fields rather than reject
   them, so a future additive change does not break an already-shipped third-party analyzer before that
   analyzer chooses to adopt whatever the new field offers.

## Requirement 4 — Forcing the `notFixes` interlock

**User story:** As an agent consuming a third-party rule pack, I want to know when that pack has never
named a single dead end, because that is exactly the condition under which I am most likely to trade one
violation for another without either of us noticing.

Verified against this project's own code before writing this requirement: `notFixes: []` already
satisfies `rule-manifest.schema.json` (no `minItems`) and every existing conformance check —
`notFixReferences` only walks the entries that exist, so an empty array has none to be dangling. A
third-party pack with ten rules and zero declared dead ends passes `cyv verify-analyzer` cleanly today.
That gap is what this requirement closes.

#### Acceptance criteria

1. `ConformanceCheck` SHALL gain a `warning: boolean` field alongside `passed`, defaulting to `false`, so a
   check can report a passing-but-notable condition as a distinct, structured signal rather than a
   convention buried in free-text `detail`. This SHALL also retrofit the suite's existing "zero violations
   caught" case (`catchesOwnConstruct`), which today only signals its warning by prefixing `detail` with
   the literal string `WARNING:` — a stringly-encoded signal this project would flag in its own rules.
2. A new check, `notFixCoverage`, SHALL run whenever an analyzer declares two or more rules. It SHALL warn
   — `passed: true, warning: true` — when none of those rules declares a non-empty `notFixes` array.
3. An analyzer declaring zero or one rule SHALL NOT trigger this warning: zero rules is Requirement 1's
   starting line, and a single rule has no sibling within its own pack to trade a violation into.
4. The warning's `detail` SHALL name every rule in the pack whose `allowedFixes` has more than one entry —
   those are the rules most likely to be hiding a real dead end, because offering more than one way to
   comply is exactly the situation in which an agent chooses between fixes and can choose the wrong one.
5. `cyv verify-analyzer`'s rendered checklist SHALL display a warning distinctly from both a plain pass and
   a failure (for example, `[WARN]` alongside the existing `[PASS]` / `[FAIL]` markers), so it is visible
   in the same scan as failures rather than hidden inside a passing line's detail text.
6. The overall `passed` result of a conformance run SHALL remain unaffected by any `warning: true` check —
   `notFixCoverage` warns; it does not fail the run and does not block `cyv check` or publication.
7. This requirement's choice is a warning, not an error, for a stated reason: a hard gate here is easy to
   satisfy dishonestly and hard to satisfy honestly. An author blocked from shipping would be incentivized
   to invent a `notFixes` entry that is not a real dead end just to turn the check green, and a fabricated
   dead end is worse than an absent one — it teaches an agent something false under the same authority as
   the guidance that is actually true, which corrodes trust in every other entry in the same manifest. A
   silent metric (deferred to a future rule-quality dashboard) was also rejected: this project's own
   carried-forward principles name silence as the thing to avoid, and a real interlock gap is cheapest to
   see and fix at the moment `cyv verify-analyzer` runs, before the pack ships — not later, in a view
   nobody is obliged to open. A loud, non-blocking warning is the position that neither hides the gap nor
   manufactures a false fix for it.

## Requirement 5 — Documentation the template carries

**User story:** As a third-party rule author, I want to know what makes a `why` and an `allowedFixes`
entry actually useful to an agent, and why I cannot just tell it which library to adopt, so my pack adds
signal instead of dependency churn.

#### Acceptance criteria

1. Template documentation SHALL instruct that `why` states the causal mechanism the rule protects
   against — what actually goes wrong, and under what condition — never a restatement of the rule's name
   or a bare appeal to convention.
2. Template documentation SHALL instruct that each `allowedFixes` entry is independently sufficient and
   phrased as an action, and that a rule with only one declared fix alongside several plausible-looking
   alternatives is a signal that those alternatives belong in `notFixes`, not that they are safe to leave
   undiscoverable.
3. Template documentation SHALL state, with first-principles reasoning rather than a bare directive, that
   rule guidance may name no vendor, library, or framework: naming one couples the guidance's usefulness
   to that dependency's continued existence and popularity, makes the guidance non-portable across
   projects that made a different stack choice, and — specifically for an agent consumer — an instruction
   to adopt a named dependency in order to satisfy a lint finding is a materially larger and riskier change
   than the violation actually required. Rules SHALL take options instead, whose default names nothing,
   mirroring the pattern already used by this project's own reference rules.
4. Because no bounded, complete list of vendor, library, and framework names exists across every
   ecosystem a third party might target, this norm SHALL NOT be mechanically enforced as a `cyv
   verify-analyzer` gate. The template SHALL instead carry it as a documented review checklist item and an
   inline reminder next to the `why`, `allowedFixes`, and `notFixes` fields in the scaffold, and the
   documentation SHALL say plainly that this is a human review norm, not an automated guarantee — stating
   the limitation is part of the requirement, not an omission from it.
5. Template documentation SHALL include at least one worked example of a `why` and a `notFixes` entry,
   drawn from one of this repository's own already-published rule packs (identified by rule id and file
   path, never copied prose), so a reader can compare a model against a real, currently-shipping manifest.

## Requirement 6 — Discovery and trust: a deliberate act

**User story:** As a user, I want running someone else's analyzer to be something I chose and understood,
never something that happened as a side effect of a command I ran for an unrelated reason.

#### Acceptance criteria

1. `cyv init` SHALL NOT search the filesystem, installed packages, or any network location for
   third-party analyzers, and SHALL NOT add one to `checkyourvibe.json` unless the user names that exact
   package or path themselves, as an explicit argument or an explicit interactive answer.
2. Adding a third-party analyzer to configuration SHALL always require the user to supply its specifier —
   by editing `checkyourvibe.json` directly, or through a command that takes the specifier as a required
   argument — and SHALL NOT be a side effect of any other command's default behavior, including `cyv
   upgrade` and `cyv doctor`.
3. Documentation SHALL state plainly, next to the existing description of `exec.type: "process"`, that
   enabling such an analyzer means the core will spawn and execute that binary with the same privileges as
   the invoking shell, with no sandboxing, isolation, or resource limiting performed by checkyourvibe.
   Running a third party's analyzer against a repository carries exactly the trust already extended to any
   other executable dependency added to a build — no more, and the documentation SHALL NOT imply less.
4. Documentation SHALL state, adjacent to Requirement 2's account of the conformance suite, that a passing
   `cyv verify-analyzer` result is not a security or quality attestation — it establishes protocol
   compliance and nothing about what the analyzer's code does beyond emitting well-formed responses.
5. Reading a manifest (`loadAnalyzerManifest`) SHALL remain safe to do before any of this — it is plain
   JSON, and nothing about it executes analyzer code. That distinction — reading a manifest is inert;
   enabling and running the analyzer is the trust decision — SHALL be stated explicitly wherever the
   manifest format is documented, so the two are never conflated into a single "installing" step.

## Non-goals

A hosted registry, index, or marketplace of third-party analyzers, and any search, ranking, review, or
download-count feature that would require one. Sandboxing, capability restriction, or resource limiting of
a `process`-exec analyzer — the trust model in Requirement 6 is disclosure, not containment. Mechanical
enforcement of the no-vendor-name norm. Committing to a specific second reference-language implementation
for the template beyond documenting the pattern `analyzer-csharp` and `analyzer-python` already prove.
Cross-analyzer `notFixes` references, where a dead end named by one analyzer's pack would trip a rule
owned by a different, separately configured analyzer — real, and left to Open Questions rather than solved
here.

## Open questions

1. **Cross-analyzer `notFixes`.** `checkNotFixReferences` today resolves a `notFix.rule` only against
   rules declared by the same analyzer. A third-party pack whose only genuine dead end trips a rule owned
   by a *different* analyzer the user has configured alongside it has no way to express that today, and
   this spec does not resolve it — noted as a Non-goal above rather than quietly ignored.
2. **One version counter or two.** Today `protocol: 1` covers both the manifest's static shape and the
   request/response wire shape as a single number. Those are two independently evolving surfaces — a new
   optional manifest field and a new optional response field are unrelated changes that currently share
   one counter. Whether they should stay merged or split is unresolved.
3. **Should `notFixCoverage` ever fire for a single-rule analyzer?** A one-rule pack can still declare
   more than one `allowedFixes` entry, and one of those could plausibly trip a rule in a *different*
   analyzer (see Open question 1). This spec scopes the warning to two-or-more-rule packs to keep the
   heuristic legible; whether that under-warns is untested against a real third-party pack.
4. **Machine-readable error codes for `cyv doctor`'s three-way split.** Requirement 3.4 asks for three
   distinctly worded findings but does not require a stable code alongside the prose. Tooling that wants to
   react programmatically (rather than parse a message) may need one; this spec does not decide it.
5. **How much of the accessibility goal in Requirement 1.7 is worth building now.** Documenting the
   pattern is required; whether an actual second reference implementation beyond `analyzer-csharp` and
   `analyzer-python` is worth shipping before a real third party asks for one is deferred.
