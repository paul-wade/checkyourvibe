# 0034 — The dashboard as the conversation: tasks

**Status:** open
Requirements in `requirements.md`, decisions in `design.md`.

The review UI is `tools/review/` and is zero-dependency and server-rendered.
Nothing here may add a dependency (R5.3).

## Open

- [x] **T34001** Widen the comment record without breaking what reads it
  Add `kind: 'note' | 'turn'` and `refs?: { task?, file?, replyTo? }` to the
  record in `tools/review/store.mjs`. An entry with no `kind` reads as `note`,
  so every record already on disk stays valid and the current page keeps
  working. `needsYou` continues to consider only open, owner-authored notes —
  a recorded turn is not something waiting on a person.
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/store.mjs,tools/review/verdict.mjs_

- [ ] **T34002** Render the exchange on the status page
  Below verdict, needs-you and in-progress (R1.3), most recent first, each entry
  showing its author, when it was written (R3.2), and what it references. An
  agent entry is distinguishable from the owner's by recorded authorship rather
  than by formatting convention (R1.2). Paginated to a recent window with the
  rest behind a link, so the page does not return to six screens.
  Empty says it is empty (R4.3), and does not imply an agent is reading when
  none is running (R4.2).
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=tools/review/server.mjs,tools/review/ui.mjs_

- [ ] **T34003** Write back a paragraph, not a line
  The one-line box becomes a textarea accepting a paragraph (R2.1), posting to
  the existing `/api/comment` so it reaches the watcher unchanged (R2.2). It can
  name a task id or file so a reply is not orphaned (R2.3).
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/ui.mjs,tools/review/server.mjs_

- [ ] **T34004** A recorded-turn helper the agent actually uses
  A small command or script that records a turn as an agent-authored entry, so
  recording is one call rather than a hand-built curl. Without it the transcript
  will not get written, and R3.1 depends on the agent being the only writer of
  its own entries.
  _Exec: executor=devin-cli kind=mechanical gates=self-check files=tools/review/record-turn.mjs_

- [ ] **T34005** Design the documents surface
  `/files` and `/view` are the least usable surface in the UI. Group documents
  by spec rather than listing paths flat, set a reading measure narrower than
  the window, make headings jumpable, and keep the per-section comment anchors
  working — that is how a spec gets commented on. Server-rendered, no
  dependency, and readable when CSS does not load (R5.3).
  _Exec: executor=claude-code-cli kind=judgment gates=self-check files=tools/review/server.mjs,tools/review/ui.mjs_

- [ ] **T34006** Check that a spec has design and tasks before work is dispatched
  The process rule now in AGENTS.md is prose, and prose is advisory. A check
  that reports a spec folder holding `requirements.md` with no `design.md` or
  no `tasks.md`, and a task with no `_Exec:` line, makes it a gate. This is the
  project's own argument applied to its own process: if a rule can be enforced
  deterministically, enforcing it beats asking.
  _Exec: executor=claude-code-cli kind=judgment gates=tsc,test,self-check files=tools/spec-completeness.mjs,.github/workflows/ci.yml_
