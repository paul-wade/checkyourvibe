# 0038 — A rule for augmenting your own modules

**Status:** active
**Created:** 2026-08-31
**Depends on:** 0007

## Introduction

Found by using the tool rather than by looking for a rule. Task T36004 asked an
executor to add three fields to `DispatchOpened`. The dispatch was scoped to
`store.ts` and a new `liveness.ts`, and `DispatchOpened` is declared in
`dispatch.ts` — which was not in scope. The executor did the only thing the
constraint allowed:

```ts
import './dispatch.js';

declare module './dispatch.js' {
  interface DispatchOpened extends Partial<DispatchLiveness> {}
}
```

It compiled, it passed the analyzer, it passed the tests, and it was wrong.
`dispatch.ts` declares a type that does not mention three of its own fields.
Anyone reading that file to learn the shape of an opened entry reads an
incomplete answer, and the compiler sides with the file they did not open.

The second-order effect was worse than the first. `parseDispatchEntry` did not
know about the fields and stripped them, so `readDispatchEntries` re-read them
from the raw JSON and spread them back on — a workaround stacked on a
workaround, both invisible from the type's own file.

This is the shape the existing pack already reports elsewhere: a construct that
makes the compiler stop objecting without changing the thing it was objecting
to. `no-ts-comment` for a directive, `no-as-cast` for an assertion,
`no-non-null-assertion` for `!`. Augmenting your own module is the same move
applied to a declaration.

### The narrowing that makes it right

`no-ts-comment` lists this among its allowed fixes:

> If a dependency type declaration is inaccurate, correct it locally with a
> module augmentation.

That fix is correct and must stay correct. You cannot edit a package inside
`node_modules`, and augmentation is the language's intended answer.

So the rule cannot be "no module augmentation". It has to be "no augmenting a
module you could have edited" — and the signal for that is already in the
source text: a **relative** specifier names a file in this project, a bare
specifier names a dependency.

This project has narrowed four rules for being right about the language and
wrong about the context. Writing this one narrow from the start is that lesson
applied in advance rather than after a hundred false positives.

## Requirement 1 — What the rule reports

1.1. A rule `no-module-augmentation` SHALL report a `declare module` block whose
   specifier is relative — beginning `./` or `../`.

1.2. The rule SHALL NOT report a `declare module` block whose specifier is bare,
   naming a dependency. That is the case `no-ts-comment` names as an allowed
   fix, and reporting it would put two rules of the same pack in direct
   contradiction.

1.3. The rule SHALL NOT report a wildcard declaration such as
   `declare module '*.css'`. It declares a shape for files that have no
   declaration, rather than adding to one that exists.

1.4. The rule SHALL NOT report `declare global`. It is a different construct
   with different reasoning, and a rule about it is not this rule.

1.5. Evidence SHALL be `syntax`. The specifier is a string literal in the source
   text and no type information is needed to read it, so the rule reports
   nothing it cannot see.

1.6. The rule SHALL belong to the `core-ts` pack and SHALL be `error` severity,
   matching the rules whose defect shape it shares.

## Requirement 2 — What it tells the reader to do instead

2.1. The guidance SHALL name declaring the member on the type in the file that
   owns it as the first fix.

2.2. It SHALL name composing a new type that contains the original — rather than
   reopening it — for a caller that needs extra fields and should not change the
   original's meaning for everyone else.

2.3. It SHALL name, for a genuine cross-module need, moving the shared shape to
   a module both sides import, so the declaration has one home.

2.4. The guidance SHALL NOT name a validation library, a framework, or any
   vendor. Rules take options; an option's default names nothing.

## Requirement 3 — The dead ends

3.1. The rule SHALL declare `notFixes` for each cheaper escape, each naming the
   rule it lands on:
   - asserting the member at each use site with `as` → `no-as-cast`
   - typing the value `any` so the member is reachable → `no-any`
   - silencing the resulting property error with a directive → `no-ts-comment`

3.2. It SHALL declare a `notFix` for the escape that lands on no rule and is
   still wrong: keeping the augmentation and making its members non-optional.
   That does not restore visibility at the declaration site, and it now asserts
   the members are always present on records written before they existed.

3.3. It SHALL declare a `notFix` for moving the augmentation into a separate
   declarations file. That makes it findable and leaves the original type still
   lying about its own shape.

3.4. Each `notFix` SHALL state what the construct does in TypeScript rather than
   inheriting a direction from a rule of the same name in another pack, per
   spec 0031's finding.

## Requirement 4 — Judged against real code

4.1. The rule SHALL be run against this repository and at least one unrelated
   TypeScript codebase before it is enabled by default.

4.2. A positive control SHALL be run: a file containing a relative augmentation,
   a bare-specifier augmentation, a wildcard declaration and a `declare global`,
   confirming exactly one finding. A rule reporting zero on real code is
   indistinguishable from a rule that never ran, and this project has made that
   mistake before.

4.3. WHERE the measured findings are dominated by false positives, the rule
   SHALL be narrowed or dropped rather than shipped with its rate excused. A
   rule that fires and is wrong trains people to ignore the tool.

## Open questions

- **Is `declare global` worth its own rule?** It has the same
  action-at-a-distance property and a different remedy, since there is no file
  that owns the global scope. Deliberately out of scope here.

- **Should the rule read `tsconfig` paths?** An alias like `@core/dispatch` is
  a bare specifier that names a file in this project, so 1.1 misses it. Reading
  path mappings would catch it and would make an evidence-`syntax` rule depend
  on configuration. Not attempted until an alias is seen being augmented.
