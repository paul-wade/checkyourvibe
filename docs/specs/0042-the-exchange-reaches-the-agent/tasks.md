# 0042 — The exchange reaches the agent: tasks

**Status:** complete. All five tasks landed.
Requirements in `requirements.md`, decisions in `design.md`.

T42001, T42003 and T42004 have disjoint scopes and run at once; T42002 depends
on T42001 for the hook subcommand it registers.

## Open

- [x] **T42001** `cyv comments --hook <agent>` and `--watch`
  Requirements 1.3, 1.4, 4. A hook form that reads the payload the agent's
  hook sends on stdin (the adapter's `parseHookPayload` is not needed; only
  the repository root, from the working directory), prints unread notes in the
  form the adapter's hook contract wants, advances the cursor only on a
  successful write, and exits with the code the adapter maps to "context for
  the model". A `--watch` form that loops on a configurable interval.

  Done. `--hook <agent>` reads this repository only — a hook fires inside one
  project, and the registry is about the dashboard — and is silent at exit 0
  when nothing is unread, so an agent running it after every edit pays nothing
  for the common case.

  **The cursor advances on a flushed write, not on a returned call.**
  Requirement 1.3 turns on this: `console.log` returns before the write reaches
  the far end, so advancing on its return would mark a note read that a closing
  pipe swallowed. Delivery waits for the write callback and leaves the note
  unread when it reports an error, which a test covers by failing the first
  write and asserting the second run still delivers.

  **The delivery contract is a table in core, and that is a compromise.**
  Claude Code is `stderr` + exit 2 — the one route that hands text back to the
  model as something it must read — and every other adapter is `stdout` + 0.
  Calling into the adapter would be more correct, but Requirement 1.4 caps this
  command at reading two small files and loading an adapter module on every
  edit is not that; and the adapter's `formatResult` takes violations, so
  reusing it would mean dressing a note up as a `Violation`, which is inventing
  a finding. The right home is a `formatNotes` beside `formatResult` in the
  plugin contract — T42002's territory, where the adapters are already open.

  **A bug in the first draft of `--watch`:** two `setTimeout`s, one `unref`'d
  and one not, which contradicted each other — the unref'd timer would let the
  process exit mid-watch. Replaced with one timer that a signal can cancel, so
  Ctrl-C does not wait out the poll interval.

  **`no-as-cast` fired four times** on stubs of `process.stdout.write` in the
  test. The stream's `write` is overloaded, so a hand-rolled stub needs a cast
  to satisfy the overload set — a claim the test cannot back. Replaced with
  `vi.spyOn`, which is typed, and the callback-position ambiguity is handled
  explicitly rather than assumed away.
  _Exec: executor=self kind=mechanical gates=cyv-check,tsc,test files=packages/core/src/cli/comments.ts,packages/core/test/cli/comments.test.ts_

- [x] **T42002** The adapters install the notes hook
  Requirements 1.1, 1.2. The Claude Code adapter adds a second `PostToolUse`
  command and a `Stop` hook, both carrying the `hook claude-code` ownership
  marker's sibling for notes; the other adapters add the `PostToolUse` form
  where their contract has one. `doctor` reports an adapter that has no
  refuse-to-stop equivalent. Depends on T42001.

  Done for five of six. Claude Code gets both the post-edit delivery and the
  `Stop` hook, which is the only contract among the six that can hold a turn
  open until a note has been read. Cursor, Gemini, Antigravity and Devin get the
  post-edit form.

  **Codex gets none, and the reason is a defect the task did not anticipate.**
  Its hooks live in a TOML array-of-tables merged by ownership marker, and
  `mergeToml` treats every entry containing the marker as a candidate — it
  replaces the first and *deletes the rest*. The notes command is
  `cyv comments --hook codex`, which contains `hook codex`, this entry's marker.
  A second entry would have installed cleanly, worked, and then vanished at the
  next `cyv init` without a word. Found by reading the merge before writing the
  entry, not by a test.

  The same overlap is harmless on the other five: their hooks sit in one JSON
  array that is replaced whole, so both commands survive together. On Claude
  Code it is deliberate — one marker owning all three entries means an upgrade
  cannot orphan any of them, which the e2e now asserts by count.

  Fixing codex needs either disjoint markers, which means renaming a flag spec
  0042 fixed in prose, or chaining both commands into one entry, which changes
  what that entry's exit code means. Neither is this task's to decide, so
  `doctor` reports the gap instead: codex says plainly that it installs no notes
  hook and why, and every non-Claude adapter says it cannot refuse to end a turn.

  Three test files encoded the old single-entry shape and were updated to the
  new contract rather than loosened — including the e2e's "no duplicated hook
  entry" count, which is the assertion that would catch a real duplication bug
  and is now pinned at three.
  _Exec: executor=self kind=judgment gates=cyv-check,tsc,test files=packages/adapter-*/src/index.ts,packages/core/src/cli/doctor.ts,packages/adapter-*/test/index.test.ts,packages/core/test/e2e/cli-flow.test.ts,packages/core/test/cli/installed-package.test.ts_

- [x] **T42003** A closing dispatch prints what arrived
  Requirement 2. After the outcome lines, `cyv dispatch` prints unread notes
  for the repository without advancing the cursor.

  Done, on **both** ways a dispatch closes. The first pass wired only the
  CLI-dispatch path and a live run caught the gap: `cyv dispatch --close <id>`,
  the sub-agent form from 0041 T41003, also closes a dispatch and printed
  nothing. That is the case where a note is most likely to have arrived, since
  the session was doing the work rather than watching for notes.

  The cursor is not advanced (Requirement 2.2), and that was verified rather
  than assumed: after a close showed the note, `cyv comments --hook claude-code`
  still delivered it and still exited 2.

  A pluralisation bug shipped for one run — "1 note ... have not been read" —
  found by reading the live output.
  _Exec: executor=self kind=mechanical gates=cyv-check,tsc,test files=packages/core/src/cli/dispatch.ts,packages/core/src/cli/comments.ts,packages/core/test/cli/comments.test.ts_

- [x] **T42004** The exchange shows unread-by-the-agent
  Requirement 3. `commentsToExchange` reads the cursor and marks each owner
  note read or unread with its age; a note unread past the stall interval
  becomes a needs-you item worded as a description.

  Done. Each owner note in the exchange now carries `readByAgent` and, when
  unread, `unreadForMs`; the page renders "read by the agent" or "unread by the
  agent for 45 minutes" on the note's own meta line. The tool's own turns carry
  neither, because the question does not arise for them.

  A note unread past the stall interval becomes its own needs-you item under a
  new `unread-note` kind. The wording is a description of a state — "The agent
  has not read this. It has been waiting 2 hours. Is a session running?" — not
  an accusation, because the only evidence is that a cursor has not moved. cyv
  cannot see whether a session is alive, busy, or has the note in front of it.

  Requirement 3.3 is enforced by construction: read is `comment.id <= cursor`
  and nothing else, so a note the hook delivered and the agent then ignored
  reads as read, because it was.

  **A layering inversion I introduced, and then fixed.** Wiring the cursor into
  the page model made `dashboard/home-model.ts` import from `cli/comments.ts` —
  the only `dashboard/ → cli/` import in the tree, and the wrong direction. The
  cursor now lives in `dashboard/review/cursor.ts`, which both the command and
  the page import. Caught by grepping for the pattern rather than by any gate;
  nothing in the repository reports a layering violation.
  _Exec: executor=self kind=judgment gates=cyv-check,tsc,test files=packages/core/src/dashboard/review/comments.ts,packages/core/src/dashboard/review/cursor.ts,packages/core/src/dashboard/review/needs-you.ts,packages/core/src/dashboard/home-model.ts,packages/core/src/dashboard/home.ts,packages/core/src/dashboard/view-model.ts,packages/core/src/cli/comments.ts,packages/core/test/dashboard/home-model.test.ts_

- [x] **T42005** Leave a note and watch it arrive
  Requirement 5. Record in `docs/STATUS.md`.

  Done, by leaving notes rather than by asserting. A note left on the dashboard
  reached a session through `cyv comments --hook claude-code` without the
  session asking, exiting 2 so the text is handed to the model; a second run
  exited 0 and delivered nothing, so a note arrives exactly once. A dispatch was
  then opened, a note left while it ran, and `--close` printed it after the
  outcome without advancing the cursor — confirmed by the hook still delivering
  it afterwards.
  _Exec: executor=self model=opus gates=manual files=docs/STATUS.md,docs/specs/0042-the-exchange-reaches-the-agent/tasks.md_
