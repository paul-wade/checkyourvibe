# 0029 — Analyzer prerequisites: Requirements

**Status:** active
**Created:** 2026-08-28
**Depends on:** 0001, 0007

## Introduction

Spec 0007's tasks T7009 and T7010 found and fixed this project's founding defect a second time, at seven
times the scale. Pointed at 170 TypeScript files from a real, unrelated codebase, `cyv check --all`
reported 693 violations, 673 of them `no-any` — because `groupFilesByProject` fell back to default
compiler options for every one of those files rather than following their solution-style tsconfig's
`references`, and under default compiler options every import resolves to `any`. The layout was not
exotic; it was the standard workspace-generator shape.

The fix that mattered was not the tsconfig fix. It was T7010: `evidence: 'semantic'` findings are now
withheld, per file, whenever the analyzer that produced them reports its own type resolution as degraded
for that file. On the same codebase that turned 693 unusable errors into 4 real ones plus a clear
statement that 170 files could not be type-checked. That mechanism — `DegradedResolution` on
`AnalyzeResponse`, and the withholding logic in `runCheck` (`packages/core/src/run/check.ts`, lines
275–296) — already exists and already works.

What does not exist is any requirement that a *new* analyzer use it. `docs/writing-an-analyzer.md`
documents the manifest shape, the request/response contract, and the skipped-file convention, and says
nothing about degraded resolution at all. `cyv verify-analyzer` passes an analyzer that never populates
`degraded` exactly as readily as it passes one that does — 11/11, either way. Only the TypeScript analyzer
implements it. This spec makes the lesson a prerequisite: what an analyzer MUST do about its own type
resolution before it can be considered complete, stated generally enough to bind an analyzer that has
never heard of a tsconfig.

This is not hypothetical. See "Where the four existing analyzers stand today," below — one of them is
in the exact unfixed position T7009 found the TypeScript analyzer in, today.

## Requirement 1 — Every analyzer must know when it is guessing

**User story:** As someone running `cyv check` against a real codebase, I want a semantic finding to mean
the analyzer actually consulted a type system, so that a missing or unusable project configuration
produces an honest report instead of a confident, fabricated one.

1. An analyzer that can run in more than one resolution mode — with a discoverable project file or
   without one, with a fully resolved reference set or a partial one, with real import resolution or a
   stand-in — SHALL detect, per file, which mode it actually used.
2. WHEN an analyzer resolves a file's types, symbols, or imports using anything other than the project's
   own real configuration — no project file found, a project file that could not be parsed or fully
   resolved, an invented fallback configuration, an external reference that did not resolve — it SHALL
   report that file in `AnalyzeResponse.degraded`, not merely as a `diagnostics` entry.
3. The `reason` on each `DegradedResolution` entry SHALL name what was missing or wrong and, where
   feasible, what would fix it. "No usable tsconfig.json governs these files (none found, or the nearest
   one is solution-style). Analysed with default compiler options, so inferred-type findings may be
   unreliable." — the TypeScript analyzer's actual message — is the standard to match, not "type
   resolution failed."
4. `degraded` is not a substitute for `skipped`. A file the analyzer could still parse and evaluate
   syntax rules on SHALL NOT be dropped to `skipped` merely because its semantic resolution was degraded
   — that discards sound syntax findings to avoid reporting an unsound semantic one, which is worse than
   either alone. Requirement 3.3 of the Go spec (0021) already reaches this conclusion independently,
   for a language nobody has written a line of this analyzer for yet: "a resolution failure degrades only
   the semantic rule, and the response's diagnostics SHALL say which rule was affected and why." This
   requirement generalizes that as a system-wide obligation rather than leave it as one spec's local,
   optional-looking design choice.
5. An analyzer with no reduced mode at all — nothing in its resolution model can vary between a real
   configuration and an invented one, because it never resolves external configuration in the first
   place — has nothing to report here, and reporting nothing is the correct, complete answer for it. This
   is not lesser compliance; Requirement 3 says how conformance tells the two cases apart.

## Requirement 2 — Declaring `evidence: semantic` is a promise

**User story:** As an agent deciding how hard to argue with a finding, I want `evidence: 'semantic'` to
mean the compiler actually resolved something, so that I do not treat a shape-match as proof.

1. A rule manifest declaring `evidence: 'semantic'` (`packages/core/src/protocol/rule-manifest.ts`) is a
   claim that every finding from that rule rests on a type system or symbol table the analyzer trusts. An
   analyzer author who declares it takes on the obligation of Requirement 1 for every file that rule can
   run against — there is no such thing as a semantic rule exempt from reporting its own degradation,
   because a semantic rule that cannot say when it is guessing is a rule that is always, silently,
   sometimes guessing.
2. An analyzer SHALL NOT declare `evidence: 'semantic'` on a rule and then run that rule unconditionally,
   regardless of whether its own resolution succeeded, on the theory that some findings will still be
   right. Some of the 673 `no-any` findings in T7009 were, in the narrowest sense, findings — some of
   those parameters probably were untyped. The rule's claim is not "some of these are true," it is "the
   compiler determined this," and only the compiler's real resolution can support that.
3. The core enforces the consequence, not the analyzer's cooperation. `runCheck` withholds a violation
   whose rule's `evidence !== 'syntax'` (an unspecified `evidence` is withheld too — the manifest's own
   doc comment already treats omission as "not the stronger claim," and the withholding logic reads it
   the same way) when that file appears in the response's `degraded` set, and reports the withheld count,
   the affected file count, and the distinct reasons (`withheldFindings` / `withheldFiles` /
   `withheldReasons` in `check.ts`). An analyzer that never populates `degraded` gets none of this
   protection — its semantic findings are trusted unconditionally, which is precisely the position the
   TypeScript analyzer was in before T7009 exposed it.
4. Declaring `evidence: 'syntax'` where the honest answer is `'semantic'` is the opposite failure and is
   equally out of bounds: it launders a real type-system claim through the confidence level that gets no
   withholding protection, at exactly the moment protection is what a wrong-configuration run needs.
   `no-console` in the TypeScript pack is the existing precedent for the harder direction — it resolves
   the identifier through the symbol table specifically to prove it is the global rather than a shadowing
   local, and only that resolution is what earns it `semantic`.

## Requirement 3 — Conformance must check this

**User story:** As someone running `cyv verify-analyzer` against a new analyzer before wiring it into a
real project, I want to know whether it can tell me when it is guessing, so that I do not find out the
way T7009 found out.

1. `verifyAnalyzer` (`packages/core/src/conformance/suite.ts`) SHALL gain a twelfth check, static and
   requiring no execution — grouped with checks 1–6 rather than the scripted checks 7–11 — that reads
   whether any rule in the manifest declares `evidence: 'semantic'`.
2. WHERE no rule declares `evidence: 'semantic'`, the check SHALL pass unconditionally, with a detail
   stating that nothing in this manifest claims the kind of evidence Requirement 1 is about. This is the
   genuinely-cannot-degrade case — the Python and Rust analyzers today, both syntax-only end to end — and
   it MUST NOT be penalized for having nothing to declare, the same way `checkCatchesOwnConstruct`
   already declines to fail an analyzer that ships zero rules rather than treat "nothing to check" as a
   defect.
3. WHERE at least one rule declares `evidence: 'semantic'`, the manifest SHALL be required to make an
   explicit, checkable claim about whether it can detect degraded resolution, rather than merely be
   trusted to. This spec proposes a new optional manifest field, `capabilities.degradableResolution:
   boolean`, alongside the existing reserved `capabilities.session`. The check FAILS when a semantic rule
   exists and this field is absent — an analyzer that has not been asked the question should not be
   assumed to have answered it correctly, the exact reasoning `evidence`'s own doc comment already applies
   to its own omission.
4. This is deliberately a self-declaration, not a behavioral proof, and this spec says so rather than
   pretending otherwise. A generic conformance suite has no way to manufacture "a solution-style tsconfig
   with no matching referenced project," "an unresolvable package reference," or "an import outside the
   module cache" — those are per-language constructs the protocol layer has no business knowing about,
   the same limit 0010 already documented for a compiled analyzer's `exec` path: "conformance proves a
   manifest is well-formed. It does not prove the thing it points at exists anywhere but here." The check
   can and does verify that the claim exists; it cannot and does not verify that the claim is true. That
   gap is closed by Requirement 5, which is a real-codebase run, not by anything conformance can do in a
   temp directory.
5. A manifest declaring `capabilities.degradableResolution: false` on an analyzer with semantic rules
   SHALL still pass. "I cannot detect this" is an honest answer this spec does not forbid — the same
   spirit as the Rust analyzer shipping a thin, honestly-scoped pack instead of an invented one. The
   check's `detail` on this branch SHALL say plainly that the claim is one the suite could not verify, so
   a reviewer reading conformance output sees the limitation instead of a clean pass that implies more
   than was checked.
6. This is how the suite distinguishes "cannot degrade" from "does not report degrading": the former has
   no `evidence: 'semantic'` rule to answer for and step 2 asks it nothing; the latter has one and step 3
   requires an answer on the record, `true` or `false`, rather than accepting silence as either.

## Requirement 4 — The per-file project-resolution problem, stated once for all languages

**User story:** As someone adopting an analyzer on a real codebase, I want to know in advance which of my
repository's layouts it actually resolves correctly, rather than discover it the way this project
discovered its own.

1. Every analyzer that resolves per-file configuration does so around a different unit — a `tsconfig.json`
   for TypeScript, an ad hoc `CSharpCompilation` assembled from whatever files one request contains for
   C#, a module for a syntax-only analyzer that has no import resolution to speak of today but would need
   one to ever earn `evidence: 'semantic'`, a crate or workspace member for a future Rust analyzer with
   real type information. All of these fail the same way in a monorepo: a file's nearest configuration
   unit is not necessarily the one that actually governs it, and picking the wrong one — or falling back
   silently when none is found — produces a resolution that looks complete and is not. That is the shape
   of the failure, independent of which of the four concrete units it happens to be a tsconfig, a
   compilation, a module, or a crate.
2. Each analyzer's README SHALL state, in its own terms, which real-world layouts its project-resolution
   logic actually handles and which it does not — not a caveat buried in a source comment, a documented,
   adopter-facing claim. `packages/analyzer-typescript`'s handling of a solution-style tsconfig (T7009's
   fix, in `project.ts`'s `groupFilesByProject`) and `packages/analyzer-rust/README.md`'s "Where this rule
   model fits Rust badly" section are the existing register to match: specific about what resolves,
   specific about what does not, never phrased as "this just works."
3. This requirement is retroactive for the analyzers that already exist. "Where the four existing
   analyzers stand today," below, states what each currently claims and what its README currently owes.

## Requirement 5 — What a new analyzer must demonstrate before it ships

**User story:** As a reviewer deciding whether a new analyzer's rules are trustworthy, I want evidence
from a real codebase, not a fixture pass, so that I am not the one who finds the false positives after
adoption.

1. Passing `cyv verify-analyzer` and a fixture suite is necessary and not sufficient. Before a new
   analyzer's rule pack is considered complete, it SHALL be run against a real codebase in its target
   language — not a fixture directory, and not this repository's own source when this repository holds
   none of that language — and the run SHALL record the finding count and a false-positive assessment of
   what fired, the same discipline T7009 already applied once, by hand, to the TypeScript pack.
2. Two measured results from this project's own history are why a fixture pass does not stand in for
   this. `no-floating-promise` (T7002) fired exactly once against this repository's real source, on `void
   flush()` inside the watch debounce timer, and it was right — a genuine unhandled-rejection bug, fixed
   as a direct result. `no-non-null-index-write` (T7004) fired fourteen times against the same repository
   and was wrong fourteen times out of fourteen, because its premise — that an index write is risky under
   `noUncheckedIndexedAccess` — is sound for an array and meaningless for a record, and every one of the
   fourteen was a record insertion (`merged[ruleId] = override`, and its like). Both rules passed their
   fixtures before either of these runs. Only one of them was right about real code, and the fixture suite
   could not have told anyone which. A fixture pair proves a rule detects the shape it was written to
   detect; it says nothing about how often that shape means what the rule assumes it means, and that gap
   is exactly what a real run closes.
3. WHERE the real-codebase run finds a rule with a materially high false-positive rate, the response
   SHALL follow T7004's precedent: narrow the rule's detection or disable it in configuration rather than
   delete it, and record why in the spec or README, rather than let a disbelieved rule stay silently
   enabled. A rule the project has switched off and left undocumented is the same dishonesty this whole
   spec exists to prevent, one level up.
4. This requirement applies to a rule pack *revision* on an existing analyzer as much as to a brand-new
   language — T7004's finding came from re-running an existing analyzer's expanded pack against this
   project's own source, not from a first-ever language run.

## Where the four existing analyzers stand today

- **TypeScript — compliant.** `groupFilesByProject` (`packages/analyzer-typescript/src/project.ts`)
  reports a `degraded` entry, with a specific per-file reason, for any file with no usable tsconfig; the
  semantic rules this protects include `no-any`. This is the one analyzer Requirements 1–3 describe
  rather than propose.
- **C# — not compliant, and not merely by omission.** `Program.cs`'s `Analyze` method compiles every file
  a request sends together against a metadata reference set built solely from the .NET runtime's
  `TRUSTED_PLATFORM_ASSEMBLIES` (`StandardReferences.cs`) — there is no `.csproj`, no package reference,
  no project or solution file anywhere in its resolution path. Every run is in what this spec calls a
  reduced mode; there is no full mode for it to fall back from. `AnalyzeResponse` (`Protocol.cs`) has no
  `degraded` field in its serialized JSON at all — the schema publishes one and this analyzer never
  writes to it. A type from a third-party package or a sibling project reference resolves to an error type
  inside the compilation, and `no-dynamic` or `no-unchecked-cast` can still fire around it with nothing
  telling the core, or the user, that the underlying model never saw that type in the first place. This is
  Requirement 1 in its unfixed form, on the second language this project shipped.
- **Python — compliant by having nothing to claim.** Every rule in `core-py` declares `evidence:
  'syntax'`, and the analyzer never resolves an import at all. Requirement 3.2's trivial-pass case is
  written for exactly this analyzer.
- **Rust — the same as Python, for the same reason.** `syn`'s syntax tree only, every rule `evidence:
  'syntax'`, nothing to degrade. The Rust README already says as much in different words: "the same
  evidence class as the Python analyzer."

## Non-goals

Extending `evidence` beyond `syntax` / `semantic`, or adding a numeric confidence score — the two-value
field already does the job this spec depends on, and 0009 rejected using severity for this exact purpose
for a reason that still holds. Building an executable, cross-language conformance scenario that forces a
real degraded run — Requirement 3.4 explains why that does not belong in a generic suite. Retrofitting the
C# analyzer's degraded-resolution reporting itself; this spec states the requirement and records that C#
fails it today, but the fix (reading an actual `.csproj`, or at minimum reporting that it never does) is
implementation work for its own task, not this spec. A `capabilities.degradableResolution` value beyond
`true`/`false` — no analyzer here has a resolution mode that is neither fully real nor fully invented, so
a tri-state was considered and left for whichever analyzer first needs it. Requiring the real-codebase run
in Requirement 5 to be re-run on every change — it is a shipping gate, not a CI step; 0018's rule-quality
metrics is where ongoing, automatic signal belongs.

## Open questions

1. **Does `capabilities.degradableResolution: true` need any teeth beyond the static declaration?** As
   written, an analyzer can declare `true` and still never populate `degraded` in practice, and nothing in
   Requirement 3 catches that beyond Requirement 5's real-codebase run happening to hit the case. Whether
   conformance should additionally require the analyzer to demonstrate degradation on a scripted
   worst-case request it constructs itself — a repo root with no project file at all, which every analyzer
   can be handed regardless of language — is left open; it would catch the C# gap today without needing
   any C#-specific knowledge, but it only proves one degraded scenario exists, not that every real one is
   caught.
2. **Should Requirement 1.4's rule — never fold a degraded file into `skipped` — be enforced by
   conformance rather than left as a written obligation?** The suite's scripted requests do not currently
   construct a scenario where an analyzer might be tempted to do this, and a check that could tell the two
   apart would need the same kind of analyzer-specific setup Requirement 3.4 argues against building
   generically.
3. **What happens when 0021's Go analyzer is actually built?** Its Requirement 3.2 already asks for
   roughly this behavior, phrased as "report that condition as a skipped file or diagnostic," not
   explicitly as populating `degraded`. Whether 0021 should be amended to point at this spec directly, or
   whether the Go implementation task is simply expected to read both, is left to whoever picks up that
   spec next.
