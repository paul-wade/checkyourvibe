# 0023 — Swift analyzer: Requirements

**Status:** active
**Created:** 2026-08-28
**Depends on:** 0001, 0007, 0029

## Introduction

A sixth analyzer, for Swift, on SwiftSyntax. The roadmap does not frame this as "another
language" — it frames it as a test of the rule *model* itself: Swift has force-unwrap (`!`) and
force-cast (`as!`), near-exact syntactic analogues of the TypeScript pack's
`no-non-null-assertion` and `no-as-cast`. Every analyzer built so far has needed its own pack,
authored from nothing, because the languages differed too much for anything to carry over
directly. Swift is the first case where two rules already look identical by name. The question
this spec exists to answer is whether the `notFixes` graph around those two rules — the thing
that makes this project's guidance worth more than a bare lint message — also carries over, or
whether the resemblance is only skin-deep and the graph has to be rebuilt from the language
outward regardless. Requirement 1 does that work edge by edge; the rest of this spec, including
which rules ship at all, follows from its answer rather than preceding it.

**Not verified on this machine before writing this spec.** `swift` is not on this machine's
`PATH` — confirmed by running `swift --version` while writing this document, which failed with
`command not found`. Every claim below about SwiftSyntax's node kinds, about which forms are
distinguishable from a parse tree alone, and about `swift run`'s and Package.swift's behavior is
drawn from the documented shape of the language and the toolchain, not from compiling anything
here. 0021 recorded the same limitation for Go and treated toolchain verification as the first
implementation task rather than a paragraph in the spec; Requirement 7 does the same here, and
Requirement 6 explains why Swift's version of that gap is worse than Go's.

## Requirement 1 — The transfer question, worked edge by edge

**User story:** As someone deciding whether to author a fifth rule pack from scratch or adapt an
existing one, I want to know precisely which parts of a working pack's interlock are portable
knowledge and which parts were accidents of one language's design, so that the next language
after this one is scoped honestly instead of by hope.

This spec examines every `notFixes` entry in the TypeScript manifest
(`packages/analyzer-typescript/analyzer.manifest.json`) that names `no-non-null-assertion` or
`no-as-cast` — either as the rule under test or as another rule's declared dead end — because
those are the two rules with a named near-exact Swift analogue. Across the pack, that is nine
distinct edge *patterns* (some repeated verbatim on multiple rules): swap `!` for `as` and back;
suppress with a compiler-directive comment; widen to `any`; move the cast onto a parsed-JSON
result; and a handful of single-rule specific relocations (`no-floating-promise`,
`no-swallowed-catch`, `no-broad-catch-rethrow`, `no-unsafe-index-access`,
`no-unsafe-array-narrowing`, `no-non-null-index-write`). Each is worked below.

1. **The `!` ⇄ cast swap transfers, and Swift's version of it is tighter than TypeScript's own.**
   `no-non-null-assertion`'s notFix "cast the value to the desired type instead" points at
   `no-as-cast`; `no-as-cast`'s notFix "assert the value is non-null with `!` instead of proving
   it" points back. In Swift the identical swap is not a loose family resemblance, it is a
   documented idiom: the tempting rewrite of a bare force-unwrap `dict["key"]!` is
   `dict["key"] as! String`, and the tempting rewrite of a bare force-cast `x as! T` is
   `(x as? T)!` — cast safely to an `Optional`, then force-unwrap the `Optional` immediately
   after. Both directions land in the other rule with nothing lost in translation. This edge is
   also *sounder* here than in TypeScript: TS's `!` and `as` both perform zero runtime check, so
   swapping one for the other does not even change *when* the program misbehaves. Swift's `!`
   and `as!` are both runtime-checked — each traps immediately if the assumption is wrong — so
   the swap genuinely relocates which specific trap fires, the same true relocation Rust's
   `.unwrap()` ⇄ `unsafe { }` pair exhibits, not a family resemblance in name only. **Verdict:
   transfers, strengthened.**

2. **The compiler-directive-comment edges transfer to nothing.** `no-as-cast`'s and
   `no-non-null-assertion`'s notFix "suppress the resulting error with `@ts-ignore` or
   `@ts-expect-error`," and the same entry repeated on four other TypeScript rules, all point at
   `no-ts-comment`. Swift has no rule for this because Swift has no construct for this: there is
   no per-line, per-expression pragma that tells the type checker to accept a mismatch it would
   otherwise reject. A type error in Swift is not a suppressible diagnostic with an escape
   comment; it is a compile failure with no documented override. (`@available` governs
   deprecation warnings, not type mismatches; nothing plays `@ts-ignore`'s role.) This is not a
   narrower version of the TypeScript edge — it is the edge's entire destination missing from
   the language, because the failure mode it depends on (a type checker whose complaint can be
   silenced without fixing the code) does not exist. **Verdict: does not transfer — no
   destination.**

3. **The widen-to-`any` edges transfer only after the arrow is reversed.** Six TypeScript rules
   — `no-as-cast`, `no-non-null-assertion`, `no-useless-types`, `no-swallowed-catch`,
   `no-floating-promise`, and the `strict-boundaries` rules on unchecked index access and
   narrowing — each declare a notFix that ends at `no-any`: widen the type, and the compiler
   stops checking. Swift's nearest name match, `Any` (and the narrower `AnyObject`), does not
   play the same role, because it does not disable checking. A value typed `Any` cannot have a
   member accessed or a method called on it until it is cast back to something concrete with
   `as!`, `as?`, or `is` — `Any` is a real, boxed existential type, not TypeScript's escape from
   the type system. Widening to it does not make the problem disappear; it relocates the force-
   cast to wherever the `Any` value is consumed, which is a real edge — but it runs *from* the
   escape-hatch type *toward* the force-cast rule, the opposite direction from every TypeScript
   edge that ends at `no-any`. This is also not a Swift-only quirk: Go's `no-empty-interface` →
   `no-unchecked-type-assertion` and C#'s `no-dynamic` → `no-unchecked-cast` already have this
   same shape, arrived at independently for the same reason — `interface{}`/`any` in Go and
   `dynamic` in C# both still require an assertion to use. Requirement 4 below ships the Swift
   side of that same edge rather than a `no-any`-shaped rule that copies TypeScript's direction
   without checking whether it still points the right way. **A pack ported by search-and-replace
   on rule names alone would get this backwards — it is the single most consequential finding in
   this section.** **Verdict: transfers, direction reversed.**

4. **The parsed-JSON-cast edge transfers, but only for the API TypeScript's idiom actually
   matches.** `no-json-parse-cast`'s notFixes route through `no-as-cast` and
   `no-non-null-assertion` because `JSON.parse` and `response.json()` return an untyped value
   that a cast then trusts without validating. Idiomatic Swift does not have this failure mode
   for its idiomatic decoding path: `JSONDecoder().decode(T.self, from:)` performs real
   structural validation as part of decoding a `Decodable` type and throws when the shape does
   not match — the "cast" and the "check" are the same operation, which is exactly the gap
   `no-json-parse-cast` exists to close in TypeScript. The edge does reappear, narrowly, on
   Swift's older `JSONSerialization.jsonObject(with:)` API, which returns `Any` the same way
   `JSON.parse` returns `any`, and which real code still casts out of with `as!` or
   `(... as? [String: Any])!` without validating further. **Verdict: transfers, narrowed to one
   specific legacy API family rather than the general case.**

5. **The remaining single-rule edges (`no-floating-promise`, `no-swallowed-catch`,
   `no-broad-catch-rethrow`, the `strict-boundaries` index rules) do not have a Swift starter-pack
   destination, but not because the underlying habit is absent from Swift** — `do { } catch { }`
   with an empty body swallows an error exactly the way TypeScript's empty catch does, and
   Swift's own indexing has the same "read might be missing, write assumes it isn't" shape as
   `noUncheckedIndexedAccess`. These are real, transferable *rules*, not edges — but they belong
   to a different pack (TypeScript's own `strict-boundaries` and reliability rules arrived after
   `core-ts`, not inside it), and this spec's starter pack is scoped to the force-unwrap/force-
   cast spine specifically, per Requirement 3. Naming them here is what keeps their absence a
   scoping decision instead of an oversight.

**Where this leaves the count.** Of the nine edge patterns, one transfers as a strengthened
match, one transfers with its direction corrected, one transfers narrowed to a specific API, and
one has no destination in the language at all. Read as a fraction of the individual notFix
*entries* examined (roughly twenty, counting repeats across rules): about a third carry over
essentially unchanged, about a third carry over only after correcting a wrong assumption
(direction or existence of a target), and about a third do not carry over because the construct
they depend on — a suppressible type-checker diagnostic — is not part of Swift. **That is this
spec's answer: the pack does not transfer by search-and-replace, but the underlying reasoning
method — ask what the tempting rewrite actually does to the runtime behavior, not what it looks
like on the page — transfers completely, and produces a graph that is different in specific,
explainable ways rather than either identical or unrelated.** That is a discovery about how packs
should be authored from here on: start from the target language's actual escape hatches and ask
which existing edges' *reasoning* still holds, never start by renaming an existing rule's edges
and assuming the destinations are still there.

## Requirement 2 — What Swift's own type system already prevents

**User story:** As someone about to write a Swift rule, I want to know how much of TypeScript's
escape-hatch territory Swift's checked-optional design already closes off, so that this pack is
scoped to what is actually still open rather than restating what `swiftc` already refuses.

1. Swift's optional type is checked at every read: a value typed `T?` cannot be used as `T`
   without the compiler seeing one of a small, closed set of operations — optional binding
   (`if let`, `guard let`), optional chaining (`?.`), nil-coalescing (`??`), or a force-unwrap
   (`!`). There is no way to read past an optional silently the way a TypeScript value typed
   `T | undefined` can flow through code that forgot to check it under a loose compiler
   configuration. This spec's four rules exist in the narrow remainder: the operations the
   compiler *does* let past unchecked, on the author's explicit say-so.
2. The three axes this spec's rules cover — unwrapping an optional, downcasting a type, and
   propagating a thrown error — each have the identical three-tier shape in Swift: a safe,
   explicit form that requires handling the failure (`if let`, `as?`, `try` inside a `throws`
   context or `do`/`catch`), a form that converts failure into an `Optional` the caller must
   still handle (implicit in `if let`/`guard let`, `as?`, `try?`), and a forced form that traps
   on failure (`!`, `as!`, `try!`). No other analyzer in this project has found a language with
   this much internal symmetry across its escape hatches; TypeScript's `!` and `as` do not share
   a construct with a "safe" and a "handle-the-optional" tier the way Swift's do.
3. Implicitly-unwrapped optionals (`T!` as a *declared type*, not an operator) are the one
   escape hatch Swift keeps that TypeScript has no equivalent of at all. Declaring `var
   response: URLResponse!` tells the compiler to treat every later read of `response` as already
   force-unwrapped, silently, with no `!` written at the use site. It exists for a narrow,
   real reason — two-phase initialization, where a property is genuinely nil only in the instant
   between `init` and a setup call that always runs before first use — and it is exactly the
   kind of "narrower and more deliberate" escape the introduction's framing promises: unlike
   TypeScript's `any`, which appears by inference with no keyword anywhere in the source, an IUO
   is always a visible, deliberate type annotation at its one declaration site.
4. What is left, honestly: force-unwrap, force-cast, force-try, and an IUO declaration are all
   the compiler permits without comment, on the strength of the author's own claim that the
   value will be present, the type will match, or the call will not throw. That claim is checked
   at runtime, not at the point it is made — which is a real improvement on TypeScript's `as`
   (checked never) but not the same thing as the compiler proving it, and a trap in production is
   not meaningfully softer than a silent type-confusion bug for the person on call when it fires.
   A trap is also, unlike a Swift `Error`, not catchable: `do`/`catch` has no path to a force-
   unwrap or force-cast failure, because it is a `fatalError`-class process termination, not a
   thrown value. This project's rules exist for exactly the territory a trap leaves open.

## Requirement 3 — The starter rules, and the evidence each one earns

**User story:** As someone deciding whether this analyzer can be a thin wrapper over a parser or
needs to link against the compiler itself, I want each rule's evidence claim justified by what it
actually has to consult, because that decision is the largest cost difference in this spec.

The analyzer SHALL ship a `core-swift` pack with exactly these four rules, derived from
Requirement 1's transfer analysis rather than proposed independently of it.

1. **`no-force-unwrap`** — the postfix `!` operator applied to an expression, in either its
   plain form (`value!`) or as part of a member/subscript chain (`dict["key"]!.count`).
   **Evidence: syntax.** SwiftSyntax gives force-unwrap its own dedicated node kind
   (`ForceUnwrapExprSyntax`); finding it requires no symbol resolution, because the grammar
   already distinguishes it from every other postfix form. This mirrors `no-non-null-assertion`
   exactly: TypeScript's grammar also makes `!` an unambiguous production, not a shape that could
   mean something else.
2. **`no-force-cast`** — an `as` expression whose operator token is `!` specifically
   (`x as! T`), as opposed to the statically-safe upcast `as` or the optional-returning `as?`.
   **Evidence: syntax.** SwiftSyntax's `AsExprSyntax` carries the exact operator token
   (`as`, `as?`, or `as!`) as part of the node; which of the three was written is visible without
   resolving what `T` or the value's type actually are. This is a narrower target than TS's
   `no-as-cast`, which reports all three of TypeScript's forms of `as` because TypeScript's `as`
   has no safely-checked sibling forms — Swift's own type system already disposes of two of the
   three cases (see Requirement 2.2), so only the forced one is this rule's territory.
3. **`no-force-try`** — a `try` expression whose operator token is `!` (`try! f()`), as opposed
   to plain `try` inside a `throws`/`do` context or the optional-returning `try?`.
   **Evidence: syntax.** Same reasoning as `no-force-cast`: `TryExprSyntax` carries which of the
   three try-forms was written, directly, with no need to resolve whether the callee can
   actually throw. This rule has no TypeScript analogue — TS has no operator for asserting an
   operation will not reject or throw — and it is the strongest single piece of evidence for
   Requirement 1's finding that the *shape* of the three-tier design, not any one specific rule,
   is what transfers.
4. **`no-implicitly-unwrapped-optional`** — a type annotation written with a trailing `!`
   (`var x: String!`, a function parameter, or a return type), at its declaration site only.
   **Evidence: syntax**, and deliberately scoped. SwiftSyntax's `ImplicitlyUnwrappedOptionalTypeSyntax`
   makes the declaration itself as visible as any other type annotation. What this rule does
   **not** catch is a plain-looking read of an IUO-typed value later in the file — `response.statusCode`
   where `response: URLResponse!` — which force-unwraps silently with no operator at that
   site for the analyzer to find. Resolving that would require knowing `response`'s declared
   type at every use, which needs the type checker, not the parser; this spec leaves that case
   for a future `evidence: semantic` rule rather than quietly narrowing this one's scope without
   saying so.

Every rule in `core-swift` is answerable from a parse tree. None needs a type-checked build,
symbol resolution, or a running `swiftc` invocation beyond parsing — the analyzer can be built as
a thin driver over SwiftSyntax, the same evidence class as the Rust analyzer's `syn`-based rules
and the Python analyzer's `ast`-based ones. This is the answer to the single biggest cost question
this spec has to settle: nothing in `core-swift` requires linking against the compiler itself.

## Requirement 4 — The interlock

1. `notFixes` SHALL only name rule ids that exist in this pack, built from Requirement 1's
   analysis rather than invented to make the graph look denser than it is.
2. **`no-force-unwrap` → `no-force-cast`.** The tempting rewrite of a force-unwrapped optional
   read, when the value also needs a type it does not statically have, is to fold the unwrap
   into a force-cast instead of removing it — `dict["key"] as! String` in place of
   `dict["key"]!`. The crash moves from one operator to the other; nothing about the risk is
   reduced.
3. **`no-force-cast` → `no-force-unwrap`.** The tempting rewrite of a force-cast is to "make it
   safer" by switching to the optional-returning form and then force-unwrapping that result:
   `(x as? T)!` in place of `x as! T`. This produces the exact same trap on a mismatch, with an
   extra `Optional` constructed and immediately discarded in between.
4. **`no-force-try` → `no-force-unwrap`.** The identical rewrite one operator over: `(try? f())!`
   in place of `try! f()`. `try?` converts a thrown error into `nil`; force-unwrapping that
   result traps exactly where `try!` would have, with the same information about *why* thrown
   away in both cases.
5. **`no-implicitly-unwrapped-optional` → `no-force-unwrap`.** The tempting rewrite of an IUO
   declaration is to make the optionality explicit (`String?` instead of `String!`) without
   changing anything at the use sites, which now need an explicit `!` at every read that used to
   unwrap implicitly. This makes the previously-invisible risk visible in the diff, which is a
   real improvement in honesty, but every one of those new `!`s is still a force-unwrap this
   pack reports.
6. **No rule points at a Swift analogue of `no-any`, because this pack does not ship one.**
   Requirement 1.3 found that TypeScript's widen-to-`any` edges reverse direction in Swift:
   `Any`/`AnyObject` require a cast to use, so the corresponding Swift edge would run from an
   escape-hatch-typed declaration *toward* `no-force-cast`, not away from a rule at either end of
   it. Shipping that declaration-side rule (an `Any`/`AnyObject`-as-declared-type check, the
   `no-empty-interface`/`no-dynamic` analogue) is left to a future revision of this pack rather
   than folded in here, because it changes the pack's shape — an API-boundary rule, not an
   operator rule — and Requirement 1 is about testing what transfers, not about matching every
   other analyzer's rule count.
7. **The pack has no terminal, unreachable rule the way Rust's `no-unsafe-block` or Go's
   `no-panic-in-library` does.** Every rule here has at least one real cross-rule dead end
   (points 2–5), because the three-tier optional/cast/try design gives each forced operator a
   sibling "convert to Optional first" move that lands in another one of these four rules. The
   one genuinely terminal non-fix — adding a comment justifying a force-unwrap instead of
   removing it, the direct analogue of Rust's undocumented-`unsafe`-block non-fix — is recorded
   with no `rule` field on `no-force-unwrap`, per the same reasoning 0010 already established:
   an absent edge says the dead end goes nowhere in this pack, and inventing one to fill the slot
   would say something false about where it goes.

## Requirement 5 — Prerequisite-spec (0029) compliance

**User story:** As a reviewer checking this spec against the standing obligation every new
analyzer carries, I want to know whether `core-swift`'s findings can be trusted unconditionally
or whether some of them depend on a project configuration this analyzer might not have resolved.

1. Every rule in Requirement 3 declares `evidence: 'syntax'`. None depends on module resolution,
   package resolution, or anything else that varies between a real configuration and an invented
   one. Per 0029 Requirement 1.5, this analyzer has nothing to report in `AnalyzeResponse.degraded`
   today, and per 0029 Requirement 3.2, `cyv verify-analyzer`'s twelfth check SHALL pass
   unconditionally against this manifest with a detail stating that nothing in it claims semantic
   evidence — the same trivial-pass case the Python and Rust analyzers are already in.
   `capabilities.degradableResolution` need not be declared.
2. This is not the same as having nothing to say about degraded resolution as a concept, and this
   spec does not treat it that way. The moment a future rule earns `evidence: 'semantic'` — the
   IUO-use-site case Requirement 3.4 names as left open is the obvious first candidate — it
   inherits 0029 Requirement 1's obligation in full, and the terms are these: a file whose
   SwiftPM target cannot be determined (it sits outside any target `Package.swift` declares), a
   package whose dependencies are declared but not fetched (no `Package.resolved`, or one that
   does not match), or an import of a module the toolchain cannot locate (a platform-specific
   system framework absent on the host, or a dependency resolved for a different platform) are
   all reduced-resolution conditions in Swift's terms, the same role a missing or solution-style
   `tsconfig.json` plays for TypeScript and an unresolved `go/importer` lookup plays for Go.
3. Unlike Go (0021 Requirement 7), this analyzer's starter pack does not face the "the unit is a
   package, not a file" problem, because nothing in `core-swift` resolves anything outside the one
   file it is asked about. That problem is deferred, not avoided: whichever rule first declares
   `evidence: 'semantic'` inherits it too, scoped to whatever unit Swift's own module system
   uses — a SwiftPM target, in the common case — rather than a file in isolation, for the same
   reason Go's package-scoped visibility made per-file type-checking unsound there.
4. Per 0029 Requirement 4.2, this analyzer's own README (not this spec) SHALL state plainly which
   real layouts a future semantic mode would resolve and which it would not, in the register the
   C# analyzer's README and the Rust analyzer's README already use. The honest baseline for a
   single-package SwiftPM project (one `Package.swift`, no unfetched external dependencies) is
   favorable; a project built through an Xcode project or workspace file instead of `Package.swift`,
   or one with unfetched or platform-mismatched external dependencies, is not something this spec
   claims a solution for.

## Requirement 6 — Execution, and Swift's version of the manifest trap

1. `exec.type` SHALL be `"process"`, reading one `AnalyzeRequest` from stdin and writing one
   `AnalyzeResponse` to stdout, with diagnostics on stderr — identical to every other subprocess
   analyzer in this project.
2. `exec.command` SHALL NOT name a built executable path directly, for the reason 0010 and 0021
   already established: `swift build` places its output under `.build/<configuration>/<name>`,
   with a `.exe` suffix on Windows and none elsewhere, and `.build/` is not committed. A manifest
   naming that path resolves on the machine that built it and loads nothing anywhere else, with
   `cyv check` reporting a clean pass over files nothing actually analyzed.
3. Instead, `exec` SHALL invoke the toolchain launcher itself: `{ "type": "process", "command":
   "swift", "args": ["run", "--package-path", ".", "analyzer-swift"] }`, resolved relative to the
   manifest's own directory the same way `writing-an-analyzer.md` already specifies for `cargo run`
   and `go run`. `swift`, like `cargo`, `go`, and `dotnet`, is a stable, PATH-resolved name across
   platforms; the artifact it produces is not.
4. Swift adds a portability risk none of the other three toolchain-based analyzers carry: this
   analyzer's own dependency on SwiftSyntax is versioned to track specific Swift language/tooling
   releases, not to float freely the way `syn` does across `rustc` versions or `go/ast` does
   across Go point releases as part of the standard library. A `Package.swift` pinning a
   SwiftSyntax version compatible with the toolchain that authored this analyzer is not
   guaranteed to resolve against a different major Swift version installed somewhere else. This
   spec does not resolve that risk; it records it so the first implementation task (Requirement
   7) checks it explicitly rather than discovering it on a stranger's machine.
5. WHEN the `swift` toolchain is absent from `PATH`, the spawn failure SHALL be surfaced as a
   named, actionable report — "the Swift analyzer is configured but the `swift` toolchain was not
   found" — never a raw spawn error, matching the requirement already carried by the C# and Go
   analyzers for their own toolchains.
6. The analyzer's own implementation SHALL contain no force-unwrap, force-cast, force-try, or
   implicitly-unwrapped-optional anywhere in its own source, verified by running `core-swift`
   against its own package the way 0002 requires of this project's TypeScript source. This is
   not a style preference here: unlike a Go panic or a Rust `panic!`, a Swift trap cannot be
   caught and converted into a well-formed error response — there is no supported `recover()` or
   `catch_unwind` equivalent for a force-unwrap or force-cast failure, only unconditional process
   termination. An analyzer that traps internally does not produce a malformed response for the
   core to reject; it produces no response at all, which is a worse failure than the one
   Requirement 6.2 exists to prevent. The only way this analyzer can guarantee a well-formed
   response on every input, including a malformed request, is to never trap in the first place.

## Requirement 7 — Toolchain verification is a prerequisite task

1. This spec was written without a working `swift` on the authoring machine, confirmed at the top
   of this document. Before Requirement 3's rules are coded, an implementation task SHALL run
   `swift --version`, `swift package init --type executable`, and a `swift run` smoke test on
   every target platform this project supports, and SHALL record the actual SwiftSyntax node
   kind names used in Requirement 3 against the real library — this spec names
   `ForceUnwrapExprSyntax`, `AsExprSyntax`, `TryExprSyntax`, and
   `ImplicitlyUnwrappedOptionalTypeSyntax` from the library's documented shape, not from a
   compile here, and 0021 records exactly this same caveat for `go/ast`'s API before a line of Go
   was written against it.
2. Windows is where this project is developed, and Swift's Windows toolchain is the least mature
   of the four this project now depends on (.NET, Go, Rust, and now Swift) — official installers
   exist, but SwiftPM and SourceKit-based tooling on Windows have materially less real-world
   mileage than on macOS or Linux, and this spec cannot respectably assert otherwise from
   documentation alone. If the verification task in Requirement 7.1 finds `swift run` unreliable
   on Windows specifically, that is grounds to gate this analyzer's registration on the host
   platform rather than assume it behaves identically everywhere the way the C# and Go analyzers
   currently do.
3. If the verification task finds SwiftSyntax's version coupling (Requirement 6.4) forces a
   specific Swift toolchain version the target machine does not have, that is an empirical answer
   to a question this spec can only flag, not close: whether this analyzer ships one pinned
   SwiftSyntax/toolchain pair and documents the requirement, or whether it needs a version
   matrix. Recording that as folklore instead of running it once is exactly the failure 0021's
   own toolchain-first discipline exists to prevent.

## Registration

The analyzer SHALL NOT be added to this repository's own `checkyourvibe.json` by default, for the
same reason the Python, Rust, and Go analyzers are not: there is no Swift source in checkyourvibe
to check, and registering an analyzer that will never match a file would add a `swift` toolchain
prerequisite — the least available of the four on this project's own development platform, per
Requirement 7.2 — to every contributor's environment for zero findings. `cyv verify-analyzer`
against the manifest, and a fixture suite mirroring the Rust and C# analyzers' `run-fixtures.mjs`
convention, are the conformance path.

## Non-goals

A Swift analogue of `no-any`/`no-dynamic`/`no-empty-interface` (Requirement 4.6) — a real edge,
left for a future revision rather than folded in to match another language's rule count. Anything
requiring `swiftc`'s full type checker or SourceKit — every rule here stays inside what SwiftSyntax
alone can answer, per Requirement 3's evidence claims. Concurrency-safety checking (`Sendable`,
actor isolation) — a different, much larger evidence problem than an operator's own syntax, and
not part of this pack's spine. Objective-C bridging and `@objc dynamic` member access — a narrower,
Cocoa-interop-specific escape hatch that behaves more like C#'s `dynamic` than like anything in
this pack, and out of scope for the same reason Requirement 4.6 defers the `Any`-typed-boundary
rule. Resolving an Xcode project or workspace (`.xcodeproj`/`.xcworkspace`) — this spec's
degraded-resolution terms (Requirement 5.4) are written for a `Package.swift`-based project only.
Competing with existing open-source Swift lint tooling that already detects these same operators
by name — this project's contribution is the `notFixes` interlock and the honest evidence/degraded-
resolution discipline 0029 requires uniformly, not novel detection of a force-unwrap.

## Open questions

1. **Does the IUO-use-site rule (Requirement 3.4's deferred case) belong in this pack at all, or
   is a declaration-site-only check simply the honest scope for a starter pack the way Go's
   Requirement 1 drew its own lines?** Left open because answering it means designing a
   `evidence: semantic` rule and its degraded-resolution terms (Requirement 5.2) before this
   analyzer has run against a single real Swift package, which Requirement 5 in the analyzer-
   prerequisites spec (0029) treats as a shipping gate, not something to guess at here.
2. **Should `no-force-cast`'s scope include the plain, statically-safe `as` form after all, on
   the theory that a starter pack should be conservative about what Swift's compiler is trusted
   to have already proven?** This spec's answer (Requirement 3.2) is that plain `as` needs no
   rule because the compiler proves it — Requirement 2's argument against duplicating what a
   type system already refuses, applied here the same way 0010 applied it to Rust. A reviewer who
   thinks Swift's upcast proof is less airtight than this spec assumes should treat this as the
   first thing to push back on.
3. **Requirement 5's SwiftPM-target unit for a future semantic rule — does it need Go's
   Requirement 7 treatment in full (locate sibling files, type-check the whole target, filter
   back down to the requested file), or does Swift's module system make a narrower answer
   possible?** Unanswered because no rule in this pack needs it yet; whoever authors the first
   `evidence: semantic` Swift rule inherits the question along with the obligation.
4. **Is a real Swift codebase available anywhere for the Requirement 5 (0029) real-codebase run
   this project's own history (T7002, T7004) shows a fixture pass cannot substitute for?** This
   repository holds no Swift source of its own, the same position the Rust analyzer was in; unlike
   Rust, this spec does not yet know of an external Swift codebase this project has access to for
   that run, and identifying one is a precondition for calling `core-swift` complete, not a detail
   to settle after shipping it.
