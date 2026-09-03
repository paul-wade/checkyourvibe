# 0045 — The editor nothing supervises: Requirements

**Status:** draft
**Created:** 2026-09-02
**Depends on:** 0011, 0036

## Introduction

`R:\gamedev\catburgler` is an Unreal Engine 5.8 project built on Epic's Lyra
sample, with checkyourvibe installed and the `unreal-gc` analyzer pack
enabled. Its executor configuration declares three dispatch lanes
(`antigravity-cli`, `codex-cli`, `devin-cli`) alongside `claude-code-cli` as
orchestrator. `catburgler/.mcp.json` declares one more MCP server, unrelated
to cyv's own:

```json
{ "mcpServers": { "unreal-mcp": { "type": "http", "url": "http://127.0.0.1:8000/mcp" } } }
```

That endpoint is served by Epic's `ModelContextProtocol` editor plugin —
listed, enabled, in `catburgler.uproject`'s `Plugins` array — from *inside* a
running Unreal Editor process. It exists only while that process exists.

An orchestrating agent session was dispatching a 37-task implementation plan
across cyv's lanes. Ten tasks were pure C++ file edits, dispatched and judged
by `cyv check` the way any TypeScript or C++ dispatch is today. Twelve more
required a running editor — creating `.uasset`/`.umap` assets, Blueprint
children, UMG widgets, level actor tagging — reachable only through the
`unreal-mcp` endpoint above. Three failures in that session share one root
cause: nothing in this project's control surface can start, stop, restart, or
even ask about the state of that editor process.

**Failure 1.** At session start, the `unreal-mcp` endpoint was
`ConnectionRefused`. The editor was not running. The agent recorded the
server as unavailable and planned around it. No lane, no dispatch, no cyv
command could start it.

**Failure 2.** The plan's tasks were dispatched over several hours with the
editor's state unknown throughout. Nothing asserted "the editor is up and
`unreal-mcp` is answering" as a precondition before handing an editor-dependent
task to a lane — there is no such assertion to make, because cyv has no model
of the editor as a thing with a state at all.

**Failure 3, the blocking one.** Two C++ lanes created a new Unreal module,
`HeistCoreRuntime`, inside a new Game Feature Plugin, `HeistCore`. Verified
against the running editor via MCP —
`GameFeaturesToolset.ListDiscoveredGameFeaturePlugins` returned
`["ShooterCore","ShooterExplorer","ShooterMaps","ShooterTests","TopDownArena"]`,
no `HeistCore` — even though `catburgler.uproject`'s `Plugins` array already
lists `HeistCore` as `"Enabled": true`. The `.uproject` file changed; the
running editor's in-memory plugin registry, built by a scan performed at
startup, did not. A brand-new module cannot be hot-added to a running editor:
it needs a compile and a restart before the editor's own discovery pass can
find it. Every one of the twelve asset tasks was therefore blocked behind a
restart no automated lane could perform, and overnight autonomy stopped
there.

`LiveCodingToolset.CompileLiveCoding` — also enabled in
`catburgler.uproject`'s `Plugins` — exists and compiles *from* a running
editor. It is real capability, but it cannot solve this case by construction:
it recompiles code the running editor already knows about. The editor that
would run it has no record of `HeistCoreRuntime` existing.

### What `packages/analyzer-unreal` actually is today

The owner described the desired capability as "the cyv unreal plugin." As of
this session, no such thing exists. `packages/analyzer-unreal` is a static
lexical analyzer and nothing else:

- Its manifest (`packages/analyzer-unreal/analyzer.manifest.json`) declares
  `exec.type: "node"`, `exec.module: "./src/index.mjs"` — the same
  in-process, no-subprocess execution shape every other bundled analyzer
  uses.
- `src/index.mjs`'s default export takes an `AnalyzeRequest` (a list of file
  paths and enabled rules), reads each file with `readFile`, and returns
  violations. It opens no network connection, spawns no process, and holds
  no state between calls.
- Its three rules (`gc-untracked-object-member`,
  `gc-object-pointer-in-unreflected-type`, `uproperty-raw-object-pointer`,
  all in `src/gc-rules.mjs`) are lexical checks over `.h`/`.cpp` text, per
  spec 0033's own design: "a lexer and not a C++ parser." Spec 0033
  explicitly scopes this to `evidence: 'syntax'` findings only.
- Nothing in `packages/analyzer-unreal` knows the `unreal-mcp` protocol,
  reads `.uproject`, resolves an engine install, or has any notion of "the
  editor" as a running thing.

So: **an analyzer package, not a plugin with a runtime or editor surface.**
The capability the owner is asking for does not extend anything that exists
today; it is new.

### What this is not

**Not 0033 (an Unreal Engine module).** 0033 is entirely about static rule
quality — reflection-macro-aware C++ linting. It never touches process
lifecycle, MCP transport, or anything that runs.

**Not 0044 (the hook is not the whole tool).** 0044 fixes what an agent is
*told* it can do — the capability surface written into `CLAUDE.md`/
`AGENTS.md`. This spec is not about telling an agent that dispatch and the
dashboard exist; it is about giving cyv a capability neither 0044 nor
anything before it grants: control over an external, long-lived process a
dispatch depends on.

**Builds on, does not replace, 0011 and 0036.** 0011's dispatch declaration,
scheduling refusal, and gate machinery, and 0036's liveness-evidence model
(host, pid, process start time, written once at open time — never
maintained by a live session) are the closest existing analogues to what this
spec needs, and Requirement 5 and `design.md` argue from them directly rather
than inventing a parallel mechanism.

### Is this already planned?

No. `docs/ROADMAP.md` has no entry mentioning an editor, a long-lived
service, or process lifecycle beyond the executor's own child-process model
(`packages/core/src/executor/child.ts`, built for a dispatch that runs to
completion and is then judged — see `design.md`'s first section for why that
model does not fit this case). `docs/STATUS.md` likewise has no prior mention
of editor control; its only Unreal-adjacent entries are about the
`unreal-gc` rule pack's dogfooding, not runtime control. This is new
territory, not a gap in a plan that already named it.

## Requirement 1 — Starting the editor from declared configuration

**User story:** As the owner of an Unreal project with cyv installed, I want
cyv to be able to launch my project's editor with its MCP server serving,
using a launch description I configured for this project, so that a
dispatch plan is not blocked at hour zero on a process nobody remembered to
start by hand.

1.1. `checkyourvibe.json` SHALL support declaring one or more managed
   long-lived environments — at minimum, for the motivating case, one editor
   environment — each naming the executable to launch, the arguments it is
   launched with, and the working directory it runs from. None of these
   SHALL be a cyv constant: the engine installation path, the `.uproject`
   path, and any launch arguments (`-log`, a specific map, `-stdout` for the
   MCP plugin, or anything else the project's own setup requires) are project
   configuration, the same way a lane's `agentId` and launch shape are
   project configuration in `executor/invocation.ts` today, not something
   cyv hardcodes per vendor.

1.2. cyv SHALL provide a command that starts the declared environment's
   process. Starting it SHALL confirm only that the process was launched
   (the way `runChild`'s `spawnError` already distinguishes "could not
   start" from every later outcome in `packages/core/src/executor/child.ts`)
   — it SHALL NOT itself claim the environment is ready. Readiness is
   Requirement 2's job, kept separate because launch and readiness fail for
   different reasons and a caller needs to know which one happened.

1.3. cyv SHALL NOT invent a default engine path, project path, or launch
   argument set by searching the filesystem or the registry for an Unreal
   install. `.uproject`'s `EngineAssociation` field (`"5.8"` in
   `catburgler.uproject`) names an engine version, not an install path on
   this machine, and resolving a version to a path is exactly the kind of
   machine-specific inference 0011 Requirement 7.1 already refuses for
   subscription quota — the same discipline applies here: a fact cyv cannot
   observe honestly is a fact the user configures.

## Requirement 2 — Readiness means the declared endpoint answers, not that the process exists

**User story:** As someone dispatching editor-dependent work right after a
launch, I want cyv to tell me the editor is actually ready to serve MCP
requests, not merely that a process with that name exists, so that a
dispatch is never handed a dead endpoint while the editor is still doing
asset-registry and shader work in the background.

2.1. An environment declared under Requirement 1 SHALL additionally declare
   how its readiness is probed: at minimum, the MCP endpoint URL a dispatch
   would otherwise be handed cold (`http://127.0.0.1:8000/mcp` in
   `catburgler/.mcp.json`, project-configured like everything else in
   Requirement 1).

2.2. cyv SHALL determine readiness by querying that endpoint — issuing a
   request the MCP protocol itself defines as a liveness check (at minimum,
   that the endpoint accepts a connection and returns a well-formed MCP
   response) — and SHALL NOT infer readiness from the process existing, from
   a fixed sleep, or from parsing the editor's log output for a string this
   project does not control the wording of.

2.3. The readiness probe SHALL be bounded by a configurable timeout and
   SHALL poll rather than check once: Unreal Editor startup routinely takes
   minutes for asset-registry scanning and shader compilation on a project
   this size, and a single early check would report "not ready" against a
   process that becomes ready seconds later.

2.4. WHEN the timeout in 2.3 elapses without a ready response THEN cyv SHALL
   report failure loudly — naming the environment, the endpoint queried, the
   timeout used, and however much of the process's own output was captured
   — and SHALL NOT report success, a partial state, or silence. This mirrors
   0011 Requirement 12.1's rule for a gate that examined nothing: a probe
   that never got an answer did not pass.

2.5. Readiness SHALL be queryable on its own, independent of the launch
   command in Requirement 1.2. An orchestrating session that started the
   editor and moved on to other work SHALL be able to ask "is it ready yet"
   without re-launching or blocking its own turn on a multi-minute wait it
   did not choose to make.

## Requirement 3 — Stopping the editor prefers graceful over killed

**User story:** As the owner of a project with in-progress edits inside the
editor, I want a shutdown cyv initiates to give the editor a chance to save
and close cleanly, so that a routine restart does not become a corrupted
asset, a poisoned DDC entry, or a lost autosave.

3.1. cyv SHALL provide a command that stops a declared environment's editor
   process, and that command SHALL attempt a graceful path before any
   forceful one. An Unreal Editor killed mid-write can corrupt an
   in-progress asset save, the local Derived Data Cache, and autosave state
   — this is a real cost, not a theoretical one, and 3.2 states plainly what
   this spec does and does not know about how to avoid it.

3.2. The graceful path SHALL be whatever request-based close the
   environment's own control surface exposes — for the Unreal case, an
   MCP-issued close/quit request, if the `ModelContextProtocol` plugin's own
   toolset exposes one. This spec does not assert that it does: the tools
   observed and named in this project's own recon are
   `GameFeaturesToolset.ListDiscoveredGameFeaturePlugins` and
   `LiveCodingToolset.CompileLiveCoding`, and no shutdown-shaped tool was
   found or verified. Whether a graceful MCP path exists at all is recorded
   as Open Question 1, and Requirement 3.4 states what happens if it does
   not.

3.3. WHEN the graceful path (or its absence, per 3.2) leaves the process
   still running after a bounded wait THEN cyv SHALL escalate to terminating
   the process directly, and SHALL report that the escalation happened and
   why. The escalation SHALL name what is lost at each step it passes
   through: a request-based close risks nothing beyond however long the
   editor takes to act on it; a forced termination risks exactly the
   corruption 3.1 names, and cyv SHALL say so in the command's own output,
   not only in this document.

3.4. WHERE no graceful path is available for an environment (3.2's open
   case resolving negatively), cyv SHALL say so plainly rather than silently
   falling back to termination as though it were the graceful path. A
   forced stop that is the only option available SHALL still be labelled
   forced.

## Requirement 4 — Restart as a first-class operation

**User story:** As the operator of the motivating incident's plan, I want a
single operation that takes the editor from "running with stale module
knowledge" to "running with current module knowledge," so that a new C++
module's discovery does not require me to remember and manually sequence a
stop and a start.

4.1. cyv SHALL provide a restart command for a declared environment,
   composed of Requirement 3's stop followed by Requirement 1's start
   followed by Requirement 2's readiness probe — not a separate code path
   that reimplements any of the three, because a restart's correctness
   depends on stop actually having stopped and readiness actually having
   confirmed serving, not on assuming either.

4.2. Restart SHALL fail loudly, naming which of the three steps failed, if
   any step does. A restart that stopped the editor but never confirmed it
   came back SHALL NOT be reported as a completed restart.

4.3. Restart exists specifically for the motivating case: a compiled binary
   for a new module now exists on disk, and only a fresh editor process's
   own startup discovery pass will find it. Requirement 7 states exactly
   where cyv's responsibility for getting that binary onto disk in the first
   place starts and stops.

## Requirement 5 — A dispatch declares it needs a ready editor

**User story:** As the orchestrator dispatching a mixed plan of C++ edits and
MCP-driven asset tasks, I want the twelve editor-dependent tasks to say so
before they are dispatched, so that a lane is never handed one of them while
the editor is down, cold, or restarting.

Whether this belongs as a new gate, a scheduling precondition, a lane
property, or a separate lifecycle command is not a stylistic choice — it
follows from how each of those already works in
`packages/core/src/executor/`:

- **Not a gate.** `gates.ts`'s two forms (`cyv-check`, `run:<program>`) both
  judge the *result* of a dispatch that already ran, against the paths it
  changed. An editor that is down produces no changed files either way, so
  a gate would let the dispatch actually run — spending a lane's attempt,
  its concurrency slot, and (per 9.1) its weakest-model request — only to
  fail afterward on a precondition that was knowable before anything was
  spawned. 0011 Requirement 12's own lesson (a gate that examined nothing
  did not pass) is about a gate given nothing to check; this is the sharper
  case of a gate that should never have run at all.
- **Not a lane property.** The editor is not a lane's capability the way a
  lane's `models` ordering or `concurrencyCap` is (`executor/lane.ts`). Every
  lane in the motivating incident — `antigravity-cli`, `codex-cli`,
  `devin-cli` — could equally be asked to drive an editor-dependent task
  through MCP; readiness is a property of the shared environment, not of
  which lane is asked. Attaching it to a lane would mean declaring the same
  fact three times and letting it drift, the exact failure shape 0044's
  design already named once for six adapters restating one fact.
- **A dispatch-level declaration, checked as a new scheduling precondition.**
  `DispatchDeclaration` (`executor/dispatch.ts`) already declares
  `taskKind` and `expectsFileChanges` up front, before a lane is chosen.
  `SchedulingRefusal`'s two existing variants —
  `overlapping-ownership` and `no-eligible-lane` — are both precondition
  checks performed at schedule time, before any executor is invoked; the
  ownership-overlap check in particular is not about any one lane's
  eligibility at all, the same shape this requirement needs. This spec
  therefore adds environment-readiness the same way: declared per dispatch,
  checked once at schedule time, and — because an unready environment
  disqualifies every candidate lane identically, not one lane specifically
  — reported as its own `SchedulingRefusal` reason rather than folded into
  `LaneIneligibility`, which exists for reasons that vary lane by lane.

5.1. `DispatchDeclaration` SHALL support declaring that a unit of work
   requires a named environment (Requirement 1) to be ready (Requirement 2)
   before it may be scheduled to any lane.

5.2. WHEN a dispatch declares a required environment THEN scheduling SHALL
   check that environment's readiness before assigning any lane, and SHALL
   refuse the dispatch — recorded the way an `overlapping-ownership` or
   `no-eligible-lane` refusal already is (`executor/store.ts`'s
   `refuseDispatch`) — naming the environment and its last-known state, WHEN
   it is not ready. This SHALL happen without invoking any executor: an
   editor-dependent dispatch against a cold editor SHALL cost no lane
   attempt, no concurrency slot, and no model request.

5.3. This check SHALL read the environment's last-recorded state from disk
   (Requirement 6's record), not re-probe the endpoint on every scheduling
   decision — the same discipline 0011 Requirement 10.1 already applies to
   the dashboard reading dispatch state without re-running or re-querying an
   executor. WHERE that recorded state is stale enough to be untrustworthy
   is Open Question 2.

## Requirement 6 — Never two editors on one project

**User story:** As the owner of a project where two lanes might both decide
the editor needs restarting, I want cyv to prevent a second editor process
from starting against the same project while one is already running, so
that I never lose work to two processes fighting over the same files and
Derived Data Cache.

6.1. Starting an environment (Requirement 1) SHALL first check whether that
   environment already has a recorded, live process, and SHALL refuse to
   start a second one when it does.

6.2. cyv SHALL record enough about a started environment's process — at
   minimum the host, process id, and process start time, the identical
   triple `executor/liveness.ts` already writes for a dispatch
   (`DispatchLiveness`) and for exactly the same reason: a heartbeat
   maintained by a live session fails precisely when that session fails,
   so the record is written once at start time and never depends on the
   environment continuing to check in.

6.3. WHERE that record's process can no longer be confirmed running (the
   process is gone, or its identity cannot be verified on this host), a
   second start SHALL be permitted — an editor that crashed or was killed
   outside cyv's own stop/restart commands is not a reason to refuse
   forever — but cyv SHALL report that the previous record looked stale
   rather than silently discarding it, the same three-way live /
   abandoned / undetermined judgement `executor/liveness.ts` already makes
   for dispatches (0036 Requirement 5.2), because the evidence available
   here is the same evidence and supports no finer a distinction.

6.4. Two declared environments pointed at the same `.uproject` path SHALL be
   treated as the same project for 6.1's purposes even if they are declared
   under different environment ids — the risk 6.1 exists to prevent is
   about the project's files and DDC, not about which configuration entry
   asked.

## Requirement 7 — The boundary: compiling a new module is not this spec's job

**User story:** As someone reading this spec to decide what it actually
fixes, I want to know exactly where cyv's new responsibility ends, so that
"restart the editor" is never mistaken for "make the new code exist to be
discovered."

7.1. Compiling a new or changed Unreal module — invoking UnrealBuildTool,
   producing the `.dll`/`.pdb` (or platform equivalent) a restarted editor's
   discovery pass would find — is a build step and SHALL NOT be considered
   part of this spec's scope. Requirement 4's restart operation launches an
   already-built editor process; it does not build anything.

7.2. WHERE a dispatch's own gates already invoke a build (a `run:<program>`
   gate naming a build script, per `executor/gates.ts`), that remains the
   existing mechanism for getting a module compiled, unrelated to this
   spec. This spec's contribution is what happens after a build already
   produced new binaries: getting a fresh editor process to see them.

7.3. cyv SHALL NOT claim, anywhere this feature is described to a user, that
   starting or restarting the editor also builds the project. The two are
   sequenced by whoever plans the dispatch (build, then restart), not
   fused into one operation this spec provides.

7.4. Whether the Unreal Editor's own startup sequence detects and compiles
   stale or missing module binaries automatically, or requires them to
   already exist on disk before launch, is engine behavior this spec does
   not assert either way — it was not verified in this project's recon, and
   is recorded as Open Question 3 rather than guessed at.

## Non-goals

Discovering or resolving an engine installation automatically (Requirement
1.3). Building or compiling anything, at any point (Requirement 7). A
general process-supervision daemon that outlives the cyv command that
invoked it — every command in this spec (start, stop, restart, is-ready) is
a foreground operation an orchestrating session runs and reads the result
of, not a background service cyv itself keeps alive between invocations.
Automatically deciding *when* to restart — Requirement 4 provides the
operation; nothing in this spec triggers it on cyv's own initiative (see
Open Question 4). Coordinating two *different* projects' editors, or two
environments that are not the editor (a build farm, a headless cook) — the
motivating case is one editor per project, and generalizing further than
that is `design.md`'s "general mechanism" question, not a requirement here.
Reading or interpreting `.uproject`'s `Plugins` array to infer what changed
— Requirement 1 and Requirement 6 both work from configuration and process
identity, never from parsing engine project files.

## Open questions

1. ~~**Does the `ModelContextProtocol` plugin's toolset expose a shutdown or
   quit-editor tool at all?**~~ **ANSWERED, 2026-09-02: it does not.**
   `EditorToolset.EditorAppToolset` was enumerated in full against a live
   editor. It exposes `StartPIE`, `StopPIE` and `IsPIERunning` — *play
   session* control — plus viewport, selection, content-browser and capture
   tools. There is no quit, exit, close, or shutdown tool anywhere in it, and
   none in the other 57 toolsets the server advertises.

   So Requirement 3's "graceful path" has no first step available over MCP.
   Requirement 3 must be read as: cyv's only shutdown lever is OS-level
   process termination, and Requirement 3.4's honesty clause is therefore the
   spec's real behavior, not a fallback case. A genuinely graceful close needs
   something that does not exist yet — most plausibly a small editor-side tool
   contributed to the plugin, which is new engineering this spec should name
   rather than assume.

   Confirmed in the same session that this is load-bearing, not academic:
   with the editor running, `Build.bat` refuses outright —
   `Unable to build while Live Coding is active. Exit the editor and game` —
   and `LiveCodingToolset.CompileLiveCoding` returns `CompileNotStarted`
   because newly added `.cpp` files need UBT to regenerate the module's file
   list. The editor must actually close for a new-file build, and nothing cyv
   can reach today can close it.

2. **How stale is too stale for Requirement 5.3's cached readiness state?**
   The dashboard precedent (0011 R10.1) is for state that changes only when
   cyv itself writes it (a dispatch record). An editor's readiness can
   change for reasons entirely outside cyv's view — a person closes it by
   hand, it crashes. Whether scheduling should re-probe past some age, or
   trust the record indefinitely until the next explicit start/stop/restart
   command touches it, is left to design.

3. **Does a fresh Unreal Editor launch compile stale or missing module
   binaries on its own, or does it require them to already exist?**
   Requirement 7.4 states this is unverified. If the editor's own launch
   does trigger a compile, Requirement 4's restart may take substantially
   longer than Requirement 2's readiness timeout currently anticipates, and
   that timeout's default needs to account for it.

4. **Should anything in this project ever trigger a restart on its own
   initiative** — for example, cyv noticing a dispatch created a new module
   and proposing (not performing) a restart? This spec deliberately scopes
   Requirement 4 as an operation a person or an orchestrating session
   invokes, never something cyv decides to do, consistent with 0036
   Requirement 6.5's refusal to hand off orchestration automatically. Left
   open because the motivating incident's overnight-autonomy goal is
   exactly the case where a human is not there to invoke it.

5. **Where does an environment declaration live in `checkyourvibe.json`** —
   nested under `executor` beside `lanes`, the way `ExecutorConfig` already
   groups lane-shaped configuration
   (`packages/core/src/config/types.ts`), or as its own top-level key? Left
   to design; this spec requires that the declaration exist and that
   `configuredLanes`'s validation pattern (`config/lanes.ts`'s
   `laneConfigProblem` — one JSON Schema per item plus a function for
   cross-item invariants JSON Schema cannot express) is the seam a new
   environment block validates through, not its exact location.

6. **Does registering an environment need its own consent step**, the way
   0011 Requirement 5 draws an explicit line around granting an executor
   write access to the repository? Starting an external editor process is a
   different kind of grant — not repository write access, but the ability
   to launch and kill an arbitrary configured executable — and whether it
   needs a distinct consent prompt the way an executor lane does is not
   decided here.
