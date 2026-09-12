# 0050 follow-ups

Items the closure-check work surfaced but deliberately did not fix. Recorded
here because the reviews that found them lived in a scratch workspace that is
deleted once the work lands. None of these blocked the merge.

## Tracked follow-ups

1. **A mis-parented notFix that the new example made legible.**
   `packages/analyzer-typescript/src/rules/no-as-cast.ts`, notFix index 4.
   It reads "Cast a returned promise to `void` so the call can be used as an
   expression statement" and names `no-floating-promise`. Every other
   `no-as-cast` notFix is an escape *from* a cast finding; this one *adds* a
   cast, so it cannot be a shortcut anyone reaches for to make a `no-as-cast`
   finding go away. Its example therefore contains the owning rule's own
   violation. The edge claim is true and verified, so this is a guidance
   parenting defect that predates this work. It belongs under
   `no-floating-promise` only, where it already correctly exists as edge 0, or
   its `pattern` needs rewording to describe an escape from a cast finding.

2. **No test covers the explain self-exclusion.**
   `packages/core/src/cli/explain.ts:83`. The `candidate.id !== ruleId` clause
   is what keeps the repository's first self-naming notFix from being listed
   as inbound from another rule. Reverting it breaks nothing in the suite.

3. **A test does not test what its name says.**
   `packages/core/test/conformance/suite.test.ts:405`. Its manifest contains
   only a rule-less notFix, so the edge list is empty and the check
   short-circuits. It exercises the zero-edge path, not "a rule-less notFix is
   skipped while real edges are verified". Mixing one rule-bearing edge into
   the same manifest would make it test its stated behaviour.

4. **The zero-edge pass wording is untested.**
   `packages/core/src/conformance/suite.ts:491` reports "No notFix names a
   rule; nothing to close." That is the only path by which this check passes
   without executing the analyzer, so the wording is what distinguishes an
   honest skip from a real pass. No test asserts it.

5. **Example convention drift across the four analyzers.** The typescript
   examples stub their dependencies with `declare function` so the file is
   near-compilable and the intended error is the only one. The rust examples
   call undefined free functions and would not compile, which is harmless
   because that analyzer is textual but is a different standard of rigour. The
   csharp, rust and unreal examples use `NotFix`-prefixed identifiers while the
   typescript ones use natural names; uniqueness genuinely forces that only for
   csharp, whose analyzer compiles all requested files into one compilation.
   One convention note in `docs/writing-an-analyzer.md` would settle it.

6. **A behaviour change worth being on the record.**
   `packages/core/src/registry/load.ts` now rejects an entire manifest when
   `example` is a non-string, where previously an unknown field was silently
   dropped. This matches the existing treatment of `rule` and is the right
   call, but it applies to every analyzer, not only the ones this work touched.

7. **The dashboard renders the self-edge as a degenerate loop.**
   `packages/core/src/dashboard/model.ts:100-111` pushes a self-loop edge and
   bumps both in-degree and out-degree; `render.ts:271-281` draws it as a
   valid but degenerate arc and the legend counts it among rule-to-rule dead
   ends. Deliberately not fixed because the dashboard directory was fenced to
   a separate agent. Reach is narrow: this repository does not register
   analyzer-rust, so it appears in neither cyv's own dashboard nor the
   CI-gated interlock SVG. The fix is a `from === to` branch in the renderer
   plus a decision on whether the legend should count self-loops. **Owner:
   whoever lifts the dashboard fence.**

## Deferred minors: weak notFix wording the examples exposed

These are defects in guidance text that predates this work. The examples did
not create them; they made them legible by rendering each shortcut as code.
Each edge's claim is still true, so none affects the closure result. Each one
makes a single notFix less instructive than it could be.

- **Five of the nine `no-ts-comment` edges** place the directive comment above
  a line that has no type error at all, so it suppresses nothing: the entries
  under `no-floating-promise`, `no-broad-catch-rethrow`, `no-json-parse-cast`,
  `no-unsafe-array-narrowing` and `no-non-null-index-write`. The other four do
  sit above real type errors. Fixing this means editing five rules' shipped
  guidance and regenerating the manifest, which is its own change.
- **`no-swallowed-catch[0]`** never reads the caught error, though its
  rationale is about avoiding having to narrow it. A missed dramatization
  rather than a false claim.
- **`no-unsafe-index-access[3]`** contains only a write and no read, so it does
  not read as a response to an unsafe-*read* finding. Compare index 41, which
  correctly shows write-then-read. The weakest of the set; worth a two-line
  rewrite when someone is next in the file.
- **`no-unsafe-array-narrowing[2]`** widens a parameter in a way that makes the
  owning rule fire harder rather than escaping it. The notFix's own `because`
  already concedes the shortcut is futile, so the example is faithful to a weak
  notFix rather than unfaithful to a strong one.

## The boundary on the headline number

"60 of 60 edges verified" is supported by the evidence and was reproduced
independently. What it proves: for every notFix naming a rule, there exists at
least one concrete program in that analyzer's language where the shortcut has
been applied and the named rule actually reports. What it does not prove:

- **Not that the shortcut escapes the source rule.** 18 of the 50 typescript
  examples still trip their own owning rule, which non-goal 2 disclaims. The
  interlock does real work on 32 of 50.
- **Not that the example is the canonical form of the shortcut**, only one
  witness of it. A rule could catch this instance and miss the shape an agent
  actually writes.
- **Not that any edge holds under full project type information.** Every
  example is analyzed in a temp directory with no `tsconfig.json` above it, so
  the analyzer uses its fallback project: `strict: true` but no
  `noUncheckedIndexedAccess`.
- **The skew matters.** 40 of the 50 typescript edges name a token-detectable
  target (`no-as-cast` 13, `no-any` 12, `no-ts-comment` 9,
  `no-non-null-assertion` 6), and `no-unsafe-index-access`, the most
  flag-dependent rule in the analyzer, is named by no notFix anywhere. So the
  check's teeth are sharpest exactly where detection was already easiest, and
  it is untestable by construction where detection is hardest. That is a fact
  about the shape of the notFix graph, not a defect in this work, and it is the
  honest boundary on the headline number.

All twelve `no-any` edges write `any` explicitly rather than relying on
inference, so degraded type resolution cannot have inflated a pass. Weak type
information makes rules fire less, not more, so it can only produce false
failures. Everything passed, so nothing was hidden by it.
