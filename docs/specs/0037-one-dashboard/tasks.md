# 0037 — One dashboard: tasks

**Status:** superseded by 0040 on 2026-09-01. T37001, T37002, T37004 through T37009, T37011 and T37013 were delivered under 0040 with a different page; T37003 (artboards), T37010, T37012 and T37014 (difit on a real phone) were not done and are carried by 0040 R9 and its open questions.
Requirements in `requirements.md`, decisions in `design.md`.

Lane placement follows 0036 Requirement 1: no task here is dispatched to
`claude-code-cli`. Judgment goes to `antigravity-cli`, mechanical to
`devin-cli`, and the orchestrating subscription is spent on planning and review.

The port tasks run before the design tasks for a reason. Drawing a page against
invented content produces a page that fits invented content; T37003 draws
against whatever T37001 and T37002 actually produce, including the states
nobody likes.

## Open

- [ ] **T37001** Port the review UI's data layer into core, under the rules
  Requirement 1.1, 1.5. Move what `tools/review/store.mjs`, `verdict.mjs`,
  `progress.mjs`, `health.mjs` and `count-tests.mjs` do into TypeScript under
  `packages/core/src/dashboard/`: the comment store including 0034's `kind` and
  `refs` fields, spec and task parsing including the `_Exec:` line, the verdict
  and needs-you derivation, progress, and the test count.
  This is a port, not a rewrite: the behaviour is settled and tested by use. What
  changes is that it becomes `.ts` and therefore falls under the analyzer for the
  first time — `**/*.ts` is the manifest's match and `.mjs` was never in it.
  Do not silence a finding to land the port. A rule that fires here fires on code
  that has never been checked, and 0002's constraint applies: no exclusion, no
  suppression to get a green gate. Where a finding needs a real fix that is
  larger than the port, record it for T37011 rather than hiding it.
  Existing `.cyv-review/` stores SHALL load unchanged (R1.5).
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/dashboard/review/**_

- [x] **T37002** Port the project registry, and stop it reporting what it did not measure
  Requirement 2.2, 2.3. Move `tools/review/projects.mjs` into
  `packages/core/src/dashboard/projects.ts`: `~/.cyv/projects.json`, explicit
  add and remove, nothing scanned, nothing inferred.
  Fix the conflation `design.md` names: `listProjects` currently reports
  `exists: false, hasConfig: false` for every path that fails validation,
  including a directory that is present and merely has no `checkyourvibe.json`.
  Report the two separately, because "the directory is gone" and "the
  configuration is gone" have different remedies and the tool knows which it saw.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/dashboard/projects.ts,packages/core/test/dashboard/projects.test.ts_

- [ ] **T37003** Draw the three treatments before building them
  Requirement 5.1, 5.2, 5.3, 5.5, 5.6. Artboards for decision, measurement and
  reference as `design.md` defines them, drawn against real content from T37001
  and T37002 rather than invented content.
  Every artboard is drawn at phone width first (R1.4). Cover, for each
  treatment: populated, empty, and each of R5.4's three evidence states, with
  unknown visibly not resembling zero. Include the state the current page is
  actually in most often — a fresh checkout with nothing measured — because that
  is the one that shipped as four em-dashes.
  Show the typographic scale as a scale (R5.5): the current page has one label
  size and therefore no hierarchy to express.
  Carry forward the stylesheet's existing decisions (R5.6) and argue any
  departure rather than making it silently.
  Output is reviewed by a person before T37004 starts. "Does this read as
  generated" has no gate, which is why this task has a reader instead of one.
  _Exec: executor=antigravity-cli kind=judgment gates=review files=docs/specs/0037-one-dashboard/design/**_

- [ ] **T37004** The shell: three roles, one scale, evidence everywhere
  Requirement 5.1 through 5.6. Implement T37003's approved treatments as the
  dashboard's shell and stylesheet. A panel declares its role and the treatment
  follows from the role, so a fourth panel added later cannot land as a fifth
  copy of one block.
  Apply the evidence marking (R5.4) to every number on the page, not only the
  verdict. Zero runtime dependencies, server-rendered, phone-first (R1.3, R1.4).
  Depends on T37003.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/dashboard/shell.ts,packages/core/src/dashboard/theme.ts_

- [ ] **T37005** Empty states, built before the populated ones
  Requirement 5.3. Every panel gets an empty state naming what would fill it and
  the command that would do it. No panel disappears when empty — an absent panel
  is a gap the reader cannot see, and silence is the enemy.
  The front page's fresh-checkout state is the one this task exists for: today it
  renders a headline saying nothing has been measured over three statistics
  showing `--`.
  Depends on T37004.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/dashboard/empty.ts,packages/core/src/dashboard/shell.ts_

- [ ] **T37006** The overview is about projects
  Requirement 2.1, 2.4. An overview listing every registered project with its
  own state read from its own files, and a per-project page beneath it. One
  server, every project, no port to remember.
  The repository the server happens to be installed in gets no special
  treatment, and the headline reports the project being viewed rather than
  checkyourvibe's own self-check. A missing or misconfigured project appears
  with T37002's distinction intact.
  Depends on T37002, T37004.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/dashboard/overview.ts,packages/core/src/cli/dashboard.ts_

- [ ] **T37007** The exchange
  Requirement 3.1 through 3.4. A project's page leads with the exchange between
  owner and agent, most recent first, each entry stating who wrote it from
  recorded authorship rather than inference, agent and owner distinguishable at a
  glance.
  The owner writes back a paragraph, not a line. A recorded turn does not appear
  as something waiting on a person.
  Depends on T37001, T37004.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/dashboard/exchange.ts_

- [ ] **T37008** Lanes on the page people open
  Requirement 4.1 through 4.5. The executor region: lanes available, at cap, in
  cooldown, idle. The orchestrating lane among them, marked, carrying its
  self-reported state with self-reported attribution and showing unknown when
  there is none.
  A stall promotes the region to a decision treatment and names the idle lanes it
  found, worded as a description and never as an accusation about a cause.
  Abandoned and undetermined dispatches appear as needing a person.
  No meter, no percentage, no remaining-token count, no projection — for any
  lane, including the orchestrator.
  Reuses `dashboard/executor-view.ts` rather than re-deriving lane state.
  Depends on 0036 T36005, T36006, T36007, and T37004.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/dashboard/lanes.ts_

- [ ] **T37009** Documents, activity, and guarded editing
  Requirement 1.1. The remainder of what 4180 serves: the document browser over
  specs and docs, git activity and recent commits, the diff view, and guarded
  editing with its existing save protections.
  Guarded editing is carried across as a capability; whether it ships enabled by
  default is an open question in `requirements.md` and is not decided here.
  Depends on T37001, T37004.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/dashboard/documents.ts,packages/core/src/dashboard/activity.ts_

- [ ] **T37010** Fix what the port surfaced
  The findings T37001 recorded rather than hid: 2,460 lines that had never been
  checked, now under nineteen rules. Fix them under 0002's constraint — no
  exclusion, no suppression, no validation library adopted to make it easier.
  Report the count found and the count fixed. If a finding turns out to be the
  rule being wrong about this context rather than the code being wrong, say so
  and narrow the rule; that has happened four times in this project and each time
  the rule was the defect.
  Depends on T37001.
  _Exec: executor=antigravity-cli kind=judgment gates=tsc,test,self-check files=packages/core/src/dashboard/**_

- [ ] **T37011** Delete the second dashboard
  Requirement 1.2. Remove `tools/review/` and every reference to it — package
  scripts, documentation, the port-4180 instructions, and anything in `docs/`
  that points a reader at it. Two surfaces drifting apart is the condition this
  spec exists to end, and leaving it in place as a fallback is how it survives.
  Runs only once T37012 has confirmed the replacement works. Deleting first and
  discovering a gap afterwards costs the surface everyone actually uses.
  Depends on T37012.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=tools/review/**,package.json,docs/**_

- [ ] **T37013** Documents render formatted, and comment where they are read
  Requirement 7.1 through 7.6. Carry the section-split markdown view across:
  headings become sections, each section carries its own comment thread anchored
  to its slug, and `tools/vendor/marked.min.js` moves with it as a vendored file
  rather than a fetched one.
  The hardening is not optional and is not a detail to re-derive: raw HTML in a
  document is escaped rather than rendered, and link and image targets are
  restricted to safe schemes. Documents here are agent-authored, which makes a
  document untrusted input.
  Give the no-script path a deliberate state rather than an empty panel, and keep
  the editor's existing protection against overwriting a file that changed on
  disk since it was opened.
  Depends on T37001, T37004.
  _Exec: executor=devin-cli kind=mechanical gates=tsc,test,self-check files=packages/core/src/dashboard/documents.ts,packages/core/src/dashboard/markdown.ts,packages/core/vendor/**_

- [ ] **T37014** Judge the diff viewer on a phone before deciding anything
  Requirement 8.1 through 8.5. Carry the difit integration across with its three
  instances intact — working, staged, branch — and its refusal to pass
  `--include-untracked`.
  Then answer the question that has not been answered: open a real diff on a real
  phone. Not a narrowed desktop window, and not the published claim that it is
  responsive. Judge line wrapping, horizontal scroll, the comment affordance, and
  whether a long diff is navigable with a thumb.
  Record the finding either way. If it holds up, that is a result and the answer
  is to keep it. If it does not, evaluate alternatives or contribute upstream —
  in that order, and without writing one from scratch (8.2).
  Depends on T37009.
  _Exec: executor=self model=opus gates=manual files=docs/specs/0037-one-dashboard/tasks.md,docs/STATUS.md_

- [ ] **T37012** Look at it, on a phone, with real state
  Requirement 6.1, 6.2, 6.3. Not fixtures. Several registered projects with at
  least one that is not checkyourvibe, at least one dispatch in flight, at least
  one lane in cooldown, and at least one abandoned dispatch from 0036 T36010.
  Open every panel's empty state and look at it, because those are the ones that
  ship broken — nobody opens them on a machine with data.
  Look at the whole thing at phone width, since R1.4 claims that is the primary
  use and nothing else tests the claim.
  The question this task answers is the one that has no gate: does it still read
  as generated. Record what was found in `docs/STATUS.md`, including anything
  that looked wrong, and do not record a pass that was not looked at.
  Depends on T37005, T37006, T37007, T37008, T37009, T37010.
  _Exec: executor=self model=opus gates=manual files=docs/specs/0037-one-dashboard/tasks.md,docs/STATUS.md_
