# 0036 — The orchestrator's own survival: tasks

**Status:** open
Requirements in `requirements.md`, decisions in `design.md`.

Each `_Exec:` names the lane the task is dispatched to. Placement follows
Requirement 9.1 of spec 0011: the smallest executor that can do the job.

This spec's own Requirement 1 applies to its execution. No task here is
dispatched to `claude-code-cli`: judgment work goes to `antigravity-cli` and
mechanical work to `devin-cli`, leaving the orchestrating subscription for
planning and review. If that ordering cannot be honoured, that is itself the
finding this spec exists to prevent.

## Open

- [x] **T36001** `acceptsDispatch` on a lane declaration
  Requirements 1.1, 1.2, 1.3. Add the optional boolean to `LaneDeclaration` and
  to the config schema. Resolution is: the declared value when present;
  otherwise `false` when the lane declares `orchestrator: true`; otherwise
  `true`. Export the resolved value rather than making every caller re-derive
  it — `configuredLanes` is the seam and the default belongs behind it.
  Add a `laneConfigProblem` case for the disclosure R1.3 requires: a lane that
  is both `orchestrator: true` and `acceptsDispatch: true` loads successfully
  and reports that the orchestrating lane is accepting dispatched work.
  Note this is a notice, not a failure — self-dispatch stays legal under 0011
  R6.2.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/core/src/executor/lane.ts,packages/core/src/config/lanes.ts,packages/core/src/config/types.ts,docs/protocol/config.schema.json_

- [ ] **T36002** The scheduler refuses rather than falling back
  Requirements 1.4, 1.5. A lane whose resolved `acceptsDispatch` is `false` is
  not a candidate in the distribution rule (0011 R7.3) and not an escalation
  target (0011 R3.3). When no eligible lane remains for a task kind, the
  dispatch refuses with a message naming the task kind, every lane considered,
  and the reason each was excluded — not accepting dispatch, at cap, in
  cooldown, or program unavailable. A refusal that says only "no lane available"
  is not this task's output; the reader must be able to act on it.
  Depends on T36001.
  **Partly done.** The distribution rule and the refusal are implemented:
  `laneIneligibility` reports `does-not-accept-dispatch` before cooldown and the
  cap, and the refusal names every lane with its reason. Verified against this
  repository, where scheduling had been falling back to the orchestrating lane
  once the other two were cooling.
  What remains is the escalation half of Requirement 1.4. `escalate.ts` escalates
  WITHIN a lane — weakest model to the next stronger in that lane's own ordering
  — and never chooses a different lane, so it never consults lane eligibility.
  Cross-lane escalation is what 0011 R3.3 describes and it does not appear to be
  implemented. Establish whether it exists before writing anything: if it does
  not, this clause is vacuous and the task closes with that recorded; if it does,
  it must skip a lane that does not accept dispatch.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/core/src/executor/schedule.ts,packages/core/src/executor/escalate.ts,packages/core/src/executor/work.ts_

- [x] **T36003** Correct this repository's own lane declarations
  Requirements 1.6, 2.5. Three changes to `checkyourvibe.json`, each of which is
  a statement about how this machine's subscriptions are spent:
  remove the `codex-cli` lane, whose program is not installed here; add a
  `gemini-cli` lane for the installed `gemini` CLI, which `adapter-gemini`
  already supports and no lane names; and stop `claude-code-cli` being the
  first-choice `judgment-required` target, leaving `antigravity-cli` and
  `devin-cli` to carry dispatched judgment work.
  Add `gemini` to the `agents` list. Verify against `cyv doctor` after T36008,
  not before.
  _Exec: executor=self model=opus gates=self-check files=checkyourvibe.json_

- [x] **T36004** What an `opened` entry has to carry
  Requirements 5.1, 5.5. Add `host`, `pid` and `processStartedAt` to the
  `opened` dispatch entry, written once at open time and never updated. `pid` is
  the cyv process, because it is the one the orchestrator spawned and the one
  that dies with it. `processStartedAt` exists because a bare pid is reusable and
  a reader that trusted the number alone would call a dead dispatch live.
  A process's OWN start time needs no platform-specific code: `process.uptime()`
  is seconds since this process began, so the start time is the current clock
  minus that. Querying ANOTHER process's start time does need platform-specific
  work, and that belongs to T36005, which is the task that reads these fields
  back. Writing is the easy half; do not import the hard half into it.
  Where the value genuinely cannot be established, record its absence rather
  than substituting the entry's `openedAt`. An entry written without it is an
  entry that must judge undetermined later, which is correct.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/core/src/executor/store.ts,packages/core/src/executor/liveness.ts_

- [x] **T36005** Judging an in-flight dispatch
  Requirements 5.2, 5.3, 5.4. Given an `opened` entry with no `closed` entry,
  return live, abandoned, or undetermined, by the evidence `design.md` sets out:
  same host with a live pid whose start time matches is live; same host with no
  such process is abandoned; a different host, or a start time that cannot be
  read on either side, is undetermined.
  Nothing here closes, reopens or re-dispatches a record. The output is a
  judgement with its reasoning attached, for T36009 and the dashboard to show.
  Test the pid-reuse case explicitly — a live pid whose start time postdates the
  entry must judge abandoned, not live — because that is the case a naive
  implementation gets wrong and the one that silently resurrects dead work.
  Depends on T36004.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test files=packages/core/src/executor/liveness.ts,packages/core/src/executor/replay.ts_
  Delivered by 0040 T40002: `judgeLiveness` in `executor/liveness.ts`, pid-reuse case tested.

- [x] **T36006** The orchestrator records its own state
  Requirements 3.1, 3.2, 3.3, 3.4. A command by which the orchestrating session
  writes healthy, degraded or exhausted, with an optional reason and the model
  it believes it is running under, appended to the dispatch log as an
  `orchestrator` event so it survives the session that wrote it.
  Every rendering of it is attributed self-reported. No absence is ever read as
  healthy: no report means unknown, and unknown is a state that gets shown, not
  a default that gets hidden. The record folder must ignore event kinds it does
  not recognise so this addition does not break a reader written before it.
  Depends on T36004.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/core/src/cli/orchestrator.ts,packages/core/src/executor/store.ts,packages/core/src/cli/index.ts_
  Delivered by 0040 T40002: `cyv orchestrator` and the `orchestrator` log event.

- [x] **T36007** The stall signal
  Requirements 4.1 through 4.5. Derive stall from the dispatch log alone:
  dispatchable open work exists, at least one available lane is below its
  declared cap and not in cooldown, and no dispatch has opened within the
  configured interval, defaulting to 30 minutes.
  The report names the idle capacity it found, lane by lane. It states what is
  happening and never why — a stall is not evidence of exhaustion, and the
  wording must not let a reader conclude it is. It changes no scheduling.
  The judgment in this task is in the wording, not the arithmetic: a report that
  reads as an accusation against the orchestrator has failed R4.2 even when the
  computation is right.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test files=packages/core/src/executor/stall.ts,packages/core/src/config/types.ts_
  Delivered by 0040 T40002: `executor/stall.ts`, `executor.stallAfterMinutes`.

- [x] **T36008** `doctor` reports what capacity actually exists
  Requirements 2.1, 2.2, 2.3, 2.4. For each declared lane, resolve its program
  through `executor/program.ts` and report found or unavailable, naming the
  program names tried. Unavailable is a notice, not an error, and an unavailable
  lane counts as no capacity anywhere.
  Then the other direction: an adapter that ships with the tool, whose program
  is on `PATH`, that no declared lane names, is reported as unused capacity —
  the case this repository is in today with `gemini`.
  Discover nothing and declare nothing on the user's behalf (0011 R1.3).
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test files=packages/core/src/cli/doctor.ts_

- [ ] **T36009** Handing the run to another subscription
  Requirements 6.1 through 6.5. One command reporting everything a relieving
  orchestrator needs, read from disk alone: open work, in-flight dispatches with
  their liveness judgement and its reasoning, lane availability and cooldown,
  the last self-reported orchestrator state with its attribution and timestamp,
  and whether the run is stalled.
  Both a human-readable form and `--json`, because the usual reader is an agent
  and prose it has to parse is a schema nobody wrote down. It dispatches
  nothing and claims nothing: choosing which subscription to spend next is the
  user's decision (R6.5).
  Depends on T36005, T36006, T36007.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/cli/handoff.ts,packages/core/src/cli/index.ts_

- [ ] **T36011** Ask each agent what it can actually do
  Requirements 9.1, 9.2, 9.7, 9.8. Extend the agent probe beyond the `PATH`
  check `dispatch --agents` does today: run each CLI in a way that establishes
  whether it authenticates, and where the CLI can list its own models, read that
  list.
  Presence on `PATH` is not availability, and the difference is not theoretical:
  `gemini` resolves here and fails with an ineligible-tier error naming a
  discontinued plan. A probe that stops at `PATH` reports it as capacity.
  Record when each fact was discovered. Report anything undetermined as
  undetermined, and never substitute a model list compiled into cyv — a stale
  name that ships inside the tool looks authoritative and is not.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/executor/probe.ts,packages/core/src/executor/catalogue.ts_
  Moved to spec 0043 on 2026-09-01: the owner read this as a story of its own, and its second attempt wrote outside its scope (test-parse.js), which the new spec widens.

- [ ] **T36012** Report a lane whose declaration no longer matches its vendor
  Requirements 9.3, 9.4, 9.5, 9.6. Using T36011's discovery, report a lane that
  declares a model its CLI does not list, and a lane declaring
  `billing.kind: subscription` whose declared models the vendor prices per token.
  Keep 9.5's distinction in the wording. A price list is a published fact about a
  model; remaining balance is a fact about an account, and cyv still never asks
  for the second. A reader must not come away thinking the tool knows how much
  of their plan is left.
  Change no configuration (9.6). Report the mismatch and leave the edit to the
  person whose subscriptions are being spent.
  Depends on T36011.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/executor/catalogue.ts,packages/core/src/cli/doctor.ts_
  Moved to spec 0043 on 2026-09-01: the owner read this as a story of its own, and its second attempt wrote outside its scope (test-parse.js), which the new spec widens.

- [x] **T36013** `--task-file` mishandles an absolute path
  Found while dispatching T36001. `cyv dispatch --task-file /abs/path.txt`
  resolves the argument against the repository root, producing
  `<repo>/abs/path.txt` and failing with an ENOENT naming a path the caller
  never wrote. The same defect shape as the schema-path bug 0005 fixed three
  times: a path resolved against the wrong root, discovered only by using it
  from somewhere the wrong root happened to be wrong.
  An absolute path is used as given. A relative one keeps resolving against the
  repository root. Add a test for each.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/cli/dispatch.ts,packages/core/test/cli/**_

- [x] **T36014** A named lane in cooldown is not refused
  Requirements 10.1 through 10.6. Found by T38001 putting `devin-cli` into
  cooldown and leaving no way to get it back: cooldown blocks scheduling, only a
  success on the lane clears it, and the only route to the lane is an escalation
  that needs an unrelated gate failure first.
  A dispatch naming a lane with `--lane` reaches it even in cooldown, and says
  so in its output and in the record. The scheduler still never chooses a
  cooling lane on its own (10.4), and no backoff, retry count or clock is
  introduced (10.5) — the recovery path is a person deciding to try.
  A success clears cooldown by the existing rule; a second produced-nothing
  leaves it cooling, so this is a way out rather than a way to keep hammering an
  exhausted lane.
  `doctor` and the refusal message state how cooldown is cleared. A state with
  no visible exit reads as a broken tool, which is how this one read.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/executor/schedule.ts,packages/core/src/cli/dispatch.ts,packages/core/src/cli/doctor.ts,packages/core/test/executor/**_

- [x] **T36015** Keep what the executor said
  Requirement 11. `reportFromObservation` discards stdout and stderr that
  `runChild` already captured, so the record of a `produced-nothing` — the
  outcome that benches a lane — reads `status: success, exitCode: 0` and nothing
  else.
  Keep both streams on the report, truncated to a stated length, keeping the
  tail because a process explains itself as it fails, and naming the original
  length whenever a stream did not fit. Report the captured output in the
  dispatch command's own output for a failing or produced-nothing outcome, where
  it is the only account of what happened.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/executor/child.ts,packages/core/src/executor/outcome.ts,packages/core/src/cli/dispatch.ts,packages/core/test/executor/**_

- [ ] **T36016** Establish a lane's condition rather than assuming it
  Requirement 12. A `cyv probe` that sends one declared lane a minimal prompt
  with a known answer and reports available, exhausted, or broken.
  The three states are the point. Today everything that is not a success reads
  as possible exhaustion, so an authentication failure and a discontinued model
  and a real rate limit are one state with one remedy, and only one of them is
  cured by waiting.
  Read the vendor's wording from the captured output (T36015) to separate
  exhausted from broken, using each adapter's own `detectsRateLimit`. Never read
  or infer a quota (12.4).
  The probe does not run itself on every ambiguous outcome (12.7): it spends
  capacity, and spending capacity to learn whether there is capacity is the
  user's trade to make.
  Depends on T36015.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/cli/probe.ts,packages/core/src/executor/probe.ts,packages/core/src/cli/index.ts_

- [ ] **T36017** Every lane cooling is a finding about the diagnosis
  Requirement 12.6. When every declared lane is in cooldown, say so as a
  condition in its own right, in the dispatch refusal and in `doctor`, and say
  that independent subscriptions do not run out simultaneously.
  Name what actually does this to every lane at once — a task brief no executor
  can satisfy, a gate that always fails, a model no longer served, a machine
  that slept — and point at the probe (T36016) as the way to tell which.
  This is wording, not arithmetic, and the wording is the deliverable: a reader
  who concludes they are out of usage on all four subscriptions has been misled
  by a tool that had no evidence for it.
  Depends on T36016.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/cli/dispatch.ts,packages/core/src/cli/doctor.ts_

- [ ] **T36010** Kill an orchestrator mid-run and read the state back
  Every spec ends by pointing the tool at something real, and for this one the
  real thing is the failure itself. Open a dispatch against a live lane, kill the
  cyv process supervising it without letting it close its record, and then, from
  a second session that never saw the first, run T36009's command.
  It passes when that second session correctly reports the dispatch as
  abandoned, names the lane and task, shows the orchestrator's last self-report
  with its timestamp and self-reported attribution, and lists the lanes sitting
  idle. It fails if any of those read as live, healthy, or measured.
  Then the case the design says must not be got wrong: verify a pid reused by an
  unrelated process judges abandoned rather than live.
  Record what was found in `docs/STATUS.md`, including anything that read wrong
  the first time. A clean pass on the first attempt is itself worth stating,
  and worth doubting.
  Depends on T36009.
  _Exec: executor=self model=opus gates=manual files=docs/specs/0036-orchestrator-survival/tasks.md,docs/STATUS.md_
