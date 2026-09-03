# 0038 — A rule for augmenting your own modules: tasks

**Status:** complete
Requirements in `requirements.md`, decisions in `design.md`.

Lane placement follows 0036 Requirement 1: nothing here goes to
`claude-code-cli`.

## Open

- [x] **T38001** The rule, narrow from the start
  Requirements 1.1 through 1.6. Report a `declare module` whose specifier begins
  `./` or `../`. Report nothing for a bare specifier, a wildcard declaration, or
  `declare global`.
  `evidence: syntax`, pack `core-ts`, severity `error`. The specifier is a
  string literal in the source text; do not reach for the type checker or for
  module resolution to answer a question the text already answers.
  The three exclusions are the rule, not edge cases bolted on afterwards — a
  bare specifier firing here would contradict `no-ts-comment`'s allowed fix in
  the same pack.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/analyzer-typescript/src/rules/no-module-augmentation.ts,packages/analyzer-typescript/src/rules/index.ts_

- [x] **T38002** The guidance and the dead ends
  Requirements 2.1 through 2.4, 3.1 through 3.4. The manifest entry: summary,
  `why`, `allowedFixes`, `notFixes`.
  Allowed fixes name declaring the member on the type in the file that owns it;
  composing a new type containing the original; and moving a genuinely shared
  shape to a module both sides import. No vendor, no library, no framework.
  Dead ends: `as` at the use site to `no-as-cast`, widening to `any` to
  `no-any`, silencing the property error to `no-ts-comment`, and two that land
  on no rule — making the augmented members required, and moving the
  augmentation to a separate declarations file. Each states what the construct
  does in TypeScript; inherit no direction from another pack (spec 0031).
  This is judgment work because the guidance is the product. A rule whose
  `notFixes` are wrong is worse than no rule: it points an agent at a dead end
  that is not one.
  Depends on T38001.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/analyzer-typescript/analyzer.manifest.json_

- [x] **T38003** Fixtures and tests
  A `.bad.ts` fixture with a relative augmentation, and an `.ok.ts` fixture
  carrying all three exclusions together: a bare-specifier augmentation, a
  wildcard declaration, and a `declare global`. The ok fixture is the rule's
  real specification, so write it before the bad one.
  Include the exact shape that produced this spec — a relative augmentation
  adding optional members to an interface declared in a sibling file — so the
  case that motivated the rule is the case guarding it.
  Depends on T38001.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,coverage files=packages/analyzer-typescript/test/fixtures/no-module-augmentation.ok.ts,packages/analyzer-typescript/test/fixtures/no-module-augmentation.bad.ts,packages/analyzer-typescript/test/**_

- [x] **T38004** Measure it before enabling it
  Requirements 4.1, 4.2, 4.3. Run against this repository and at least one
  unrelated TypeScript codebase.
  Run the positive control first: one file holding a relative augmentation, a
  bare-specifier augmentation, a wildcard declaration and a `declare global`,
  and confirm exactly one finding. Zero from a rule that ran and zero from a
  rule that never ran are the same number, and this project has already shipped
  that mistake once.
  Report the counts honestly, including the sample size, and say if it is small.
  If the findings are mostly false positives, narrow or drop it — do not ship it
  with the rate excused.
  Record the result in `docs/STATUS.md` whichever way it goes.
  Depends on T38002, T38003.
  _Exec: executor=self model=opus gates=manual files=docs/specs/0038-no-module-augmentation/tasks.md,docs/STATUS.md_
