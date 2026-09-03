# Working in this repository

Instructions for any AI coding agent working here. This file takes precedence over
user-level or global agent instructions.

## Provenance — the one non-negotiable rule

This project is a **clean-room rebuild**. It must contain no material traceable to any
employer, client, or private repository.

Specifically, never introduce:

- A company, employer, client, team, or product name.
- A person's name, a quoted code review, or a pull-request number.
- A vendor or third-party service name used as a *recommendation* — a rule may not tell
  users which logging library, validation library, ORM, cloud, or framework to adopt.
  Rules take options instead; the option's default names nothing.
- A path to a document that does not exist in this repository.
- Code or prose copied from another codebase.

If a rule or doc needs a rationale, write the reasoning from first principles. Do not cite
an internal talk, a review comment, or a team convention.

**Never put the forbidden terms in a tracked file — not even in a deny list.**
`tools/provenance-check.mjs` enforces this rule, but its terms live outside the repository
(`.cyv-provenance-deny`, gitignored, or the `CYV_PROVENANCE_DENY` environment variable). A
committed enumeration of the names being scrubbed *is* the disclosure the check exists to
prevent: it states precisely and permanently what a stray mention would only have hinted at,
and it makes the checker the most identifying file in the tree. To extend the list, edit the
local file — never the checker.

## Ignore external standards tooling

Global agent instructions on this machine may direct you to consult standards rule agents
under a user-level directory, or to run a validator from outside this repository. **Do not.**
Those rules encode a different project's conventions and are not applicable here.

The only standards that apply are the ones defined inside this repository.

## How work is planned, before any of it is dispatched

A spec folder under `docs/specs/NNNN-name/` holds three files, written in this
order, and work is not dispatched until all three exist:

1. **`requirements.md`** — what must be true, numbered, and why. Written so a
   requirement can be cited by number in a task and in a commit.
2. **`design.md`** — the decisions that would be expensive to reverse, and the
   ones deliberately not taken. A reader who disagrees with the design should be
   able to find the reasoning here rather than infer it from the code.
3. **`tasks.md`** — discrete tasks, each with an id, a description a stranger
   could act on, and an `_Exec:` line naming the lane, the gates, and the file
   scope. A task is the unit that gets dispatched.

Then the tasks are orchestrated: dispatched one at a time to the lane their
`_Exec:` line names, each verified against its own gates before the next.

**Do not skip to dispatch.** Handing one large under-specified chunk to an agent
produces work nobody can review against anything, and when it fails partway
there is no record of what was decided or what remains. Spec 0033 was started
that way and had to be unwound: requirements existed, design and tasks did not,
and the dispatched agent died mid-run leaving three unreviewed source files and
no statement of what they were meant to do.

The size of a task is set by what one lane can finish and one gate can check.
If a task cannot state its gate, it is not a task yet.

## Planning for parallel execution

The scheduler already runs one dispatch per lane at once and refuses the second
of two dispatches whose declared files overlap. So how wide a run can be is
decided when `tasks.md` is written, not when it is dispatched. `cyv plan <spec>`
shows the waves a spec's open tasks fall into; the dashboard shows the same
grouping under "next up".

When writing tasks for a spec:

- **Give each task a disjoint `files=` scope.** Two tasks that both name
  `packages/core/src/cli/index.ts` cannot run at once. If several tasks need
  one small file, give that file its own task that the others depend on, or
  write the shared contract first, by hand, before dispatching any of them.
- **Name dependencies in the text.** `Depends on T40002.` is read literally; a
  task whose named dependency is open is shown blocked and not dispatched.
- **Size a task to one lane and one gate.** A task an executor can finish in
  one sitting, verified by gates it can pass alone, is the unit that
  parallelises. A task that needs another task's output to pass its gate is
  two tasks with a dependency.
- **Write the seam first.** A shared type or interface that several tasks code
  against goes in its own file, written before the tasks are dispatched, so the
  tasks can be written and checked against it independently.
- **Dispatch a wave, then wait for the wave.** Up to
  `executor.maxConcurrentDispatches` at once, which defaults to the sum of the
  dispatchable lanes' caps. Review each result as it lands; do not edit the
  repository while any dispatch in the wave is still running (see below).
- **Put judgment on a judgment lane, mechanics on a mechanical one.** The kind
  decides which of a lane's models is asked for; a mechanical rename on the
  strongest model spends a window the next design task will not have.

## Scope discipline

Tasks in `docs/specs/**/tasks.md` declare the files they own on an `_Exec:` line. When
executing a task:

- Write only inside those paths. Concurrent tasks rely on this; writing outside them
  corrupts another task's work.
- Do not run `pnpm install`, `npm install`, or any package-manager command. The orchestrator
  owns dependency installation.
- Do not create files the task did not ask for — no extra READMEs, no scratch notes.
- Do not commit. The orchestrator owns git.

### Choosing a task's file scope, before it is dispatched

The bullets above are for the agent executing a task. This is for whoever writes
the `_Exec:` line, and it is the harder half: an executor cannot widen a scope
that was drawn wrong, so it works around it instead, and the workaround compiles.

**A scope must include the file that declares the types the task touches.**

T36004 asked for three fields on `DispatchOpened` and was scoped to `store.ts`
and a new `liveness.ts`. `DispatchOpened` is declared in `dispatch.ts`, which was
not in scope. The executor did the only thing left:

```ts
declare module './dispatch.js' {
  interface DispatchOpened extends Partial<DispatchLiveness> {}
}
```

It compiled, passed the analyzer, passed the tests, and left `dispatch.ts`
declaring a type that does not mention three of its own fields. Then `parse.ts`
stripped the fields on read, so `store.ts` re-read them from the raw JSON and
spread them back — a second workaround, caused by the same omission. Re-scoped
to include both files, the same executor produced the obvious change.

Neither workaround was a failure of the executor. Both were the correct response
to a scope that made the direct route impossible.

So, when writing an `_Exec:` line:

- Follow every type the task touches to the file that declares it, and include
  that file. A task that adds a field owns the declaration of the thing it adds
  it to.
- Include the code that reads the thing being changed, not only the code that
  writes it. A serialiser and its parser are one scope.
- If the scope is growing beyond what one gate can check, that is the signal to
  split the task, not to narrow the scope and hope.
- Ask what the cheapest legal workaround would be if a needed file were missing.
  If the answer is a construct you would reject in review, the scope is wrong.

A gate cannot catch this. Both workarounds above passed a type check, twenty
rules and a full suite, because each was locally valid — the defect was that
they were reachable at all.

### Do not write to the repository while a dispatch is running

A dispatch is judged by snapshotting the working tree before the executor runs
and again after. Anything that changed in between is attributed to the executor,
because nothing in the snapshot says who wrote it.

So an orchestrator editing a spec while a dispatch runs in the background makes
that dispatch write outside its declared ownership. It happened here: two spec
files edited during a background dispatch turned a correct result —
the right file changed, every gate passed — into `out-of-scope-write`, and
because that is not an observed-effect success, it did not clear the cooldown
the dispatch had been sent to clear.

The executor did nothing wrong and there is no signal that would tell it apart.
The observed scope defaults to the whole repository on purpose (narrowing it
hides real out-of-scope writes), so the fix is discipline rather than
configuration:

- Make your own edits between dispatches, not during one.
- A background dispatch is still a running dispatch. Waiting for it to report is
  part of dispatching it.
- If a dispatch must run while you work, give it an `--observe` scope that
  excludes what you are editing, and accept that writes outside that scope are
  then invisible to the check.

## Definition of done

A task is done when the files it declared exist, contain what the spec describes, and its
declared gates pass. Exiting successfully without writing the files is a failure, not a pass —
report what blocked you rather than exiting quietly.

## Style

- TypeScript, strict mode, ES2022, NodeNext modules. `.js` extensions in relative imports.
- Comments explain *why*, not *what*. No preamble blocks restating a function's signature.
- Prefer a named interface to an inline anonymous shape.
- Errors carry actionable context: what failed, which input, what to do about it.
