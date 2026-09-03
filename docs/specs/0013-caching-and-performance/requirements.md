# 0013 — Caching and performance: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001, 0004

## Introduction

The C# analyzer costs roughly 500ms per invocation: every request pays a fresh runtime start, a
`StandardReferences.Get` load of the standard-library reference set, and a `CSharpCompilation.Create`
over every file in the request, because the one-shot process protocol in `packages/core/src/run/execute.ts`
cannot hold any of that warm between calls. `AnalyzerManifest` has carried a reserved
`capabilities.session` flag since 0001 for exactly this case, unused until now.

The roadmap names two candidate fixes — a `session` capability that lets an analyzer hold state across
requests, or a content-addressed cache that skips re-analysis of a file whose result is already known —
and one instruction that outranks both: **measure before building either**.

That instruction is the spine of this spec, not its preamble. "The C# analyzer is slow" resolves to
three different fixes depending on which of three numbers dominates: process/runtime startup, per-file
analysis work, or something else entirely (I/O, git diff computation, request/response serialization). A
session capability only helps the first. A result cache only helps the second, and only for files that
have not changed since the last run. Building either before knowing which one dominates is how a project
acquires a cache — or a stateful protocol, which is the larger commitment of the two — that it did not
need, or that solves the wrong 500ms.

A cache carries its own failure mode worth stating plainly up front: a cache that returns a stale finding
is worse than no cache, because it reports a clean file it never checked. That is this project's second
carried-forward principle — *silence is the enemy* — applied to a new surface, and it governs every
requirement below about what a cache key must cover and what happens when the cache cannot be trusted.

## Requirement 1 — Measure first

**User story:** As the person deciding whether to build a session capability or a cache, I want real
numbers instead of a stopwatch impression, so that the fix matches the bottleneck instead of whichever
roadmap entry read most excitingly.

1. The repository SHALL provide a reproducible benchmark, runnable as a single command, that reports
   three numbers separately for each process-based analyzer: **per-invocation startup cost** (time from
   spawn to the analyzer being ready to receive a request, isolated from analysis work), **per-file
   analysis cost** (time spent analyzing files once running, isolated from startup), and **total wall
   clock** for a full run. Collapsing these into one number is the exact ambiguity this requirement
   exists to remove.
2. The benchmark SHALL run against this repository's own C# and Rust analyzer targets, but SHALL NOT
   stop there: this repository is small — a handful of files per analyzer — and a benchmark that only
   ever measures a handful of files cannot tell startup cost apart from analysis cost, because analysis
   cost rounds to noise at that scale. The benchmark SHALL support pointing at an external directory of
   files so it can be run against a codebase of realistic size before any caching decision is made.
3. Results SHALL be recorded in the repository — committed, not left in a terminal scrollback — with the
   date, the analyzer and its version, the file count and approximate size of the target, and the three
   numbers from 1.1. A later change's claim to have helped is unverifiable against a number nobody wrote
   down.
4. WHEN the benchmark is re-run after a change intended to improve performance THEN its recorded numbers
   SHALL be compared against the prior recorded run for a comparably-sized target, and that comparison
   SHALL be part of what makes the change reviewable.
5. Neither a `session` capability implementation nor a result cache implementation SHALL begin until this
   benchmark exists, has been run against this repository and at least one externally-sized target, and
   its numbers are recorded per 1.3. This is the literal reading of "measure before building either," and
   it is a gate on starting the rest of this spec, not a suggestion.

## Requirement 2 — What correctness means for a cache

**User story:** As a developer relying on checkyourvibe to tell me about a real problem, I want a cache
hit to mean "this was actually checked and found clean," so that a cache never becomes a way for a stale
finding — or a stale absence of one — to reach me as truth.

1. A cache key SHALL be derived from everything that can change the result of analyzing a file: the
   file's content, the full configuration (id, options, and enabled state) of every rule that ran
   against it, the analyzer's own version, and the protocol version. Any one of these changing SHALL
   invalidate every cache entry that depended on it.
2. WHERE an analyzer's findings for a file can depend on something other than that file's content — a
   `tsconfig`, a project reference, a type resolved from another file — the analyzer SHALL either declare
   that dependency so the cache key can cover it, or SHALL be treated as not cacheable for the affected
   rules.
3. The C# analyzer, as built, compiles every file in a request together in one `CSharpCompilation`
   (`packages/analyzer-csharp/src/Program.cs`), which means a finding for one file can already depend on
   the presence and content of another file in the same batch. Per-file caching of its results is unsound
   until this dependency is either eliminated (analyzing files in isolation) or declared in a form the
   cache key can consume. This spec does not resolve which; see Open questions.
4. WHEN an analyzer or a rule is uncacheable per 2.2 THEN the run SHALL report that plainly — as a stated
   fact about that analyzer or rule, not as a cache miss indistinguishable from "not yet seen." A cache
   that always misses for a reason nobody surfaces is a cache silently doing nothing while claiming to
   help.
5. A cache hit SHALL reproduce the exact violations, skipped-file entries, and diagnostics the analyzer
   would have produced by actually running — never an approximation, and never a result that trades
   completeness for speed.

## Requirement 3 — The `session` capability as the alternative

**User story:** As someone choosing between the two fixes the roadmap names, I want the `session`
option's real cost stated honestly, so it is not chosen for looking simpler on the manifest than it is
to operate.

1. A `session`-capable analyzer turns the protocol's current one-request/one-response contract, per
   invocation, into a stateful one: multiple requests served by one long-lived process. That is a
   materially larger change than a cache, because a cache only ever adds a fast path in front of the
   existing stateless contract, while a session moves process lifecycle, crash recovery, and memory
   growth from "whatever the OS does when a short-lived process exits" onto the core.
2. WHERE the core manages a session-capable analyzer, it SHALL detect the process becoming unresponsive
   or exiting unexpectedly, SHALL NOT treat files sent to a session that never answered as clean, and
   SHALL recover — by restarting the session or falling back to a one-shot invocation for the affected
   files — rather than hanging or silently dropping them.
3. A long-lived analyzer process holding a warm compilation is exactly the kind of process whose memory
   grows across many requests. WHERE a session is used across a working session's worth of edits, the
   core or the analyzer SHALL bound that growth (for example, by recycling the process after a request
   or memory threshold) rather than leaving it unbounded until the OS intervenes.
4. `capabilities.session` on `AnalyzerManifest` (`packages/core/src/protocol/analyzer.ts`) SHALL remain
   optional and advisory. An analyzer that declares it SHALL still produce correct results when invoked
   one-shot, exactly as `runProcessAnalyzer` invokes it today — the capability is an optimisation the
   core may use when present, and SHALL NOT become something an analyzer, `cyv verify-analyzer`, or a
   user relies on being active.

## Requirement 4 — Cache location, clearing, and corruption

**User story:** As a developer who just did something that should invalidate a stale result — switched
branches, changed a tsconfig, hit a bug in the cache itself — I want an obvious way to clear the cache and
a guarantee that a broken cache fails loudly rather than quietly serving wrong answers.

1. A result cache SHALL live in a repository-local, gitignored directory, following this repository's
   existing convention for local tool state (`.cyv-review/` is the precedent) rather than a path outside
   the repository or a location that could be committed by an unwary broad `git add`.
2. The cache SHALL NOT be committed, and configuration or documentation SHALL NOT suggest committing it —
   a cache checked into version control is stale the moment it is written, for every contributor except
   the one who wrote it.
3. A command SHALL exist to clear the cache explicitly and unconditionally. Clearing SHALL never be an
   automatic side effect of an ordinary `cyv check` — a cache that clears itself under conditions a user
   cannot see is no more trustworthy than one that never invalidates.
4. WHEN the cache directory, an index, or an entry is unreadable, unparsable, or otherwise inconsistent
   with what its own key implies THEN it SHALL be discarded and the affected files SHALL be analyzed as
   if no cache existed, with a diagnostic naming what was discarded and why. A corrupt cache SHALL NOT be
   partially trusted — there is no principled way to know which of its entries are the ones that rotted.
5. A cache written under one protocol version or one analyzer version SHALL NOT be read under another;
   per Requirement 2.1 either changing invalidates the whole cache, and the safe default is to discard
   rather than to inspect entries individually for compatibility.

## Requirement 5 — Correctness verification, and in CI

**User story:** As a maintainer, I want proof that caching never changes an answer, not just an argument
that it should not, so that a bug in the cache is caught by a gate rather than by a user's silent trust
running out.

1. `cyv check` SHALL support a mode that runs the same file set twice — once with the cache disabled,
   once with it enabled — and asserts the two runs produce identical violations, skipped files, and
   diagnostics (modulo cache-attributable diagnostics themselves).
2. WHEN the two runs disagree THEN this mode SHALL fail loudly, reporting which findings differed and
   for which file, rather than reporting the cached run's result as if it were unremarkable.
3. This verification mode SHALL run in CI, on every change that touches the cache or an analyzer whose
   output the cache stores, so a regression is caught by the gate that can see both answers rather than
   by whichever developer happens to notice a finding vanished.
4. Running analysis twice is inherently slower than running it once. This mode SHALL NOT be the default
   for a developer's local `cyv check` — it is a CI and pre-release gate, not a habit imposed on every
   edit.

## Non-goals

A distributed or shared cache — anything one machine's run could populate for another machine or another
contributor to read. Anything hosted. Anything requiring an API key. All three would violate this
project's standing constraint that nothing may require a key or a network service to produce a correct,
offline result (see `docs/ROADMAP.md`, "Subscriptions, not metered APIs"), and a cache is exactly the kind
of feature that tempts a hosted "just sync it" shortcut. The cache this spec describes is local,
per-repository, and disposable.

## Open questions

- **Is per-file caching viable for the C# analyzer at all**, given it compiles every requested file
  together (Requirement 2.3)? The alternative — caching the whole batch as one unit — invalidates
  entirely the moment any one file in it changes, which may cache nothing useful in practice. This stays
  unresolved until the batching itself is revisited or a per-file dependency declaration is designed.
- **Are `session` and a cache actually alternatives**, or could a session-held compilation serve as the
  cache — sidestepping serialization entirely by keeping results in the same warm process that would
  otherwise need to recompute them? The roadmap poses them as an "either," but they may compose.
- **What does "rule options" mean for the cache key when an option is left at its schema default** rather
  than stated in configuration — is the key built from the resolved options after defaults are applied,
  or from the configuration as written? These need not produce the same key, and only one of them is
  safe.
- **Does the Rust analyzer need either mechanism**, given its `syn`-based native binary has no
  standard-library reference load and a much smaller cold-start cost by construction? Plausibly out of
  scope entirely — but that is exactly the kind of claim this spec insists be measured (Requirement 1)
  rather than assumed from the language's reputation.
- **Where does "anything the analyzer reads that is not the file itself" end** for a language not yet
  built, where the project-level dependency surface (a crate graph, a module resolution graph) looks
  nothing like a `tsconfig` or a batched compilation? Whether that needs a generic manifest-level
  declaration or remains bespoke per analyzer is not answered here.
