# 0033 — An Unreal Engine module: design

Answers the requirements in `requirements.md`. Decisions here are the ones that
would be expensive to reverse.

## Why a lexer and not a C++ parser

The defects worth catching live in Unreal's reflection macros, not in C++
semantics. `UPROPERTY` decides whether the garbage collector can see a pointer;
that fact is a macro on a line, and a lexer can read it.

A real C++ front end (libclang) would cost every user an LLVM install, would
need the project's include paths and compile flags to resolve anything, and
would still not understand the macros without Unreal Header Tool's own
expansion. It buys type resolution the first rule family does not need.

The cost is stated rather than hidden: every rule declares `evidence: 'syntax'`
(R1.1), and no semantic rule ships until the analyzer can genuinely resolve
types (R1.2). The core's withholding machinery is therefore never handed a
claim this analyzer cannot support.

## The scanner tracks reflection context, not just lines

A rule cannot decide anything from a matched line alone. `ULyraPerformanceStatSubsystem* MySubsystem;`
is a defect inside a `UCLASS`, and is not addressable by `UPROPERTY` inside a
plain `struct` (R2.2).

So the scanner walks each header maintaining a stack of enclosing type
declarations, each carrying:

- the kind (`class` or `struct`)
- whether a `UCLASS()` / `USTRUCT()` macro immediately preceded it
- whether a `GENERATED_BODY()` / `GENERATED_USTRUCT_BODY()` appeared in its body
- the current access section (`public` / `protected` / `private`)
- the brace depth it opened at

A type is **reflected** only when the macro and the generated-body marker are
both present. That pair is what Unreal Header Tool requires, and either alone is
a half-declared type the engine itself rejects.

Rules receive members already annotated with their enclosing context. A rule
never re-derives it, so two rules cannot disagree about whether a type is
reflected.

## What the scanner deliberately does not do

- **No preprocessor.** `#if WITH_EDITOR` blocks are scanned as ordinary text.
  A member inside a disabled block is still a member in some configuration.
- **No macro expansion.** A type declared through a project's own wrapper macro
  is invisible. The analyzer reports what it can see and does not guess.
- **No template instantiation.** `TArray<UObject*>` is matched as a shape.

Each of these is a known blind spot rather than a bug, and belongs in the
analyzer's README so a reader knows what silence means.

## Rule families, in the order they earn their place

1. **Garbage collection.** A reflected type holding a raw `UObject`-derived
   pointer without `UPROPERTY()`. This is the family no general C++ analyzer
   catches, and the reason the module exists.
2. **Unreflected ownership** (R2.3). An unreflected type holding the same
   pointer. A different finding with a different remediation, never merged with
   the first.
3. Anything else only after measurement (R3.1).

## Module layout

```
packages/analyzer-unreal/
  analyzer.manifest.json     rules, match globs, exec
  package.json
  src/
    index.mjs                default export called with the request
    scanner.mjs              reflection-context walk
    object-types.mjs         which identifiers name UObject-derived types
    gc-rules.mjs             the first rule family
  test/
    fixtures/                .h files, one pair per rule
    *.test.ts                collected by the repository's one vitest run
```

`index.mjs` exports a default `analyze(request)` function. The `node` exec type
imports the module and calls that export — it does not spawn a process and does
not write stdin. A module that reads stdin at import never finishes loading.

## How "is this a UObject type?" is answered without a compiler

By convention and by declaration, in that order:

1. Epic's prefix convention: an identifier beginning `U` or `A` followed by an
   upper-case letter names a `UObject`-derived type; `F` names a plain struct;
   `I` an interface; `E` an enum.
2. Types the file itself declares or forward-declares, which override the guess.

The convention is Epic's own published contract (R4.2), not a studio
preference, so relying on it is reasonable. It is still a heuristic, and a
project that violates it gets false findings — so the check is an option a
project can narrow, and the analyzer's README says what it assumes.

## Testing

Fixture pairs per rule (`.bad.h` / `.ok.h`) plus a copy of the real Lyra header
that motivated R2.2, so the plain-struct case is a permanent regression test
rather than a note. Tests are `.test.ts` under `test/`, collected by the
repository's single vitest run — the same choice `analyzer-comments` made, and
what `tools/analyzer-coverage.mjs` requires of every analyzer.

## Open

- Whether `.cpp` files are worth scanning at all in the first release. The
  reflection macros live in headers; the rule families above may not need them.
