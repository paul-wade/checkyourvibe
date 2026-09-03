# 0028 — A concurrency and async pack: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0007, 0027

## Introduction

`no-floating-promise` fired once against this repository and was right the first time. Inside
`packages/core/src/run/watch.ts`, a debounce timer called `void flush()`. `flush` awaits `runOnce`,
which throws when an analyzer fails — a subprocess analyzer that is not installed is enough to trigger
it. `void` silences the compiler's "unused expression" complaint; it does not attach a rejection
handler. The failure therefore surfaced as an unhandled rejection thrown from a `setTimeout` callback
with no caller left to catch it: the process either died mid-session or, worse, kept the watcher running
while it had silently stopped reporting anything. The fix — recorded in the same file — was an `onError`
callback threaded through `WatchOptions` so a failed run has somewhere to go. This is not a synthetic
example written to justify the pack; it is the strongest evidence any rule in this project has produced,
because it was found in code written by people who knew the rules, on the first run, against the tool's
own source.

The same body of work produced the opposite result. `no-non-null-index-write` reported fourteen
findings against this repository and was wrong all fourteen times — every one was a record insertion
(`merged[ruleId] = override`), which an index write into a `Record` is supposed to do, not a risky write
past the end of an array. The rule is disabled, not deleted, because its premise is sound for arrays and
tuples and the narrowing work is recorded as open (`docs/specs/0007-rule-packs/tasks.md`, T7004).

This spec exists between those two outcomes. A concurrency and async pack is where the highest-value
finding this project has produced came from, and it is also where the sharpest tool exists to produce
another `no-non-null-index-write`: questions about *when* and *whether at the same time* are, in
general, not answerable from one file. What follows is which candidate rules can answer their question
soundly today, which cannot without more than this protocol gives an analyzer, and what has to be shown
before any of them ship enabled by default.

## Requirement 1 — Why a concurrency rule is a different kind of claim, and the bar for shipping one

**User story:** As someone deciding whether to enable this pack, I want every rule in it to have earned
its place the way `no-floating-promise` did, not merely to exist because the category sounded valuable.

1. Every other rule in the TypeScript analyzer asks a question a single expression can answer: is this
   cast unchecked, is this catch empty, is this index write guarded. A concurrency rule asks whether two
   things happen at overlapping times, or whether a value crosses a boundary this analyzer cannot see
   past — the caller of an exported function, the scheduler that decides when a callback runs, another
   file's copy of the same call. `scope: 'project'` does not close this gap; it gives a bigger static
   picture of the same repository, not the runtime order in which its code executes. No `scope` value
   this protocol defines answers "did these two writes actually interleave."
2. A rule that cannot answer its question soundly for the shape it targets SHALL either narrow its claim
   until it can, or SHALL NOT ship enabled by default. T7004 is why this is not a stylistic preference:
   a rule wrong 14 times out of 14 did not merely waste fourteen reviews, it is the exact mechanism that
   teaches a developer to stop reading this tool's findings — the cost of a false positive here is not
   local to the finding, it is borrowed against every true finding the rule (and, once trust is spent,
   every other rule) produces afterward.
3. The standard for what "narrowed until it can" looks like already exists in this codebase and this
   spec holds every rule below to it. `no-non-null-index-write`'s `isInGuardCondition` carries a doc
   comment that states its own deliberate hole plainly — loop-bound checks are accepted with no proof
   they name the right receiver, because the alternative (refusing them) is what produced the
   fourteen-for-fourteen result — rather than either hiding the hole or pretending a heuristic is a
   proof. Every rule proposed below that ships is written to that same disclosure standard: what it
   proves, and the specific shape of case it knowingly does not catch.
4. "Sound enough to ship enabled" is operationalized in Requirement 5, not left as a feeling: a rule
   ships enabled only once running it against this repository's own source produces findings that are,
   individually, all true positives — the `no-floating-promise` outcome, not the `no-non-null-index-write`
   one.

## Requirement 2 — The candidate rules

Five candidates were considered. Each is evaluated for what it can prove from one file, plus whatever
the TypeScript analyzer's type checker resolves across the project, and what it cannot prove without
information this protocol does not give an analyzer — the caller's identity, the scheduler's behavior,
or code outside the repository.

1. **An async function whose rejection has no handler.** This is `no-floating-promise`
   (`packages/analyzer-typescript/src/rules/no-floating-promise.ts`), already shipped in `core-ts` and
   the rule the Introduction is about. **Evidence: semantic** — it needs the type checker to know a call
   expression's return type is `Promise<T>`; nothing about that is visible from syntax alone, since any
   function name could return a promise or not. It proves that, at one call site, the returned value is
   discarded without being awaited, returned, stored, or given a rejection handler. It does not, and
   cannot from one file, prove that a *handled* promise's rejection handler does something useful — that
   is a different, much harder claim, and this rule does not make it. Moving this rule from `core-ts`
   into this pack is itself a pack membership change of the kind T7001 and T7006 warn about; it is listed
   as a migration hazard in Requirement 4.
2. **Work started and never awaited at a boundary, even when the local expression looks handled.** Two
   distinct claims hide under this description, and they do not ship the same way.
   - The narrow, provable form: an async function (or any function whose inferred return type is a
     `Promise`) passed as an argument where the target parameter's own declared or inferred signature
     returns `void`, not `Promise<unknown>` or `unknown`. TypeScript structurally allows this assignment
     — a `Promise<void>`-returning function is assignable wherever a `void`-returning callback is
     expected — which is exactly why it is easy to write and easy to miss: the compiler raises nothing.
     Proposed as **`no-async-void-callback`**. **Evidence: semantic** — it requires resolving both the
     passed function's return type and the target parameter's declared type through the checker; no
     syntactic pattern distinguishes a `void`-typed callback parameter from a `Promise`-typed one. This
     is decidable from one file (plus the whole-project type graph the analyzer already loads for
     `no-floating-promise` and `no-any`), because the mismatch is a static fact about two resolved types
     at one call site — it needs no knowledge of who calls the callback or when. **This ships.**
   - The broad form implied by "a route handler, a lifecycle method": that any async function assigned
     to a well-known handler or lifecycle slot is invoked later by code this analyzer never sees — a web
     framework's request dispatcher, a UI framework's render loop — and that its rejection is therefore
     unobserved regardless of what the local expression looks like. This is a true and common bug shape.
     It is also not decidable from a file-scoped protocol: proving it requires knowing that the *caller*
     of the assigned function never attaches a handler, and the caller is, by construction, code outside
     this repository or resolved through a runtime property lookup the type checker does not follow.
     Narrowing this to "any function assigned to a parameter or property whose name matches a known
     lifecycle convention" would mean hard-coding a specific framework's handler names into a rule — the
     one thing rule guidance in this project is not allowed to do, and a narrower version than that has
     not been found. **This does not ship.** It is recorded here as a real gap rather than silently
     dropped, per the Roadmap's "silence is the enemy" principle.
3. **A cancellation token or abort signal accepted and never checked.** Proposed as
   **`no-ignored-abort-signal`**: a function parameter whose resolved type is (or includes, in a union)
   the platform's standard cancellation-signal type, where the parameter's identifier has zero references
   anywhere else in the function body — not read, not passed to another call, not attached to a listener.
   **Evidence: semantic** — confirming the parameter's type is the cancellation type, rather than an
   unrelated type that happens to share a parameter name like `signal`, requires the checker; matching on
   the name or the literal annotation text would misfire on an aliased import or a differently-typed
   parameter. What it proves: this specific parameter is dead in this function body. What it does not
   prove: that cancellation is meaningfully honored, only that the parameter is not silently ignored — a
   function that reads `signal.aborted` once and never acts on it passes this rule and is still broken in
   a way this rule cannot see. It also has a known false-positive shape worth naming before it ships: a
   parameter required by a typed interface or callback signature that a given implementation genuinely
   has no use for is a legitimate reason to accept and not reference it, and this rule cannot distinguish
   that from an oversight. Whether that shape is common enough to disqualify the rule is exactly what
   Requirement 5's self-application run has to answer, not something asserted here.
4. **A shared mutable value written from two async paths.** As stated, this does not ship, and it is the
   clearest case in this pack of a question the file-scoped protocol cannot answer soundly. Proving a
   race needs a call graph telling us whether two functions that write the same value can actually be
   invoked with an `await` between them at the same time — an interleaving fact, not a static one, and
   knowable in general only by knowing every call site across the program, including ones reached through
   dynamic dispatch. `scope: 'project'` does not rescue this: a bigger static picture still is not a
   schedule. The nearest sound-adjacent shape — a module-scope or object-field value read in a condition,
   followed by an `await`, followed by a write to that same value with no lock, dedup, or re-check after
   the `await` (the classic check-then-act-across-a-suspend-point pattern) — is worth naming as a future
   candidate, but it was not designed further here: every function with that shape is not necessarily
   ever called twice concurrently, and asserting it is would repeat T7004's mistake with a subtler
   premise instead of a simpler one. **Not proposed to ship, and not designed past this paragraph.**
5. **`await` inside a loop where the iterations are independent.** This is a performance observation, not
   a correctness one, and the two questions get answered by different processes: "is this a bug" is what
   a false-positive rate can invalidate, "is this slower than it needs to be" is true or false regardless
   of intent. A rule that reports it a fault by default would be wrong about the category, because
   sequential awaiting inside a loop is frequently deliberate — rate-limiting a downstream call,
   preserving write order, avoiding a burst of concurrent requests a receiver cannot absorb — and a rule
   with no way to distinguish "accidentally sequential" from "deliberately sequential" is the same shape
   of premise error that produced T7004's fourteen wrong findings, on a claim that is additionally not
   even a correctness claim to begin with. **It does not belong in this pack.** If it is ever built, it
   belongs in a pack whose findings are labeled advisory-for-performance from the start, with a category
   and default severity that never reads as "this is broken," and that is a decision for whichever spec
   proposes that pack — not a quiet addition here.

## Requirement 3 — The interlock

`notFixes` in this pack SHALL name only real dead ends — ones this codebase's own history or this pack's
own rule logic actually produces, never an edge invented to make the graph look denser.

1. **`void somePromise()` is the literal shape of the bug this pack's headline rule found.** It is not
   listed as a `notFix` on `no-floating-promise`, because it is not a dead end that evades the rule — the
   rule's own `isHandled` check already treats a bare, uncommented `void` expression as unhandled and
   reports it (`packages/analyzer-typescript/src/rules/no-floating-promise.ts`). It is recorded here as
   the reason `no-async-void-callback`'s guidance SHALL warn explicitly against reaching for `void` at
   the call site as a "fix": wrapping the mismatched callback argument in `void` does not resolve the
   type mismatch this new rule reports, and if the wrapped expression is itself an unhandled promise-
   returning call, `no-floating-promise` reports it again on the same line. An author who tries this gets
   caught twice by two different rules for the same underlying discard, which is the interlock working
   as designed rather than a coincidence.
2. **`.catch(() => {})` turns a floating rejection into a swallowed one, and this is a genuine gap today,
   not a solved edge.** `no-floating-promise`'s `isExplicitlyHandledChain` treats any `.catch(...)` call
   as handling the promise regardless of what the callback body does
   (`packages/analyzer-typescript/src/rules/no-floating-promise.ts`) — an empty-bodied `.catch` silences
   the rule exactly as effectively as a real handler. The natural interlock is a `notFix` on
   `no-floating-promise` pointing at `no-swallowed-catch`. But `no-swallowed-catch`'s current detection
   (`isEmptyCatchClause`, `packages/analyzer-typescript/src/rules/no-swallowed-catch.ts`) only inspects
   `try`/`catch` clauses; it never looks at a promise's `.catch(...)` method call, so an empty
   `.catch(() => {})` passes both rules today. Recording the `notFix` as though this already worked would
   be exactly the kind of dishonesty the Roadmap calls out — a pack's `notFixes` describing an interlock
   that does not exist. This spec records the gap instead: **shipping this `notFix` truthfully requires
   first broadening `no-swallowed-catch` to also flag an empty-bodied `.catch(...)` callback**, which is
   a small, separately-scoped change to an existing `core-ts` rule, not part of this pack, and is listed
   in Open Questions rather than assumed done.
3. **`no-ignored-abort-signal` → no interlock target exists.** The tempting non-fix — reference the
   signal once, trivially (`console.log(signal)`, an unused-looking `void signal`) to satisfy a
   reference-count check without acting on it — is a real dead end but not one any existing rule in this
   analyzer catches; nothing here polices "referenced but not meaningfully used." Per the precedent set
   by the Go analyzer's `no-panic-in-library` (`docs/specs/0021-go-analyzer/requirements.md`, Requirement
   5.5) and the Rust analyzer's `no-unsafe-block`, a rule with a real dead end and no sibling rule to
   point at ships with that `notFix` recorded with no `rule` field rather than an invented one.

## Requirement 4 — Cross-language applicability, and the boundary 0027 already drew

1. The rule *ideas* in this pack transfer well beyond TypeScript, more directly than most packs proposed
   in the Roadmap: an unawaited `Task` and `async void` in C#, an un-awaited coroutine and a bare
   `asyncio.create_task` result in Python, a dropped future and an unjoined `JoinHandle` in Rust are the
   same underlying claim — work was started, and the thing that would observe its failure or its result
   is not present — expressed in each language's own types. That is a discovery about the model, in the
   sense 0023's Swift entry hopes for from `no-non-null-assertion`, not merely a coincidence of naming.
2. What does not transfer is the implementation, and this spec does not propose one. Each analyzer is
   independent code with its own semantic model — Roslyn's `Task<T>`, Python's `ast` with no type
   information at all (so a Python version of any of these would have to either accept `evidence: syntax`
   for a materially weaker claim or take on a separate type checker, exactly the choice 0009 already
   documented as the Python analyzer's founding constraint), Rust's ownership rules already refusing
   most concurrency mistakes this class of rule exists to catch outside `unsafe`, per the Roadmap's
   standing caution.
3. 0027 Requirement 5.5 already decides the shape this has to take: "a pack's `members` SHALL be drawn
   from a single analyzer manifest's own `rules` array... a pack SHALL NOT span multiple analyzers." This
   spec does not revisit that. The pack proposed here — `concurrency-async` — is authored inside
   `packages/analyzer-typescript`'s own manifest and scoped to its own rules, exactly as `strict-boundaries`
   is today. If a concurrency pack is ever proposed for the C#, Python, or Rust analyzers, each is its
   own pack, independently authored, independently versioned, sharing a name and an `intent` by
   convention rather than by any code or schema link between them. That answers the Roadmap's framing of
   0027 as deciding "whether a pack is a per-analyzer or a cross-analyzer concept": per-analyzer, and this
   spec's pack is built to that answer rather than around a different one.
4. This pack's `intent`, once 0027's declared-pack shape lands (see Open Questions on which side of that
   spec's own open question this depends on), reads: "rules governing whether asynchronous work is
   awaited, cancelled, or safe to run concurrently" — specific to what its members check, per 0027
   Requirement 5.1's bar for what an `intent` has to be.

## Requirement 5 — How each rule is proven before it ships enabled

Every rule below already has a fixture pair by the time it is implemented; the existing rules in this
analyzer prove that a fixture pair is not what caught either `no-floating-promise`'s success or
`no-non-null-index-write`'s failure — both were fixture-clean and both results came from running against
real code. This spec requires the same discipline for every rule proposed to ship:

1. Before a candidate rule (`no-async-void-callback`, `no-ignored-abort-signal`) is enabled by default in
   any pack, it SHALL be run, unmodified from its shipped form, against every package in this repository
   — not a subset chosen because it looks favorable.
2. Every violation that run produces SHALL be triaged individually by a human reader, the same way T7002's
   single finding was read closely enough to identify the exact failure mode and T7004's fourteen were
   read closely enough to see they were all the same category of mistake. A count alone ("N findings") is
   not triage; "here is what each one is and whether it is right" is.
3. A rule ships enabled by default only if that triage shows every reported violation is a true positive.
   This is deliberately the same bar `no-floating-promise` met (1 finding, 1 correct) and
   `no-non-null-index-write` did not (14 findings, 0 correct) — not a percentage threshold, because a
   percentage threshold would have let `no-non-null-index-write` ship at any cutoff below 100%.
4. WHERE a rule's self-application run produces zero violations, that is not by itself evidence the rule
   works — an inert rule and a correct-but-untriggered one look identical. The rule's fixture pair SHALL
   include at least one `.bad` case constructed to mirror the actual shape of a real historical bug where
   one exists — `no-async-void-callback`'s bad fixture SHOULD reconstruct the shape closest to
   `watch.ts`'s own history (an async operation handed to a signature that discards its promise), since
   that is the one concrete, verified instance this project has of the bug class it targets.
5. A rule whose self-application run finds a false positive SHALL follow the `no-non-null-index-write`
   precedent exactly: disabled in `checkyourvibe.json` rather than deleted, with the false-positive shape
   recorded in this pack's own follow-on tasks file in the same form T7004 recorded it — the wrong
   premise stated plainly, not just the count.

## Non-goals

Detecting an actual race condition from static analysis alone — Requirement 2.4 explains why this is not
merely undone work but a claim this protocol's file-scoped evidence cannot make sound, and no scope value
it defines changes that. A performance-oriented "unnecessary sequential await" rule — Requirement 2.5
excludes it from this pack on category grounds, not protocol grounds; it may belong to a future pack this
spec does not propose. The broad "unawaited work at a framework boundary" rule described in
Requirement 2.2 — recorded as a real gap, not solved by a narrower rule found here. Cross-analyzer pack
sharing of any kind — 0027 Requirement 5.5 already forecloses this. Deadlock detection, thread-pool or
worker-thread-specific rules (Node's single-threaded event loop is this pack's whole territory), and any
rule requiring runtime instrumentation rather than static source analysis.

## Open questions

- **Does `no-swallowed-catch` get broadened to cover an empty-bodied promise `.catch(...)` as part of
  this spec's implementation, or as its own small, separately-tracked change to an existing `core-ts`
  rule?** Requirement 3.2 needs this to be true before the `notFix` it describes can be recorded
  truthfully. This spec takes no position on which task does it, only that the `notFix` SHALL NOT be
  written until it is done.
- **Is `no-floating-promise` actually moved into `concurrency-async`, or does it stay in `core-ts` and
  get referenced by this pack instead?** Requirement 2.1 treats the move as the natural reading of the
  Roadmap entry and the task brief that named it "the one rule of this pack that already exists," but a
  pack move is exactly the T7001/T7006 hazard 0027 exists to police, and 0027 is not yet built. This
  spec's position is that the move should not happen ahead of 0027 landing, since moving it under today's
  bare `pack: string` field would repeat T7006 with no reporting to catch it — the same failure this
  pack's own headline rule exists to prevent one layer up.
- **`no-ignored-abort-signal`'s interface-conformance false-positive risk (Requirement 2.3) is asserted,
  not measured.** Requirement 5's self-application run is where this gets answered; this document takes
  no position on whether the rule survives that run in its current, simplest form or needs a carve-out
  for parameters whose type comes from an implemented interface rather than a locally declared function.
- **Is the check-then-act-across-`await` pattern named in Requirement 2.4 worth designing further at
  all, or is race detection simply out of scope for this protocol permanently?** This spec leaves it
  named but undesigned rather than answering it either way.
- **This pack's `packs[].intent` and `version` (Requirement 4.4) depend on 0027's own unresolved question**
  of whether pack membership is authored on the rule or on the pack. This spec's pack declaration cannot
  be finalized ahead of that choice, and implementing this spec SHOULD wait on it rather than encode a
  provisional shape that has to be migrated twice.
