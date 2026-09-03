# 0040 — A dashboard that makes sense: tasks

**Status:** complete — see docs/STATUS.md, 2026-09-01
Requirements in `requirements.md`, decisions in `design.md`.

The seam is `packages/core/src/dashboard/view-model.ts`, written first so the
readers and the renderer are separate tasks with disjoint scopes and can run
at once. Nothing here adds a runtime dependency.

Lane placement: the orchestrating session is the only lane on this machine
with a working Claude Code subscription, and the other two lanes are one
concurrent dispatch each. The port tasks below are dispatched to the
orchestrator's own sub-agents (spec 0041, self-dispatch) so they run in
parallel; `executor=self` marks that.

## Open

- [x] **T40001** Port the review data layer under the rules
  Requirement 8.3, 5.1, 2.1 (tasks, blocked, notes), 3.3, 3.6. Move what
  `tools/review/store.mjs`, `verdict.mjs`, `progress.mjs` and the file and
  git helpers in `server.mjs` do into TypeScript under
  `packages/core/src/dashboard/review/`: the comment store with 0034's `kind`
  and `refs`, spec and task parsing including every `_Exec:` field and the
  dependencies a task names, wave grouping by disjoint file scope, the
  needs-you sources that come from the repository, uncommitted-work reading,
  markdown discovery and safe path resolution, section splitting, and the
  STATUS log reader. Existing stores load unchanged.
  _Exec: executor=self kind=mechanical gates=tsc,test,cyv-check files=packages/core/src/dashboard/review/comments.ts,packages/core/src/dashboard/review/specs.ts,packages/core/src/dashboard/review/needs-you.ts,packages/core/src/dashboard/review/progress.ts,packages/core/src/dashboard/review/documents.ts,packages/core/src/dashboard/review/status-log.ts,packages/core/test/dashboard/review/**_

- [x] **T40002** Liveness, stall, the orchestrator's self-report, stop, and difit
  Requirements 3.2, 3.5, 4.4, 6, 7.1. Judge an open dispatch live, abandoned or
  undetermined by 0036 Decision 2 (T36005). Derive the stall signal from the
  log alone (T36007). Record the orchestrator's self-reported state as an
  `orchestrator` event the record folder keeps and readers written before it
  ignore (T36006). Stop a running dispatch by pid, on this host only, and
  close its record as `did-not-complete` (Decision 3). Port the difit wrapper.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/executor/liveness.ts,packages/core/src/executor/stall.ts,packages/core/src/executor/dispatch.ts,packages/core/src/executor/parse.ts,packages/core/src/executor/store.ts,packages/core/src/executor/index.ts,packages/core/src/config/types.ts,docs/protocol/config.schema.json,packages/core/src/cli/orchestrator.ts,packages/core/src/dashboard/stop.ts,packages/core/src/dashboard/review/difit.ts,packages/core/test/executor/liveness.test.ts,packages/core/test/executor/stall.test.ts,packages/core/test/executor/orchestrator-event.test.ts,packages/core/test/dashboard/stop.test.ts_

- [x] **T40003** The shell and the four regions
  Requirements 1, 2.3, 3, 4, 5, 6.3, 7.2, 7.1 (page side). Port 4180's
  stylesheet and shell, keeping its three rules, and render `HomePage` from
  the view model: top bar with project selector, check indicator and tabs;
  needs you; in motion with running, next-up waves, just finished, stall and
  uncommitted work; lanes; exchange with a paragraph box. The stop control
  arms on one tap and sends on the second. Also the docs, view, edit and diff
  page bodies. Every region's empty state is designed, not `--`.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/dashboard/shell.ts,packages/core/src/dashboard/home.ts,packages/core/src/dashboard/pages.ts,packages/core/test/dashboard/home.test.ts,packages/core/test/dashboard/pages.test.ts_

- [x] **T40004** Build the model from disk
  Requirements 2, 3, 4. Compose the view model: lanes from configuration,
  replay, program resolution and the self-report; unused adapters; the active
  spec, running dispatches with liveness, next-up waves, finished dispatches,
  the stall; the needs-you list from every source; the exchange; the project
  options. Reads only; runs no analyzer and no executor.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/dashboard/lanes.ts,packages/core/src/dashboard/motion.ts,packages/core/src/dashboard/home-model.ts,packages/core/test/dashboard/home-model.test.ts_

- [x] **T40005** One server, and the commands beside it
  Requirements 1.5, 5.2, 5.3, 6, 7, 8.1, 8.2. `cyv dashboard` serves every
  registered project from one port: the home page, its poll key, comment
  posting and status, stop, the docs browser with section comments and guarded
  editing, the vendored renderer, diff with start-on-demand, and `/rules`
  serving today's page. `cyv projects` lists, adds and removes registrations.
  `cyv comments` replaces the watcher.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/cli/dashboard.ts,packages/core/src/cli/projects.ts,packages/core/src/cli/comments.ts,packages/core/src/cli/index.ts,packages/core/vendor/**,packages/core/package.json,packages/core/test/dashboard/serve.test.ts,packages/core/test/cli/projects.test.ts_

- [x] **T40006** Look at it
  Requirement 9. Phone width, real state: a dispatch in flight, a lane in
  cooldown, an abandoned dispatch, every empty state. Record what was seen in
  `docs/STATUS.md`.
  _Exec: executor=self model=opus gates=manual files=docs/STATUS.md,docs/specs/0040-a-dashboard-that-makes-sense/tasks.md_

- [x] **T40007** Delete the second dashboard
  Requirement 8.4. Remove `tools/review/` and every reference to it and to
  port 4180: docs, the spec workflow's mentions, package scripts. Runs after
  T40006.
  _Exec: executor=self kind=mechanical gates=tsc,test,cyv-check files=tools/review/**,tools/vendor/**,docs/**,package.json,README.md_

- [x] **T40008** Fix what the port surfaced
  Decision 7. Findings the port recorded rather than hid. Report the count
  found and fixed; where the rule was wrong about the context, say so.
  Result: the port was written under the hook from the first line, so every
  finding was fixed as it was made. Across the ported modules the analyzer
  reported one `no-editorial-comment` and one `no-any` inferred from an
  `AsyncIterable` chunk, both fixed; no rule was found wrong about the
  context.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/dashboard/**_

## Reopened after looking at it

The first render of "needs you" listed statuses with a link to a document.
The owner: "I have no idea what the question is; a link to the doc doesn't
help." Each item now states what happened, asks the decision as a question,
and carries its answers as buttons: tell the agent (prefills the exchange
box), needs nothing (records an `acknowledged` log event), close the record
(an abandoned dispatch), mark addressed (a note), open (the document).

- [x] **T40009** The repository-sourced items ask a question and carry answers
  `task`, `blocked` and `note` items in `review/needs-you.ts` fill `question`,
  `detail` and `actions` per the view model. A task's detail is its description
  lines from tasks.md.
  _Exec: executor=devin-cli kind=mechanical gates=cyv-check,tsc,test files=packages/core/src/dashboard/review/needs-you.ts,packages/core/test/dashboard/review/needs-you.test.ts_

- [x] **T40010** Render each item as a question with its answers as buttons
  `needsYouHtml` in `home.ts` renders question, what happened, detail lines and
  the action row; the client script in `shell.ts` handles tell (prefill and
  focus the exchange box), needs nothing (`/api/acknowledge`) and close the
  record (`/api/stop`). No inline handlers.
  _Exec: executor=antigravity-cli kind=judgment gates=cyv-check,test files=packages/core/src/dashboard/home.ts,packages/core/src/dashboard/shell.ts,packages/core/test/dashboard/home.test.ts_

- [x] **T40011** The log-sourced items ask a question, and an answer is recorded
  `home-model.ts` builds the dispatch, refusal, liveness and stall items as
  questions naming the spec task; `acknowledged` becomes a dispatch log event
  the folder keeps and `/api/acknowledge` writes; acknowledged items leave the
  list. difit moves to ports 4381 to 4383 and `difitUp` checks that difit
  itself answers, after the diff tab framed a preview server on 4173.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/dashboard/home-model.ts,packages/core/src/dashboard/view-model.ts,packages/core/src/executor/dispatch.ts,packages/core/src/executor/parse.ts,packages/core/src/executor/store.ts,packages/core/src/dashboard/review/difit.ts,packages/core/src/cli/dashboard.ts,packages/core/test/dashboard/home-model.test.ts_

- [x] **T40012** A shim under a spaced path could not be a gate
  Found by dispatching T40009 and T40010: both closed `gates-failed` on
  `run:npx vitest run …` while each executor reported the same command green.
  The gate ran `npx.CMD` as `cmd /d /s /c <path> <args>` with the path as its
  own argument; Node quoted the path for its space and `/s` stripped the first
  and last quote of the string, so cmd ran `C:\Program`. `pnpm`'s shim sits in
  an unspaced directory, which is why that gate passed. `launchArguments` now
  builds one quoted command line passed verbatim; a failed gate keeps the tail
  of what it wrote, so the next reader sees the reason and not only the code.
  The two dispatched results were verified by hand (30 tests, typecheck, zero
  findings) and accepted; their records keep the outcome the runner recorded.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/executor/program.ts,packages/core/src/executor/child.ts,packages/core/src/executor/gates.ts,packages/core/src/cli/dispatch.ts,packages/core/test/executor/program.test.ts_

## The diff tab on a phone

The owner, on a phone: "difit is a bit rough at mobile size; keep the nice
highlighting but drop some chrome to show more code." And: the agent already
starts difit after every task with no port named, so the dashboard should use
that one rather than own a second.

- [x] **T40013** A same-origin proxy for difit with a phone-width stylesheet
  `review/difit-proxy.ts`: forwards a request to difit and streams the answer,
  injects a `@media (max-width: 720px)` stylesheet into its page that hides
  difit's header, the Viewed button and the old-line-number column and tightens
  the gutter and type. Desktop is untouched. Dispatched to devin-cli; every
  gate passed on the first attempt through the fixed runner.
  _Exec: executor=devin-cli kind=mechanical gates=cyv-check,tsc,test files=packages/core/src/dashboard/review/difit-proxy.ts,packages/core/test/dashboard/review/difit-proxy.test.ts_

- [x] **T40014** One row of chrome on the diff tab, same-origin frame
  `shell()` gains a compact mode: tabs, the working/staged/branch selector and
  the project name in one 44px row. The frame points at `/frame?d=…` on this
  origin. Dispatched to antigravity-cli; every gate passed on the first attempt.
  _Exec: executor=antigravity-cli kind=judgment gates=cyv-check,test files=packages/core/src/dashboard/shell.ts,packages/core/src/dashboard/pages.ts,packages/core/test/dashboard/pages.test.ts_

- [x] **T40015** Find the difit the agent already started
  `difitInstanceStates` probes difit's own default ports (4173 to 4179) and
  lists any difit answering there as an external instance the frame can show,
  so an agent that starts difit with no port after a task is picked up where it
  landed. The `/frame` route sets a cookie naming the port and the dashboard
  proxies `/assets/*`, difit's `/api/*` and its icons to it.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/dashboard/review/difit.ts,packages/core/src/dashboard/view-model.ts,packages/core/src/cli/dashboard.ts_

## Needs you cleans itself

The owner, after an hour: four notes he had written were still listed as
unanswered although each had been answered, and a parked roadmap entry sat
beside them. "If it's parked or done get it off; ensure the agent cleans up as
it goes." Every item type now has an exit, and the agent's ordinary actions
take the exit as a side effect.

- [x] **T40016** Every item leaves the list when its cause does, or on one tap
  Answering a note (`cyv comments --record --reply-to N`) marks it addressed.
  An acknowledgement names any item — a dispatch id, a task id, a spec number —
  so tasks marked for the owner and parked roadmap entries carry a "needs
  nothing" button too; `cyv acknowledge <id>` is the same act from the
  terminal. A task whose latest dispatch succeeded is tagged "landed — check it
  off" under next up rather than listed as work to start. The `acknowledged`
  event's field is `itemId`; entries written under the first name still read.
  _Exec: executor=self kind=judgment gates=tsc,test,cyv-check files=packages/core/src/cli/acknowledge.ts,packages/core/src/cli/comments.ts,packages/core/src/cli/index.ts,packages/core/src/executor/dispatch.ts,packages/core/src/executor/parse.ts,packages/core/src/executor/store.ts,packages/core/src/dashboard/home-model.ts,packages/core/src/dashboard/motion.ts,packages/core/src/dashboard/home.ts,packages/core/src/dashboard/shell.ts,packages/core/src/dashboard/review/needs-you.ts,packages/core/src/dashboard/view-model.ts_
