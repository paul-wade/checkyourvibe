# 0009 — Python analyzer: Requirements

**Status:** complete
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

A third analyzer, for Python, on the standard library `ast` module and no third-party dependency.

The rule count is not the point. Every analyzer before this one reads a statically typed language, and
the protocol quietly assumed an analyzer can resolve types: the TypeScript analyzer's headline feature
is detecting *inferred* `any`, and the C# analyzer uses Roslyn's semantic model. Python's `ast` gives
syntax and nothing else. This spec exists to find out what breaks when that assumption does not hold.

## Outcome

The analyzer works — four rules in a `core-py` pack, fixture pairs, and **11/11 conformance**. It was
built against the published protocol documents alone, and unlike the C# analyzer it found no new gaps
in them, which is itself a result: the fixes that spec 0004 forced were the real ones.

**Startup is roughly an order of magnitude cheaper than the C# analyzer**, which builds a
`CSharpCompilation` and loads the BCL reference set on every invocation. Per-language cost is therefore
a real input to whether an editor hook is viable for that language — not a property of the tool.

## The finding: severity is not confidence

The analyzer surfaced a genuine gap in the protocol, and argued it precisely.

A `Violation` carries location, rule, message, snippet and severity. Nothing says whether the finding
came from matching shape or from consulting a type system. With only `ast`, some things are provable —
a bare `except:` is a bare `except:`, an empty list default is an empty list default — and others are
not: whether an `assert` guards external input or an internal invariant, or whether `set()` in a
default refers to the built-in or a shadowed name.

**Severity is the wrong lever for this**, and that is the insight worth keeping. Severity measures
impact; evidence quality measures confidence. They are independent — a syntax-only finding can be
certain in shape and severe in consequence, while a semantically proven one can be trivial. Using
severity to signal uncertainty would force an analyzer to understate importance in order to be honest.

`RuleManifest` therefore gained an optional `evidence: 'syntax' | 'semantic'`. Per-rule rather than
per-violation: simpler, and it avoids widening the `Violation` schema, which is `additionalProperties:
false` by design. Omitted means *unspecified*, never *semantic* — an analyzer that has not considered
the question should not be credited with the stronger claim.

Every Python rule declares `syntax`.

## Requirements met

1. Reads one `AnalyzeRequest` from stdin, writes one `AnalyzeResponse` to stdout, nothing else on
   stdout; human-readable output goes to stderr and is folded into diagnostics by the core.
2. A file that fails to parse becomes a `skipped` entry with its reason, never a silent omission.
3. A malformed request produces a well-formed response whose diagnostics explain the problem, and a
   non-zero exit — never a traceback on stdout.
4. Rules chosen so a syntax-only analyzer can judge them honestly: `no-bare-except`,
   `no-mutable-default-arg`, `no-assert-for-validation`, `no-star-import`. All prose written from
   first principles for Python; no vendor named anywhere.
5. `.ok.py` fixtures are genuine false-positive guards — `except Exception:` is not a bare except,
   `def f(x=None)` is not a mutable default.
6. No third-party dependency, and no package manager was run.

## Not registered by default

The analyzer is built and conformant but is **not** listed in this repository's `checkyourvibe.json`.
There is no Python here to check, and registering an analyzer that will never match a file would add
startup cost and a `dotnet`-style runtime prerequisite for no benefit.

## Non-goals

Type inference. Cross-file resolution. Any rule requiring an import graph. Competing with a dedicated
Python type checker — a rule this analyzer cannot judge honestly is a rule it should not ship.
