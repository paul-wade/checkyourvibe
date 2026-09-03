# 0030 — A test-quality pack: Requirements

**Status:** active
**Created:** 2026-08-28
**Depends on:** 0007, 0027

## Introduction

`packages/analyzer-typescript/test/fixtures/monorepo/libs/api-contracts/src/index.spec.ts` already exists
in this repository, and it is a better argument for this spec than anything invented for it:

```ts
import { describe, it } from '<test-framework>';
import { Project } from 'ts-morph';

export function makeProject(project: Project): string {
  return 'ok';
}

describe('project', () => {
  it('exists', () => {
    makeProject;
  });
});
```

By file name, by import, by the shape of the call, this is a test. Its `it` block calls no assertion of
any kind — `makeProject` is referenced, not invoked, and nothing about its result is checked. Read as a
test of `makeProject`, it asserts nothing and would pass unchanged if `makeProject` were deleted. Read as
what it actually is — a fixture that exists so `project.test.ts` has a `.spec.ts` file with a resolvable
monorepo reference to load — it is exactly right, and `checkyourvibe.json`'s
`"packages/*/test/fixtures/**"` exclusion already keeps every rule in this project from seeing it, for a
reason that has nothing to do with test quality: it was written to stop `no-any` and friends from grading
deliberately-bad fixture source as if it were production code. That the same exclusion also happens to
hide the one file in this repository that would otherwise be this pack's first real finding is not a
coincidence to be proud of — it is the central problem this spec has to solve honestly. A rule in this
pack cannot tell, from the shape of the code alone, whether it is looking at an abandoned assertion or a
fixture doing exactly its job. Both compile. Both parse as a `describe`/`it` block with an empty check.

The Roadmap entry that names this pack states the reason it exists in the same sentence as the reason to
be careful: "assertions that cannot fail, tests that pass when the code under test is deleted, mocks
asserted against themselves. Harder than it sounds and easy to get wrong; a false positive here trains
people to ignore the tool." Every other pack in this project points at production code, where "wrong" has
an external referent — the language's own semantics, the type checker's own model. This pack points at
test code, where the question is not "does this compile" but "does this test anything," and that second
question is a claim about what the author meant, not a fact this analyzer can read off an AST node the
way it reads off a `Promise` return type. A false positive from `no-floating-promise` costs a reviewer a
few minutes proving the tool wrong. A false positive from this pack tells someone who did the right thing
— they wrote a test — that they did it wrong, on the authority of the same tool that is right about
everything else it says. That is a different, higher cost, and it is why this pack does not get the
benefit of the doubt any other pack gets.

## Requirement 1 — Why this pack answers a different kind of question, and the bar that follows from it

**User story:** As someone deciding whether to enable this pack, I want its rules held to a standard this
spec states before a single one of them, not discovered after the first complaint.

1. Every rule in `core-ts` and `strict-boundaries` proves something about what the code *does*: a cast is
   unchecked, a catch is empty, an index write is unguarded. A rule in this pack has to prove something
   about what a test *is for* — and "for" is supplied by the author's intent, which is not a node in the
   AST and not a fact the type checker resolves. The nearest a rule here can get is a provable proxy for
   intent (an assertion call with no possible failing outcome, a test body with no assertion call
   anywhere in it), and the gap between the proxy and the real claim is exactly where a fixture like
   `index.spec.ts` lives: true by the proxy, and beside the point about the file.
2. T7002 and T7004 (`docs/specs/0007-rule-packs/tasks.md`) are the calibration, and this pack is held to
   them at least as strictly as 0028 was. `no-floating-promise` fired once and was right once; that is
   the outcome a rule needs before it ships enabled. `no-non-null-index-write` fired fourteen times and
   was wrong fourteen times on the very first real codebase it met; that is the outcome that gets a rule
   disabled rather than trusted a little. Nothing in this pack ships enabled on the strength of its
   premise sounding right — every rule below is either accompanied by the run that proves it or is
   explicit that the run has not happened yet.
3. Three shipping tiers, stated concretely rather than left as a feeling:
   - **Enabled by default** requires everything `no-floating-promise` had: the rule's self-application
     run (Requirement 6) produced findings that are, individually, every one a true positive, and the
     rule's own disclosed false-positive shape (Requirement 2) is either provably empty or narrow enough
     that no ordinary test in a real suite falls into it by accident.
   - **Shipped, disabled by default** is the T7004 outcome: the rule's premise is sound for the shape it
     targets, its fixture pair exists, but either the self-application run has not yet been performed
     against a second, independent sample (Requirement 6.4), or that run surfaced a plausible
     false-positive shape common enough that shipping it live would be gambling with someone else's test
     suite. Disabled and present beats deleted, for the same reason it did in T7004: the rule is not
     wrong about its narrow claim, only unproven at the scale this pack demands before trusting it by
     default.
   - **Not shipped** is for a claim this protocol's evidence cannot make sound at all — no amount of
     narrowing turns it into a rule, only into a smaller version of the same unsound claim. Requirement 3
     names the one candidate in that tier without qualification, and Requirement 2 names a second.
   A percentage threshold between these tiers is rejected for the same reason 0028 rejected one: no
   cutoff below 100% would have kept `no-non-null-index-write` off, and this pack's cost of being wrong is
   higher than that rule's, not lower.
4. A rule that reports a true statement about the code that is nonetheless the wrong file to have reported
   it about — `index.spec.ts` is the standing example — is a Requirement 4 problem, not a Requirement 2
   one, and this spec does not let the two blur: a rule can be perfectly sound about test bodies and still
   misfire because the file it ran on was never really a test in the sense the rule cares about.

## Requirement 2 — Candidate rules

Each candidate states what it proves, what it does not, its `evidence` value, and whether it is decidable
from one file. `RuleGuidance.evidence`'s doc comment (`packages/core/src/protocol/rule-manifest.ts`) is the
standard being applied: `semantic` only where the type checker or symbol table was actually consulted,
never assumed because the rule *feels* like it should need one.

1. **An assertion that cannot fail.** Proposed as `no-tautological-assertion`. Two provable sub-shapes,
   not one:
   - The same literal compared to itself: `expect(true).toBe(true)`, `expect(1).toBe(1)`,
     `assert.strictEqual('x', 'x')`. Nothing about the code under test appears in either operand, so the
     check passes regardless of what the test exercises. There is no legitimate reason to write a literal
     against the identical literal — the shape that looks like this and *is* legitimate,
     `expect(MAX_RETRIES).toBe(3)`, has an identifier on one side and is untouched by this rule, because
     only the literal-versus-identical-literal case is flagged.
   - The same *effect-free* expression compared to itself: `expect(x).toBe(x)` where `x` is a bare
     identifier. This is provable from syntax alone — nothing evaluates between the two reads of `x`, so
     nothing can make them differ — but only if the repeated expression cannot itself produce a different
     value or an observable effect on each evaluation. `no-swallowed-catch`'s `isEffectFreeExpression`
     (`packages/analyzer-typescript/src/rules/no-swallowed-catch.ts`) already drew this exact line, for a
     different rule, and this candidate reuses its logic rather than inventing a looser one: identifiers,
     literals, and effect-preserving wrappers (`void`, non-null assertion, `as`, `satisfies`) count as
     effect-free; a call expression does not. That exclusion is deliberate and load-bearing here, not
     incidental: `expect(select(state)).toBe(select(state))` — two separate calls compared for referential
     identity — is a legitimate check that a memoized function returns the same reference on repeated
     input, and a rule that could not tell it apart from a tautology would be wrong about the one shape a
     test author most plausibly meant on purpose. Restricting to identifiers and literals means a
     self-comparison through a getter with side effects (`expect(obj.prop).toBe(obj.prop)`) is not
     flagged either, since `PropertyAccessExpression` is not on the effect-free list — a false negative,
     not a false positive, and the safer direction to be wrong in.
   **Evidence: syntax** — deciding both sub-shapes is pure AST comparison; no type is resolved. Decidable
   from one file, in fact from one call expression. **This ships, enabled by default** once Requirement 6's
   run confirms it, because no ordinary reason to write either sub-shape has been found, and the one shape
   that looks similar and is legitimate (self-comparison of a call expression) is structurally excluded
   rather than merely expected to be rare.

2. **A test with no assertion at all.** Proposed as `no-assertion-free-test`: a call to a conventional
   test-declaration function (an identifier named `it` or `test`, taking a callback) whose callback body
   contains, anywhere in its own syntax tree, no call shaped like a conventional assertion (`expect(...)`
   with a chained matcher, or a call into the identifier `assert` — Node's built-in module, not a
   third-party one, and nameable for that reason). `index.spec.ts` (Introduction) is this shape exactly:
   the callback's only statement references `makeProject` without calling it or checking anything about
   it. **Evidence: syntax.** Decidable from one file for the literal claim — no assertion-shaped call
   appears in this callback's own text — but not decidable for the claim a reader actually cares about,
   which is whether the test checks anything *at all*. A test that calls a locally defined or imported
   helper (`assertValidUser(result)`) that itself performs the real check is invisible to a rule that can
   only see the calling file; the helper's body is a different file or a different, uninlined function,
   and this protocol does not resolve into it. This is a real, not a contrived, false-positive shape —
   shared assertion helpers are ordinary practice in a test suite of any size — so the rule needs a
   configurable escape valve (an `assertionCallees: string[]` option, empty by default per this project's
   no-vendor rule, since a non-empty default would be this pack recommending a specific helper-naming
   convention) and, even with the option available, a codebase that has not been given its own helper
   names will see whatever false positives its own conventions produce. **Shipped, disabled by default**,
   pending Requirement 6's run: the rule's core claim is sound and its `index.spec.ts`-shaped case is
   exactly the value proposition, but the delegated-helper shape is common enough that this pack does not
   assume it away before measuring it.

3. **A mock asserted against itself.** The meaningful version of this claim is: a test configures a
   mock's return value, exercises the code under test, and then asserts only that the *mock's own
   recorded output* reappeared — checking that the mock did what it was told to do, not that the code
   under test did anything with it. Proving that requires knowing whether anything of substance happened
   between the mock's configuration and the assertion, and "nothing of substance happened" is not a
   syntactic fact — a test that asserts pure pass-through *on purpose*, to verify a thin wrapper forwards a
   value unchanged, looks identical to one that accidentally tests the mock instead of the code. This is
   the same shape of question 0028 declined to answer for shared mutable state: not merely hard, but not
   decidable from what this protocol gives an analyzer, because the thing that would decide it — was this
   assertion meant to prove pass-through, or was it meant to prove something the code never actually did —
   is not present in the syntax or the type graph either one. The only sub-case that *is* provable is the
   degenerate one where the exact same expression reads the mock's own call-or-result record on both sides
   of the assertion (`expect(m.mock.results[0].value).toBe(m.mock.results[0].value)`) — and that is not a
   distinct rule, it is candidate 1's identifier-self-comparison shape with a mock-introspection
   expression standing in for a plain identifier, already covered. **Not proposed as a standalone rule.**
   No narrower version than "the degenerate case candidate 1 already catches" was found, and inventing one
   to have something to ship here would repeat T7004's mistake: a plausible-sounding premise nobody
   checked against a real test first.

4. **A test whose only assertion is that a call did not throw.** Proposed as `no-throw-only-assertion`: a
   test body whose sole assertion-shaped call is a negated-throw check (`expect(() => fn()).not.toThrow()`)
   with no other assertion anywhere in the body. **Evidence: syntax** — the shape is a call and a chained
   negated matcher name, nothing more. Decidable from one file. What it proves: this test's entire
   contribution to confidence in `fn` is "it ran without throwing," which says nothing about `fn`'s return
   value, its side effects, or whether it did the right thing rather than merely something legal-looking.
   What it does not prove, and cannot: whether that is actually a weak test. A function whose entire
   contract *is* "throws on invalid input, otherwise succeeds silently" — a validator, a parser used only
   for its side effect of rejecting bad input — is correctly and completely tested by exactly this shape,
   and this rule cannot distinguish that function from one where "didn't throw" is a placeholder for a
   check the author never got around to writing. This is a common, not a contrived, false-positive shape:
   validation and parsing functions are ordinary, and testing them this way is not a mistake. **Shipped,
   disabled by default**, for the same reason as candidate 2 and the T7004 precedent directly: the
   detectable shape is real, but whether it is a defect depends on a fact about the function under test —
   its contract — that this rule has no way to read.

5. **A snapshot with no meaningful content.** The provable sliver of this claim is narrow: a call to a
   conventional snapshot-matching method (`toMatchSnapshot`, a name shared across the snapshot-testing
   convention generally, not tied to naming any one package) whose snapshotted expression is, at the call
   site, a literal carrying no information — `{}`, `[]`, `''`, `null`, a bare numeric or string literal.
   **Evidence: syntax**, decidable from one file, but of limited value: an author who writes
   `expect({}).toMatchSnapshot()` has written something odd enough that it is rare in practice, and the
   claim that actually matters — "the *recorded* snapshot, once written, captures nothing useful even
   though the snapshotted expression looks like real, computed data" — is not decidable from the source
   file being linted at all. It requires reading a second, generated artifact (the on-disk snapshot file)
   that this file's own syntax does not name and that may not exist on the first run, may be excluded from
   analysis the same way `test/fixtures/**` is today, and is not a shape any rule in this project has
   attempted: every existing `scope: 'file'` rule reads the one source file it was asked about, never a
   second file its output implies. **Not proposed to ship.** The narrow literal-at-call-site form is real
   but low-value and mostly redundant with candidate 1's territory; the form worth having — is the
   recorded snapshot itself trivial — needs an architecture (reading a build artifact rather than a source
   file) this spec does not design, and is carried to Open Questions rather than forced into a rule that
   would rarely fire and would not be testing the claim anyone actually means by "empty snapshot."

## Requirement 3 — The one that cannot be done, and what to use instead

"Tests that pass when the code under test is deleted" is mutation testing, and it is not a candidate this
spec narrows — it is excluded outright, because the reason is categorical rather than a matter of degree.
Every rule above, shipped or not, answers its question by reading source once: a syntax tree, optionally
the type graph the checker already built for it. Proving a test would still pass against *mutated* source
— code deleted, a comparison flipped, a boundary shifted by one — requires generating that mutant, running
the suite against it, and recording whether anything failed, repeated once per mutation the technique
wants to try. That is execution, repeated, against changing source; it is not analysis of the source as it
stands, and no `evidence` value or `scope` this protocol defines changes what kind of claim it is. A
single-pass, file-scoped protocol cannot produce it by writing a smarter rule, in the same way `scope:
'project'` does not turn a static call graph into a runtime interleaving (0028, Requirement 2.4). This is
not a weaker version of the claim being proposed instead — it is stated once, plainly, and not chased with
an approximation that would quietly fail differently. Someone who wants this needs a dedicated mutation-
testing tool for their language, run as its own step outside this protocol entirely; consistent with the
project's standing rule against naming a vendor product in a rule's guidance, that recommendation names the
category and not a specific one — the same shape of restraint `no-json-parse-cast`'s guidance already
shows by saying "a runtime schema validator" and naming none.

## Requirement 4 — Scope: how does an analyzer know a file is a test

`index.spec.ts` (Introduction) is the concrete case this decision has to survive, because it satisfies
every signal this pack could use and is still not the thing the pack means by "a test": correct suffix,
real import of `describe`/`it` from a test package, a real call to both. A production file being
misidentified as a test is the failure this requirement is told to weigh most heavily, because these
rules applied to production code are not merely noisy — `no-assertion-free-test` against an ordinary
function would report every function in the codebase, and `no-tautological-assertion` would misfire on any
code that legitimately compares a value to itself for an unrelated reason. That failure mode has to be
foreclosed structurally, not merely made unlikely.

1. **Path/basename convention** — a file whose basename ends in `.test.ts` or `.spec.ts`. This is the
   convention this repository's own 58 test files already use exclusively (`find … -name "*.test.ts"`
   returns 58; exactly one `.spec.ts` file exists in the whole tree, and it is `index.spec.ts` itself). No
   production module in this project, or in ordinary practice, is named this way by accident — the
   specific failure this requirement weighs most heavily (production code wrongly treated as a test) is
   close to structurally impossible under this signal alone, which is exactly why it is chosen as the
   scope gate: **this spec adopts basename convention as the sole scope signal.**
2. **Directory convention** — any file under a directory segment literally named `test`, `tests`, or
   `__tests__` — is rejected as a primary signal, and this repository supplies the counter-example without
   having to invent one: `packages/*/test/fixtures/*.bad.ts` and `*.ok.ts` sit under a `test/` directory
   and are unambiguously not tests — they are the deliberately-wrong and deliberately-right source this
   project's own fixtures are built from. A directory-only signal would apply this pack's rules to fixture
   source written to be bad on purpose, which is close to the worst version of this pack's central risk.
   `checkyourvibe.json`'s existing `exclude` entry for `packages/*/test/fixtures/**` already keeps every
   rule, this pack included, off those files today — but that exclusion exists for an unrelated reason (T7004
   and neighboring rules needed it first) and an adopter's own repository will not necessarily lay fixtures
   out the same way, so this pack's scope decision cannot depend on it.
3. **Declaration shape** — a file that imports a binding named `describe`, `it`, `test`, or `expect`,
   matched on the imported name only and not on the module specifier, so no package is named in the rule.
   This is rejected as the *primary* signal for two reasons: an ambient/global test DSL with no import
   statement at all is common and would be silently invisible to it (a false negative, the safer
   direction, but one that would make the signal inconsistent between two files in the same suite for no
   principled reason); and, more concretely, it is exactly the signal `index.spec.ts` satisfies and the
   basename convention was chosen specifically because it does not resolve that file's ambiguity either —
   adding this signal on top would not have changed the outcome for the one real case this repository has
   to offer.
4. **The disclosed failure mode.** Basename convention is chosen precisely because it makes the *worse*
   failure (production code misclassified as a test) nearly impossible, at the cost of not resolving the
   *lesser* one this repository's own fixture demonstrates: a file that is test-shaped by every available
   signal but is not, in the sense this pack cares about, a test of anything. This spec does not solve that
   case. It is accepted as a standing, disclosed limitation — the same posture `no-non-null-index-write`
   takes toward its loop-bound hole (documented in source, not hidden, not chased with a heuristic that
   would trade one failure mode for a worse one) — rather than either pretending the ambiguity away or
   adding an import- or directory-based second gate whose main effect, as shown above, would be added
   complexity without resolving the one concrete case in front of it. Note also that this project's own
   `exclude` list keeps `index.spec.ts` itself invisible to `cyv check` today, which means the self-
   application run in Requirement 6, run under this repository's ordinary configuration, will not surface
   this exact case either — seeing it requires pointing the tool at `test/fixtures/` directly, overriding
   the exclusion, and that is what Requirement 6.2 asks for.

## Requirement 5 — The interlock

`notFixes` in this pack name real dead ends this pack's own logic or this repository's history actually
produces.

1. **`no-tautological-assertion` and `no-assertion-free-test` trap each other, in both directions.**
   Deleting a weak assertion to silence `no-tautological-assertion` does not make the test better — it
   removes the last assertion the test had, which is precisely `no-assertion-free-test`'s claim. The
   `notFix` on `no-tautological-assertion` reads: "delete the tautological assertion and leave the test
   otherwise unchanged," `rule: 'no-assertion-free-test'`, because a test with one useless check removed
   and nothing put in its place has strictly fewer assertions than it started with, not zero problems. The
   reverse edge is just as real: the tempting non-fix for `no-assertion-free-test` is adding
   *something* that satisfies "a call to `expect`," and the cheapest thing to add is `expect(true).toBe(true)`
   — which trips `no-tautological-assertion` on the same line. This pair is this pack's version of
   0028's `void`/`no-floating-promise` pair: two rules that could each be silenced by a change that only
   the other rule catches, recorded as a pair rather than two independent facts. It is also, honestly,
   presently a pair with one live leg: `no-tautological-assertion` ships enabled and `no-assertion-free-test`
   ships disabled (Requirement 2), so today only the first direction is protection an adopter gets by
   default. The edge is recorded now because it is true now, not because both sides are already enabled —
   the same discipline 0028 used recording the `.catch(() => {})` edge before `no-swallowed-catch` could
   actually see it.
2. **`no-throw-only-assertion` → `no-swallowed-catch`, and this one works today regardless of this pack's
   own state.** The tempting non-fix for a `.not.toThrow()`-only test is to wrap the call in a `try`/`catch`
   whose `catch` block does nothing, converting an explicit (if weak) assertion into a swallowed exception
   with no check at all. `no-swallowed-catch` (`packages/analyzer-typescript/src/rules/no-swallowed-catch.ts`,
   shipped, enabled, `evidence: semantic`) already reports an empty catch block wherever it appears, test
   file or not — nothing in its manifest excludes test code, and this repository's own `checkyourvibe.json`
   does not exclude test files from analysis. The `notFix` on `no-throw-only-assertion` names
   `no-swallowed-catch`, and unlike the previous pair, this edge is live the moment `no-throw-only-assertion`
   ships in any state, because its partner is already enabled.
3. **`no-tautological-assertion` → no interlock target for the identifier-self-comparison sub-shape.** The
   tempting non-fix — replace `expect(x).toBe(x)` with `expect(x).toBeDefined()` or `expect(x).toBeTruthy()`
   to make the assertion *look* different without checking anything more — is a real dead end, and no rule
   in this analyzer today would catch it; a call to `toBeDefined` or `toBeTruthy` on a value known to be
   non-`undefined` is a distinct and harder claim (it needs to know `x`'s possible values) that no rule
   proposed here makes. Following 0028's precedent for exactly this situation (Requirement 3.3, citing the
   Go and Rust analyzers' own real dead ends with no sibling rule), this is recorded as a `notFix` with no
   `rule` field, rather than inventing a target that does not exist.

## Requirement 6 — How each rule gets proven before it ships

The discipline is the one 0007 and 0028 already established, and this pack does not get a lighter version
of it because its false-positive cost is higher, not lower.

1. Before `no-tautological-assertion`, `no-assertion-free-test`, or `no-throw-only-assertion` is enabled
   by default in any configuration, it SHALL be run, unmodified from its shipped form, against every test
   file in this repository — explicitly including `packages/*/test/fixtures/**`, overriding
   `checkyourvibe.json`'s standing exclusion for that run, since Requirement 4.4 already established that
   the ordinary excluded run would never exercise `index.spec.ts`, the one concrete case this spec is
   built around. This repository's 513 tests across 58 files (verified: `find … -name "*.test.ts" | wc -l`
   returns 58) is a legitimate first target and not a hypothetical one.
2. Every violation that run produces SHALL be read individually and judged true or false, the way T7002's
   one finding and T7004's fourteen both were. A count is not triage. For this pack specifically, "true
   positive" means the flagged test really does check nothing meaningful, not merely that the rule's
   syntactic proxy matched — the two can come apart, and `index.spec.ts` is the standing reminder of why:
   a rule can be completely right about what a file's syntax contains and still be reporting the wrong
   thing about what the file is for, and a human triaging the run has to catch that distinction, not just
   confirm the pattern matched.
3. A rule ships enabled by default only if that triage shows every reported violation is a true positive
   in the sense of 6.2. `no-tautological-assertion`'s proposed enabled-by-default status (Requirement 2.1)
   is contingent on this, not a prediction about the outcome — this spec states the rule's premise, not
   its result.
4. **A clean run against this repository is weak evidence, and this spec says so rather than treating a
   zero-false-positive result here as proof.** This project's own test suite was written by the people who
   wrote these rules, over the same period, with the same conventions in mind — it is closer to a rule
   agreeing with its own author than to an independent check. `no-floating-promise`'s credibility rested on
   finding a bug nobody had gone looking for; a test-quality rule finding nothing wrong with the tests its
   own designers wrote proves less than the same result would on a suite this project did not write. This
   pack's precedent for what a real second sample looks like already exists in this project's own history:
   T7009 and T7010 installed the packed tool into an unrelated, real 170-file TypeScript codebase and found
   a defect no fixture had caught. Before any rule in this pack ships enabled on the strength of a clean
   self-application run, it SHALL also be run against at least one real test suite this project's authors
   did not write, chosen for a different testing style or idiom mix than this repository's own, and that
   run's finding count and false-positive assessment SHALL be recorded with the same honesty as T7009's —
   including if it finds nothing, or finds something this repository's own suite never surfaced.
5. A rule whose self-application run — against either sample — produces a false positive SHALL follow the
   T7004 precedent exactly: disabled in `checkyourvibe.json` rather than deleted, with the false-positive
   shape recorded in this pack's own follow-on tasks file in the form T7004 used — the wrong premise stated
   plainly, not just the count.

## Non-goals

Mutation testing, in any approximated form — Requirement 3 excludes it categorically, not provisionally.
A standalone rule for "a mock asserted against itself" — Requirement 2.3 folds its only provable shape into
`no-tautological-assertion` and declines to invent a broader one. Code-coverage measurement — a percentage
of lines or branches exercised is a different, already-solved question than the one this pack answers,
which is whether a given test's own checks can fail; a fully-covered line with a tautological assertion
over it is exactly what this pack is for and coverage tooling cannot see it. Test flakiness detection —
like mutation testing, this needs the suite to be run repeatedly and its outcomes compared across runs,
not read once from source; it belongs, if it belongs anywhere in this project, to a category of tool this
protocol was not built to be. Enforcing a specific assertion library, test runner, or mocking convention —
every rule above names a shape (`expect(...).toBe(...)`, an identifier `assert`, a call named `it` or
`test`), never a package, per this project's standing rule against a vendor recommendation in a rule.
Reading a generated snapshot file's own on-disk content — Requirement 2.5 names this as the version of the
snapshot claim actually worth having and does not design it.

## Open questions

- **Is reading a second, generated file (a snapshot on disk) ever in scope for a `scope: 'file'` rule, or
  does it need a scope value this protocol does not yet define?** Requirement 2.5 leaves the meaningful
  version of the empty-snapshot claim named and undesigned, the same way 0028 left the check-then-act
  pattern named and undesigned. This spec takes no position on whether that is a future extension of
  `scope` or permanently out of reach.
- **Does the delegated-assertion-helper false positive (Requirement 2.2) recur often enough on a second
  real sample that `no-assertion-free-test` should stay disabled indefinitely, the way `no-non-null-index-
  write` did after being narrowed once already, or does the `assertionCallees` option plus one clean run
  clear it for enabled-by-default?** Requirement 6.4's second-sample run is where this gets answered, not
  here.
- **Is `no-throw-only-assertion` a correctness rule this pack should keep chasing, or a category error the
  way 0028 decided "await in a loop" was** — a shape that is sometimes exactly correct depending on a fact
  (the function's contract) this protocol cannot read, rather than a shape that is usually a mistake with
  known exceptions? This spec ships it disabled rather than answering that question either way.
- **This pack's `packs[].intent` and `version`, once 0027 lands, depend on the same unresolved question
  0028 already flagged** — whether pack membership is authored on the rule or the pack — and this spec's
  `test-quality` pack declaration cannot be finalized ahead of that choice for the same reason.
