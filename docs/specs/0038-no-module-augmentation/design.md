# 0038 — Design

## Decision 1 — The specifier is the whole test

The rule needs to separate "a module you could have edited" from "a module you
could not". Three signals were available and only one is honest at
`evidence: syntax`.

**Resolve the specifier and check whether the file is inside the project.**
Accurate, and it makes the rule depend on module resolution, which means it
depends on `tsconfig`. This project has already been burned twice by rules whose
answer changed with type-resolution configuration — 673 fabricated `no-any`
findings, and a C# analyzer that did not know its type graph was partial. A rule
that can be wrong when configuration is wrong has to withhold when resolution
degrades, and that machinery is far more than this rule is worth.

**Check whether the resolved path is under `node_modules`.** Same dependency on
resolution, plus it is wrong for a workspace: a sibling package resolves into
`node_modules` through a symlink and is a file you can edit.

**Read the specifier as written.** A specifier beginning `./` or `../` names a
file in this project by construction — that is what relative means, and no
configuration changes it. A bare specifier names a package. The rule reads a
string literal that is sitting in the source text.

The third is chosen. It is exact for the case that matters, it needs no type
checker, and its one blind spot is stated rather than hidden: a `tsconfig` path
alias is a bare specifier pointing at project code, and the rule will not report
it. That is a miss, not a false positive, and this project's stated preference
is to under-report rather than fabricate.

## Decision 2 — This rule is defined by what it does not report

Four constructs share the `declare module` syntax and only one is the defect:

| Construct | Reported | Why |
|---|---|---|
| `declare module './dispatch.js'` | yes | the file is right there and could carry the member |
| `declare module 'express'` | no | you cannot edit `node_modules`, and `no-ts-comment` names this as an allowed fix |
| `declare module '*.css'` | no | declares a shape for files that have none, rather than adding to one that exists |
| `declare global` | no | a different construct with a different remedy; Requirement 1.4 |

The second row is the one that decides whether this rule can ship at all.
`no-ts-comment` currently tells a reader to fix an inaccurate dependency
declaration with a module augmentation. A rule reporting all augmentation would
make one rule's allowed fix another rule's violation, in the same pack, with
nothing to route between them — the interlock graph would contain a cycle whose
only exit is to suppress one of the two.

The README's claim is that reaching for an escape lands you on another rule that
names the escape. That only holds if the graph's edges are real. An edge between
these two would not be.

## Decision 3 — The `notFixes` are drawn from what the executor actually reached for

Three of the four dead ends are not hypothetical. When the augmentation was
removed and the fields had to reach `parse.ts`, the cheap routes available were
exactly: assert at the use site, widen to `any`, or silence the property error.
Each lands on a rule this pack already has.

The fourth is the interesting one because it lands on nothing. Keeping the
augmentation and making its members required looks like a strengthening — the
type is now more precise — and it makes things worse twice: the declaration site
still does not mention them, and entries written before the fields existed are
now claimed to have them. It is recorded as a `notFix` with no target rule,
which the format supports and which is the honest shape for a dead end that no
other rule catches.

Per spec 0031: each edge states what the construct does **in TypeScript**. None
of these directions is inherited from a rule of the same name in the C#, Python
or Rust packs, and the audit that produced 0031 exists because that inheritance
was done once and was wrong.

## Decision 4 — Narrow first, measure second

Every rule this project has had to fix was too broad on first contact:
`no-non-null-index-write` wrong fourteen times out of fourteen, Python's
`no-assert-for-validation` wrong 335 times out of 353, Rust's
`no-panic-in-library` firing inside `#[test]`, and `no-tautological-assertion`
at 100% false positives until a name check was added.

The pattern is the same every time: a rule right about the language and wrong
about where it was applied. So this one ships with its three exclusions built in
rather than discovered, and Requirement 4 still measures it against real code —
because the argument above is reasoning, and this project's own standard is that
reasoning about a rule is not evidence about it.

Requirement 4.2's positive control is not optional ceremony. `no-module-augmentation`
will very plausibly find zero on a healthy codebase, and zero from a rule that
ran and zero from a rule that did not are the same number.

## What this spec does not resolve

- **`tsconfig` path aliases.** A bare specifier that resolves to project code is
  a miss, stated in Requirement 1.1's open question. Closing it means reading
  configuration into an `evidence: syntax` rule, which is a trade not worth
  making before an alias has been seen augmented.

- **`declare global`.** Same action-at-a-distance property, no file that owns
  the global scope, so the guidance would differ. Its own rule if it earns one.
