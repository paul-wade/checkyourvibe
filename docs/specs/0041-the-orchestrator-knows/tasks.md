# 0041 — The orchestrator knows it is the orchestrator: tasks

**Status:** complete. All seven tasks landed.
Requirements in `requirements.md`, decisions in `design.md`.

Runs after spec 0040's data layer lands, because `cyv plan` and the brief both
read `dashboard/review/specs.ts`. T41001, T41002 and T41004 have disjoint
scopes and run at once; T41003 depends on T41002; T41005 on T41004.

## Open

- [x] **T41001** The brief
  Requirements 1.1 through 1.4. `executor/brief.ts` exports
  `orchestrationBrief(config, lanes-with-availability)` returning the block
  body. Every adapter's `plan()` calls it and writes a `managed-block` with
  `blockId: '<agent>-orchestration'` only when a lane naming that adapter's
  agent declares `orchestrator: true`. `doctor` compares the file's block to
  the generated one and reports drift. No model ranking, no capacity claim.

  Done. `PlanContext` gained an optional `orchestration`, because an adapter
  knew its own instructions file and nothing about lanes. Adapters call one
  exported `orchestrationWrite(agentId, path, orchestration)` rather than
  composing a block each — six adapters composing their own is six chances for
  the brief to describe one run differently, which Requirement 1.2 rules out by
  asking for one function in core.

  Drift needed no new mechanism. `checkAgentDrift` already compares a plugin's
  planned writes against disk, so passing the orchestration into `doctor`'s plan
  context puts the brief through the same comparison as every other managed
  block (Requirement 1.3).

  **Verified against this repository (Requirement 4.1).** The block names
  `claude-code-cli` as the orchestrator and lists `agy`, `devin` and `claude` as
  found on PATH, matching what `cyv doctor` reports. It also confirmed T41004's
  default independently: the brief states a global cap of 2, which is
  antigravity's 1 plus devin's 1, with the reserved orchestrating lane correctly
  excluded from the sum.

  **A pre-existing doctor test changed meaning, correctly.** Its fixture
  declares lanes *after* `cyv init` has run, so the orchestrating lane's brief
  has never been written — which is drift, and the exit code moved 0 to 1. The
  test now asserts the drift rather than tolerating it, and a second test covers
  the negative: no orchestrating lane, no block, no drift.

  **`no-editorial-comment` fired on two comments this task wrote**, which is
  worth recording given the pack argument it belongs to. One read "saying so is
  better than rendering a confident blank" — a judgment against an alternative
  that is not in the file. The rule targets exactly the habit a generator has
  and a human mostly does not, and it caught a generator. Both rewritten to
  describe rather than argue; neither suppressed.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/executor/brief.ts,packages/core/src/protocol/agent.ts,packages/core/src/index.ts,packages/core/src/cli/init.ts,packages/core/src/cli/upgrade.ts,packages/core/src/cli/doctor.ts,packages/adapter-*/src/index.ts,packages/core/test/executor/brief.test.ts,packages/core/test/cli/doctor.test.ts_

- [x] **T41002** `executes`, and the one-lane defaults
  Requirements 2.1, 2.2. Add `executes?: 'cli' | 'subagent'` to
  `LaneDeclaration` and the schema. `configuredLanes` resolves it and resolves
  `acceptsDispatch` to `true` when the orchestrating lane is the only lane
  declared. `doctor` states both resolved values on the lane line.

  Done. Both defaults are resolved by `configuredLanes` against the whole lane
  set, because "is this the only lane" is not a property of a lane. The
  per-lane `acceptsDispatch(lane)` stays exactly as it was for the callers that
  legitimately hold one lane in isolation — a replayed record, a test fixture —
  and the scheduler reaches the resolved answer because `cli/dispatch.ts` feeds
  it lanes that came through `configuredLanes`.

  **The `_Exec:` scope was drawn wrong.** The task text requires `doctor` to
  state both resolved values, and `doctor.ts` was not in `files=`. Corrected
  below rather than worked around, per the scope guidance in `AGENTS.md`.

  **A pre-existing test changed meaning, and so did a message.**
  `laneConfigNotice` warned that the orchestrator "declares acceptsDispatch:
  true" — read off the *resolved* value. A sole orchestrating lane now resolves
  to `true` having declared nothing, so that sentence would have quoted a field
  the user never wrote, about a configuration they had no alternative to. Split
  into two notices: the declared case keeps its wording, and the sole-lane case
  states the cost — one subscription both planning and executing, with no
  second lane to fall back to — without implying it was chosen.

  **A subagent lane needs no program on PATH.** `doctor` reported one as
  unavailable because its program was missing, which is a fact about the wrong
  mechanism: nothing is spawned for a sub-agent lane. It now says so instead.
  _Exec: executor=self kind=mechanical gates=tsc,test,cyv-check files=packages/core/src/executor/lane.ts,packages/core/src/config/lanes.ts,packages/core/src/cli/doctor.ts,docs/protocol/config.schema.json,packages/core/test/config/lanes.test.ts_

- [x] **T41003** Dispatch to a sub-agent, and close it
  Requirements 2.3, 2.4, 2.5. `runDispatch` gains a two-phase form: open and
  persist the before snapshot; later, from the persisted snapshot, take the
  after snapshot, run gates, classify and close. `cyv dispatch` uses the first
  phase for a `subagent` lane and prints the dispatch id and prompt path;
  `cyv dispatch --close <id>` runs the second. The no-eligible-lane refusal
  names `--self` when an orchestrating lane exists.
  Depends on T41002.

  Done as `openSelfDispatch` and `closeSelfDispatch` beside `runDispatch`
  rather than as a mode inside it. A CLI dispatch brackets a child in one
  process; a sub-agent dispatch is two invocations of `cyv` minutes or hours
  apart, so the before snapshot has to outlive its process. It persists to
  `.cyv-review/snapshots/<dispatchId>.json`, beside the dispatch log and for the
  same reason: a run has to be readable from disk alone (0036).

  **What the executor's report says, and what it does not.** There is no child,
  so there is no exit code. The report records `success` with no exit code —
  the session's claim to have finished, which is the same claim a CLI makes by
  exiting 0. Whether anything was accomplished is decided by `classifyOutcome`
  from the changed files and the gates. A close with no file change records
  `produced-nothing` against a report that says success, which is the
  observed-effect rule (0011 R2) doing exactly what it exists for, and there is
  a test asserting that disagreement.

  A `--close` with no persisted snapshot refuses rather than proceeding: an
  outcome derived from a comparison that never happened would be a fabricated
  finding about the run itself. The snapshot is discarded on close, so a second
  `--close` refuses too.

  **`--self` named an option that did not work.** Requirement 2.4's refusal
  correctly printed "`--self` runs this task on lane session" — and `--self`
  was then refused by the same reservation, because it only set the lane id
  while `acceptsDispatch` stayed false. Found by running it, not by a test.
  `--self` now overrides the reservation for that one dispatch, which is the
  caller taking responsibility for spending the orchestrating subscription —
  the same shape as naming a metered lane with `--lane`. Overriding per
  dispatch rather than requiring a config edit matters: the config edit would
  apply to every dispatch thereafter.

  **Verified live (Requirement 4.2).** A repository declaring only the
  orchestrating lane dispatched by sub-agent, printed its id and prompt path,
  spawned nothing, and `--close` recorded `succeeded` with one file changed in
  the observed scope. A `--close` on an unknown id refused. With two lanes, the
  refusal named `--self`, and `--self` then opened the dispatch.

  **Two more inferred-`any` findings**, both from `Array.isArray` narrowing an
  `unknown` to `any[]` — once directly and once through the `entry` a `.every`
  callback receives. Fixed with an `isUnknownArray` guard, the same fix T41005
  needed. That is three times in one spec that this construct produced an
  invisible `any`, which is an argument for the rule and possibly for a
  codemod.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/executor/run.ts,packages/core/src/executor/snapshot.ts,packages/core/src/executor/work.ts,packages/core/src/cli/dispatch.ts,packages/core/test/executor/self-dispatch.test.ts,packages/core/test/cli/dispatch.test.ts_

- [x] **T41004** The global cap
  Requirements 3.1, 3.2. `executor.maxConcurrentDispatches` in config and
  schema, defaulting to the sum of dispatchable lanes' caps. The scheduler
  adds an `at-global-cap` ineligibility, reported on every lane when the count
  of open dispatches across lanes has reached it.

  Done. The cap reaches the scheduler as an optional `GlobalCap` argument
  rather than by making the scheduler read configuration, so every function in
  `schedule.ts` stays pure. The default sums only the lanes that *accept*
  dispatched work: summing every declared lane would count a lane reserved for
  orchestration toward a ceiling it can never contribute to, making the default
  quietly looser than the lanes it describes.

  It is checked after a lane's durable reasons and before the lane's own cap.
  A lane offering no model for the kind says so even while the run is full,
  because that does not lift when a dispatch closes and this does.

  **The `_Exec:` scope was drawn wrong again, and worse than T41002's.**
  `LaneIneligibility` is a discriminated union, so adding a member broke the
  exhaustive switches in `cli/dispatch.ts` and `dashboard/home-model.ts` — tsc
  caught both. Two more consumers, `executor/parse.ts` and
  `dashboard/render.ts`, have `default:` clauses and compiled unchanged while
  degrading: `parse.ts` would have returned `undefined` for the new reason,
  silently dropping a recorded rejection on read. That is the failure principle
  2 exists to prevent, and it would have shipped. Five files added to the scope.

  The lesson is narrower than "scopes were too small": **a task that adds a
  member to a union owns every consumer of that union**, and the ones with a
  `default:` clause are the dangerous half, because the compiler will not name
  them.
  _Exec: executor=self kind=mechanical gates=tsc,test,cyv-check files=packages/core/src/config/types.ts,packages/core/src/config/lanes.ts,docs/protocol/config.schema.json,packages/core/src/executor/schedule.ts,packages/core/src/executor/dispatch.ts,packages/core/src/executor/work.ts,packages/core/src/executor/parse.ts,packages/core/src/cli/dispatch.ts,packages/core/src/dashboard/home-model.ts,packages/core/src/dashboard/render.ts,packages/core/test/executor/schedule.test.ts_

- [x] **T41005** `cyv plan`
  Requirement 3.3. Waves for one spec, human and `--json`, from `planWaves`.
  Depends on 0040 T40001.

  Done. It calls the same `planWaves` the dashboard's "next up" renders, so the
  page and the terminal cannot disagree about what is ready. A spec argument
  resolves by exact id first, then as a substring; an ambiguous match is refused
  by naming every candidate rather than picking one.

  **Two findings from running it on a real spec rather than a fixture.**
  `cyv plan 0036` rendered `lane self,` with a trailing comma, because T36010's
  `_Exec:` line declares no `kind=`. Fixed in the renderer — an empty field
  should look absent, not blank — but the missing `kind=` is a real gap in
  0036's task file, and nothing else reports it.

  And Requirement 4.3 is no longer satisfiable as written. It says `cyv plan
  0040` shall show more than one task in its first wave; 0040 reached 16 of 16
  and has no open tasks, so the command correctly prints "every task is done".
  T41007 should verify against 0036, whose first wave holds three. Recorded
  rather than quietly substituted.

  **cyv caught two of its own rules in this task's test file**, which is worth
  writing down because it is the argument for the pack. `JSON.parse` returns
  `any`, so `const plan = JSON.parse(...)` is an inferred-`any` binding —
  invisible to a rule that only looks for the written keyword. And
  `Array.isArray` on an `unknown` narrows to `any[]`, so the validation *looked*
  careful while leaving every element unchecked. Both were fixed the way
  `cyv explain` names: a shape-checking parse, and a hand-written
  `isUnknownArray` guard. Neither was suppressed.
  _Exec: executor=self kind=mechanical gates=tsc,test,cyv-check files=packages/core/src/cli/plan.ts,packages/core/src/cli/index.ts,packages/core/test/cli/plan.test.ts_

- [x] **T41006** Planning for parallel execution, written down
  Requirement 3.4. A section in `AGENTS.md` on writing tasks that run at once,
  and the brief points at it.

  Mostly already done, and worth recording why. `AGENTS.md` already carried a
  "Planning for parallel execution" section covering all four things
  Requirement 3.4 names — disjoint `files=` scopes, dependencies named in the
  text, a task sized to one lane and one gate, and gates each task can pass
  alone — plus two the requirement does not: write the shared seam first, and
  put judgment work on a judgment lane.

  It was written **ahead of the code**, referencing `cyv plan <spec>` and
  `executor.maxConcurrentDispatches` while neither existed. Both landed today in
  T41005 and T41004, so the guidance stopped describing something unavailable.
  Documentation that runs ahead of the implementation is a state nothing in this
  repository reports, and it held for at least two specs here.

  Added: the brief's pointer at that section, and a `cyv plan` entry in
  `docs/getting-started.md`, which had no mention of the command.

  **Scope note.** The "brief points at it" half required editing
  `executor/brief.ts`, which this task's `files=` did not name — the third
  `_Exec:` scope in this spec drawn narrower than its own text. Added below.
  _Exec: executor=self kind=judgment gates=self-check files=AGENTS.md,docs/getting-started.md,packages/core/src/executor/brief.ts_

- [x] **T41007** Verify on this repository
  Requirement 4. `cyv init` here; read the block; a one-lane configuration in a
  temp repo dispatched and closed by sub-agent; `cyv plan 0040` with a wave
  wider than one. Record in `docs/STATUS.md`.

  Done, and it earned its place. **`cyv init --dry-run` on this repository
  planned no orchestration block at all** — `init` reads the config through
  `parseExistingConfig`, which is deliberately lenient because it is the command
  that repairs a broken config, and which keeps only the fields it needs,
  dropping `executor`. The brief was generated from an always-empty lane list
  and returned nothing, silently. `doctor` and `upgrade` were unaffected because
  they read through `loadConfig`. Every unit test passed throughout. Fixed to
  read through `loadConfig`, with a regression test verified by reintroducing
  the bug and watching it fail.

  R4.1: satisfied. The planned block names `claude-code-cli` as the orchestrator
  and lists `agy`, `devin` and `claude` as found on PATH, matching `cyv doctor`.

  R4.2: satisfied live. A temp repository declaring only the orchestrating lane
  dispatched by sub-agent, spawned nothing, printed its id and prompt path, and
  `--close` recorded `succeeded` with one file changed in the observed scope.

  R4.3: **not satisfiable as written**, and not quietly substituted. It asks
  that `cyv plan 0040` show more than one task in its first wave; 0040 reached
  16 of 16 while this spec sat open, so the command correctly reports every task
  done. Verified against 0036, whose first wave holds three. A requirement that
  names a specific spec's open work has a shelf life.

  **Left for the owner.** `cyv init` has not been run for real here. The dry run
  confirms the block and its content; a real run also reapplies roughly thirty
  files of unrelated pre-existing drift, including agent files under the home
  directory, which is a decision rather than a verification step.
  _Exec: executor=self model=opus gates=manual files=docs/STATUS.md,docs/specs/0041-the-orchestrator-knows/tasks.md,packages/core/src/cli/init.ts,packages/core/test/cli/init.test.ts_
