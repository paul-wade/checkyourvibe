# 0025 — SQL and schema migrations: Requirements

**Status:** active
**Created:** 2026-08-28
**Depends on:** 0001, 0029, 0031

## Introduction

The roadmap names this analyzer "different in kind from every other analyzer" and says why: "the
unit is a migration, not a file, and the interesting rules are about *irreversibility* — a dropped
column, a non-concurrent index build, a `NOT NULL` added without a default. It does not fit the
file-scoped protocol cleanly, and finding out exactly where it breaks would tell us more about the
protocol than another well-fitting language would." Every analyzer built so far — TypeScript, C#,
Python, Rust, and the Go and Swift proposals — has treated "check this file" and "check these files
together" as the only two shapes a request needs, because for source code, the order in which two
files are handed to a compiler or a linter never changes what is true about either one. This spec's
job is to find out whether that assumption survives contact with a migration, and to say so plainly
where it does not, rather than force-fitting a design the domain does not support.

**No live database, no real migration history, and no target dialect are available while writing
this spec.** This repository has no migrations directory of its own — the same position the Rust,
Go, and Swift specs were in for their languages — so nothing below has been run against a real
migration history, and no rule proposed here has been checked against a running database engine.
Every claim about what a rule can and cannot decide is reasoned from the SQL standard's and the
major engines' documented behavior, not from executing anything. Where 0021 and 0023 record this gap
as a toolchain-verification task to run before coding a rule, this spec's equivalent gap is larger:
there is no toolchain to verify, only a written contract (a database engine and a migration tool's
transaction-wrapping convention) that varies by adopter, which is itself one of this spec's findings
rather than a caveat on top of it.

## Requirement 1 — What the unit of analysis actually is, and whether either declared scope fits

**User story:** As someone deciding whether this analyzer can be built as `scope: 'file'` or
`scope: 'project'`, I want an honest answer about which one applies, so that the analyzer is not
shipped claiming a scope it cannot actually deliver on.

1. A migration file's own text answers some questions completely on its own — whether an `ALTER
   TABLE` statement carries a `DEFAULT` clause is true or false from the bytes of that one file, no
   matter what came before it. But its most consequential questions are not about the file in
   isolation, they are about a *transition*: whether `DROP COLUMN age` removes a column that exists,
   whether `ALTER TABLE users ADD COLUMN plan_id integer NOT NULL` lands on an empty table or a
   populated one, whether two migrations three files apart are really one rename split in half. None
   of those are properties of the file; they are properties of the accumulated effect of every
   migration that ran before it, in the order it ran. `scope: 'file'` (`packages/core/src/protocol/rule-manifest.ts`:
   "`file` rules examine one source file at a time... work in hook and explicit-path invocations")
   is honest about what it can promise here — one migration's own statement shapes, nothing about
   history — and every rule in Requirement 3 that depends on prior schema state is out of bounds for
   it. This is not a gap to work around inside a `scope: 'file'` rule; it is the boundary the field
   already draws correctly.
2. `scope: 'project'` is documented as needing "the whole tree (cross-file maps, orphan detection)"
   — a model built for *unordered* cross-referencing, where seeing every file matters but the
   sequence they arrive in does not (an import graph is the same graph regardless of which file's
   imports get walked first). A migration history is not that shape. Handing a migration-history
   rule "the whole tree" without a guaranteed, correct order is not a weaker version of what it
   needs, it is a different computation: replaying `DROP COLUMN age` before `ADD COLUMN age integer`
   proves something true; replaying the same two statements in the other order proves the opposite.
   `scope: 'project'` gets the *completeness* half of what this analyzer needs and is silent about
   the *order* half, which for source-code analyzers has never mattered and here is the entire
   question.
3. Neither value, therefore, is sufficient on its own, and the honest way to say why is: `scope:
   'file'` cannot see history at all, and `scope: 'project'` can see a full file set but the protocol
   makes no promise about what order that set arrives in or that it will not be split across more
   than one request (Requirement 2 shows both gaps are real today, not hypothetical). A rule needing
   "the complete, correctly ordered migration history, delivered whole" is asking for something
   neither declared scope, nor any combination of the two, currently states as an obligation anywhere
   in the protocol.
4. The smallest protocol change that would close this gap is not a third `scope` value — `file` vs.
   `project` still correctly separates "needs the whole tree" from "does not," and every other
   analyzer's rules sort cleanly into one or the other. What is missing is a way for a rule to declare
   that it needs the *complete* set its manifest's `match` glob covers, undivided, rather than
   whatever subset of that set the current run mode happens to have selected. This spec proposes a
   new, optional `RuleManifest` field, `requiresCompleteFileSet: boolean`, read by `runCheck`
   alongside `scope`: WHEN true and the file selection behind the current request is not known to be
   the analyzer's whole matched set — which today means anything except `mode: 'all'`, per
   Requirement 2 — the core SHALL exclude that rule from the request (the same way
   `rulesForAnalyzer` already excludes `scope: 'project'` rules under `requestMode: 'file'`,
   `packages/core/src/run/check.ts` lines 63–79) and SHALL emit a diagnostic naming the rule and the
   reason, rather than run it against a fragment and let it either find nothing or find something
   built on an incomplete replay. This is a small, mechanical addition — a second boolean check next
   to one that already exists — not a redesign, and Requirement 2 is why it is necessary rather than
   ornamental.
5. A second, easy-to-miss wrinkle even inside "the unit is a migration": a repository's SQL files are
   not automatically its migration history. Seed data, ad hoc query files, and application-level
   `.sql` used by an ORM's raw-query escape hatch can live in the same tree as the actual migration
   sequence, and a manifest's `match` glob (a list of path patterns, `packages/core/src/protocol/analyzer.ts`)
   has no way to distinguish "this `.sql` file is part of the applied history" from "this `.sql` file
   is something else that happens to share an extension." Every migration tool answers this
   differently — a dedicated directory, a filename convention, a ledger table inside the target
   database itself — and none of those answers is visible from a glob. This spec assumes the common
   case (a single, dedicated migrations directory, one file per migration) and treats a mixed or
   multi-tool layout as out of scope; Requirement 5 and the Non-goals section return to this.

## Requirement 2 — Ordering is semantic here, and the request shape does not carry it

**User story:** As someone who has just watched a coding agent generate a new migration file, I
want the hook that fires right after that edit to see this analyzer's most important findings, so
that the one moment this tool is most useful is not also the one moment it is structurally blind.

1. For every other analyzer this project has built or proposed, the order in which two files are
   checked never changes the answer for either one. For this analyzer, order is not a performance
   detail, it is the entire content of the claim: "this migration drops a column" is true or false
   depending on whether an earlier migration created that column and no later-but-still-earlier one
   dropped it first. Nothing else in this project's rule set has this property, and the request shape
   — `AnalyzeRequest.files: string[]`, `packages/core/src/protocol/analyzer.ts` — was designed
   entirely around cases where it does not hold.
2. Tracing where the actual file list comes from (`packages/core/src/run/discover.ts`,
   `selectFiles`) shows the gap concretely, mode by mode:
   - `mode: 'files'` (explicit paths) and `mode: 'staged'` (`git diff --cached`) both resolve to
     `requestMode: 'file'` (`analyzeModeFor`, `check.ts` lines 59–61), so `scope: 'project'` rules —
     where every history-dependent rule in Requirement 3 would have to live — never run at all.
   - `mode: 'working'` (diff against the merge base) and `mode: 'branch'` (diff against a branch) do
     resolve to `requestMode: 'project'`, unlocking project-scope rules to run — but the `files` list
     behind them is still only what `git diff --name-only` reports as changed
     (`discover.ts` lines 237–250). A newly added migration file arrives alone, with none of its
     predecessors, in exactly the mode a post-edit hook is built around. A rule needing "the schema as
     of the migration before this one" receives one file and nothing to compare it to.
   - `mode: 'all'` (`git ls-files` for tracked, plus `--others --exclude-standard` for untracked,
     `discover.ts` lines 199–217) is the only mode that supplies the complete file set this
     analyzer's rules need — but it is also the mode a coding agent's post-edit hook does not run in,
     because rerunning every check-all rule after every single edit is the cost this project's
     hook/full-check split exists to avoid.
   - The practical consequence: this analyzer's history-dependent rules are usable in `cyv check
     --all` and effectively unusable in the hook path that fires immediately after the file they are
     most relevant to was written. That is close to the opposite of what a migration author needs —
     the check that could stop a bad `DROP COLUMN` from being committed is available only in the mode
     that runs least often.
3. Even where the complete set is delivered (`mode: 'all'`), order is not delivered with it in any
   form the protocol promises. `git ls-files` returns paths in tree order, which is lexicographic by
   path — not "the order these migrations were applied." Many migration-naming conventions happen to
   make those coincide (a zero-padded timestamp or version prefix sorts the same way it applies), but
   that is a property of the naming convention an adopter chose, not of the protocol, and it fails
   exactly where the convention is not followed: unpadded sequential versions sort `V1, V10, V11, V2`
   lexicographically, and some migration ecosystems (a per-migration dependency list rather than a
   single linear sequence) do not have a total filename order at all — the true order is a fact
   recorded inside the migration files themselves, not recoverable by sorting their names. An
   analyzer built on "sort the files this array happens to contain" is trusting a convention the
   protocol never asked the caller to guarantee.
4. A second, independent way the array can be silently fragmented: `groupFilesByRules`
   (`check.ts` lines 175–203) splits an analyzer's file set into more than one `AnalyzeRequest`
   whenever a per-path configuration override gives two files different resolved rule settings — a
   single suppressed migration among fifty otherwise-identical ones is enough to split the set into
   two requests, each internally ordered but with no relationship declared between them. This exists
   for a good reason (an override should not force every other file in the run into the same request)
   and it is invisible to every existing rule, because no existing rule's correctness depends on
   seeing every other file's request in the same call. It would not be invisible to a rule replaying
   migration history, which is exactly the audience `requiresCompleteFileSet` (Requirement 1.4) has to
   account for: the check that field enables must also refuse to run when the analyzer's matched set
   has been fragmented this way, not only when a run mode has narrowed it.
5. What this implies for the request shape, stated plainly: `files: string[]` already carries a real
   array order today, and nothing in the protocol forbids an analyzer from trusting it — but nothing
   in the protocol *promises* it either, for either mode selection or grouping, because nothing before
   this analyzer has ever needed that promise kept. `requiresCompleteFileSet` closes the completeness
   half. Order itself is left to the analyzer to reconstruct from filename convention once it holds
   the complete set — the protocol does not need to learn what a migration tool's naming convention
   is, but it does need to stop silently handing this analyzer a set it cannot promise is either whole
   or ordered and calling that a request the same shape as every other analyzer's.

## Requirement 3 — The rules, and what each one can actually prove

**User story:** As someone reading a finding from this analyzer, I want to know whether it rests on
this file's own text, on the accumulated history behind it, or on something no static analyzer could
ever see, so that I give the finding exactly the weight it has earned and no more.

The pack below is scoped to a single dialect (Requirement 5) and a single migration-file convention
(one file per migration, applied in a determinable order). It is presented at the same level of
detail as the Rust, Go, and Swift starter packs so the evidence question can be answered rule by
rule — not as a pack this spec is recommending be shipped as-is; the Recommendation section says why.

1. **`no-drop-column`** — an `ALTER TABLE ... DROP COLUMN` naming a column.
   **Evidence: syntax, for the bare fact that a drop statement exists.** Recognizing the statement
   shape needs no resolution at all. **Evidence: semantic, for the claim that the dropped column is
   real** — that it was not added and dropped inside the same migration, and that an earlier `DROP
   COLUMN IF EXISTS` did not already remove it — which requires the cumulative column catalog built
   by replaying every predecessor migration in order. That catalog plays exactly the role a symbol
   table plays for the TypeScript analyzer's `no-any`, so this is a legitimate use of `semantic`
   under the existing definition, not a new category. **Not decidable at all:** whether the table is
   populated, whether the column is still read by deployed application code, whether the current
   deployment is rolling. Requirement 4 covers why the rule must say so rather than assume the worst
   or the best.
2. **`no-drop-table`** — the same shape one level up, `DROP TABLE`.
   **Evidence: syntax** for the statement; **semantic** for confirming the table was not created and
   dropped within the same replayed window. Strictly worse than `no-drop-column` on the "cannot
   decidable at all" axis: a dropped table can cascade to drop dependent foreign keys and views that
   the migration text never mentions, and which objects those are depends on the *full* schema graph
   at that point in history, not just the one table's own column list — a heavier computation this
   spec does not work out further than naming it here.
3. **`no-not-null-without-default`** — a column made `NOT NULL` (an `ADD COLUMN ... NOT NULL` with no
   `DEFAULT`, or a two-step `ADD COLUMN` followed by `ALTER COLUMN ... SET NOT NULL` with no
   intervening backfill statement visible in the same file).
   **Evidence: syntax, and only syntax — the one rule in this pack with no history dependency at
   all.** Whether the statement carries a `DEFAULT` clause, and whether an `UPDATE` appears between
   the column's creation and the `NOT NULL` constraint being applied, are both facts of this one
   file's text. This is worth stating explicitly as the exception that proves Requirement 2's point:
   not every migration rule needs history, only the ones whose claim is about a *change relative to
   what existed before* (drop, rename) rather than a *property of this statement standing alone*
   (missing a default). **Not decidable at all:** whether the table has any rows yet — the fact that
   turns this from a no-op into a full-table rewrite or a hard failure — and whether the specific
   engine version in use can apply a constant default without rewriting existing rows at all, which
   varies by engine and by version within the same engine. This is the clearest instance of
   Requirement 4's obligation: the rule can prove the statement shape with total confidence and must
   not extend that confidence to the severity of running it.
4. **`no-nonconcurrent-index`** — `CREATE INDEX` missing the dialect's non-blocking option (Postgres's
   `CONCURRENTLY`; the nearest equivalents in other engines are named and scoped differently, which is
   why Requirement 5 restricts this rule to one dialect rather than generalizing the keyword check).
   **Evidence: syntax** for the keyword's presence or absence. **Not decidable at all, and worse than
   a missing fact — actively dialect- and tool-dependent:** whether the blocking build even matters
   (an empty or small table locks for a moment nobody notices) and, sharper than that, whether the
   non-blocking form is even legal in context — Postgres refuses to run `CREATE INDEX CONCURRENTLY`
   inside a transaction block at all, and if the migration tool wraps every file in an implicit
   transaction (a convention this spec has no way to read off the file), the "fix" this rule's
   guidance would otherwise suggest does not merely fail to help, it fails to run. The rule's guidance
   text is required to say this rather than present the concurrent keyword as a context-free
   improvement.
5. **`no-mixed-schema-and-data-migration`** — one migration file containing both a DDL statement
   (`CREATE`/`ALTER`/`DROP` on a table, column, or index) and a DML statement that touches rows
   (`INSERT`/`UPDATE`/`DELETE` against a table, as opposed to metadata).
   **Evidence: syntax** — classifying a statement as DDL or DML is a grammar-level fact, decidable per
   file with no history needed. **Not decidable at all:** whether the two actually run "in one
   transaction" in the sense that matters — some engines auto-commit around most DDL regardless of
   any transaction wrapper the migration tool applies, which means the risk this rule is gesturing at
   (a partially applied migration) is sometimes real and sometimes a false alarm depending on the
   target engine's own DDL-transactionality rules, a second, independent axis from the tool's own
   wrapping convention named in Requirement 3.4. The rule can prove the mixture; it cannot prove the
   mixture is dangerous in a given adopter's stack.
6. **`no-implicit-rename`** — a heuristic: within a small window of the migration history, a `DROP
   COLUMN` on one table correlated with an `ADD COLUMN` of a compatible type on the same table,
   suggesting the author performed a rename as a drop-and-add instead of `RENAME COLUMN`.
   **Evidence: neither syntax nor semantic, honestly.** Detecting the correlation needs history (so
   it is not a single-file syntax fact), but even given the complete, correctly ordered history, the
   finding is a guess about *intent* — the tool can observe that a drop and a compatible add happened
   near each other and cannot know whether that was one rename or two unrelated changes that happen
   to resemble one. This is this pack's sharpest example of the instruction this spec was asked to
   honor: where a rule's real basis is "these two protocol-defined evidence tiers do not describe
   what I actually have," it must say that rather than round up to `semantic` because the alternative
   (`syntax`) sounds too weak for how much history it consulted. This spec does not resolve which
   evidence value, if any, honestly covers this rule — Open Questions returns to it, and the
   Recommendation treats it as a candidate for dropping from the pack entirely rather than shipping
   under a label that overclaims.

One interlock edge is worth recording without building the full graph a shipping pack would need:
`no-drop-column`'s most tempting non-fix is splitting a rename into a `DROP COLUMN` in one migration
and an `ADD COLUMN` of the new name in a later one, on the theory that spreading it across two files
makes it a smaller change. It does not — the tool still sees a drop, still reports it, and the
`because` text should say the split additionally creates a window during deploy where neither the old
nor the new column carries the row's data, which is worse than the single-file version, not better.
Per 0031's authoring discipline, this edge is named because it is a real, observed dead end, not
manufactured to make the graph look more connected than five rules and one heuristic actually are.

## Requirement 4 — What the analyzer cannot know, and must not claim

**User story:** As someone deciding how much to trust a severity on one of these findings, I want the
rule's own guidance to tell me which facts it could not check, so that I do not read "error" as "this
will hurt you" when the rule has no way to know that.

1. Four facts recur across Requirement 3 and none of them is available to a static file-based
   analyzer under any circumstances this spec can construct: **whether the target table is
   populated** (a row count, which exists only in a live database this analyzer never connects to);
   **whether a dropped or renamed column is still read by deployed application code** (which requires
   knowledge of every application and service reading the same database, not just the migration
   repository, and which this project's own principle of no cross-repository, no-external-service
   analysis rules out); **whether the deployment carrying this migration is rolling** (old and new
   application code briefly coexisting against the same schema is an operational fact about the
   deployment pipeline, not about the SQL text); and **the target engine's exact version and its
   specific behavior for a given DDL form** (whether adding a `NOT NULL` column with a constant
   default requires rewriting existing rows differs by engine and by version within the same engine).
2. WHERE a rule's severity would, in reality, hinge on any of these — `no-drop-column`,
   `no-drop-table`, and `no-not-null-without-default` all do — its guidance SHALL say so explicitly,
   in the rule's `why` text, rather than assert a fixed severity that implicitly assumes the worst
   case (a populated table, code still reading the column, a rolling deploy) or the best case (an
   empty table, dead code, an all-at-once deploy). "This drops a column; whether that column still
   holds meaningful data or is read anywhere is not something this check can see — verify both before
   trusting a clean report to mean nothing will break" is the standard this spec sets, matching the
   register 0029 Requirement 1.3 already requires of a `degraded` reason: name what is missing, in
   terms a human can act on.
3. This is not a new mechanism. 0029's `evidence` field already carries exactly this kind of honesty
   for a narrower case — a shape-matched finding that cannot prove what a resolved type system could.
   This requirement is the same discipline extended past `evidence`'s own two-value vocabulary and
   into the guidance prose itself, for the specific facts (population, live readership, rollout
   shape) that no evidence tier this protocol defines was built to describe at all. 0029's non-goals
   already declined to extend `evidence` past `syntax`/`semantic` for a reason that still holds — a
   two-value confidence signal doing one job well. The facts in Requirement 4.1 are not a confidence
   gradient on the same axis `evidence` measures; they are fixed, permanent unknowns for a static
   analyzer of any evidence tier, which is why they belong in guidance prose rather than as a pressure
   to invent a third `evidence` value this spec is not proposing.
4. A rule that cannot state what would change its answer is not being honest about a decidable
   question it got wrong; it is failing to state that the question was never decidable by this tool
   in the first place. This requirement exists to keep those two failures from looking identical in
   a finding's guidance text.

## Requirement 5 — Dialect

**User story:** As someone adopting this analyzer, I want to know which SQL engine's behavior its
rules actually reason about, so that a rule written against one engine's rules does not misfire on a
migration written for a different one.

1. SQL is not one language, and the differences that matter most to this pack are exactly the ones
   Requirement 3 depends on: whether DDL runs transactionally at all (true for some engines, false or
   partial for others — an engine that auto-commits around most DDL makes `no-mixed-schema-and-data-
   migration`'s entire premise moot for that engine, not merely less severe), what a non-blocking
   index build is called and where it is legal (a dedicated keyword usable outside a transaction in
   one engine; a table-rewrite option expressed differently in another; not offered at all in a
   third, single-writer engine that locks the whole database for any write regardless), and what
   `ALTER TABLE` forms are even supported (some engines historically could not `DROP COLUMN` at all,
   which would make `no-drop-column` fire on a statement that cannot exist in that dialect's real
   migrations).
2. A rule built to look for one dialect's specific keyword (Postgres's `CONCURRENTLY`) and pointed at
   a migration written for a different engine does not degrade gracefully to "no finding" — it
   misfires, either by flagging every single index creation in a dialect where the concept it is
   checking for does not exist in that form, or by silently passing files it cannot actually parse as
   if they were clean. 0029 already records what this looks like in production: `no-non-null-index-
   write` fired fourteen times against this project's own TypeScript source and was wrong fourteen
   times out of fourteen, because its premise held for one shape (an array) and not for the shape it
   was actually run against (a record). A dialect mismatch here is the same failure at a coarser
   grain — not a rule that is sometimes too strict, a rule reasoning about a language the file in
   front of it is not written in.
3. Three options exist, and this spec picks the first rather than leave the choice open:
   - **One dialect, chosen explicitly.** Every rule in Requirement 3 is written against
     PostgreSQL's specific grammar and transactional semantics. The cost is total, stated plainly:
     this analyzer has zero coverage for a migration written for any other engine, and a manifest
     `match` glob of `**/*.sql` cannot express "only Postgres SQL" (Requirement 1.5) — the analyzer
     itself must recognize what it cannot parse as Postgres and report those files as skipped with a
     named reason, never silently analyze them as if the grammar matched.
   - **Several dialects, each with its own rule variants.** Rejected for a starter pack: Requirement
     3 already shows that the *interesting* part of each rule — what makes a non-concurrent index
     build dangerous, what makes mixing DDL and DML risky — is precisely where engines diverge, so
     "several dialects" would mean writing most of this pack twice or three times over before any of
     it has been checked against one real migration history, the same order-of-operations mistake
     0009 warns against for Ruby/PHP: building more coverage before the first instance has been
     judged useful.
   - **A parsed-but-dialect-agnostic subset.** Rejected outright, not merely deferred: a generic SQL
     grammar can recognize "this is a `CREATE INDEX` statement" and "this is a `DROP COLUMN`
     statement" across dialects, but every rule this pack's evidence analysis found interesting is
     interesting exactly because of a fact a generic grammar cannot see — whether DDL is
     transactional, what the non-blocking option is called, whether it is legal here. A
     dialect-agnostic pack would be left with the statement-shape detection half of Requirement 3 and
     none of the irreversibility reasoning the roadmap named as the point of building this analyzer
     at all.
4. Choosing Postgres is not a claim that Postgres is the more important engine; it is a claim that a
   rule which understands one engine's real transactional and locking behavior is worth more than a
   rule that understands five engines' statement grammar and none of their behavior, for a pack whose
   whole value proposition is irreversibility, not statement recognition.

## Requirement 6 — 0029 compliance for a migration analyzer

**User story:** As a reviewer checking this pack against the standing obligation every analyzer
carries, I want to know what "degraded" means for something that does not have a tsconfig or a
module graph, so that a migration finding is not trusted unconditionally just because nothing here
looks like the case 0029 was written against.

1. This analyzer has a genuine full-vs-reduced resolution axis, the condition 0029 Requirement 1.1
   asks every analyzer to check for. Full resolution is: the complete, correctly ordered migration
   history from the first migration (or a trusted baseline, see Open Questions) through the file
   under evaluation, delivered in one request. Reduced resolution is anything short of that —
   Requirement 2 showed this is the *common* case today, not an edge case, because `mode: 'working'`
   and `mode: 'branch'` supply a diff, not a history.
2. Per 0029 Requirement 1.2, WHEN this analyzer runs `no-drop-column`, `no-drop-table`, or
   `no-implicit-rename` (the three rules in Requirement 3 whose evidence depends on the replayed
   catalog) against anything other than the complete, correctly ordered set, it SHALL report every
   file in that request under `AnalyzeResponse.degraded`, with a reason naming what was missing —
   "this request contained 1 migration file without its predecessor history (received via `mode:
   'working'`); column-existence and rename-correlation findings require the complete migration
   sequence and were not evaluated for this file" is the standard 0029 Requirement 1.3 sets, applied
   here.
3. Per 0029 Requirement 1.4, `no-not-null-without-default`, `no-nonconcurrent-index`, and `no-mixed-
   schema-and-data-migration` — the three rules Requirement 3 found fully decidable from one file's
   text — SHALL continue to run and report normally even when the request is degraded for the other
   three rules. A missing history degrades the rules that need one; it has no bearing on a rule whose
   evidence was always confined to the one file in front of it, and folding those files to `skipped`
   to avoid reporting an unsound history-based finding would discard a sound one to protect against an
   unsound one that was never going to run in the first place.
4. Per 0029 Requirement 3.3, this manifest SHALL declare `capabilities.degradableResolution: true` —
   it has semantic rules (Requirement 3.1, 3.2, 3.6) and can, per Requirement 6.2, actually detect and
   report the condition, unlike the C# analyzer's unfixed position or the Python/Rust/Swift trivial
   pass case.
5. One condition is specific to this analyzer and has no analogue in 0029's existing text: even under
   `mode: 'all'`, where the complete file set is delivered, the analyzer may still be unable to
   establish a confident total order over it (Requirement 2.3 — an unpadded version scheme, or a
   migration format whose true order is a declared dependency graph rather than a filename sequence).
   WHERE the analyzer cannot derive an order it trusts, that SHALL also be reported as degraded for
   the affected files, with a reason naming the ambiguity, rather than silently picking an order and
   reporting findings as if it were certain of it. This extends 0029 Requirement 1's "detect which
   mode you actually used" to a case 0029 did not anticipate: a resolution mode degraded not by a
   missing configuration file, but by an ordering convention the analyzer had to infer and could not
   confirm.

## Non-goals

Connecting to a live database to answer any of Requirement 4's unknowns — row counts, whether a
column is still read, or an engine's exact version behavior. This is not deferred as future work
this spec expects to reach; Requirement 4 argues those facts are useful specifically because they
are unavailable to a static analyzer, and a rule engineered to fetch them stops being the same kind
of tool this project builds. Migration ecosystems whose migration file is not literal SQL — a
schema-definition language compiled to SQL, or a general-purpose language's migration DSL — where
the actual DDL the target database receives is generated, not authored; this spec's unit of analysis
(Requirement 1.5) is a literal `.sql` migration file, and a generated-SQL ecosystem's real source of
truth lives one layer up from anything this analyzer reads. Reproducing a migration tool's own dry-
run or lint feature, where one exists. Multi-dialect support (Requirement 5.3). A notFixes graph
built out to the density the TypeScript or Rust packs reached — Requirement 3's one recorded edge is
honest about being a start, not a finished interlock. Detecting a rename via anything stronger than
the heuristic in `no-implicit-rename`, and shipping that heuristic at all is itself left open below.

## Open questions

1. **Does a baseline/checkpoint concept belong in the protocol, or only in this analyzer's own
   configuration?** Requirement 1's "complete history" assumes replay from migration one is
   affordable. A real adopter with years of migrations may instead keep a baseline schema snapshot and
   discard old migration files entirely (a common practice this spec has not designed for). Whether
   `AnalyzeRequest.options` is an adequate, ad hoc place to pass such a baseline, or whether this is
   common enough across future history-dependent analyzers to deserve a named protocol field, is left
   for whoever picks this spec up next to decide with a real adopter's layout in hand.
2. **Is `no-implicit-rename` honest enough to ship at all?** Requirement 3.6 already flags that its
   evidence does not fit either protocol value cleanly. A rule whose finding is "we correlated two
   statements and guessed at your intent" is close to the shape 0029/T7004 already burned this project
   on once — a rule that sounds authoritative and is frequently wrong. Whether it ships as an advisory
   note rather than an ordinary violation, or does not ship in a first version at all, is not decided
   here.
3. **Should `requiresCompleteFileSet` (Requirement 1.4) generalize beyond this analyzer, or is
   migration history the only case this project will ever have for it?** No other analyzer proposed
   or built so far needs it. Adding a field for an audience of one rule pack is a real cost against
   the same "rule count is the easiest thing to grow" caution the roadmap states for rules; this spec
   argues the field earns its place here regardless, but whether it is designed narrowly for this pack
   or generally for "an ordered, undividable file set" is a call for whoever implements it.
4. **What happens when `groupFilesByRules`' override-driven split (Requirement 2.4) and
   `requiresCompleteFileSet` interact with a config that legitimately wants to silence one rule on one
   migration** — say, a known-safe backfilled `NOT NULL` the team has already reviewed? Suppressing
   that one file's `no-not-null-without-default` finding should not need to fragment the whole
   history-dependent request the way it would today; whether the fix belongs in how overrides are
   grouped generally, or in a narrower carve-out for `requiresCompleteFileSet` rules specifically, is
   unresolved.
5. **Is there a real, literal-`.sql`-migration codebase available to run this against?** 0029
   Requirement 5 treats a real-codebase run as a shipping gate, not optional polish, and 0023 recorded
   the identical gap for Swift. This repository has no SQL migrations of its own to substitute, the
   same position Rust and Swift were in — unlike them, this spec does not know of an accessible
   external corpus of raw-SQL migration history to test the replay model against, and finding one is a
   precondition for calling any rule in Requirement 3 validated rather than merely reasoned about.

## Recommendation

**Not yet.** The roadmap framed this analyzer as an experiment on the protocol rather than a product
need, and the experiment's answer is that the protocol has a real gap, not a cosmetic one: the mode a
coding agent's hook actually runs in today (`working`/`branch`, a diff) structurally cannot supply
what this analyzer's most valuable rules require, and the mode that can (`all`) still makes no
promise about order, which is the one thing that makes a migration a migration rather than an
ordinary file. Shipping `core-sql` today would mean its two irreversibility-specific rules
(`no-drop-column`, `no-drop-table`) either silently under-report in the hook path or have to be
withheld there entirely with no protocol mechanism to say so cleanly — precisely the kind of quiet,
discoverable-the-hard-way gap this project's own founding incident (a solution-style `tsconfig`
silently destroying type resolution) exists to prevent repeating.

Three things have to be true first, in order: (1) `requiresCompleteFileSet`, or an equivalent
protocol-level acknowledgment that some rules need an undivided, complete file set rather than
whatever a run mode's selection happens to contain, has to be designed and reviewed at the core
level — not invented ad hoc inside one analyzer's own request handling, which would silently
reintroduce the exact "analyzer resolved something the core has no visibility into" failure 0029
exists to close off. (2) The baseline/checkpoint question (Open Question 1) needs an answer, because
a design that only works by replaying from migration one is not a design a real, years-old migration
history can use. (3) A real literal-SQL migration history — this project has none of its own, per
0029 Requirement 5 and the precedent 0023 already set for Swift — needs to be identified, because a
fixture pair proves a rule detects the shape it was written for and nothing about how often that
shape means what the rule assumes, the same lesson `no-non-null-index-write` already taught this
project once on its own source.

None of that is a reason to abandon the idea. The reasoning in Requirements 1–2 is itself the
valuable output the roadmap predicted: it is now known, specifically and with citations to running
code, where the file-scoped protocol stops being able to describe this problem honestly, and
`requiresCompleteFileSet` is a small, addressable answer rather than a redesign. Building the analyzer
before that field exists would produce a tool whose cleanest reports are the ones least worth
trusting — which is the one outcome every prior spec in this project has been written to prevent.
