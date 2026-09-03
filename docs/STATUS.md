# Status

Newest first. One entry per stretch of work, written when it lands rather than
summarised afterwards. What was found matters more than what was built.

## Notes reach the agent without it asking, and a dispatch says what arrived

Spec 0042 closed. The exchange was pull-only: a note landed in
`.cyv-review/comments.json` and nothing carried it into the session, so three
notes went unread for an hour while `cyv comments` got run twice, when the
orchestrator remembered. It is a hook now, the way findings are.

Verified by leaving notes rather than by asserting. A note left on the dashboard
reached a session through `cyv comments --hook claude-code` without the session
asking, exiting 2 so the text is handed to the model rather than printed past
it; a second run exited 0 and delivered nothing, so a note arrives once. Then a
dispatch was opened, a note was left while it ran, and `--close` printed it
after the outcome without marking it read.

**The cursor advances on a flushed write, not a returned call.** `console.log`
returns before the write reaches the far end, so advancing on its return would
mark a note read that a closing pipe swallowed. A test fails the first write and
asserts the second run still delivers.

**Codex gets no notes hook, and the reason was nearly a silent defect.** Its
hooks are a TOML array-of-tables merged by ownership marker, and `mergeToml`
replaces the first entry containing the marker and *deletes the rest*. The notes
command contains the analyzer hook's marker as a substring, so a second entry
would have installed cleanly, worked, and disappeared at the next `cyv init`
without a word. Found by reading the merge before writing the entry. The same
overlap is harmless on the five adapters whose hooks sit in one JSON array
replaced whole. `doctor` now states the gap, and states which agents have no
refuse-to-stop equivalent — a fact about a vendor's contract, not a defect in an
adapter.

**Wiring the cursor into the dashboard introduced the only `dashboard/` to
`cli/` import in the tree** and it was caught by grepping for the pattern, not
by any gate. Nothing here reports a layering violation, which is worth noting
given how much else it does report. The cursor moved to
`dashboard/review/cursor.ts`, which both sides import.

## The orchestrator is briefed, can execute its own work, and the scopes were wrong three times

Spec 0041 landed. The session that starts in this folder is now told what it is:
which lane it is, which lanes take dispatched work and whether their programs
exist, how many dispatches may be open at once, and that it must not edit the
repository while one is running. One function in core generates that text and
all six adapters write it, so the brief cannot describe the run differently
depending on which agent is reading.

**The verification found a bug the tests could not.** `cyv init --dry-run` on
this repository planned no orchestration block at all. `init` reads the config
through `parseExistingConfig`, which is deliberately lenient — it has to work on
a configuration too broken to load, because it is the command that repairs one —
and it keeps only the fields it needs, dropping `executor`. So the brief was
generated from a lane list that was always empty, and returned nothing, in
silence. `doctor` and `upgrade` were fine, because they read through
`loadConfig`. Every unit test passed throughout.

That is the founding principle for the fourth or fifth time: the only findings
worth trusting are the ones the tool produced while pointed at real code. The
fix reads through `loadConfig` and falls back to no block when the config will
not load — a configuration too broken to load has no lane declaration worth
briefing from either. There is now a regression test, and it was checked by
reintroducing the bug and watching it fail.

**A refusal named an option that did not work.** Requirement 2.4 asks that a
no-eligible-lane refusal name self-execution instead of ending on a list of
exclusions. It did, printing "`--self` runs this task on lane session" — and
`--self` was then refused by the same reservation it was supposed to escape,
because it only set the lane id while `acceptsDispatch` stayed false. Also found
by running it rather than by a test. `--self` now overrides the reservation for
that one dispatch: the caller taking responsibility for spending the
orchestrating subscription, the same shape as naming a metered lane with
`--lane`, and scoped to one dispatch rather than to every dispatch after it.

**Three of seven `_Exec:` scopes were drawn too narrow**, and the pattern is
worth stating because it will recur. T41002's text required `doctor` to state
two resolved values and its `files=` did not name `doctor.ts`. T41006's text
said "the brief points at it" and did not name `brief.ts`. T41004's was the
instructive one: adding a member to the `LaneIneligibility` union broke two
exhaustive switches, which tsc named immediately — and two further consumers
have `default:` clauses, compiled unchanged, and degraded. `executor/parse.ts`
would have returned `undefined` for the new reason, silently dropping a recorded
rejection when the log was read back. That is the failure principle 2 exists to
prevent, and nothing but reading the consumers would have caught it.

**A task that adds a member to a union owns every consumer of that union**, and
the ones with a `default:` clause are the dangerous half, because the compiler
will not name them.

**Documentation ran ahead of the code, for two specs.** `AGENTS.md`'s "Planning
for parallel execution" section already covered everything Requirement 3.4 asks
for, and referenced `cyv plan <spec>` and `executor.maxConcurrentDispatches`
while neither existed. Both landed here. Nothing in this repository reports that
state, and it held for at least two specs.

**Requirement 4.3 expired before it could be run.** It asks that `cyv plan 0040`
show more than one task in its first wave; 0040 reached 16 of 16 while 0041 sat
open, so the command correctly prints "every task is done". Verified against
0036 instead, whose first wave holds three. A requirement that names a specific
spec's open work has a shelf life, which is worth knowing before writing another
one.

**cyv found five of its own violations in this spec's code**, none suppressed.
Three were inferred `any` — twice from `Array.isArray` narrowing an `unknown` to
`any[]`, once from `JSON.parse` — and the same `isUnknownArray` guard fixed all
three, which is an argument for a codemod. Two were `no-editorial-comment`, on
comments this session wrote; one read "saying so is better than rendering a
confident blank", a judgment against an alternative that is not in the file.
That rule targets a habit a generator has and a human mostly does not, and it
caught a generator. The pre-commit gate also refused one commit outright, over
`twoLanes[0]!` in a test written moments earlier.

**Left for the owner.** `cyv init` has not been run for real on this repository.
The dry run confirms the block and its content, but a real run also reapplies
about thirty files of unrelated pre-existing drift, including agent files under
the home directory, and that is a decision rather than a verification step.

## The exchange was pull-only, and needs-you did not clean up after the agent

Two findings from the owner using the dashboard while the orchestrator worked.

**Three notes went unread for an hour.** The exchange is written to a file and
nothing carries it into the session; `cyv comments` was run when the
orchestrator remembered, twice. The project's own lesson about advisory prose
applies one layer up. Spec 0042 is the fix: notes delivered through the agent
hook the way findings are, a `Stop` hook that refuses to end a turn with a
note unread, `cyv dispatch` printing what arrived while it ran, unread-age on
the page, and `cyv comments --watch`. Until it lands, a monitor polls the
command every twenty seconds.

**Answered notes stayed on needs-you.** Replying did not mark the note
addressed, so four answered notes sat beside a parked roadmap entry with no
way off the list but a tap. Now: a reply marks its note addressed; an
acknowledgement names any item, so owner tasks and parked entries carry
"needs nothing" and `cyv acknowledge <id>` does the same from the terminal;
a task whose latest dispatch succeeded is tagged "landed — check it off"
instead of being offered as work.

**The diff tab.** difit proxied through the dashboard so a phone-width
stylesheet can hide its header, the Viewed button and the old-line-number
column; desktop untouched. The dashboard discovers a difit the agent started on
difit's own default ports and frames it, so the owner's habit of starting difit
after every task needs no second install and no port. Both halves were
dispatched to the lanes and passed every gate first time through the repaired
runner.

## Dogfooding the dashboard found a gate the runner could never pass

Reworked "needs you" after the owner's reading of the first render: "I have
no idea what the question is; a link to the doc doesn't help." Each item now
states what happened, asks the decision as a question, and carries its
answers as buttons: tell the agent (prefills the exchange box), needs nothing
(an `acknowledged` log event), close the record (an abandoned dispatch), mark
addressed (a note), open (the document). Dispatch items name the spec task
rather than the dispatch id.

The two halves went to the lanes as T40009 (devin-cli, the reader) and T40010
(antigravity-cli, the renderer), in parallel with disjoint scopes, while the
orchestrator held `home-model.ts` and the server route.

**Both closed `gates-failed`, and both were correct.** Each executor reported
its vitest gate green; the runner recorded exit 1 and nothing else. Reproduced
through the runner's own child process: `npx.CMD` was launched as
`cmd /d /s /c <path> <args>` with the path as a separate argument. Node quotes
an argument with a space, `/s` strips the first and last quote of the command
string, and cmd ran `C:\Program`. `pnpm`'s shim sits under a directory with no
space, so that gate passed and hid the fault. `launchArguments` now builds one
quoted command line and passes it verbatim, and a failed gate keeps the tail of
what it wrote (0036 R11.4 applied to gates). The dispatched work was verified
by hand — 30 tests, typecheck clean, zero findings — and accepted; the records
keep the outcome the runner recorded, because that is what happened.

**An escalation re-ran finished work.** T40010's second attempt, on the
stronger model, found the first attempt's files already correct and added a
trailing newline to each so the dispatch would not read as `produced-nothing`.
An escalation after a gate failure that was the runner's fault re-spends the
lane on nothing; the fix above removes the cause, and the pattern is worth
knowing.

**The diff tab framed the wrong server.** difit's default port, 4173, is also a
common preview server's default, and `difitUp` was a TCP connect. difit now
runs on 4381 to 4383 and the probe fetches the page and looks for difit's own
name.

Changed:

- `packages/core/src/executor/program.ts`, `child.ts`, `gates.ts`,
  `packages/core/src/cli/dispatch.ts` (the launcher and gate output)
- `packages/core/src/executor/dispatch.ts`, `parse.ts`, `store.ts` (the
  `acknowledged` event)
- `packages/core/src/dashboard/view-model.ts`, `home-model.ts`, `home.ts`,
  `shell.ts`, `review/needs-you.ts`, `review/difit.ts`,
  `packages/core/src/cli/dashboard.ts`

## The dashboard was an apology, and it is now four regions about the run

Opened `cyv dashboard` at phone width to see what specs 0034 to 0037 were
describing. The page was 79,000 pixels tall. Every panel opened with a
paragraph explaining what it refused to draw before it drew anything — the
executor panel's lede was six sentences about quota meters it did not have —
and the front page was a rule browser, an interlock graph, trend, file heat,
baseline and suppressions, none of which say what is happening. The 4180
review UI answered the question in four screens and knew nothing about lanes.

Spec 0040 replaced the page rather than merging the two. Four regions, in the
order a person asks: needs you; in motion (running now with liveness, next-up
waves by disjoint file scope, just finished, a stall line, uncommitted work);
lanes, with the orchestrator marked and its self-report attributed; the
exchange, with a paragraph box that reaches `cyv comments`. A project
dropdown and the last check at the top; diff, docs and rules one tab away.
Rules kept its page at `/rules`, unchanged. `tools/review/` is deleted.

**A running dispatch can be stopped from the phone.** Two taps, then the
supervising pid is killed by the liveness judgement's evidence and the record
closes as `did-not-complete` with the stop stated in its detail. Verified
against a real process: a detached sleeper registered as a dispatch died on
the second tap and its close entry followed. An abandoned dispatch closes the
same way without a kill; an undetermined one is refused with the reason.

**Tests were on the headline and are not the product.** The 4180 verdict
carried `1037 tests pass`. cyv has no opinion on whether a project has tests;
a suite is one gate a task may name. The check indicator now shows the last
`cyv check` and nothing else.

**Every closed failure stayed in "needs you" forever.** The first render of
the real log listed a superseded attempt beside the attempt that answered it.
Only the latest attempt of a unit of work can still be waiting on a person,
and a refusal answered by a later dispatch of the same work is history.

**The diff tab trusts a port.** `difitUp` is a TCP connect, carried across
from 4180. On this machine 4173 is currently held by the landing-page dev
server, so the diff tab framed the landing page. Not fixed here; the check
should ask difit rather than the socket.

**Looked at, on a phone width, with real state.** Three registered projects,
one of them a fixture with a live dispatch, an abandoned one (dead pid on this
host), a lane cooling after `produced-nothing`, a degraded self-report, an
owner note and an agent turn; one fresh project with nothing at all, to see
every empty state; and this repository. What read wrong the first time: the
task id printed twice on a running row, the spec number printed twice on the
docs ledger, and the superseded-attempt noise above. The fixture's log was
written by hand; the liveness judgement, the stop, the stall and the cooldown
were computed by the same code that runs against a real one.

**The port put 2,460 lines under the rules.** Written under the hook from the
first line; two findings on the way (an editorial comment, an `any` inferred
from an async iterator) and no rule found wrong about the context.

Also delivered, from 0036: `judgeLiveness` (T36005), `cyv orchestrator` and
the `orchestrator` log event (T36006), and the stall signal with
`executor.stallAfterMinutes` (T36007). Spec 0041 — the orchestrator is briefed
from the configuration, one subscription can execute by sub-agent, and
`maxConcurrentDispatches` plus `cyv plan` make waves explicit — is written and
is next.

Changed:

- `packages/core/src/dashboard/` — `view-model.ts`, `home-model.ts`,
  `motion.ts`, `lanes.ts`, `home.ts`, `shell.ts`, `pages.ts`, `stop.ts`,
  `review/*` (new); `render.ts` (ledes removed, nav param)
- `packages/core/src/executor/` — `liveness.ts`, `stall.ts` (new),
  `dispatch.ts`, `parse.ts`, `store.ts`
- `packages/core/src/cli/` — `dashboard.ts` (rewritten), `projects.ts`,
  `comments.ts`, `orchestrator.ts` (new), `index.ts`
- `packages/core/vendor/marked.min.js` (moved from `tools/vendor/`)
- `tools/review/**`, `tools/vendor/**` (deleted)
- `AGENTS.md` (planning for parallel execution), `docs/ROADMAP.md`,
  `docs/specs/0040-*`, `docs/specs/0041-*`, `docs/specs/0036-*/tasks.md`,
  `docs/specs/0037-*/tasks.md`

## The first real dispatch failed on its own build output, and the lane config described a machine that does not exist

Dispatched T36001 to the devin lane — the first unit of spec work this project
has handed to an executor since the lane machinery was built. It surfaced four
defects, three of them in cyv rather than in the work.

**A gate's build output counted as an ownership violation.** devin edited exactly
the four files it declared and both gates passed, and the dispatch closed as
`out-of-scope-write`. The seven offending paths were a `dist/` tree and a
`.tsbuildinfo` written by the `pnpm typecheck` gate. `git status` showed only the
four intended files, and every one of the seven is gitignored.

Every dispatch whose gates compile anything fails that way, and
`out-of-scope-write` does not escalate — so the run stops with correct work
marked failed. Ownership is a claim about what the executor authored; the
snapshot sees every byte that changed and cannot tell authored from generated.
The diff is now split before it is judged, by asking git rather than by keeping a
list of directory names in the core, which would have been this project's layout
imposed on every repository the tool runs in. Ignored paths are reported as
touched and not judged, because a dispatch writing into a build directory is
still worth seeing.

**`--task-file` resolved an absolute path against the repository root**,
producing `<repo>/private/tmp/...` and an ENOENT naming a path the caller never
wrote. The same shape as the schema-path bug 0005 fixed three times: a path
resolved against the wrong root, found only by using the tool from somewhere the
wrong root was wrong. Recorded as T36013.

**The lane configuration described a machine that does not exist.** It declared a
`codex-cli` lane whose program is not installed here, and no lane at all for the
installed `gemini` CLI. The orchestrating lane was simultaneously `orchestrator:
true` and the first-choice `judgment-required` target, so every judgment dispatch
was charged to the subscription driving the run — the exact failure spec 0036
exists to prevent, sitting in the config the whole time.

Then gemini turned out not to be capacity either: it resolves on `PATH` and fails
with `IneligibleTierError`, a discontinued individual tier that redirects to
Antigravity. `dispatch --agents` reported it as present, because a `PATH` check is
all it does. Presence is not availability, and the difference is only visible by
running the thing.

**What the passing gates did not catch.** devin's first attempt satisfied both
gates and was still wrong three ways: `configuredLanes` mutated the config object
it was handed, the resolved value stayed typed optional so every caller still had
to remember the default, and the four tests the brief named were not written.
0011's thesis is that an executor's exit code is not a gate. The extension this
found is that a passing gate is not proof of a correct result either — it is
proof of what the gate could check. A second dispatch with the three defects named
fixed all of them, with a test asserting the absence of the mutation.

**What none of it was in the tool.** Finding which CLIs were installed took a
`PATH` check; finding that one could not authenticate took running it; finding
the real model names took `devin models list`; and finding which models were free
rather than billed per token took reading a price column. All of it was
hand-copied into `checkyourvibe.json`, all of it rots silently, and a lane
declaring `swe-1-7` is only correct because someone checked once that it is one
of the two models devin marks free. Now Requirement 9 of spec 0036.

**The provenance check crashed on a bad pattern in its own deny list.** It was
unarmed on this machine — no deny list, exit 2, correctly refusing to report a
pass it had not earned. Arming it exposed the next defect: `git grep` uses POSIX
ERE, a pattern using a negative lookahead is rejected with exit 128, and the
checker rethrew that as an unhandled rejection. The reader got a Node stack
trace and no indication which of their lines was at fault, from a tool whose
entire premise is that errors carry actionable context.

It now names the label, the pattern, the file it came from and git's own
message, and exits 2 rather than 1 — the check did not run, so it found nothing
and is not entitled to report a pass. The ERE limit is now documented in the
example file, because it is not a mistake a first-time author avoids by being
careful: "this shape, except these known-innocent prefixes" is the natural thing
to want and the thing ERE cannot express.

The deny list itself is partial and says so at the top. Its structural half —
internal hostnames, review references, cloud account identifiers — needs no
name to work and is tuned to fire on none of this repository. The named half is
empty, because the employer, client and product names are not discoverable from
this machine and inventing them would produce a check that passes while
scanning for the wrong words.

Changed:

- `packages/core/src/executor/ignored.ts` (new)
- `packages/core/src/executor/run.ts`
- `packages/core/src/cli/dispatch.ts`
- `packages/core/src/config/lanes.ts`
- `packages/core/src/executor/lane.ts`
- `packages/core/test/config/lanes.test.ts`
- `checkyourvibe.json`
- `docs/protocol/config.schema.json`
- `tools/provenance-check.mjs`
- `tools/provenance-deny.example.txt`

## TypeScript pack judged against 341 real files: three rules were right about the syntax but wrong about the context

Copied 346 TypeScript and TSX files from six unrelated projects into a temporary
scratch git repository and ran the TypeScript analyzer with `core-ts`,
`strict-boundaries`, and `test-quality`. 341 files were checked; the other five
were configuration or environment declarations outside the analyzer's file match.
There were no diagnostics, no withheld findings, and no skipped files.

Before the fixes: **1,510 findings**. After the fixes: **1,484 findings**.

| Rule | Before | After | Judgment |
|------|-------:|------:|----------|
| `no-any` | 972 | 972 | real: explicit and inferred `any` at JSON, API, and tool boundaries |
| `no-console` | 238 | 238 | real: committed logging calls in libraries and scripts |
| `no-as-cast` | 165 | 165 | real: unchecked claims on forms, profiles, and response data |
| `no-floating-promise` | 64 | 64 | real: setup and auth promises without rejection handling |
| `no-swallowed-catch` | 23 | 23 | real: empty or comment-only catch blocks |
| `no-non-null-assertion` | 10 | 10 | real: `!` on environment variables and optional API fields |
| `no-useless-types` | 5 | 5 | real: `object` and `Function` in public shapes |
| `no-json-parse-cast` | 24 | 6 | narrowed: 18 false positives from static `.json(...)` constructors and `any`/`unknown` return types |
| `no-unsafe-index-access` | 7 | 0 | narrowed: all seven were write targets, not reads |
| `no-unsafe-array-narrowing` | 2 | 1 | narrowed: one safe guard-and-iterate pattern; one real `any` loop remains |

`no-json-parse-cast` was matching any property access named `.json` as if it
were `JSON.parse` or a response-body parse. Static constructor `.json(...)`
calls, such as those on a response class, build a JSON response rather than parse
one, and `Promise<any>`/`unknown` return types make no concrete shape claim. The
rule now asks the type checker whether the call is on an instance or a
constructor, and it treats `any` and `unknown` claims as outside its scope.

`no-unsafe-index-access` was reporting `record[key] = value` and `env[k] = value`
as possibly-undefined reads. A write target does not consume a possibly-undefined
value; the rule now skips simple assignments where the element access is the
left-hand side.

`no-unsafe-array-narrowing` was firing on a safe validation routine:
`Array.isArray(data)` with an early return, then a `for...of` whose first
statement is an `if` that guards each element with `typeof`, `in`, `instanceof`,
`Array.isArray`, null/undefined checks, and numeric comparisons. That pattern does
not let the invisible `any[]` escape, so the rule now skips it. The remaining
finding is on an explicit `any` value whose loop body uses the element without a
guard, which is a true positive under the rule's own definition.

No `no-any` narrowing was attempted. The 972 `no-any` findings are dominated by
genuine explicit `any` at boundaries, and the run produced no degraded-resolution
diagnostics, so there was no evidence of the earlier fabricated-inferred-`any`
problem recurring.

Changed:

- `packages/analyzer-typescript/src/rules/no-json-parse-cast.ts`
- `packages/analyzer-typescript/src/rules/no-unsafe-index-access.ts`
- `packages/analyzer-typescript/src/rules/no-unsafe-array-narrowing.ts`
- `packages/analyzer-typescript/test/fixtures/no-json-parse-cast.ok.ts`
- `packages/analyzer-typescript/test/fixtures/no-unsafe-index-access.ok.ts`
- `packages/analyzer-typescript/test/fixtures/no-unsafe-array-narrowing.ok.ts`

## C# and Rust analyzers measured against real code: one rule was right about the language but wrong about tests

Drove both analyzers through the real core against non-trivial samples, with a
positive-control probe for each rule so a clean result would be credible. The
C# probe tripped `no-dynamic`, `no-unchecked-cast`, `no-null-forgiving`, and
`no-empty-catch`; the Rust probe tripped `no-unwrap`, `no-panic-in-library`,
`no-unsafe-block`, and `no-ignored-result`.

The non-ASCII question was tested with a C# file containing an accented
identifier (`café`), a non-Latin string literal, an emoji in a comment, and a
non-ASCII type name in a cast, and a Rust file containing an accented identifier,
an emoji comment, and a non-ASCII method name. Both analyzers returned
well-formed JSON and exited 0. C# `JsonObject.ToJsonString()` escapes non-ASCII
by default; Rust `serde_json::to_string` emits raw UTF-8 and the core decodes
stdout as UTF-8. No encoding fix was needed.

C#: 215 files from a directory of C# scripts on `R:\` were copied into a
scratch git repo. The run checked 216 files and reported 73 findings. 70 were
`no-empty-catch`, all in editor/runtime scripts that swallow expected or
optional failures. Under the rule's own definition—a `catch` that does not
handle, log, or rethrow is not allowed—those are real findings; the rule is not
wrong about its context, it is just strict. The other three rules fired only on
the probe. 90 diagnostics noted casts whose operand or target type could not be
resolved, so the analyzer withheld semantic guesses as designed.

Rust: 62 files from several Rust app directories on `R:\` were copied into a
scratch git repo. That is below the ~100 target, so the sample size is reported
honestly rather than dressed up. The run checked 63 files. Before the fix: 90
findings—42 `no-ignored-result`, 39 `no-unwrap`, 8 `no-panic-in-library`, and
1 `no-unsafe-block` (probe). The 7 non-probe `no-panic-in-library` findings were
inside `#[test]` functions, where `panic!`, `todo!`, and `unimplemented!` are
normal test assertions and placeholders. That is the same shape as the Python
`no-assert-for-validation` problem: right about the language, wrong about where
it is applied. After narrowing `no-panic-in-library` to skip test contexts, the
same run reported 83 findings, leaving only the probe `no-panic-in-library`.
The remaining `no-ignored-result` and `no-unwrap` findings are real under the
rule's own definition; `no-ignored-result` is dominated by discarded `Result`
values from `emit`, `send`, `flush`, `remove_file`, and similar calls.

Changed `packages/analyzer-rust/src/main.rs` to check `self.in_test == 0` before
reporting `no-panic-in-library`, and added a `#[test]` with a `panic!` to
`packages/analyzer-rust/fixtures/no-panic-in-library.ok.rs` so the regression is
guarded by the case that caused it.

## The Python analyzer skipped every real file, then found 353 things and was wrong about 335

The 16-file Python sample that came back clean was too small and too lucky. Ran
it against 316 files drawn from three unrelated projects instead. It checked **zero** of
them.

`write_response` used `json.dumps(..., ensure_ascii=False)` and wrote straight to
stdout. On Windows stdout defaults to the system codepage, so a single accented
character anywhere in a snippet raised `UnicodeEncodeError` and killed the
process. The core saw a non-zero exit and reported every file as skipped, with
the traceback attached — correct behaviour, and the run still ended with "0 files
checked" and no findings. The earlier 16-file sample had been pure ASCII.

With stdout forced to UTF-8: 316 files, 398 findings. And 353 of those were
`no-assert-for-validation`, of which **335 were inside test files**.

`assert` is the idiomatic assertion in Python tests — the standard runners are
built on it. The rule's premise is true and irrelevant there: a suite is not run
under `-O`, and if it were, stripping the asserts would leave a suite that
asserts nothing rather than a program that misbehaves. A 95% false-positive rate,
the same shape as the TypeScript rule that fired fourteen times and was wrong
fourteen times.

Excluded test files by the filename convention the Python runners themselves use
for discovery. The result on the same 318 files: **65 findings** — 34 mutable
default arguments, 13 bare excepts, 18 asserts outside tests. That is a
believable number of real ones.

Two lessons, and the second is the one that generalises. A rule that is right
about the language can still be wrong about where it is applied. And a sample
small enough to be all-ASCII is small enough to prove nothing — the first Python
run reported a clean codebase and it had checked sixteen files, none of which
contained an accent.

## I overclaimed a finding, and an audit caught it

Spec 0023 concluded that TypeScript's "widen to `any`" notFix edges point the
wrong way in Swift, and said Go and C# had "independently arrived at the same
reversal". I repeated that. An audit of every notFix in all four real manifests
found it overclaimed.

The reversal is confirmed **once**, in one implemented manifest: C#'s
`no-dynamic` points at `no-unchecked-cast`, because `object` still requires a
cast before use. Go's version exists only as prose in a spec for an analyzer that
does not exist, written by an author who had already read the C# pack — that is
independent *reasoning*, not independent *observation*, and calling it the latter
was the error. Python and Rust have no escape-hatch-type rule at all, so their
silence is not evidence for either direction.

The audit also found something the original framing missed: a pack having no
suppression-comment edge means three different things. Swift has no such
construct. C# has one and names it in prose — "disable nullable warnings for the
file or project" — with no rule to route to. Python and Rust have `# noqa`,
`# type: ignore` and `#[allow(...)]`, unmentioned in either manifest, never
considered. Reading all three as "the language lacks it" would have written a
false claim into a spec.

Recorded in spec 0031 rather than 0027, on the argument that this is authoring
guidance for individual edges rather than a fact about how packs are selected.

One finding survives intact and is the thing to keep: **a notFix edge is a claim
about what a construct does in that language, not about a rule with the same
name elsewhere.** Never inherit an edge's direction from another pack.

## A task scope named a test path the runner does not scan, and every gate still passed

T37002 declared its files on the `_Exec:` line as
`packages/core/src/dashboard/projects.ts` and
`packages/core/src/dashboard/projects.test.ts`. The executor wrote both,
touched nothing else, and produced a correct port: `tsc -b` clean,
`cyv check` 0 errors across both files, and the Requirement 2.3 fix —
reporting a missing directory separately from a directory that merely lacks
`checkyourvibe.json` — implemented as asked.

`vitest.config.ts` includes `packages/**/test/**/*.test.ts`. The declared path
is under `src/`, so the 164-line test file was never collected. Fourteen tests,
none of them run, and nothing said so: the dispatch's declared gates were
`tsc -b` and `cyv-check`, both of which pass happily on a test file that no
runner ever opens. Had the dispatch not been killed first, it would have closed
as `succeeded` on the strength of tests that did not exist as far as the suite
was concerned.

Moved to `packages/core/test/dashboard/projects.test.ts`, the fourteen run and
pass, and two of them are the ones that matter: reverting the `exists` /
`hasConfig` split fails exactly `reports a missing directory separately from a
missing config` and `validateProjectPath measures presence and config
independently`, and nothing else.

This is the failure AGENTS.md already describes — an executor cannot widen a
scope that was drawn wrong, so it complies and the result compiles — but with a
twist worth recording separately. The module-augmentation case at least left a
construct a reviewer could see. This one leaves nothing: correct code, correct
tests, green gates, and a silent zero. A grep across every `_Exec:` line in
`docs/specs/` found this was the only task scoping a test under `src/`, and the
line has been corrected.

The general lesson is narrower than "check your scopes": **a gate that does not
name the test runner cannot tell you the tests ran.** `tsc` and the analyzer both
read the file and both approve of it. Only vitest knows it was never collected,
and it was not asked.

## A rule written narrow from the start found nothing it should not have

`no-module-augmentation` reports a `declare module` whose specifier is relative —
a file in this project, which the author could have edited instead. It came out
of T36004, where a scope that omitted the declaring file left an executor no
route but to reopen the type from outside.

Measured before enabling, per Requirement 4:

| Codebase | `.ts` files scanned | Findings |
|---|---|---|
| this repository | 4,854 | 2 (both the rule's own bad fixture) |
| an ML/diff tool | 405 | 0 |
| a web UI | 104 | 0 |
| a Next.js app | 69 | 0 |
| an assistant service | 46 | 0 |

5,478 files, zero false positives, and the only findings are the fixture written
to trip it. The augmentation that motivated the rule is gone because T36004 was
re-scoped and redone, so its absence here is the repair landing rather than the
rule missing it.

Zero on unrelated code is the number a rule that never ran also produces, so the
positive control from 4.2 was run first: one file holding a relative
augmentation, a bare-specifier augmentation, a wildcard declaration and a
`declare global` produced **exactly one** finding, on the relative specifier.
The three exclusions are the rule rather than trimming applied afterwards — a
bare specifier firing here would contradict `no-ts-comment`, which offers module
augmentation as an allowed fix in the same pack.

The sample is small in the way that matters: relative augmentation is a rare
construct, so five clean codebases are weak evidence that it is rare and no
evidence that the rule is right when it fires. What carries the claim is the
control, not the corpus.

**A hole found while doing this, unrelated to the finding counts.** The rule
source and `analyzer.manifest.json` hold two copies of each rule's guidance: the
hook prints the source's, `cyv explain` prints the JSON's. The parity test
compared only `summary`, `why` and `examples`, and `sync-manifest.mjs` copied
only those three — so `allowedFixes` and `notFixes` could differ between the two
surfaces with nothing detecting it. This rule shipped in exactly that state,
`notFixes: []` in the source against populated guidance in the JSON. Both the
sync script and the parity assertion now cover all five fields, and the
assertion was negative-controlled by emptying `notFixes` in the JSON alone and
confirming it fails. No other rule had drifted.

## A rule that found nothing, and a positive control that proved it was running

`no-tautological-assertion` — an assertion comparing a literal to an identical
literal, which passes whatever the code does — found zero findings across this
repository's 58 test files.

Zero could equally mean the rule never ran, so it was checked rather than
assumed. A probe with `expect(true).toBe(true)`, `expect(1).toBe(1)` and
`expect('x').toBe('x')` produced exactly three findings, and the two real
assertions beside them produced none. The zero is a clean suite.

Enabled by default, which is what spec 0030's higher bar for this pack asks for
— with the caveat the spec itself states: a suite written by the same people who
wrote the rule is a weak sample.

## Rule ids stay unqualified, and the reason is that the failure is already loud

The last question left open that would be expensive to change after publishing:
should a rule id be `no-any` or `typescript/no-any`? Four analyzers now ship, so
it was time to settle it.

The premise turned out to be wrong. The worry was that two analyzers declaring
the same id would resolve to whichever loaded last, silently. They do not —
`allRules` throws, names both analyzers, and exits 2 before anything runs.
Verified by building a second analyzer that declares `no-any` and watching the
run refuse to start. This project's cardinal sin is a silent failure, and this is
not one.

So the answer is: leave it. Bare ids appear in `rules`, `overrides`,
`suppressions[].ruleId`, every entry in a committed baseline, and
`cyv explain <id>` — qualifying them breaks all of that, or requires accepting
two spellings for one rule, which is its own confusion. And it has not happened:
seventeen rules across four analyzers, no collision, because rule names track
language idiom. `no-any` is a TypeScript concept and the C# analyzer independently
arrived at `no-dynamic`.

What was missing was recourse. The error named the collision and stopped, without
saying what the reader could do about it — and they cannot rename someone else's
rule. It now says: drop one analyzer, or ask its author to rename, and why the
tool will not just pick one.

The pressure will come from a third-party analyzer whose author cannot see our
names. When it does, the loud error is what tells us, and qualification can be
added then, knowing what it is for.

## The C# analyzer did not know it was guessing

Spec 0029 made "an analyzer must detect its own degraded resolution" a
prerequisite rather than folklore, and named the C# analyzer as failing it. It
was: it compiles every requested file against the .NET runtime's trusted platform
assemblies alone — no `.csproj`, no package references, no project references —
and never reported that its type graph was partial. Meanwhile `no-dynamic` and
`no-unchecked-cast` both declare `evidence: semantic` and both read
`GetTypeInfo`. Same shape as the 673 fabricated TypeScript findings, waiting.

It now reports degradation from four compiler diagnostic IDs — CS0246, CS0234,
CS0012, CS0006 — chosen because those four mean a reference is missing rather
than that the user's own code is wrong. CS0103 and CS1061 are deliberately
excluded: a misspelled member is a genuine error in the file, and treating it as
degraded resolution would let the analyzer blame its own reference set for the
user's typo.

Verified against a file importing a namespace that does not exist, alongside a
clean file in the same run: two semantic findings withheld from the unresolvable
one, one finding reported from the other.

That test also exposed a smaller defect in the core. The withheld-findings notice
ended with "Fix the type-resolution configuration that covers these files (for
example, a tsconfig.json whose `include` reaches them)" — printed directly beneath
the C# analyzer's own reason correctly explaining that it had not read a
`.csproj`. The core does not know which language it is talking about. The
example is gone; the analyzer's reason is where the specific remedy belongs.

## "This is not a pass", then exit 0

Ran the Python analyzer against a 105-file Python project —
and it checked none of them, reported no violations, and exited 0.

Two separate defects, both found only by doing it.

The first was a third instance of a bug already fixed twice: `loadConfig` read
the config schema from `<the user's repository>/docs/protocol/config.schema.json`.
It worked in every previous test only because `cyv init` writes a copy of the
tool's own schema into each project it sets up, so `check` was reading a file the
tool had planted. Hand-write a `checkyourvibe.json` — which is what someone
following the documentation instead of running `init` does — and it fails with an
ENOENT naming a path inside their own tree they have never heard of. The schema
belongs to the tool; it now reads it from the tool.

The second is worse. Every Python file in that repository lived inside a git
submodule. `git ls-files` reports a submodule as a single gitlink and never
descends into it, so `--all` legitimately saw nothing. The run printed **"No
files were matched by this run; this is not a pass."** and then **exited 0**.
Saying the right thing in prose while returning the wrong thing in the exit code
is worse than staying silent, because the prose is what makes it look handled —
and no CI system reads prose.

A `--all` or explicit-paths run that matches nothing now exits 2. `--staged`,
`--working` and `--branch` still exit 0, because a commit touching only images
legitimately stages nothing checkable and failing that would make the pre-commit
hook unusable within a day. The alarming modes are named explicitly rather than
their inverse, so a mode added later has to opt in and the safe behaviour is the
one you get by forgetting.

On the analyzer itself: 16 real Python files, zero findings. That could mean the
rules are worthless, so it was checked rather than assumed — a probe file with a
bare `except:`, a mutable default argument, an `assert` used for validation and a
wildcard import produced exactly four findings, one per rule. The zero is a clean
codebase, not a broken analyzer. Distinguishing those two is the whole thesis;
it would have been embarrassing to assume.

## A stranger can now install it and use it

Seven tarballs, `npm install` into an empty directory outside the repository, and
the whole flow runs: `init` writes a config naming `@checkyourvibe/analyzer-typescript`
rather than a path into one machine, `check` reports real findings with their
guidance and dead ends attached, `doctor` reports every surface ok and confirms
the embedded command resolves to a bare `cyv`, and `explain` prints a rule with
its pack, evidence and owning analyzer.

The blocker was that core depended on none of the five agent adapters, so a
fresh install reached no agent at all — a tool whose entire purpose is agent
integration, integrating with nothing. Core now depends on the adapters it ships,
and the adapters declare core as a peer dependency so the graph has no cycle.

Rejected the tidier-looking alternative — optional adapters discovered at
runtime — because a first run that does nothing until you learn you need a second
package wastes the one moment adoption actually happens. The plug-in axis is a
claim about the protocol, not about packaging: core still resolves any adapter by
name, so a third-party one is exactly as installable as a bundled one. The cost is
that adding a sixth agent needs a core release, which is a small recurring tax
against a broken first run.

Confirmed the hard way. With core depending on adapters that were not published,
`npm install` failed with a 404 before anything else could go wrong.

## 693 fabricated findings became 55 real ones

Both fixes landed and the same 170 files were re-measured. Not estimated —
repacked, reinstalled, rerun against the same 170 files:

    before            693 violations   (673 no-any, 170 files degraded)
    following refs     89 violations   (69 no-any, 5 files degraded)
    withholding too    55 violations   (48 no-any, 34 withheld from 4 files)

Following a solution-style tsconfig's `references` to the project that actually
covers each file resolved 165 of the 170. The remaining handful fall back
honestly, and the agent that did it listed exactly which real-world tsconfig
shapes it still cannot resolve rather than claiming the general case.

The second fix is the one that generalises. Every rule declares whether its
findings rest on the type checker or on shape, so when an analyzer reports it ran
without types, the semantic findings for those files are withheld and the syntax
ones survive. The run now says so out loud:

    34 findings withheld from 4 files because type resolution was degraded.
    Fix the type-resolution configuration that covers these files. Until the
    analyzer can resolve their types, their semantic findings are not reported.

And the halves had landed inert. The core consumed a structured `degraded` field
that no analyzer emitted, so the withholding logic had nothing to act on and a
run over unresolvable files still reported every inferred-type finding it made —
the same wired-but-not-connected pattern this project has now caught in itself
four times. Connected, and re-measured to prove it.

The 55 that remain look like real findings on real code.

## Pointed the packed tool at a real project, and it fell over

Installed the packed tarballs into a fresh project holding 170 TypeScript files
from an unrelated project — the first time this tool has been used the way
a stranger would use it. It did not survive.

**It would not install.** `npm error code EUNSUPPORTEDPROTOCOL: Unsupported URL
Type "workspace:"`. The packed analyzer still carried `"@checkyourvibe/core":
"workspace:*"`, which no registry can resolve — and the release gate had
reported "All 7 package(s) passed" on exactly that tarball, because it checked
the file list and never checked whether the manifest was installable.

**`cyv verify-analyzer` was broken for every installed user**, and separately so
was `cyv init`. Both read protocol schemas from four directories up, which is the
repository root from a clone and `node_modules/docs/protocol/` from an install.
`init` died mid-write on a first run. No test could catch either: the tests run
from the checkout, where the broken path resolves.

**`cyv check --all` died with `stdout maxBuffer length exceeded`** — no mention
of git, of which command, or of what it had been doing. `git ls-files --others`
produced 2.4 MB of paths against Node's 1 MB default.

**Then it reported 693 violations, 673 of them `no-any`.** Buried among them, one
`warn`: no usable tsconfig governs these files, analysed with default compiler
options. With no compiler options every import resolves to `any`, so `no-any`
fires on nearly every parameter in the codebase. Those 673 findings are not
findings. The four `no-non-null-assertion` hits in the same run are real, because
that rule reads syntax.

The layout is not exotic — it is the standard workspace-generator shape, one
`tsconfig.json` per package with `files: []`, `include: []` and references to
`tsconfig.lib.json`. The analyzer sees solution-style and falls back to defaults
instead of following the reference to the config that actually covers the files.

This is the project's founding defect, unfixed. The roadmap opens by citing "a
solution-style tsconfig that silently destroyed type resolution and produced 91
fabricated findings" as the result that justified everything built since. It
still does it, on the most common workspace layout there is, at seven times the
scale. In flight as T7009 and T7010.

## The interlock had a hole in exactly its own shape

`.catch(() => {})` passed **both** rules meant to stop it. `no-floating-promise`
was satisfied — the promise is handled. `no-swallowed-catch` only ever inspected
`try`/`catch` clauses and had no notion of a promise's `.catch`. So the cheapest
way to silence an unhandled rejection without handling it was clean under both,
and `no-floating-promise`'s own guidance pointed an agent straight at it.

Fixed in the order that matters: broaden the rule first, declare the edge second.
A `notFix` naming a rule that would not fire is a dead end that is not a dead
end, and the graph is only worth reading if its edges hold.

## `cyv init --yes` wrote a hook into the machine's global Codex config

Ran it to refresh stale guidance. It configured three agents this repository had
not opted into and appended a `[hooks.PostToolUse]` block to
`~/.codex/config.toml`, hard-coding a path to this one checkout — so every Codex
session anywhere on the machine would have run it. Reverted by hand.

The merging was flawless: namespaced managed blocks, nothing overwritten, the
user's own hooks untouched. The defect is scope and disclosure. `--yes` means
"adopt everything detected" when someone reaching for it in CI means "confirm the
plan", and a planned write outside the repository root should be surfaced as such
rather than found in a diff.

## A rule that was wrong fourteen times out of fourteen

`no-non-null-index-write` reported a write through an index whose read would be
`T | undefined`. Sound for an array, where writing past the end creates a hole.
Meaningless for a record, where an index write *is* the insertion — `counts[key]
= n` is the only way to add a key.

Every finding on this repository was of that second kind. Narrowed, re-enabled,
and its remaining blind spot documented in the source rather than left to be
discovered: inside a `for` loop any upper bound is accepted, so the canonical
off-by-one is not reported. Narrowing further needs range analysis, not a better
pattern match.

The counterweight landed the same day: `no-floating-promise` fired once, on
`void flush()` in the watch debounce timer, and was right. `flush` awaits a call
that throws when an analyzer fails; `void` silences the compiler, not the
rejection. The session either died or kept watching while having quietly stopped
checking anything.

## A typo in a pack name used to print "0 errors"

One character wrong in `packs` — `strict-boundries` — silently disabled four
rules and reported a clean run. It now reads `13 of 17 rules enabled`, names the
unrecognised pack, and exits 2. Three notices now print on every run without
being asked: what the configuration resolved to, what the baseline defers, what
the suppressions hide.

Suppressions were themselves inert until this stretch — validated, tested, and
never loaded by `cyv check`. The first thing the feature suppressed, once wired,
was a whole rule across `packages/core/src/**`, written by the agent that built
it to get a green gate. It said so in its own report, which is the only reason
that is a note rather than a defect.
