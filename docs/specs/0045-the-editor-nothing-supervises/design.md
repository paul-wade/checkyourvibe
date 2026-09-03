# 0045 — Design

## Why editor lifecycle belongs to cyv's executor, not each agent lane

The alternative is real and cheap to imagine: teach each lane's agent CLI —
antigravity, codex, devin, claude-code — to start the editor itself when it
finds `unreal-mcp` unreachable. Nothing stops an agent session from shelling
out to `UnrealEditor.exe` today; the motivating incident's own agent could
have tried it.

That alternative breaks Requirement 6 by construction. "Never two editors on
one project" requires one thing in the system to know, authoritatively,
whether an editor is already running before a second start happens. If four
lanes can each independently decide "the endpoint is down, I'll start one,"
the check that prevents a collision would have to be re-implemented
identically in four agent CLIs cyv does not control the internals of — the
same failure shape 0044's design already named for six adapters each writing
their own capability paragraph, except worse here, because the cost of
getting it wrong is not stale prose but two Unreal Editor processes holding
the same Derived Data Cache and the same `.uasset` files open for write at
once. A single point of control is not an architectural preference here; it
is the only way Requirement 6 can be true.

It also matches where the analogous decision already lives. 0011 already
puts scheduling — which lane runs what, when, and whether a precondition
blocks it — inside cyv's core rather than inside any one lane's CLI
(`executor/schedule.ts`, `executor/work.ts`). An agent lane is judged by cyv;
it does not judge itself. Environment lifecycle is one more thing a dispatch
depends on being true before it runs, and Requirement 5 places its check in
exactly the same scheduling layer, for the same reason 4.3-shaped ownership
conflicts are checked there rather than trusted to whichever executor
happens to run first.

**Not taken: a lock file convention each lane's CLI is asked to honor.**
This has the same failure mode as the rejected alternative above, one layer
down — it depends on every lane's own process respecting a convention cyv
cannot enforce, rather than cyv itself being the only thing that starts a
process.

## Why readiness is probed at the MCP endpoint, not the process or the log

Three signals were available to build Requirement 2 on: whether a process
with the right name exists, whether the editor's log contains a string that
looks like "ready," or whether the declared MCP endpoint answers. The
motivating incident already argues against the first two directly.

**Process existence proved nothing in Failure 1.** The whole incident began
with `unreal-mcp` reporting `ConnectionRefused` — and the natural first
question anyone would ask, "is the editor even running," is exactly what a
process check answers, and exactly what would have been insufficient here
even if it had said yes: Unreal Editor startup runs for minutes doing
asset-registry scans and shader compilation before anything is actually
served. A process check would report ready the instant the executable
appears, and hand a dispatch a connection that refuses for several more
minutes. Requirement 2.3's polling-with-timeout design exists specifically
because "the process exists" and "the process is ready" are minutes apart
for a project this size, not the same instant.

**Log-string matching was rejected on the same grounds 0011 R2.6 already
uses.** 0011 refuses to trust an executor's own stdout/stderr as a
self-report of what it did, because that is exactly the self-report a vendor
could phrase however it likes and change without notice. A "ready" string in
an Unreal log is the identical shape of evidence — vendor-authored text this
project does not control the wording of — and Requirement 3.2 already
concedes this project has not even verified what MCP-relevant tools the
editor's own plugin exposes, let alone what it logs. Building a readiness
signal on log-scraping would be evidence this spec cannot stand behind.

**The endpoint answering is the one signal that means what Requirement 2
needs it to mean.** A dispatch that needs the editor needs `unreal-mcp` to
serve a request, not for a process to exist or a log line to have appeared.
Probing the actual endpoint — the same one a dispatch would otherwise be
handed cold — is the only one of the three signals that is evidence of the
exact fact being asserted, rather than a proxy for it. This is the same
discipline 0011 Requirement 2.2 already applies one layer up: success is
determined by the observed effect a dispatch cares about, not by a report
about it.

## Whether this is a general "managed long-lived service" capability, or Unreal-specific

Argued for general, with the Unreal case as the only concrete instance,
for one specific reason: **the readiness check Requirement 2 needs is not
Unreal knowledge.** Confirming that an HTTP endpoint speaks MCP — accepts a
connection, returns a well-formed response to a protocol-level request — is
generic MCP client behavior, the same shape of check regardless of what is
on the other end. Nothing in Requirement 1 through 6 as written needs to
know that the process is `UnrealEditor.exe`, that `.uproject` exists, or
that `GameFeaturesToolset` is a real tool name. Every Unreal-specific fact
this spec touches — the executable path, the project path, the launch
arguments, the endpoint URL — is *configuration data* Requirement 1.3
already refuses to let cyv infer, not *code* cyv would have to write with
Unreal in mind. That is the same shape 0011 already uses for a lane's model
ordering (`executor/lane.ts`'s `LaneModelOffering.ordering` — opaque to the
core, owned by the declaration) and for a gate's command
(`executor/gates.ts`'s `run:<program>` — the core runs an exit code, never
interpreting what the program does). A general "declare a long-lived
process, launch it, probe a readiness endpoint, prefer graceful shutdown,
prevent a second start" capability, implemented once in
`packages/core/src/executor/` beside `lane.ts`, `dispatch.ts`, and
`gates.ts`, covers the Unreal case with zero Unreal-aware code — only
Unreal-aware *configuration*, supplied by whoever writes
`checkyourvibe.json` for an Unreal project.

**Where Unreal-specific code lives, under this decision: nowhere new.**
`packages/analyzer-unreal` stays exactly what it is today — a static lexical
analyzer with no runtime surface (see requirements.md's recon) — and this
spec does not add anything to it or create a sibling package for it,
because nothing in Requirements 1 through 6 needs Unreal-specific logic to
be written at all. If a later spec needs an Unreal-aware readiness check
beyond "does this endpoint speak MCP" — verifying a specific tool is
callable, say — that would be the first genuine argument for Unreal-specific
code, and it would belong beside `analyzer-unreal` or in a new package at
that point, not folded into the analyzer package's existing manifest
contract (`exec.type: 'node'`, called with an `AnalyzeRequest` — a shape
built for one-shot file analysis, not for holding a live process handle).

**The risk this choice accepts.** A general mechanism, built from one
concrete case, can end up under-specified for cases it was never tested
against — a build farm agent, a headless cook process, a second game
engine's own MCP plugin with different quirks. This spec accepts that risk
deliberately rather than naming the config shape `unreal.editor` and
generalizing later: the alternative (name it for Unreal now, generalize when
a second case exists) would mean an early adopter's configuration breaks
when that generalization happens, and 0011's own lane declarations already
set the precedent of a config shape general enough to add a fifth agent
without reshaping the first four.

**Not taken: name the feature and its configuration after Unreal.** Rejected
for the reason above — it optimizes for the one case known today at the
cost of a breaking change for the next one, and the generic version costs
nothing extra to build since no Unreal-specific code was needed either way.

## Why the escalation shape survives having no graceful path

The complexity is real: Requirement 3 needs a request-based close attempt,
a bounded wait, an escalation to a forced kill, and honest reporting of
which path was actually taken — where `child.kill()`
(`packages/core/src/executor/child.ts`) already does the forced case alone,
in one line, today. The case for the extra machinery is what forced
termination actually costs against this specific kind of process.

Every other process cyv currently kills is a gate or an executor CLI
mid-dispatch — `executor/child.ts`'s `timedOut` path, and the dashboard's
"stop a running dispatch" control (`docs/STATUS.md`'s dogfooding entry:
"the supervising pid is killed by the liveness judgement's evidence"). Both
are processes whose interrupted state is, at worst, an incomplete edit a git
diff already shows plainly. An Unreal Editor holds substantially more
interrupted state than that at any moment it is running: an in-progress
asset save (`.uasset` files use a serialization format that assumes a clean
write), the local Derived Data Cache (shared, rebuildable, but expensive to
rebuild and not append-only-safe against a torn write), and autosave state.
None of that is visible in a git diff the way an interrupted text edit is —
a corrupted `.uasset` is a binary file that may not show as corrupted until
someone opens it. Requirement 3.1 states this cost as the reason the
escalation exists at all, rather than treating "kill it, it's just a
process" as good enough because that is what `child.ts` already does for
every other case.

The complexity is bounded, not open-ended: three states (graceful request,
bounded wait, forced kill), each already namable in the vocabulary
`executor/child.ts` and the dashboard stop control (`docs/STATUS.md`) use
for a different process today. This spec is not inventing a new escalation
model; it is applying the one degree of caution this specific process
category has earned, on top of a shape (request, wait, escalate) this
project has already built once.

**Amended 2026-09-02, after Open Question 1 was answered.** The first of
those three states has no implementation route. The editor's MCP surface
exposes no shutdown-shaped tool in any of its 58 toolsets, so there is no
request to send and nothing to wait on. What is buildable today is the
second half alone: terminate the process, and label the stop *forced* —
Requirement 3.4's clause, which was written as the negative case and is now
the only case.

This does not retire the section above; it relocates it. The cost argument
is unchanged and is why the label matters — a user told plainly that cyv can
only kill the editor can save and close it themselves first, which is the
whole value now available. The escalation machinery of 3.3 (bounded wait,
report which path was taken) is not built, because there is no path to
choose between; it becomes dead scaffolding if written now.

The graceful first state therefore needs engineering that does not exist:
an editor-side tool contributed to the `ModelContextProtocol` plugin that
accepts a close request. That is a separate piece of work with its own
risks, named here so it is not mistaken for something this spec's tasks can
deliver. Until it exists, `tasks.md` implements Requirements 3.1, 3.3's
reporting clause and 3.4, and implements no graceful request.

## What happens to an in-flight dispatch when the editor dies unexpectedly

Nothing in this spec makes that dispatch's own outcome any different from
what 0011 already computes for it. A dispatch whose task required the
editor (Requirement 5) and whose editor died mid-run produces no observed
effect on its declared paths — 0011 Requirement 2.2's observed-effect check
already classifies that as failure or `produced-nothing`, exactly as it
would for any other executor that stopped partway through for any other
reason. This spec adds nothing to that judgment.

What this spec *does* add is Requirement 6's environment record going stale
— the recorded process no longer being confirmable as running — which
0036's own liveness vocabulary already has a name for: not live, not
confirmed abandoned by direct evidence, but a judgment 0036 Requirement 5.2
requires be stated as what it is rather than guessed. Requirement 6.3 reuses
exactly that three-way shape for the environment record, deliberately,
rather than inventing a second vocabulary for "this long-lived thing might
be dead" beside 0036's existing one for dispatches.

The one thing this spec does not resolve: whether a *second, already
in-flight* dispatch that also required the same environment should be
proactively refused or stopped the moment the environment is discovered
dead, versus being left to fail on its own observed-effect check when it
eventually completes or times out. 0011 Requirement 11 already establishes
that closing an abandoned dispatch is a deliberate act, never an
elapsed-time rule ("there is no elapsed-time rule that reaps one" —
`executor/stall.ts`'s Decision 4 reasoning). This spec follows that
precedent by not adding automatic cancellation here either, but the
specific interaction — one dead environment potentially invalidating
several concurrently in-flight dispatches at once — was not worked through
in enough detail to state as a requirement, and is left open below.

## Open

- ~~Requirement 3.2's open question — whether `ModelContextProtocol`'s
  toolset exposes any shutdown-shaped tool at all.~~ **Answered 2026-09-02:
  it does not.** `EditorToolset.EditorAppToolset` was enumerated against a
  live editor; it exposes play-session, viewport, selection, content-browser
  and capture tools and no quit, exit, close or shutdown tool, and neither do
  the other 57 toolsets. The graceful path has no first step, and the
  amendment above states what is built in its place. See Open Question 1 in
  `requirements.md` for the full enumeration and for the Live Coding evidence
  that the editor must genuinely close for a new-file build.
- Whether an environment declaration is validated through the same
  `laneConfigProblem`-shaped function (`config/lanes.ts`) extended to cover
  environments, or a sibling function following the identical pattern
  (one JSON Schema per item, one function for cross-item and
  cross-reference invariants JSON Schema cannot express — Requirement 6.4's
  same-`.uproject`-path check is exactly such an invariant), is left to the
  implementing task.
- Whether the launch command (Requirement 1.2) blocks its caller until the
  process has started, or spawns detached and returns immediately, is not
  decided here. `executor/child.ts`'s `runChild` is built around a child
  that runs to completion and is awaited; a long-lived environment process
  is the opposite shape by construction, and the implementing task needs a
  genuinely different spawn path (`detached: true`, no completion to await)
  rather than a variation on `runChild` — but whether the CLI command
  wrapping that spawn call returns the moment the process exists, or blocks
  through Requirement 2's readiness probe as a convenience, is a UX choice
  this spec leaves open given Requirement 2.5 already requires readiness be
  separately queryable either way.
- The multi-dispatch interaction named at the end of the previous section:
  what, if anything, happens to other dispatches already in flight against
  an environment that is discovered to have died.
