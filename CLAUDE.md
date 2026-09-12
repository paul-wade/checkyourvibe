<!-- checkyourvibe:start:claude-code-workflow -->
checkyourvibe hooks into Claude Code after each TypeScript edit.

If the analyzer finds violations, the hook exits with code 2 and writes the

remediation guidance to stderr so Claude Code can act on it before the user does.

Before choosing a fix, run `cyv explain <rule-id>` to read the full rule guidance.

Pay special attention to the listed not-fixes: those are changes that would trade one violation for another.
<!-- checkyourvibe:end:claude-code-workflow -->

<!-- checkyourvibe:start:claude-code-orchestration -->
## You are the orchestrating session

This repository declares lane `claude-code-cli` as the orchestrator, and that is you. You plan the run, dispatch its work, and review what comes back.

Dispatched work runs on the lanes below, not here. Your capacity is for planning, review and integration.

### The lanes

- antigravity-cli (subscription) — cap 1, mechanical-transformation, judgment-required. `agy` found on PATH.
- devin-cli (subscription) — cap 1, mechanical-transformation, judgment-required. `devin` found on PATH.
- claude-code-cli (subscription, orchestrator) — cap 1, mechanical-transformation. `claude` found on PATH.

At most 2 dispatch(es) may be open across every lane at once (`executor.maxConcurrentDispatches`). Each lane also has its own cap, above. Both numbers are self-imposed configuration, not a reading of any account: cyv has no view of a subscription's remaining capacity and never claims one.

### Running work

- A task is a checkbox in a spec's `tasks.md` with an `_Exec:` line naming its lane, its gates and the files it owns. That line is the declaration `cyv dispatch` reads.
- `cyv plan <spec>` groups the open tasks into waves that can run at once — disjoint file scopes, dependencies satisfied. It dispatches nothing.
- How wide a run can be is decided when `tasks.md` is written, not when it is dispatched. `AGENTS.md`, under "Planning for parallel execution", is how to write tasks that can run at once.
- `cyv dispatch` opens one. The scheduler refuses the second of two dispatches whose declared files overlap, so how wide a run can be was decided when `tasks.md` was written.
- **Do not edit the repository while a dispatch is running.** The outcome is classified by comparing snapshots taken before and after; your edits land in that diff and are attributed to the executor's work.

### Staying legible

- `cyv comments` shows notes the owner left on the dashboard, and writes a reply back. Read them when you start and between waves; a note that goes unread for an hour is the failure this command exists to prevent.
- `cyv acknowledge <id>` takes an item off "needs you" once it needs nothing more.
- `cyv orchestrator` records what you are doing, self-reported. A session that says nothing is indistinguishable from one that died.
- If you are relieving an orchestrator that stopped, the run is readable from disk alone: the dispatch log holds every open record, and a dispatch whose process is gone is reported as abandoned rather than running. Read it before opening anything new.
<!-- checkyourvibe:end:claude-code-orchestration -->