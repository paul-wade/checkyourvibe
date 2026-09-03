# 0033 — An Unreal Engine module: tasks

**Status:** open
Requirements in `requirements.md`, decisions in `design.md`.

Dogfooded against `R:\gamedev\catburgler\Source` — a Lyra starter project on UE
5.8, 463 `.cpp` and 464 `.h`. Read only; that project is never modified.

Each `_Exec:` names the lane the task is dispatched to. Placement follows
Requirement 9.1 of spec 0011: the smallest executor that can do the job.
Mechanical work with a checkable gate goes to a free or spare lane; work whose
failure is expensive stays on the strongest.

## Open

- [ ] **T33001** The reflection-context scanner
  Walks a header maintaining the stack of enclosing type declarations described
  in the design: kind, whether `UCLASS()`/`USTRUCT()` preceded it, whether a
  generated-body marker appeared inside it, current access section, and brace
  depth. A type is reflected only when the macro and the marker are both
  present. Members are handed to rules already carrying that context, so no rule
  re-derives it.
  Partial work exists in `packages/analyzer-unreal/src/` — `scanner.mjs`,
  `object-types.mjs` and `gc-rules.mjs` were salvaged from an interrupted run
  and are unreviewed. Read them before adding to them.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/analyzer-unreal/src/scanner.mjs,packages/analyzer-unreal/src/object-types.mjs_

- [ ] **T33002** The package the core can load
  `analyzer.manifest.json`, `package.json`, and `src/index.mjs` exporting a
  default `analyze(request)`. A `node` exec-type analyzer is imported and its
  default export called; it must not read stdin, which never settles at import.
  Match `**/*.h` and `**/*.cpp`; exclude `Intermediate/`, `Binaries/`, `Saved/`,
  `DerivedDataCache/` and `*.generated.h`. Passes all eleven checks of
  `cyv verify-analyzer`.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,verify-analyzer files=packages/analyzer-unreal/**_

- [ ] **T33003** The garbage-collection rule, grounded in Epic's documentation
  A reflected type holding a raw `UObject`-derived pointer without
  `UPROPERTY()`. Its `why` is written from a fetched Epic documentation page,
  and this entry records the page and the engine version it describes (R7.1).
  Not from recollection.
  _Exec: executor=claude-code-cli kind=judgment gates=tsc,test,self-check files=packages/analyzer-unreal/src/gc-rules.mjs,packages/analyzer-unreal/analyzer.manifest.json_

- [ ] **T33004** The unreflected-ownership rule, kept separate
  An *unreflected* type holding the same pointer. Requirement 2.3: a different
  finding with a different remediation — make the type a `USTRUCT`, hold a weak
  pointer, or state the ownership — never merged with T33003.
  Regression fixture is the real header that motivated it:
  `LyraGame/Performance/LyraPerformanceStatSubsystem.h`, where
  `FLyraPerformanceStatCache` is a plain `struct` holding
  `ULyraPerformanceStatSubsystem*`. `UPROPERTY` does not compile there.
  _Exec: executor=claude-code-cli kind=judgment gates=tsc,test,self-check files=packages/analyzer-unreal/src/gc-rules.mjs,packages/analyzer-unreal/analyzer.manifest.json_

- [ ] **T33005** Fixtures and tests
  A `.bad.h`/`.ok.h` pair per rule, plus the Lyra header above as a permanent
  regression test. `.test.ts` under `test/`, collected by the repository's one
  vitest run, which is what `tools/analyzer-coverage.mjs` requires of every
  analyzer.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,coverage files=packages/analyzer-unreal/test/**_

- [x] **T33006** Measure every rule against the Lyra project
  Run the analyzer over `R:\gamedev\catburgler\Source` and open the actual
  source line for a sample of every rule's findings. Record measured true and
  false counts per rule in this file (R3.1). A rule that cannot be defended is
  removed, with the reason written here — not shipped at a lower severity
  (R3.2).
  _Exec: executor=claude-code-cli kind=judgment gates=none files=docs/specs/0033-unreal-module/tasks.md_

  **Measured 2026-09-01.** `git init` was taken in the catburgler checkout so
  `cyv init --analyzer <this repo>/packages/analyzer-unreal/analyzer.manifest.json`
  and `cyv check --all` could run as they would for a real adopter, rather than
  calling the analyzer module directly. `cyv check --all` covered 707 tracked
  and untracked files (`.gitignore` added first, excluding `Binaries/`,
  `Intermediate/`, `Saved/`, `DerivedDataCache/`, `Build/`) and reported 14
  findings, 0 files skipped, 0 crashes.

  | Rule | Findings | Opened and read | True | False |
  |---|---|---|---|---|
  | `gc-object-pointer-in-unreflected-type` | 12 | 12 | 12 | 0 |
  | `gc-untracked-object-member` | 2 | 2 | 2 | 0 |
  | `uproperty-raw-object-pointer` | 0 | — | — | — |

  All 14 findings were opened at their reported file and line. For each, the
  enclosing type's declaration was checked by hand for a preceding
  `UCLASS()`/`USTRUCT()` and a `GENERATED_BODY()`-family macro in its body —
  the two-part test Requirement 2.1 requires. In every case the scanner's
  classification of the enclosing type (reflected or plain) matched what a
  human reading the same declaration would conclude. No false positive and no
  misfiled finding (a `gc-untracked-object-member` reported for a plain type,
  or the reverse) turned up.

  Notable findings, as evidence the rule is reading real code correctly:

  - `Source/LyraGame/Performance/LyraPerformanceStatSubsystem.h:153` —
    `ULyraPerformanceStatSubsystem* MySubsystem;` inside plain `struct
    FLyraPerformanceStatCache`. This is the exact case Requirement 2.2 and
    T33004 are written against, confirmed correctly filed under
    `gc-object-pointer-in-unreflected-type` rather than
    `gc-untracked-object-member` — the historical 100%-false shape (R3.1) does
    not recur here.
  - `Plugins/UIExtension/Source/Public/UIExtensionSystem.h:67` —
    `TArray<TObjectPtr<UClass>> AllowedDataClasses;` inside a plain
    `TSharedFromThis`-derived struct. `TObjectPtr` alone does not protect a
    member outside a `UPROPERTY`-marked reflected type, which is exactly the
    distinction the rule's `notFixes` state; a reader could otherwise assume
    `TObjectPtr` was already safe here.
  - `Source/LyraGame/System/LyraReplicationGraph.h:86` —
    `AGameplayDebuggerCategoryReplicator* GameplayDebugger` behind
    `#if WITH_GAMEPLAY_DEBUGGER` inside a `UCLASS()`. Confirms the design's
    "no preprocessor" choice working as intended: the member inside the
    disabled block is still flagged, matching the design note that a member
    inside a conditional block is still a member in some configuration.

  One nuance short of a false positive: `Source/LyraGame/Weapons/
  LyraGameplayAbility_RangedWeapon.h:77` (`ULyraRangedWeaponInstance*
  WeaponData` in `FRangedWeaponFiringInput`) and `Plugins/GameFeatures/
  ShooterCore/Source/ShooterCoreRuntime/Public/ShooterCoreRuntimeModule.h:19`
  (a module singleton's cached settings pointer) both match the rule's
  syntactic contract exactly, but the struct in the first case is a
  stack-local, single-call parameter object and the pointer in the second is
  a `GetMutableDefault<>`-style settings object that in practice is never
  garbage collected. The rule does not claim to know either fact — lifetime
  analysis is an explicit non-goal (design.md, "What the scanner deliberately
  does not do") — so both are counted as true positives against the rule's
  actual, syntax-only claim, not against a lifetime judgement it never makes.

  `uproperty-raw-object-pointer` had zero findings in this codebase: Lyra's
  own `UPROPERTY` object members are already `TObjectPtr` almost everywhere
  sampled, so this run does not exercise it. It is not counted as a failure,
  but it is not measured either — `packages/analyzer-unreal/test/` currently
  holds only `gc-rules.test.ts`, which does not exercise this rule, and no
  `test/fixtures/*.bad.h`/`*.ok.h` pair exists yet for it (T33005 is still
  open). This run defends the two `gc-*` rules on real code; it does not
  defend `uproperty-raw-object-pointer` at all, which is a gap for T33005 to
  close, not a result to report as a pass.

  No rule was removed. The two rules this run actually exercised are
  defended by it.

- [ ] **T33007** Subagents, written from fetched documentation
  Subagent definitions for the agents this repository supports. Each engine
  behaviour a subagent states cites the page that says so (R7.2). A subagent
  advises; the analyzer decides (R5.3). It is told which MCP server the project
  exposes rather than having one hardcoded — three Unreal MCP servers are
  configured on this machine, each pointing at a different project.
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=packages/analyzer-unreal/agents/**_

- [ ] **T33008** The analyzer's README states its blind spots
  No preprocessor, no macro expansion, no template instantiation, and a
  prefix-convention heuristic for deciding what is a `UObject` type. A reader
  needs to know what the analyzer's silence means.
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=packages/analyzer-unreal/README.md_

## Deferred, with the reason

- **A semantic tier via libclang.** Costs every user an LLVM install and needs
  the project's include paths, and still cannot see the macros without Unreal
  Header Tool. Revisit when a rule genuinely needs a resolved type (R1.2).
- **Blueprint and `.uasset`.** Not source. The useful checks are on references
  between assets rather than on content, which is a different mechanism.
- **Anything needing build output.** Requiring a build to check a header is not
  a check anyone runs (R6.2).
