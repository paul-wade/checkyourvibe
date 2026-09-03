# 0031 — Interlock direction: authoring `notFixes` across languages

**Status:** active
**Created:** 2026-08-28
**Depends on:** 0007 (the `notFixes` interlock itself), 0027 (packs)

## Introduction

0023 (Swift), while working out which of the TypeScript pack's `notFixes` edges around
`no-non-null-assertion`/`no-as-cast` transfer to Swift, found that the "widen to an escape-hatch
type" family reverses direction: TypeScript's `any` disables checking, so every TS edge that ends at
`no-any` runs *toward* the escape hatch. Swift's `Any` still requires a cast before use, so the
corresponding Swift edge would run *away* from the escape-hatch declaration and *toward* the cast
rule instead. 0023 supported this with two more data points, asserting that "Go's
`no-empty-interface` → `no-unchecked-type-assertion` and C#'s `no-dynamic` → `no-unchecked-cast`
already have this same shape, arrived at independently for the same reason."

If a wrong-direction edge really is worse than a missing one — it tells an agent to walk toward the
thing it should be leaving — then whether this reversal is a real, checked property of languages, or
an assumption riding on two examples, matters beyond Swift. This spec exists because 0023's finding is
right about the direction, but overstates how independently it was confirmed, and because working the
question across all four *implemented* manifests turned up a second, more general lesson: a manifest's
silence about an edge is not evidence the language lacks the construct, and conflating the two is a
mistake a future pack author is likely to repeat if nothing says otherwise.

This spec does not belong inside 0027. 0027 governs whether a *pack* — a named, versioned bundle of
rule ids — is honest, stable, and reported when it silently changes; its own Non-goals section
explicitly declines to referee semantic correctness between rules, deferring that to "the existing
`notFixes` interlock validation" (0027 Requirement 4.3, citing 0007). This spec is that validation's
missing prose: not a schema rule, but the reasoning a rule author needs before writing a `notFixes`
entry that names another rule, in any pack, in any language. It is scoped to authoring judgment, the
same register as `packages/analyzer-rust/README.md`'s "where this rule model fits Rust badly" section
— a spec-shaped place for that section to generalize to, rather than each new analyzer's spec
re-deriving it from scratch under time pressure, as 0023 had to.

## Requirement 1 — What was actually verified, stated precisely

**User story:** As someone deciding whether to trust 0023's reversal finding, I want to know exactly
which claims rest on a real, running manifest and which rest on prose in a spec for an analyzer that
does not exist yet, because those are different strengths of evidence and 0023 does not distinguish
them.

1. The escape-hatch-type reversal is confirmed by exactly one implemented, fixture-tested manifest:
   C#'s. `packages/analyzer-csharp/analyzer.manifest.json`'s `no-dynamic` rule carries this notFix
   verbatim: `"Declare the value as \`object\` instead."` → `rule: "no-unchecked-cast"`, `because:
   "\`object\` still leaves every member access unresolved and requires a cast before anything useful
   can be done with it; it does not restore compile-time checking, it just changes which keyword
   defers it."` This is the reversal, in production: the escape-hatch rule (`no-dynamic`) points
   *at* the cast rule, the opposite of every TypeScript edge that points *at* `no-any`. No reverse
   edge exists anywhere in the C# manifest — `no-unchecked-cast`'s own notFixes name only
   `no-null-forgiving`, never `no-dynamic` — so C#'s version of this pattern is a one-way arrow, not
   the symmetric loop TS's `!`⇄`as` pair (or 0023's claimed Swift `!`⇄`as!` pair) forms. That
   asymmetry is itself worth noting: a "reversed direction" finding does not imply the reversed edge
   comes with a return trip.
2. Go's half of 0023's corroboration is not a second data point of the same kind. There is no
   `packages/analyzer-go` directory and no shipped Go manifest — `no-empty-interface` and
   `no-unchecked-type-assertion` exist only as prose in 0021 (`docs/specs/0021-go-analyzer/requirements.md`,
   Requirement 5.2), a spec whose own introduction states plainly that `go` was not installed on the
   authoring machine and every claim in it is "drawn from the documented behavior of the toolchain,
   not from running it here." 0021 Requirement 5.2 does say this edge is "the same shape as the C#
   pack's `no-dynamic` → `no-unchecked-cast` edge, arrived at independently rather than copied" — but
   "independently" there means independently *reasoned*, by someone who had already read the C# pack
   and was designing a new one by the same method. It is not independent *observation*: no Go fixture
   has ever produced this finding, no Go rule has ever been run against real code, and nothing here
   contradicts the C# result — but citing it as a second confirming instance, the way 0023 does,
   overstates what it is. It is the same idea applied twice by design, not the same idea discovered
   twice by accident.
3. Python and Rust are not silent counter-evidence, and they are not confirming evidence either — the
   question does not apply to them as currently modeled. `packages/analyzer-python/analyzer.manifest.json`
   and `packages/analyzer-rust/analyzer.manifest.json` contain no escape-hatch-type rule at all: Python
   has no rule resembling `no-any`/`no-dynamic` (this pack does not model `typing.Any` or any static
   type system), and Rust has no such type either (there is no Rust equivalent of `any` in `core-rust`).
   Neither manifest's silence says anything about whether the reversal holds in those languages; it
   says only that this particular family of rule was never in scope for either pack. A future reviewer
   SHALL NOT read "Python and Rust don't have this edge" as "Python and Rust confirm the TypeScript
   direction" or "confirm the reversed direction" — both readings claim evidence that is not there.
4. This spec's conclusion for 0023: the reversal claim itself SHOULD stand, but its evidentiary
   weight SHOULD be restated as "confirmed once, in an implemented pack (C#), and independently
   re-derived once more by the same reasoning method applied to an unbuilt language (Go)" — not "landed
   on independently" by three languages, which reads as three separate confirmations where there is
   one. This spec does not edit 0023; per the task that produced it, that correction is reported for
   someone else to apply.

## Requirement 2 — Silence in a manifest is not evidence about the language

**User story:** As a rule author reading an existing pack for a language I am about to extend, I want
to know whether an absent edge means "this construct does not exist here" or merely "nobody has
authored this edge yet," because treating the second as the first will make me miss a real escape
hatch my pack should be naming.

1. 0023 Requirement 1.2 claims Swift has no destination for the "suppress with a compiler-directive
   comment" family because Swift has no per-line, per-expression pragma that overrides a type
   mismatch. That specific claim may well be true of Swift — this spec does not check Swift, which has
   no implemented manifest to check. But the same family's *absence* from the three other implemented
   manifests does not mean the same thing in each case, and a pack author who assumes it does will
   misclassify at least two of them:
   - **C# has the construct, named, but no rule targets it.** `no-null-forgiving`'s own notFixes
     include `"Disable nullable reference warnings for the file or project instead of resolving
     individual cases."` with no `rule` field — this is C#'s version of a compiler-directive
     suppression (`#nullable disable`, or a `#pragma warning disable` for the specific nullable
     warning code), named in prose, in the same manifest 0023 cites for the reversed edge, and left
     with nowhere to point because `core-cs` has not authored a dedicated rule for it. This is not "no
     destination because no construct" — it is "no destination because not yet modeled," and the
     manifest itself is the evidence for the difference: it describes the escape by name in a
     `because` clause without being able to route to it.
   - **Python and Rust have the construct, unnamed anywhere in either manifest.** Python's ecosystem
     has `# type: ignore` and `# noqa` as real, idiomatic per-line suppressions; Rust has
     `#[allow(...)]`, including forms like `#[allow(clippy::unwrap_used)]` that would sit directly
     beside `no-unwrap`'s territory. A search of both manifests for these tokens (`noqa`, `type:
     ignore`, `#[allow`, `pragma`) finds zero matches. Neither manifest states, the way 0023 does for
     Swift, that the construct is absent — it simply never comes up, in a pack whose actual rules
     (bare `except`, mutable default args, `.unwrap()`, `unsafe` blocks) are exactly the kind of thing
     a real author reaches for `# noqa` or `#[allow(...)]` to silence.
2. A rule author extending any of these four packs, or writing a fifth, SHALL check the target
   language for a per-line/per-expression suppression mechanism before treating its absence from the
   pack as a design decision. Where the construct exists and is not yet modeled (C#, Python, Rust today,
   per Requirement 2.1), that is an open gap worth a future rule, not a confirmed non-transfer. Where a
   spec asserts, as 0023 does for Swift, that the construct itself does not exist, that assertion SHALL
   be stated as a claim about the *language* — checked against real documentation or a working
   toolchain — not inferred from a sibling manifest's silence.
3. This spec's own contribution is naming the gap, not closing it: Requirement 2.1's three findings are
   left as an open question (see below) for whichever future revision of `core-cs`, `core-py`, or
   `core-rust` takes it up, rather than rules this spec invents in a document it is not permitted to
   implement rules from.

## Requirement 3 — Two structurally different edge families, not one

**User story:** As a rule author deciding whether a new edge needs the direction-check Requirement 1
describes, I want to know which of a rule's `notFixes` are even candidates for reversal, so I do not
spend the same scrutiny on every entry when only one family has ever shown the failure mode.

1. **The escape-hatch-type family** — an edge whose destination is a type or construct that removes or
   relaxes static checking (`any`, `dynamic`, `interface{}`, `Any`) — is the only family this
   investigation found to reverse direction, and it reverses specifically because languages disagree
   about what that destination construct *does*: TypeScript's `any` disables checking outright; C#'s
   `dynamic`-adjacent `object`, Go's proposed `interface{}`/`any`, and Swift's proposed `Any` all still
   require a cast to consume. An edge in this family is a factual claim about whether the named
   destination type requires a checked operation before use, and SHALL be verified against that
   language's actual semantics — never assumed from another language's rule of a similar name.
2. **The silence/discard family** — a rule whose violation is failing to observe or propagate an
   outcome (an empty `catch`, a bare `except:`, `let _ = result`, an unhandled promise rejection) —
   shows the opposite property everywhere it was checked: it tends to have *no* cross-rule notFix at
   all, in any of the four implemented manifests. Every one of Python's four rules (`no-bare-except`,
   `no-mutable-default-arg`, `no-assert-for-validation`, `no-star-import`) has zero `notFixes` entries
   with a `rule` field — the entire `core-py` pack is edge-free. C#'s `no-empty-catch` is the same:
   both of its notFixes lack a `rule` field. TS's `no-console` is the same again. This is not an
   accident of these four packs being incomplete; it follows from what the violation *is*. A discarded
   error has no adjacent, differently-named type-level escape to relocate into the way a type
   annotation does — the only nearby moves (a justifying comment, an alias, a narrower exception class
   that is still empty) are cosmetic restatements of the same discard, which is exactly why every
   implemented manifest's `because` text for these describes the rewrite as "still the same violation"
   rather than naming a different rule. A rule author writing this shape of rule SHOULD expect it to be
   terminal or near-terminal by default, and SHOULD treat a claimed cross-rule edge on this family as
   the one needing the stronger justification, not the reversal-prone escape-hatch family.
3. A third, narrower shape recurs across the two manifests that have it at all: a **terminal rule for
   an operation the language makes irreducibly, deliberately explicit** — Rust's `no-unsafe-block`
   (`packages/analyzer-rust/README.md`: "its plausible non-fixes ... do not launder the problem into a
   different rule in this pack, and inventing an edge to make the graph look denser would teach an
   agent to distrust the edges that are real") and Go's proposed `no-panic-in-library` (0021
   Requirement 5.5: "this pack has no sibling 'dangerous but explicit' rule for a relocated panic to
   fall into"). Both are reached the same way: several *other* rules' dead ends converge on them
   (Rust's `no-unwrap`, `no-panic-in-library`, and `no-ignored-result` all end at `no-unsafe-block`;
   Go's proposal has no such convergence because it has no sibling unsafe-marker rule at all), and
   neither has an outbound edge of its own. This is the same shape as Requirement 3.2's silence family
   for a different reason: not because discarding information has no adjacent escape, but because the
   language has already put the most-dangerous operation at the bottom of its own escape hierarchy, and
   there is nowhere further down to relocate to. A rule author who finds several edges converging on one
   rule with no way back out SHOULD treat that convergence as a sign the rule is doing its job, not as a
   gap to fill with an invented edge — the precedent both the Rust README and 0021 Requirement 5.5
   already state for their own packs generalizes as a rule of authoring, not a coincidence of two
   packs.

## Requirement 4 — The one thing to tell a rule author about direction

**User story:** As someone about to write a `notFixes` entry that names another rule in a different
language's pack than the one it was modeled on, I want the single check that would have caught 0023's
overclaim, so I run it before publishing the edge rather than after a reviewer catches it.

1. A `notFixes` entry is a claim about what a specific, named construct in *this* language actually
   does at compile time or run time when an agent reaches for it — never a claim inherited from a
   same-named or similar-looking construct in another language's pack. Before writing an edge of the
   escape-hatch-type shape (Requirement 3.1), the author SHALL answer concretely, for the actual
   language: does the destination construct let a value be *used* — a member read, a method called, an
   element indexed — without a checked operation in between? If yes, the edge runs toward it (the
   TypeScript shape). If no — if some cast, unwrap, or pattern match is still required before the value
   is usable — the edge runs away from it, toward whatever rule governs that required operation (the
   C# shape, and 0023's corrected Swift shape). Getting this backward is not a cosmetic error: it tells
   an agent that the escape hatch is where the fix ends, when in this language it is where the next
   violation begins.
2. A manifest's silence about an edge is worth one further check before it is trusted as "this language
   doesn't have that problem": does the language actually have the construct the edge would name
   (Requirement 2)? An author reusing another pack as a template SHALL check the target language's own
   documentation for the construct, not the source pack's coverage of it, before concluding either "this
   transfers" or "this doesn't apply here."

## Non-goals

Adding, removing, or renaming any rule or `notFixes` entry in any analyzer manifest — this spec is
authoring guidance, not a rule change, and `packages/**` is out of scope for the investigation that
produced it. Deciding whether `core-cs`, `core-py`, or `core-rust` should gain a suppression-comment
rule (Requirement 2's open gap) — left to whoever next revises those packs. Editing 0023 — its
correction (Requirement 1.4) is reported, not applied, per the scope of the investigation this spec
records. Formal, tool-enforced verification of edge direction (e.g., a validator that checks a
destination construct's semantics automatically) — Requirement 4 is a question a human or agent
answers by reading the language's own documentation before publishing an edge, not a check `cyv
verify-analyzer` can run today.

## Open questions

1. **Should `core-cs`, `core-py`, and `core-rust` each gain a rule for their language's
   compiler-directive/linter-suppression comment** (`#pragma`/`#nullable disable`, `# noqa`/`# type:
   ignore`, `#[allow(...)]`), the way `core-ts` has `no-ts-comment`? Requirement 2 only establishes that
   the gap exists and is not the same gap as Swift's; whether it is worth closing, and at what
   evidence cost (a `#[allow(...)]` attribute is trivially syntactic; recognizing which specific lint it
   suppresses may not be), is left to a future revision of each pack.
2. **Is a one-way escape-hatch-type edge (C#'s shape) or a two-way loop (TypeScript's and 0023's
   proposed Swift shape) the more honest default for a language whose forced operators are
   runtime-checked rather than silent?** C#'s `no-unchecked-cast` does not point back at `no-dynamic`
   even though switching from a checked cast to `dynamic` is also a plausible tempting rewrite in the
   other direction. Whether that is a considered omission or an unauthored edge in `core-cs` is not
   answered by anything this investigation read, and is worth asking whoever maintains that manifest.
3. **Does the silence/discard family (Requirement 3.2) ever legitimately need a cross-rule edge, or is
   "terminal by default" the correct permanent shape for it?** This spec found zero counter-examples
   across four manifests, which is suggestive but not a proof that no such edge could ever be honest —
   only that none of the packs examined here have found one.
