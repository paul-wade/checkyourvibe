# 0004 — C# analyzer (Roslyn): Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

A second language analyzer, for C#, built on Roslyn and run as a subprocess.

This is the spec that decides whether the analyzer axis is real. Everything so far has been Node
talking to Node: the TypeScript analyzer implements the subprocess protocol, but it is still our own
code, in our own language, written by people who knew what the core wanted. A C# analyzer cannot
import a single line of the core, cannot share its types, and cannot be debugged by reading the same
files. If the protocol is underspecified, this is where that shows.

Roslyn is the correct counterpart to ts-morph — a full compiler with a semantic model — so the C#
analyzer can do the thing that distinguishes this project from a syntax linter: detect what the
compiler *inferred*, not merely what someone wrote.

**Verified on this machine before writing this spec:** .NET SDK 9.0.314 is installed,
`dotnet new console` succeeds, and `Microsoft.CodeAnalysis.CSharp` restores and builds. This is not a
plan contingent on tooling that might exist.

## Requirement 1 — Protocol conformance from outside the ecosystem

**User story:** As someone writing an analyzer in a language that is not TypeScript, I want the
published contract to be sufficient, so that I do not have to read the core's source to succeed.

1. The analyzer SHALL be implemented using only the published protocol documents — the JSON Schemas
   under `docs/protocol/` and `docs/writing-an-analyzer.md`.
2. WHERE those documents prove insufficient or wrong, the gap SHALL be recorded as a documentation
   defect and fixed, not worked around by reading the core's TypeScript.
3. The analyzer SHALL pass `cyv verify-analyzer` with every check green.
4. The analyzer SHALL NOT depend on any checkyourvibe package.

## Requirement 2 — Execution

1. It SHALL declare `exec.type: "process"`.
2. It SHALL read one `AnalyzeRequest` as JSON from stdin and write one `AnalyzeResponse` as JSON to
   stdout.
3. stdout SHALL carry the JSON response and nothing else. Diagnostics for humans go to stderr, which
   the core folds into the response's diagnostics.
4. WHEN the request is malformed THEN it SHALL emit a well-formed response whose diagnostics explain
   the problem, and exit non-zero — never a stack trace on stdout.
5. It SHALL NOT require a project or solution file to analyse a single file, because editor hooks
   invoke it on one path at a time.
6. Startup cost SHALL be reported in the design once measured. If a cold start makes the editor hook
   unusable, that is a finding about the protocol's one-shot shape, not something to hide.

## Requirement 3 — Real semantic analysis

1. At least one rule SHALL require the semantic model rather than syntax alone, mirroring `no-any`'s
   role in the TypeScript pack.
2. WHERE a compilation cannot be fully resolved (a missing reference, a file analysed outside its
   project), the analyzer SHALL report that condition rather than emitting findings derived from a
   degraded model.
3. Requirement 2 above is not optional politeness. The TypeScript analyzer produced 91 fabricated
   findings from a degraded type graph, and that defect is the reason this requirement is written
   explicitly.

## Requirement 4 — Starter rules

1. The analyzer SHALL ship a `core-cs` pack containing at minimum:
   - `no-dynamic` — the `dynamic` keyword, C#'s counterpart to `any`.
   - `no-unchecked-cast` — direct cast expressions where `as` plus a null check, or pattern matching,
     would be honest.
   - `no-null-forgiving` — the `!` null-forgiving operator.
   - `no-empty-catch` — a `catch` block that swallows without handling or rethrowing.
2. Every rule SHALL carry a full manifest: `summary`, `why`, `allowedFixes`, `notFixes`, `examples`,
   and `pack: "core-cs"`.
3. Rules SHALL be written from first principles for C#. They SHALL NOT be translations of the
   TypeScript rules' prose, and they SHALL NOT name any vendor, library, or framework.
4. The `notFixes` graph SHALL be internally consistent: a `notFix` may only reference a rule id that
   exists in this analyzer.
5. Each rule SHALL have fixture pairs where the `.ok.cs` file is a genuine false-positive guard.

## Requirement 5 — Coexistence

1. Configuration SHALL support both analyzers at once, routing `.ts` files to one and `.cs` to the
   other.
2. A file claimed by two analyzers SHALL remain a configuration error, not a silent first-match win.
3. `cyv check` SHALL aggregate violations from both into one report, sorted and grouped consistently.
4. The report SHALL make clear which analyzer produced a finding when that is not obvious.

## Requirement 6 — Build and distribution

1. The analyzer SHALL build with `dotnet build` and run with `dotnet <dll>` or as a published binary.
2. Its manifest's `exec.command` SHALL work when the checkout is not the current working directory —
   the core resolves relative `exec` paths against the manifest's own directory, and this analyzer is
   the first real test of that.
3. WHEN the .NET runtime is absent THEN `cyv check` SHALL report that clearly rather than failing with
   an opaque spawn error. A user without .NET who never asked for C# support should not be confused.
4. CI SHALL build and test the analyzer, and SHALL run `cyv verify-analyzer` against it.

## Requirement 7 — The verdict

1. This spec SHALL record every change the C# analyzer forced on the core, the protocol, or the
   published documentation.
2. It SHALL record what `docs/writing-an-analyzer.md` failed to explain, because that document's whole
   purpose is to be sufficient for exactly this exercise.
3. The verdict SHALL be written plainly whether or not it flatters the design.

## Non-goals

Analyzing whole solutions. Incremental or watch-mode support for C# — the one-shot protocol is what is
being tested. NuGet publication. Any rule requiring cross-project analysis.
