# 0006 — Web dashboard: Tasks

**Status:** active

## Done

- [x] **T6000** Rule browser and the interlock graph
  Rules as nodes, `notFixes` as directed edges, laid out radially so the layout is deterministic and
  two screenshots of the same pack are comparable. Static manifests only — no analyzer runs to render
  the page, which is the whole reason manifests are static.
  _Exec: executor=self model=opus gates=tsc files=packages/core/src/dashboard/**,packages/core/src/cli/dashboard.ts_

- [x] **T6001** Results, trend, and never-fired
  Run history as append-only ndjson, a hand-drawn SVG trend, and the never-fired view. Three visually
  distinct empty states so "clean" can never be read as "never checked".
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/dashboard/**,packages/core/test/dashboard/**_

- [x] **T6002** Never-fired: withhold judgement without evidence
  Found by pointing the view at this repository at zero violations: it announced "13 enabled rules
  have produced no finding — this is not a success", naming every rule as suspect. When nothing fires
  at all, every rule is trivially never-fired, and that is a fact about the codebase being clean, not
  evidence about any rule. Now a three-state view that reports the *asymmetry* — how many violations
  other rules found — because the asymmetry is the signal, not the silence.
  _Exec: executor=self model=opus gates=tsc,test files=packages/core/src/dashboard/**_

## Found by dogfooding, then fixed

- [x] **T6003** The interlock graph conflates analyzers
  With TypeScript and C# both registered, the graph draws 14 nodes in one circle as though they form
  a single system. They do not: a C# rule can never be a dead end for a TypeScript violation, and the
  two packs' interlocks are entirely separate. Group or visually distinguish by analyzer, and compute
  isolation *within* an analyzer — `no-empty-catch` currently reads as isolated, but the honest
  statement is "isolated within the C# pack", which is a different and more useful claim.
  (Rule ids stay unqualified — that question was settled; see the note on `allRules` in
  packages/core/src/registry/load.ts.)
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/dashboard/**,packages/core/test/dashboard/**_

- [x] **T6004** Show a rule's evidence kind
  `RuleManifest` now carries `evidence: 'syntax' | 'semantic'`, raised by the Python analyzer: a
  syntax-only finding and a type-checked one differ in confidence, not severity. The rule browser
  should show it, so a reader can weigh a finding rather than assuming every rule is equally grounded.
  Omitted must render as "unspecified", never as "semantic".
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/dashboard/**_

- [x] **T6005** Suppressions and baseline in the dashboard
  Requirement 3.6: a rule suppressed everywhere is a rule the team disagrees with, and that is
  information about the rule rather than about the team. Show active suppressions beside the rules
  they suppress, and the baseline's remaining count by rule.
  Was blocked on T8005: `cyv check` never loaded suppressions, so a dashboard showing suppressions
  would have been showing a list of things that suppress nothing. T8005 has landed.
  Done. The Baseline and Suppressions panels and the per-rule debt pills were in place; what was
  missing is the distinction T8009 introduced. `Suppression` now carries an optional snippet
  `fingerprint`, and `evaluateSuppressions` splits what it hid into `broadSuppressed` and
  `pinnedSuppressed`, but the page rendered both alike and its lede stated flatly that a suppression
  "matches a rule id against a path glob, not a specific finding" — false for a pinned one, and the
  breadth is the whole of what Requirement 3.6 reports. Each row now states its scope, the summary
  reads "N active suppression(s) — B broad, P pinned" as `cyv check` reports it, and the per-rule
  pills count broad and pinned separately. A baseline entry or suppression naming a rule this
  configuration does not enable has no rule to sit beside, so it is now named rather than dropped.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/dashboard/**_

- [x] **T6006** The dashboard passed its own rule-to-analyzer map and never used it
  Found while verifying T6003 by actually serving the page. `cyv dashboard` had the map available and
  called `renderDashboard` without it, so grouping fell back to `rule.pack` — which looked correct on
  this repository only because its packs happen to line up one-to-one with its analyzers. Fixed in the
  same commit; recorded because the pattern is the recurring one, not because the fix was hard.
  Verified fixed by serving the page rather than by reading the call: `cyv dashboard --port 4599`
  against this repository renders three graph blocks named `comments`, `csharp` and `typescript` —
  the analyzer ids — and states "isolated within the typescript analyzer". Its five packs would have
  produced five blocks and the word "pack".
  The open question was whether `renderDashboard` should take the map as a required parameter. A
  required parameter would have caught this one omission at compile time and nothing downstream of
  it, and every existing caller is a test that has no map to pass. Answered instead by making the
  wiring testable: `cli/dashboard.ts` exports `createDashboardServer`, and
  `test/dashboard/serve.test.ts` binds it, fetches `/`, and asserts on the bytes served. Confirmed by
  reverting the argument to `undefined`: three of those tests fail.
  _Exec: executor=self model=opus gates=tsc,test files=packages/core/src/cli/dashboard.ts_

- [x] **T6007** The dashboard re-implements guidance rendering, and it has already drifted
  Found while writing spec 0032. `renderRule` in `dashboard/render.ts` builds a rule's sections itself
  rather than calling the shared `guidanceSections` that `cyv explain` uses, and the two already
  disagree about the same field: a `notFix`'s target reads `(violates <rule>)` in the terminal and
  `would trip <rule>` on the page.
  Today that is a wording difference. The failure it precedes is not: two renderers that independently
  decide what a `notFix` looks like will eventually disagree about whether to show one at all, and a
  dead end shown in the terminal but missing from the page is a dead end the reader never learns
  about. Derive both from one source. Spec 0032 states the requirement.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/dashboard/render.ts,packages/core/src/guidance/**,packages/core/test/dashboard/**_

## Open

None. Every task in this spec has landed.
