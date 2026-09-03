# 0035 — One dashboard, several projects: tasks

**Status:** open
Requirements in `requirements.md`, decisions in `design.md`.

`tools/review/` is zero-dependency and server-rendered. Nothing here adds a
dependency.

## Open

- [x] **T35001** The project registry
  `~/.cyv/projects.json`, a list of absolute paths, with `--add` and `--remove`
  refusing a path holding no `checkyourvibe.json` and saying why. Registration
  is explicit: nothing scans a disk, nothing infers a project from activity
  (R2.2). A registered path that no longer exists is reported as missing and is
  not silently dropped (R2.3).
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/projects.mjs_

- [x] **T35002** Read one project's state from its own files
  A function taking a project root and returning its status: last run,
  in-flight dispatches, open comments needing a person, recorded health, and
  when each was measured. Every read is defensive — a project with no
  `.cyv-review/` is a normal first-run state, and one whose file cannot be
  parsed renders as unreadable with the reason rather than as empty (R3.3).
  Reuse the existing parsers; do not write second readers for the same files.
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/project-state.mjs_

- [x] **T35003** The overview page
  One row per project carrying what decides whether to open it: whether anything
  needs a person, whether work is in flight, and when it was last measured
  (R5.2). Fits a phone (R5.1). With exactly one project registered the overview
  is skipped and that project's page is the home page (R1.2).
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=tools/review/server.mjs,tools/review/ui.mjs_

- [x] **T35004** Stop the server being about its own checkout
  `REPO` is resolved from the server's install location, which is why a page
  opened to look at somebody's project reports checkyourvibe's self-check. Every
  route takes the project it is about. The tool's own repository becomes one
  registered project among the others (R1.3).
  This is the task the other four depend on and the one most likely to break
  something: every existing route reads `REPO` today.
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=tools/review/server.mjs_

- [x] **T35005** Fix the headline
  Requirement 6. `215 files` and `19 rules` leave the headline for wherever
  configuration is reported; `tests pass` and `tasks` stay. "Clean against
  itself" goes — a project's headline states that project's state. A measurement
  still carries its age, but age is not the loudest thing on the page (R6.4).
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/verdict.mjs,tools/review/server.mjs_

- [x] **T35006** The watcher covers every registered project
  `watch-comments.mjs` takes the registry instead of one root and names the
  project a new comment came from, so an agent working in one project is not
  blind to a note left on another (R4.2). The cursor file gains a per-project
  key; no comment store changes shape (R4.3).
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/watch-comments.mjs_

## Deferred, with the reason

- **Converging with `cyv dashboard`**, the rules browser from spec 0006. Two
  servers on two ports. They answer different questions — what rules exist
  versus what is happening — and merging them is a larger decision than this
  spec.
- **Any cross-project aggregate.** A total findings count across projects is a
  number nobody acts on.
