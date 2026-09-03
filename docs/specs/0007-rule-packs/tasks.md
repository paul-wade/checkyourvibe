# 0007 — TypeScript rule pack expansion, and packs as a first-class concept: Tasks

**Status:** complete. All ten tasks landed.
Requirements in `requirements.md`, recovered after the fact on 2026-09-02.

## Done

- [x] **T7001** A second pack, so `packs` is a choice rather than a switch
  Every rule declared `pack: "core-ts"`, so `packs: ["core-ts"]` was all-or-nothing. `strict-boundaries`
  now holds the rules that govern data crossing into the program — `no-json-parse-cast`,
  `no-unsafe-array-narrowing`, `no-unsafe-index-access` — and a team can pick a posture.
  A rule declares exactly one pack; multi-pack membership was considered and rejected as a way of
  making the choice mean nothing.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/analyzer-typescript/**_

- [x] **T7002** `no-floating-promise`, and the bug it found on its first run
  A call returning a Promise that is neither awaited, returned, nor handled. Semantic: it needs the
  type checker to know the return type is a Promise.
  It fired once against this repository, on `void flush()` inside the watch debounce timer — and it
  was right. `flush` awaits `runOnce`, which throws when an analyzer fails. `void` silences the
  compiler, not the rejection, so a failed run became an unhandled rejection from a timer with no
  caller: the session either died or kept watching while having quietly stopped checking anything.
  Fixed with an `onError` callback that reports and keeps watching.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/analyzer-typescript/**_

- [x] **T7003** `no-broad-catch-rethrow`
  `catch (e) { throw e; }` and its equivalents — a frame added and nothing hidden. Distinct from
  `no-swallowed-catch`, which is about not rethrowing at all. Syntax evidence; it needs no types.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/analyzer-typescript/**_

## Found by running the new rules against this repository

- [x] **T7004** `no-non-null-index-write` is wrong 14 times out of 14
  The rule reports a write through an index whose read would be `T | undefined` under
  `noUncheckedIndexedAccess`. That premise is sound for an **array or tuple**, where writing past the
  end silently creates a hole. It is meaningless for a **record**, where an index write *is* the
  insertion — `counts[key] = n` is not a risky write to a missing slot, it is the only way to add one.

  Every one of the fourteen findings on this repository was a record insertion:
  `merged[ruleId] = override`, `ruleCounts[violation.ruleId] = ...`, `settings[rule.id] = ...`. A
  100% false-positive rate on the first codebase it met, and the codebase was not unusual.

  It is disabled in `checkyourvibe.json` rather than deleted, because the array case is real and worth
  keeping. Narrow it: flag a write through a **non-literal numeric index into an array or tuple**, and
  never a write into an object with an index signature or a `Record`. Then re-enable it here — a rule
  this project has switched off is a rule this project does not believe, and leaving it that way
  quietly would be the same dishonesty the tool exists to prevent.

  Done. Narrowed to array and tuple writes; it reports nothing here and still catches a bare
  `arr[i] = x`, verified by probe rather than by test alone. The four real shapes it used to flag are
  now `.ok.ts` fixtures, so the regression is guarded by the thing that caused it. Its remaining hole
  is documented in the source: inside a `for` loop that controls the index, any upper bound is
  accepted, so `for (let j = 1; j <= n; j++) arr[j] = x` is not reported. Narrowing further needs
  range analysis, not a better pattern match.
  _Exec: executor=devin model=swe gates=tsc,test,self-check files=packages/analyzer-typescript/src/rules/no-non-null-index-write.ts,packages/analyzer-typescript/test/**,checkyourvibe.json_

- [x] **T7005** Seven rules still declare no `evidence`
  `no-any`, `no-as-cast`, `no-non-null-assertion`, `no-ts-comment`, `no-useless-types`, `no-console`
  and `no-swallowed-catch` predate the field. Several are unambiguously semantic — `no-any` and
  `no-as-cast` consult the type checker — and the dashboard currently renders all seven as
  "unspecified", which understates what they actually know.
  Declare it per rule from what the check does, not from what the rule feels like. A rule that matches
  a keyword is `syntax` even when the keyword is about types.
  Done, and extended past the seven: all seventeen rules across all four analyzers now declare it —
  nine semantic, eight syntax. `no-console` is semantic because it resolves the identifier through the
  symbol table to prove it is the global rather than a local of that name. `no-json-parse-cast` is
  syntax, and that is worth knowing: it matches the text `JSON`, so it misses a renamed import and
  would flag a local variable called that.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/analyzer-typescript/src/rules/**,packages/analyzer-typescript/analyzer.manifest.json_

## Found while writing later specs

- [x] **T7006** A pack move can silently disable rules
  Moving three rules into `strict-boundaries` turned them off in this repository, because
  `checkyourvibe.json` listed `packs: ["core-ts", "core-cs"]` and nothing said otherwise. It was caught
  because the change was reviewed, not because anything reported it.
  A configured pack that no longer exists, and a rule whose pack is in no configured pack, are both
  states the tool can detect and neither is reported. `cyv check` should say how many rules its
  configuration expanded to and name the packs it did not recognise — the same reasoning that made the
  deferred-baseline count print on every run.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/core/src/config/**,packages/core/src/cli/check.ts_

- [x] **T7007** `.catch(() => {})` escapes both rules that should stop it
  Found while writing spec 0028, and verified against source rather than assumed. `no-floating-promise`
  is satisfied — the promise IS handled. `no-swallowed-catch` never looks at it, because
  `isEmptyCatchClause` only inspects `try`/`catch` clauses and has no notion of a promise's `.catch`
  method. So the single most common way to silence an unhandled rejection without handling it passes
  both rules cleanly.
  This is the failure the interlock exists to prevent, in its exact form: a remediation for one rule
  that lands in the blind spot of the rule that should have caught it. It is worse than an ordinary
  false negative, because `no-floating-promise`'s own guidance points an agent toward `.catch(...)`,
  and an empty one is the cheapest thing to write.
  Broaden `no-swallowed-catch` to an empty or no-op `.catch()` handler on a promise, then add the
  `notFix` edge from `no-floating-promise` — in that order. Declaring the edge first would be
  declaring a dead end that is not actually a dead end.
  _Exec: executor=devin model=swe gates=tsc,test,self-check files=packages/analyzer-typescript/src/rules/no-swallowed-catch.ts,packages/analyzer-typescript/src/rules/no-floating-promise.ts,packages/analyzer-typescript/test/**_

- [x] **T7008** `catch { continue; }` swallows exactly as thoroughly as `catch {}`
  Both analyzers now treat a block whose statements are all control flow as swallowing: `continue`,
  `break`, and a bare `return`. A `return someFallback` stays clean, because producing a fallback is
  a response to the failure.

  Verified by running both, not by reading them. TypeScript, against a scratch repo with all four
  shapes: three findings at the `continue`, `break` and bare-`return` blocks, and nothing on
  `return { ok: false }`. C#, against the fixture pair: five expected violations in
  `no-empty-catch.bad.cs` including the three control-flow cases, and zero on `no-empty-catch.ok.cs`,
  which logs before its `continue` and `break` and must stay clean.

  Running the C# side was harder than it should have been, and that turned out to be the more
  serious finding — see T4009.

## Found by pointing the packed tool at a real codebase (T5009)

- [x] **T7009** 673 fabricated `no-any` findings on an ordinary monorepo
  Installed the packed tool into a project holding 170 TypeScript files from a real, unrelated
  codebase and ran `cyv check --all`. It reported **693 violations, 673 of them `no-any`** — and one
  `warn` diagnostic buried among them:

      170 file(s): No usable tsconfig.json governs these files (none found, or the nearest one is
      solution-style). Analysed with default compiler options, so inferred-type findings may be
      unreliable.

  With no compiler options, every import resolves to `any`, so `no-any` fires on essentially every
  parameter in the codebase. Those 673 findings are not findings.

  The layout is not exotic. Each package has a `tsconfig.json` of the form
  `{ "extends": "../../tsconfig.base.json", "files": [], "include": [], "references": [
  { "path": "./tsconfig.lib.json" }, { "path": "./tsconfig.spec.json" } ] }` — the standard
  workspace-generator shape. `groupFilesByProject` detects it as solution-style and falls back to
  defaults instead of following the reference to `tsconfig.lib.json`, which is the real configuration
  and does cover the files. Adding the missing `tsconfig.base.json` changed nothing, confirming the
  reference-following is what is absent rather than a broken extends chain.

  This is the project's founding defect, unfixed. The roadmap opens by describing "a solution-style
  tsconfig that silently destroyed type resolution and produced 91 fabricated findings" as the result
  that justified everything after it. It still does it, on the most common monorepo layout there is,
  and at seven times the scale.

  Follow a solution-style tsconfig's `references` and pick the referenced project whose `include`
  actually covers the file. Prefer the lib config over the spec config for a source file and the spec
  config for a test file. If no referenced project covers it, that is when the fallback is honest.
  _Exec: executor=devin model=swe gates=tsc,test files=packages/analyzer-typescript/src/project.ts,packages/analyzer-typescript/test/**_

- [x] **T7010** A semantic finding made without types is not a finding
  T7009 is a bug and will be fixed. This task is the safety net that makes the next one of its kind
  harmless, and it needs no new information — the mechanism already exists.

  Every rule declares `evidence: 'syntax' | 'semantic'`. A `semantic` rule's finding rests on the type
  checker having resolved something. When the analyzer reports it is running on default compiler
  options, that premise is false, and every semantic finding it produces is unfounded — while its
  syntax findings remain exactly as sound as they ever were.

  So: when an analyzer reports degraded type resolution for a set of files, `cyv check` must withhold
  `evidence: semantic` findings for those files, report how many it withheld and why, and report the
  syntax findings normally. The distinction between severity and confidence was built for precisely
  this, and it has never been used for anything.

  On the codebase in T7009 this turns 693 unusable errors into 4 real ones plus a clear statement that
  170 files could not be type-checked. That is a tool someone would keep. 693 fabricated errors is a
  tool someone uninstalls, and they would be right — this project's own argument is that a false
  finding costs more credibility than a missed one.

  A withheld finding must never be silently dropped: state the count, the reason, and how to fix the
  configuration.
  _Exec: executor=devin model=swe gates=tsc,test,self-check files=packages/core/src/run/check.ts,packages/core/src/report/**,packages/core/test/run/**_
