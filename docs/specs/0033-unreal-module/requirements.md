# 0033 — An Unreal Engine module

**Status:** draft
**Created:** 2026-08-30

A module a user adds to checkyourvibe to check Unreal Engine C++: rules, the
guidance generated from them, and subagents that know the project's own tooling.
The core ships no analyzer (0005 T5011), so this is a package someone installs,
not something bundled.

## Why Unreal is a distinct problem

Unreal C++ is C++ plus a reflection system implemented as macros. `UCLASS`,
`USTRUCT`, `UPROPERTY`, `UFUNCTION` and `GENERATED_BODY` are read by Unreal
Header Tool before the compiler sees the translation unit, and they decide
things the C++ type system does not express — most importantly whether the
garbage collector can see a pointer.

That gives a class of defect no general C++ analyzer reports, because the
information is not in the C++ semantics. It is in the macros.

## Requirement 1 — Evidence must match what the analyzer can actually see

1.1. Rules whose evidence is a reflection macro SHALL declare
   `evidence: 'syntax'`. The macros are lexically present, and a finding that
   rests on reading them is as sound as the lexer.

1.2. A rule that needs a resolved C++ type — an inheritance chain, an overload
   set, a template instantiation — SHALL declare `evidence: 'semantic'` and
   SHALL NOT ship until the analyzer can genuinely resolve types. The core
   withholds semantic findings when an analyzer reports degraded resolution, and
   that mechanism must not be given claims it cannot support.

1.3. The first release MAY be lexical only. Saying so is required; implying
   otherwise is not permitted.

## Requirement 2 — A rule must know whether the enclosing type is reflected

2.1. Before reporting that a member needs `UPROPERTY()`, the analyzer SHALL
   establish that the enclosing type is reflected: a `UCLASS()` or `USTRUCT()`
   carrying `GENERATED_BODY()` or `GENERATED_USTRUCT_BODY()`.

2.2. WHERE the enclosing type is a plain C++ class or struct, the analyzer SHALL
   NOT recommend `UPROPERTY()`. The macro is unavailable there and the
   recommendation would not compile.

   This is not hypothetical. `FLyraPerformanceStatCache` in Lyra holds
   `ULyraPerformanceStatSubsystem* MySubsystem;` in a plain `struct`. A rule
   matching the pointer shape alone reports Epic's own code and prescribes a fix
   that fails to build.

2.3. A raw `UObject`-derived pointer held by an unreflected type is still a
   lifetime question, and MAY be reported as a distinct finding with its own
   remediation — make the type a `USTRUCT`, hold a weak pointer, or state the
   ownership — but never as the same finding as 2.1.

## Requirement 3 — Rules earn their place by measurement

3.1. Every rule SHALL be measured against a real Unreal codebase before it
   ships, and the measured true and false counts recorded in its task entry.
   The project's history is that unmeasured rules are wrong: one shipped at
   100% false across 39 findings.

3.2. A rule that cannot be made precise SHALL NOT ship with a lower severity as
   a compromise. A warning nobody trusts is the same defect at a lower volume.

## Requirement 4 — No rule names an engine version, plugin or vendor

4.1. Consistent with the existing packs: no rule guidance names a plugin, a
   marketplace asset, a specific engine version, or a studio's convention. A
   rule whose guidance names a package stops being true when the package
   changes.

4.2. Conventions that are genuinely Epic's — the `U`/`A`/`F`/`E`/`I` type
   prefixes, `TObjectPtr` in engine module code — MAY be rules, because they are
   the engine's own published contract rather than a third party's preference.
   Each SHALL take options so a project can turn it off without editing a rule.

## Requirement 5 — Guidance and subagents

5.1. Per-rule guidance SHALL be generated from the rule manifests by the
   existing adapter machinery. No hand-written duplicate of a rule's text.

5.2. The module MAY ship subagent definitions for the agents this repository
   already supports. A subagent SHALL be told which MCP server the project
   exposes rather than having one hardcoded: three Unreal MCP servers are
   configured on the machine this was written on, each pointing at a different
   project.

5.3. A subagent SHALL NOT be given authority the rules do not have. It advises;
   the analyzer decides.

## Requirement 6 — The analyzer must not need the engine

6.1. Running the analyzer SHALL NOT require Unreal Engine, Unreal Build Tool, or
   a built project. It reads source.

6.2. WHERE a rule would genuinely need build output — reflection data generated
   by UHT, a linked module list — that rule SHALL be deferred rather than
   silently reporting on what it can guess. Requiring a 45-minute build to
   check a header is not a check anyone runs.

## Requirement 7 — Grounded in Epic's documentation, not in recollection

7.1. A rule's `why`, and the guidance generated from it, SHALL be grounded in
   Epic's published documentation, and the rule's task entry SHALL record the
   page it came from. A model's memory of Unreal is not a source: the engine
   changes across versions, and a confidently wrong claim about reflection or
   garbage collection is worse than no rule, because it will be believed and
   acted on.

7.2. Subagent definitions SHALL likewise be written from fetched documentation
   rather than recalled. Where a subagent states an engine behaviour, the page
   that says so SHALL be cited in the definition.

7.3. WHERE the documentation is ambiguous or silent, the rule SHALL say so
   rather than resolving the ambiguity by assertion. An honest "the docs do not
   specify this; measured behaviour on 5.8 was X" is permitted and preferred.

7.4. Documentation is versioned. A claim that holds for one engine version and
   not another SHALL name the version it was read against.

## Open questions

- Whether a later semantic tier uses libclang, and what that costs a user who
  has the engine but not LLVM.
- Whether `.uasset`/`.umap` are in scope at all. They are binary, and the useful
  checks on them are references rather than content.
- Whether Blueprint is in scope. It is not source, and its defects are real.
