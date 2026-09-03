# 0007 — TypeScript rule pack expansion, and packs as a first-class concept: Requirements

## Introduction

**Written after the fact, on 2026-09-02.** This spec shipped with a `tasks.md`
and nothing else — no requirements, no design — which under the rule in
`AGENTS.md` means it was never a spec at all, and `tools/spec-workflow.mjs`
reported it as such. The work is complete and in the tree; what follows is
recovered from the ten tasks that delivered it and from the code they produced.
It is a record, not a plan, and it is written so that the pack model has stated
requirements something later can be checked against.

Where a requirement is narrower than the roadmap entry that motivated it, the
narrower text is correct: it describes what was built.

The entry's own framing was that rule count is the least valuable thing to grow.
That held. Of the ten tasks, three added rules and seven were findings about
rules that already existed — two of which (Requirements 5 and 6) were defects
serious enough that shipping the pack without them would have made the tool
worse than not having it.

## Requirement 1 — A pack is a choice, not a switch

**User story:** As a team adopting the tool, I want to select a posture rather
than accept one opinion, so that the configuration says something about what we
believe.

1.1. There SHALL be more than one TypeScript pack. Every rule declaring
   `pack: "core-ts"` made `packs: ["core-ts"]` all-or-nothing, which is a
   setting, not a choice.

1.2. A rule SHALL declare exactly one pack. Multi-pack membership was
   considered and rejected: a rule in every pack makes the choice mean nothing.

1.3. The second pack SHALL be drawn along a stated line rather than by
   convenience. `strict-boundaries` holds the rules governing data crossing into
   the program — `no-json-parse-cast`, `no-unsafe-array-narrowing`,
   `no-unsafe-index-access`.

## Requirement 2 — The async and error-handling family

2.1. `no-floating-promise` SHALL report a call returning a promise that is
   neither awaited, returned, nor handled. Semantic: it needs the type checker
   to know the return type is a promise.

2.2. `no-broad-catch-rethrow` SHALL report a catch that adds a frame and hides
   nothing — `catch (e) { throw e; }` and its equivalents. Distinct from
   `no-swallowed-catch`, which is about not rethrowing at all. Syntax evidence.

2.3. Each new rule SHALL declare its `notFixes` edges against the rules that
   already exist, before it is considered done.

## Requirement 3 — Every rule states what its finding rests on

3.1. Every rule in every analyzer SHALL declare
   `evidence: 'syntax' | 'semantic'`. Seven TypeScript rules predated the field
   and rendered as "unspecified", which understated what they knew.

3.2. `evidence` SHALL be declared from what the check does, not from what the
   rule is about. A rule that matches a keyword is `syntax` even when the
   keyword is about types.

## Requirement 4 — A configuration that expands to nothing says so

**User story:** As someone changing pack membership, I want the tool to tell me
what my configuration resolved to, so that a rule cannot be switched off by an
edit nobody reads as switching it off.

4.1. Moving three rules into `strict-boundaries` disabled them in this
   repository, because `checkyourvibe.json` named `core-ts` and `core-cs` and
   nothing said otherwise. It was caught by review, not by the tool. `cyv check`
   SHALL report how many rules its configuration expanded to.

4.2. `cyv check` SHALL name any configured pack it does not recognise.

4.3. A rule whose pack is in no configured pack is a detectable state and
   SHALL be reported rather than passed over in silence.

## Requirement 5 — The interlock covers the cheapest escape

**User story:** As an agent acting on a finding, I want the remediation the
guidance points me toward to be checked by something, so that fixing one rule
cannot land me in another rule's blind spot.

5.1. `.catch(() => {})` satisfied `no-floating-promise` — the promise *is*
   handled — and was invisible to `no-swallowed-catch`, whose check only
   inspected `try`/`catch` clauses. The most common way to silence an unhandled
   rejection without handling it passed both rules cleanly.
   `no-swallowed-catch` SHALL report an empty or no-op `.catch()` handler on a
   promise.

5.2. The `notFixes` edge from `no-floating-promise` to `no-swallowed-catch`
   SHALL be declared only *after* 5.1 lands. Declaring the edge first declares a
   dead end that is not a dead end.

5.3. A catch block whose statements are all control flow SHALL be treated as
   swallowing — `continue`, `break`, and a bare `return`. `return someFallback`
   stays clean, because producing a fallback is a response to the failure. This
   SHALL hold in both the TypeScript and C# analyzers.

## Requirement 6 — A semantic finding made without types is not a finding

**User story:** As someone running the tool on a codebase it cannot type-check,
I want to be told that rather than handed fabricated errors, because a false
finding costs more credibility than a missed one.

6.1. WHEN an analyzer reports degraded type resolution for a set of files THEN
   `cyv check` SHALL withhold `evidence: semantic` findings for those files.

6.2. It SHALL report syntax findings for those files normally; their soundness
   is unaffected.

6.3. A withheld finding SHALL NOT be silently dropped. The count, the reason,
   and how to fix the configuration SHALL be stated.

6.4. A solution-style `tsconfig.json` SHALL have its `references` followed, and
   the referenced project whose `include` covers the file SHALL be used —
   preferring the lib config for a source file and the spec config for a test
   file. Only when no referenced project covers the file is the default-options
   fallback honest.

## Requirement 7 — Verified against a codebase nobody here wrote

7.1. The packed tool SHALL be installed into a project holding real TypeScript
   from an unrelated codebase, and run.

7.2. The result of that run is the acceptance evidence for Requirements 6.1
   through 6.4. It reported 693 violations, 673 of them fabricated `no-any`
   findings caused by 6.4's defect, with the explanatory diagnostic buried among
   them. The target is those 693 becoming 4 real findings plus a clear statement
   that 170 files could not be type-checked.

## Non-goals

- More rules for their own sake. Three were added; seven tasks were findings
  about the rules already present, and that ratio was the point.
- A rule that belongs to several packs (Requirement 1.2).
- Deleting `no-non-null-index-write`, which was wrong 14 times out of 14 on its
  first real codebase. It was narrowed to array and tuple writes and re-enabled,
  because a rule this project has switched off is a rule this project does not
  believe, and leaving it switched off quietly would be the dishonesty the tool
  exists to prevent.

## Open questions

1. **`no-non-null-index-write` inside a controlled loop.** Any upper bound is
   accepted, so `for (let j = 1; j <= n; j++) arr[j] = x` is not reported.
   Narrowing further needs range analysis, not a better pattern match. Recorded
   in the rule's source.

2. **Whether `evidence` should be finer than two values.** 0009's requirements
   raise the same question from the analyzer side — whether `Violation` needs a
   confidence or basis field for a language with no type checker at all.
   Requirement 6 uses the two-value form and does not settle it.
