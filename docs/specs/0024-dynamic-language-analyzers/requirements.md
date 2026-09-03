# 0024 — Ruby and PHP analyzers: Requirements

**Status:** the gate in Requirement 1 has since been met — see "The evidence arrived" below.
The recommendation it produced is unchanged in shape but now rests on data rather than on a
projection.
**Created:** 2026-08-28
**Depends on:** 0001, 0009, 0029

## Introduction

The roadmap gates this entry explicitly, and the gate is the reason this document exists rather than
a rule pack: "Dynamically typed, like Python, and therefore mostly `evidence: syntax`. Worth doing only
once the Python analyzer has been pointed at a real codebase and its syntax-only findings have been
judged useful or not. Building two more analyzers with the same limitation before answering that
question would be building on an untested assumption."

That question has now been partly answered. `docs/STATUS.md` records a run of the Python analyzer
against a real, unrelated 16-file codebase: zero findings, with a positive-control probe file —
one deliberate instance each of a bare `except:`, a mutable default argument, a validating `assert`,
and a wildcard import — producing exactly four findings, one per rule. The zero is a clean sample, not
a broken analyzer; that distinction was checked rather than assumed, which is exactly right.

It is also thin evidence, in either direction, and this spec's first obligation is to say so rather than
round it up. Sixteen files is a demonstration that the rules *can* fire, not a demonstration of how
often they *should*. A codebase that happens to be written carefully could go far larger than sixteen
files and never trip any of these four patterns, and that would say nothing bad about the rule model —
it would just mean the sample was clean. The inverse is equally true: a codebase an order of magnitude
larger, in a different style of Python (a scientific-computing script collection, a decade-old web
service, a pile of one-off automation), could turn up real findings the 16-file run was never going to
surface, because it never had the chance to. Neither reading is available from this one run alone.

**What a sufficient test looks like.** Three things this run did not have, and the next one needs:

- **Scale.** Sixteen files is a toy sample next to the scale at which this project's own founding
  defect was actually found — 170 real TypeScript files, in spec 0029's own account, and even that run
  turned up a problem (a solution-style tsconfig) that a smaller sample had already missed twice. A
  Python run an order of magnitude larger — on the order of several hundred files, not sixteen — is the
  minimum this spec would treat as informative rather than anecdotal.
- **Variety.** One codebase is one style. Bare `except:` and `assert`-as-validation are habits that vary
  enormously by community and era; a codebase that avoids all four happens not to prove the four are
  rare in general. At least one additional, unrelated real codebase — ideally in a different domain than
  whatever the first one was — is needed before "found nothing" or "found something" generalizes past a
  single sample.
- **A codebase this project's authors did not write and did not have in mind while writing the rules.**
  The same caution `docs/STATUS.md` already states for `no-tautological-assertion` — "a suite written by
  the same people who wrote the rule is a weak sample" — applies with more force to a real-codebase
  judgment than to a fixture pass, because the fixture pass is expected to be favorable by construction
  and the real-codebase run is not supposed to be.

**What result would justify or refuse the next two analyzers**, stated in advance rather than decided
after seeing the number, per T7002 and T7004's own precedent of a human reading each finding rather than
trusting a count: a run meeting the scale and variety above that turns up findings judged real on
inspection (T7002's `no-floating-promise`, not T7004's `no-non-null-index-write`) is evidence the
syntax-only shape earns its keep and Requirement 1 below should move from "not yet" toward "yes." A run
at that scale that again finds nothing is a materially stronger signal than the 16-file run — not proof,
but a real answer — and argues for revising what `core-py`'s four rules look for before spending the
same effort twice more on the same shape. A run that finds many violations that turn out to be mostly
wrong on inspection (the `no-non-null-index-write` shape) argues against extending the model at all
until that failure mode is understood, because Ruby and PHP would inherit it by construction.

## The evidence arrived, and it argued both ways

This spec was written while the Python analyzer had been run against sixteen real
files and found nothing. Requirement 1 asked for a run an order of magnitude
larger before Ruby or PHP could be justified. That run has now happened — 318
files from three unrelated real codebases — and it changes what this spec rests
on.

Two things came out of it, and they point in opposite directions.

**The plumbing was broken and the small sample hid it.** The analyzer checked
*zero* of the 316 files in the first attempt: `write_response` wrote non-ASCII to
a Windows stdout defaulting to the system codepage, `UnicodeEncodeError` killed
the process, and every file came back skipped. The sixteen-file sample that
"passed" had been pure ASCII. So the clean result this spec was gated on was not
a result at all — which is an argument for the bar Requirement 1 sets, not
against it.

**And the rules are not yet trustworthy at scale.** With the crash fixed: 398
findings, of which 353 were `no-assert-for-validation` — and 335 of those were
inside test files, where `assert` is the idiomatic assertion and the rule's
premise about `-O` is true but irrelevant. A 95% false-positive rate, discovered
only at this scale. After excluding test files by the convention the Python
runners use for discovery: **65 findings across 318 files** — 34 mutable default
arguments, 13 bare excepts, 18 asserts outside tests.

**What this does to the recommendation.** The bar is met and the answer is still
wait, for a changed reason. It is no longer "we do not know whether syntax-only
rules find anything" — they do, at a believable rate. It is that the Python pack
needed two corrections at its first real scale, and neither was visible from
fixtures or from a small sample. Building two more analyzers of the same kind
before that pack has been stable against a codebase nobody here wrote would be
copying a shape that has not finished settling.

The concrete condition, replacing the projected one: **the Python pack runs
against a real codebase not selected by us, and needs no correction.** That is
one round-trip away, not a research programme.

## Requirement 1 — The gating question, answered explicitly

**User story:** As someone deciding whether to spend the effort that built four analyzers on two more
with the identical evidentiary shape, I want an explicit recommendation rather than the roadmap's
condition left open for whoever gets to it next to interpret however suits the moment.

1. **Recommendation: not yet.** Ruby and PHP analyzers SHALL NOT be started until the Python analyzer
   has been run against at least one further real, unrelated codebase meeting the scale and variety
   named in the Introduction, and the combined result across both runs has been judged by a human
   reviewer — not inferred from a finding count alone — as either "found something real" or "found
   nothing, credibly, because the sample was large and varied enough to trust the absence."
2. This is a "later," not a "never." Nothing in this spec argues the syntax-only shape is worthless —
   the positive control already proved the plumbing (parsing, walking, reporting, skipping, exit codes)
   is sound, and that part of the question is closed. The caution is entirely about sequencing: the
   roadmap set a specific condition, one small clean run does not meet it, and this spec's job is to
   hold that line rather than relax it because the first data point happened to come back quiet.
3. Should the additional Python run land before this document is next revisited, whoever picks it up
   SHALL update the Status line above rather than begin Requirement 3's candidate rules against a gate
   this spec records as unmet today.
4. This gate applies identically to both languages named in this spec's title. Requirement 2 finds real
   differences between Ruby and PHP, but "has the Python evidence accumulated enough to justify a third
   language of the same evidentiary shape" is not one of the places they differ.

## Requirement 2 — One analyzer, two, or a shared question with two separate answers

**User story:** As someone about to scope a Ruby or PHP pack, I want to know whether the roadmap's
pairing of the two under one entry number reflects a real similarity or just alphabetical or thematic
convenience, so I do not design one pack and stretch it over both languages.

1. Ruby and PHP share the property the roadmap names — dynamically typed, mostly `evidence: syntax` —
   but they differ on the two axes that actually decide whether a syntax-only pack is honestly scoped:
   whether the language has any typing discipline in general use, and whether an established,
   widely-adopted static-analysis tool already occupies the territory a starter pack would otherwise
   claim.
2. **PHP has gradual, in-language typing and two mature third-party tools that do real cross-file
   inference over it.** Scalar and return type declarations, nullable types, and union types are part of
   the language itself (not bolted on externally), and PHPStan and Psalm both perform genuine type-flow
   analysis on top of that — resolving a class hierarchy, tracking a variable's inferred type across
   branches, and flagging a call that cannot type-check given what was declared. This is a materially
   different landscape from where Python sits: Python also has mypy and pyright, but a large share of
   real Python carries no type annotations for either to check, whereas a PHP codebase with type
   declarations at all gives PHPStan or Psalm something immediate to work with even at a low strictness
   setting.
3. **Ruby's typing is external, optional, and not close to universal in real code.** RBS with Steep, or
   Sorbet, exist and are used seriously at some organizations, but the great majority of Ruby in the
   wild — including most open-source Ruby — carries no type signatures for either to check. A Ruby
   analyzer is syntax-only not as a design choice weighed against gradual typing the way a PHP one would
   be; it is syntax-only because that is nearly the only evidence available for nearly all real Ruby,
   which is a much closer parallel to Python's own actual position than to PHP's.
4. **Decision: two packs, most likely two analyzer packages, one spec.** `core-ruby` and `core-php`
   answer different honest-scope questions (Requirement 3) and sit next to different ecosystem
   incumbents (Requirement 4), so they are not one pack wearing two names — the same reasoning that
   already forced Java and Kotlin apart as "one analyzer or two" in the roadmap's own framing of that
   entry applies here for a different, language-specific reason. They share this one requirements
   document because the actual shared question — has the Python evidence accumulated enough to justify
   a third language of this evidentiary shape — is one question with one answer (Requirement 1), and
   splitting it across two files would either repeat the same argument twice or silently let one
   language's gate drift from the other's.
5. Once Requirement 1's gate is met, the two packs SHALL be free to ship as independent implementation
   tasks on independent timelines. Nothing in this spec requires them to land together, and Requirement
   6's open question about whether Ruby is worth building at all is a real possibility that a shared
   ship date would obscure.
6. No shared cross-language abstraction — a common base rule class, a shared configuration schema, a
   `dynamic-language` pack umbrella — is proposed here. Inventing one to make two differently-scoped
   packs look like a single feature would be the same mistake 0010 and 0031 warn against for a
   manufactured `notFixes` edge, applied to packaging instead of interlock: it would make the project
   look more unified than the underlying analysis actually is.

## Requirement 3 — What syntax-only rules can honestly claim in each language

**User story:** As someone drafting a starter pack for either language, I want candidate rules that were
checked against that language's actual semantics, not carried over from `core-py` by name resemblance —
0031's own lesson, that a construct's behavior must be verified in the target language and never
inherited from a same-named or similarly-shaped one elsewhere.

1. **The direct port fails on inspection, and that failure is the most useful finding this section
   has.** `no-mutable-default-arg` exists because Python evaluates a default argument expression exactly
   once, at `def` time, so a list or dict literal in a default position is shared across every call that
   omits it. Ruby does not have this behavior: a Ruby method's default argument expression is
   re-evaluated on every call, so `def append(item, items = [])` allocates a fresh array each time
   `items` is omitted. The bug `no-mutable-default-arg` exists to catch is not merely rare in Ruby — the
   language does not have the evaluation-timing property that makes it possible at all. A pack author
   who ported this rule by name would ship a rule with no true positives to find, ever, in any Ruby
   program, which is a stronger and more specific failure than a merely low-value rule. This is
   Requirement 4's own reasoning method (checked against the language's actual documented semantics, not
   assumed from a sibling pack) applied before a single rule was proposed, not after one was shipped and
   found wrong.
2. **Ruby candidates**, each stated with its evidence class:
   - `no-rescue-exception` — a `rescue` clause that explicitly names `Exception` (`rescue Exception =>
     e`), as opposed to a bare `rescue` with no class, which already defaults to `StandardError` and so
     already excludes `SignalException`, `SystemExit`, `NoMemoryError`, and `Interrupt`. This is Ruby's
     actual analogue of Python's bare `except:` — the too-broad catch — and it is *not* the same
     construct as a bare `rescue`, which is comparatively narrow already. **Evidence: syntax**, with the
     same accepted limitation the Python and Go packs already document for a similarly-named built-in:
     `Exception` could in principle be a locally shadowed constant rather than the real global class, and
     distinguishing the two needs a symbol lookup this rule does not perform.
   - `no-empty-rescue` — a `rescue` clause (bare or typed) whose body is empty or contains only a
     comment, silently discarding whatever was raised. **Evidence: syntax** — an empty body is visible
     from the parse tree alone.
   - `no-dynamic-eval` — a call to `eval`, `instance_eval`, `class_eval`, or `module_eval` whose argument
     is not a string literal (i.e., a dynamically constructed string), the shape that turns ordinary
     input into executable Ruby. **Evidence: syntax** — whether the argument is a literal or a
     constructed expression is a grammar-level fact.
   - `no-string-to-sym-injection`-style dynamic method dispatch (`send`/`public_send` with a
     non-literal method-name argument) was considered and is deliberately not proposed: distinguishing a
     legitimate dynamic-dispatch pattern from an injection risk needs more context than a parse tree
     gives honestly, and a rule this pack cannot judge honestly is a rule 0009's own Non-goals already
     says should not ship.
3. **PHP candidates**, each stated with its evidence class:
   - `no-loose-comparison` — `==` or a `switch` statement used where PHP's type-juggling comparison
     rules are the documented source of surprising results (numeric-string coercion, and pre-8.0's
     famous `0 == "abc"`). **Evidence: syntax** — the `==` versus `===` token, and `switch` versus
     `match`, are both visible without evaluating either operand's type.
   - `no-error-suppression-operator` — the `@` operator applied to an expression, silencing every
     runtime notice, warning, and recoverable error the expression could produce. **Evidence: syntax** —
     `@` is a prefix token, not a value that needs resolving.
   - `no-extract-and-variable-variables` — a call to `extract()`, `compact()` used to build an opaque
     variable set, or a variable-variable (`$$name`). Each creates or reads local variables whose names
     are not visible in the source text, which is the same "makes static analysis of this very file
     unreliable" shape `no-star-import` targets in Python. **Evidence: syntax.**
4. Every rule named above is a candidate, not a committed pack. Requirement 1's gate applies to all of
   them before any is implemented, and Requirement 6 requires toolchain verification before any is
   implemented even after the gate opens.

## Requirement 4 — What each language's own ecosystem already covers

**User story:** As someone deciding whether a candidate rule is worth a process launch, I want to know
what the language's own widely-used tooling already tells the user for free, because a rule that repeats
that is not a rule, it is a slower version of something the user already has — spec 0021 makes this
argument about `go vet`, and it applies with more force here, because both PHP and Ruby have tooling
with a materially larger footprint in real projects than `go vet`'s opt-in analyzer set.

1. **PHP.** PHPStan and Psalm are both mature, widely used, third-party static analyzers that perform
   real cross-file type-flow analysis over PHP's gradual type system — resolving a class hierarchy,
   tracking a variable's inferred type across a function body, and reporting when a call cannot
   type-check given what was declared. Neither tool's job is threatened by anything in Requirement 3:
   none of the three PHP candidates ask a type-flow question. `no-loose-comparison`,
   `no-error-suppression-operator`, and `no-extract-and-variable-variables` are all true regardless of
   whether the file being checked has a single type declaration in it, which is exactly the territory
   neither tool's primary mission covers — the same relationship `core-ts` has to `tsc` and `core-rust`
   has to `cargo check`/`clippy`, rather than a competing claim on the same ground.
2. **Ruby.** RuboCop's default cop set already occupies a meaningfully large slice of exactly the
   "escape hatch" territory a starter pack like `core-py`'s would otherwise target — its published
   documentation describes a default-enabled `Lint/RescueException` cop covering an explicit `rescue
   Exception`, a default-enabled `Lint/SuppressedException` cop covering an empty rescue body, and a
   `Security/Eval` cop covering `eval` usage. That is three of Requirement 3's four Ruby candidates,
   named in the published cop documentation, not verified by running RuboCop here (Requirement 6 records
   why). This is a materially different risk than PHP's: PHPStan and Psalm are adopted deliberately, at
   a chosen strictness level, by a project that opted in; RuboCop with its stock configuration is close
   to a default expectation in professional Ruby work, which means the overlap is not merely possible,
   it is the likely case for any Ruby project that would install this tool at all.
3. Because of Requirement 4.2, a Ruby rule proposed under this spec is not honestly scoped by checking it
   against real Ruby code alone. It SHALL also be checked against RuboCop's own default-configuration
   output on the same code, and a rule that only fires where RuboCop's stock configuration already
   flags nothing new is not worth shipping — the same "not a rule, a slower compiler error" standard
   Requirement 1 of 0021 applies to `go vet`, made a literal per-rule check here rather than a one-time
   background fact, because the overlap risk for Ruby specifically is this concrete.

## Requirement 5 — 0029 compliance for a language with no compilation step

**User story:** As a reviewer checking this spec against the standing obligation every new analyzer
carries, I want to know whether "no compiler, therefore nothing to degrade" is really true here, or
whether it is being used to wave the requirement away without checking it.

1. Every candidate rule in Requirement 3 declares `evidence: 'syntax'`. None resolves an import, a
   `require`, a `use` statement, a class hierarchy, or a project configuration file of any kind. Per 0029
   Requirement 1.5, an analyzer with no reduced resolution mode has nothing to report in
   `AnalyzeResponse.degraded`, and per 0029 Requirement 3.2, this is the trivial-pass case — the same
   position the Python and Rust analyzers already occupy, and `capabilities.degradableResolution` need
   not be declared by either pack today.
2. That is not the same as the requirement being vacuous for these two languages in general, and this
   spec says so rather than let the "no compiler" framing quietly stand in for "the question does not
   apply." **PHP has a real project-configuration surface even though nothing here resolves it yet**:
   Composer's autoloader (`composer.json`, `vendor/autoload.php`) and a project's declared PHP version
   constraint are exactly the kind of per-project configuration a future `evidence: semantic` PHP rule
   — one that needed to resolve a class hierarchy or a `use`d namespace, for instance — would have to
   read correctly or degrade honestly about, playing the same role a `tsconfig.json` plays for
   TypeScript and a `go.mod` plays for Go's proposed `no-ignored-error`. Nothing in Requirement 3 touches
   it, so the day a semantic PHP rule is proposed, it inherits 0029 Requirement 1 in full rather than
   being told the language doesn't have this problem.
3. **Ruby's version of the same surface is thinner but real**: `Gemfile`/`Gemfile.lock` and
   `require`/`require_relative` resolution are Ruby's nearest analogue, but no candidate in Requirement 3
   resolves a require path or a gem dependency, so Ruby is the fully vacuous case today, in the same
   position as Rust.
4. This distinction — "nothing to report because nothing here resolves configuration" versus "the
   requirement doesn't apply because there's no compiler" — is the one a future reviewer should not
   collapse. The first is 0029's trivial-pass case, checked and current. The second would be the same
   mistake 0031 names for manifest silence: absence of a semantic rule today is not evidence the
   language lacks anything to degrade, only that nothing proposed here needs it yet.

## Requirement 6 — Toolchain reality, verified rather than assumed

**User story:** As someone about to authorize implementation work on either pack, I want to know whether
the toolchain exists on the machine that would build it, so this spec does not repeat 0021's original
gap — a spec written before anyone checked whether Go was installed — without at least closing that gap
for itself.

1. **Verified while writing this document, not assumed**: neither `ruby` nor `php` resolves on this
   machine's `PATH` (`ruby -v` and `php -v` both fail with "command not found"). This spec is written
   from the same position 0021 (Go) and 0023 (Swift) recorded for their own toolchains, and adopts the
   same discipline both already established — every claim above about PHP's type system, Composer,
   PHPStan/Psalm's coverage, Ruby's per-call default-argument evaluation, and RuboCop's default cop set
   is drawn from each language's or tool's published documentation, not from running anything here.
2. The concrete cost of skipping this is already recorded in this project's own history: the roadmap's
   note on 0021 states the Go analyzer "was dispatched and correctly refused to scaffold a package it
   could not build, test, or claim conformance for," per 0029's own requirement that a real-codebase run
   gates every new analyzer, and "a package nobody can run is worse than none." That refusal was the
   correct outcome, but it was discovered by dispatching the work and having it stop, not by checking
   first. This spec requires the check first.
3. **A parser decision follows directly from which toolchain is actually present, and it forks the two
   languages differently.** Ruby's standard library ships `RubyVM::AbstractSyntaxTree` (a real
   node-based parse tree, the direct analogue of Python's `ast` module) with no third-party dependency
   needed — the same zero-dependency discipline 0009 held Python to. **PHP has no standard-library
   AST at all** — only `token_get_all()`, a flat token stream with no tree structure, which is not what
   any other syntax-only analyzer in this project walks. A PHP analyzer therefore needs either a
   hand-built tree reconstructed from that token stream, or the third-party `nikic/php-parser` package —
   the same library PHPStan and Psalm are themselves built on. This is not a new kind of exception: 0010
   already accepted a third-party parser (`syn`, `proc-macro2`) for Rust specifically because Rust
   exposes no usable parser from its own standard library, and "no vendor in a rule" (the ROADMAP's own
   principle) governs what a rule's *remediation guidance* may recommend to a user, not what an
   analyzer's own implementation is built on. PHP's position is closer to Rust's than to Python's or
   Ruby's, and the pack SHALL be scoped with that dependency decided rather than assumed away.
4. Before a single rule from Requirement 3 is coded for either language, an implementation task SHALL
   verify the toolchain end to end on the actual target platform(s): for Ruby, `ruby -v` and a smoke
   test parsing a real file with `RubyVM::AbstractSyntaxTree.parse`; for PHP, `php -v` and a smoke test
   of whichever parsing path Requirement 6.3 settles on. This is the same discipline 0004 applied to
   .NET before a line of C# was written, and 0021 and 0023 both applied after the fact, in writing, for
   Go and Swift — applied here before any implementation task begins rather than recorded as a caveat
   once one already has.
5. WHEN either toolchain is absent from a future implementation environment's `PATH`, that SHALL be
   surfaced as a named, actionable report — "the Ruby (or PHP) analyzer is configured but the `ruby` (or
   `php`) toolchain was not found" — never a raw spawn error, matching the requirement every other
   subprocess-based analyzer in this project already carries for its own toolchain.

## Registration

Neither analyzer SHALL be added to this repository's own `checkyourvibe.json` by default, for the same
reason the Python, Rust, Go, and Swift analyzers are not: there is no Ruby or PHP source in
checkyourvibe to check, and registering an analyzer that will never match a file would add a toolchain
prerequisite and a process-launch cost to every `cyv check` for zero benefit. This applies independently
of Requirement 1's gate — even once the gate opens and one or both packs are built, registration here
still has nothing to check against.

## Non-goals

Building either analyzer now — Requirement 1 gates that explicitly, and this document is the gate, not
an implementation plan. Competing with PHPStan's or Psalm's type-flow analysis, or with RuboCop's default
cop set, in either direction (Requirement 4). A shared cross-language pack, base class, or configuration
layer spanning both languages (Requirement 2.6) — the two packs are separately scoped and stay that way.
Resolving a Composer autoloader or a Gemfile's dependency graph — flagged in Requirement 5 as a future
semantic rule's obligation, not this spec's. Any rule declaring `evidence: 'semantic'` — nothing proposed
here needs one, and 0029's obligations for one are left for whoever first proposes it. Deciding PHP's
parser dependency (Requirement 6.3) definitively — flagged as a real fork with a precedent to reason
from, not resolved here without a working PHP toolchain to prototype against.

## Open questions

1. **Does Ruby survive Requirement 4's overlap risk at all, once RuboCop's default output is actually
   checked against real code?** If a real toolchain check confirms RuboCop's stock configuration already
   flags everything Requirement 3.2 proposes, `core-ruby` may not be worth building even after
   Requirement 1's gate opens, and PHP could proceed alone. This spec does not resolve that question; it
   makes checking it a precondition (Requirement 4.3) rather than an afterthought.
2. **Should the PHP parser question (Requirement 6.3) be settled by a spike before this spec's
   implementation task begins, given that the choice changes the dependency story for the whole
   analyzer?** Left to whoever picks this up with a working PHP toolchain in hand, per the same reasoning
   0021 left `go/importer`'s real-world reach as an empirical question rather than a design commitment.
3. **Does Requirement 1's real-codebase run need to happen once, covering both a bigger Python sample
   and the first Ruby/PHP samples together, or does each language need its own independent real-codebase
   run before its own pack is considered complete** (0029 Requirement 5's standing obligation, applied
   per-language the way it already was for Swift)? This spec assumes the latter — Requirement 1 is
   about Python specifically, and 0029 Requirement 5 would apply to Ruby and PHP again, separately, once
   each pack exists — but does not restate 0029's own requirement in full here.
4. **What does "judged useful" mean operationally, beyond a human reading each finding the way T7002 and
   T7004 were read?** Whether a numeric threshold (a minimum true-positive rate, say) should be fixed in
   advance of the next Python run, so the judgment is not made after the number is already known, is the
   same integrity concern 0018 raises about rule-quality metrics generally, and is not settled here.
