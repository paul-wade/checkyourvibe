# 0014 — Editor diagnostics via LSP: Requirements

**Status:** active
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

A hook reports after an edit finishes. A language server reports while the edit is still happening.
Every analyzer already speaks one request/response contract regardless of how the core reaches it —
that is the entire point of the `node`/`process` split on `AnalyzerManifest.exec`. The claim worth
testing here is whether that contract is *enough*: whether standing a language server in front of it is
mostly a transport question, or whether "during an edit" needs something the contract does not have.

It might not hold, and this spec is written expecting to find out where. The request schema is sealed
to absolute paths on disk, with no room for content that has never been saved. The fastest analyzer
available today still starts cold on every request. Both of those are honest limits, not oversights,
and the requirements below say plainly what each one costs rather than assuming a transport can paper
over them for free.

## What already constrains this

Established from the protocol and the reference implementations, before writing anything below:

- **Every request starts cold.** Even the in-process TypeScript analyzer — the fastest path there is —
  builds a fresh compiler project on every `AnalyzeRequest`, whether the request came from a terminal
  invocation, a pre-commit hook, or `cyv watch`. The reuse `cyv watch` already gets from Node's module
  cache saves the cost of re-importing the analyzer's own code; it does not save the cost of
  re-resolving a project. A language server sending one request per debounced keystroke inherits the
  cold cost by default, not by mistake.
- **The request is disk-only, and its schema is sealed.** `AnalyzeRequest` carries `files` — absolute
  paths — and nothing else, and its JSON Schema forbids additional properties. No analyzer, in this
  repository or outside it, has ever been asked to accept content that has not been written to disk.
- **Subprocess analyzers are already excluded from the nearest always-on consumer.** `cyv watch`
  already restricts itself to in-process analyzers and reports, on every run, which analyzers it did
  not run and why. This spec's answer to "which analyzers can participate" is not new — it is that
  same answer, carried into a second always-on consumer, with doctor visibility added.
- **Configuration already has real teeth.** Per-path overrides require a written reason; suppressions
  require a reason and an expiry and reappear the moment they lapse. Editor diagnostics that resolved
  rules any other way would disagree with everything else already enforcing them.

## Requirement 1 — Diagnostics carry their own guidance

**User story:** As a developer whose editor just underlined a line, I want the rule id, the fixes that
work, and the fixes that only look like they work, without leaving the editor, so that I do not launder
one violation into another mid-keystroke.

1. Every published diagnostic SHALL carry its rule id, a severity mapped from `Violation.severity`
   (`error` → Error, `warning` → Warning — never Information or Hint, which would understate a rule the
   project's own configuration marked as blocking), and a source identifying checkyourvibe.
2. WHERE `endLine`/`endColumn` are absent, the diagnostic's range SHALL still be well-formed — a
   single-point range at the reported location — never a synthesized guess at a wider range the
   analyzer did not claim.
3. The violation's guidance — `summary`, `why`, `allowedFixes`, `notFixes`, `examples` — SHALL be
   reachable from the diagnostic itself, without a second request or a lookup in separate
   documentation, exactly as Requirement 3.5 of 0001 already requires for every other channel.
4. `notFixes` SHALL remain distinguishable from `allowedFixes` in whatever the diagnostic carries. An
   editor rendering the two identically would erase the one distinction that makes this guidance worth
   more than a lint message.
5. The language server SHALL NOT implement a code-action surface, or any other surface offering an
   invocable action, derived from a `notFix`. Because the analyzer contract has no notion of a
   machine-applicable fix — `allowedFixes` are prose remediations, not edits — this version SHALL NOT
   offer code actions for `allowedFixes` either. Not building the surface at all is safer than building
   one that must tell "safe to invoke" from "would be actively harmful to invoke" the first time either
   list gains a machine-applicable form it does not have yet.
6. Guidance rendering SHALL reuse the same rule-manifest data the terminal and MCP renderers already
   use. The language server SHALL NOT hold its own copy or paraphrase.

## Requirement 2 — Debounced, document-scoped runs

**User story:** As a developer typing, I want my editor to stay responsive, so that a check that costs
hundreds of milliseconds does not cost them on every keystroke.

1. An edit to an open document SHALL NOT trigger an analysis run synchronously. The server SHALL wait
   for a quiet period with no further edits to that document before invoking the analyzer(s) claiming
   it.
2. Only the latest content for a document SHALL be analyzed when the quiet period elapses. An edit
   arriving while a run is in flight SHALL NOT start a second concurrent run against stale content; it
   SHALL extend the wait.
3. Every debounced run SHALL be scoped to exactly the one changed document — `mode: 'file'`, with that
   document's path as the only entry in `files` — never the workspace. Project-scope rules SHALL be
   excluded from these requests, matching how `file` mode already excludes them everywhere else.
4. A save SHALL always trigger a run for that document immediately, independent of debounce state — a
   save is a deliberate, infrequent action a developer expects reflected without delay.
5. Before any debounce interval is fixed as a default, the following SHALL be measured for every
   analyzer expected to participate: per-request latency for a single small document, both on the first
   request against it and on a request following shortly after (to separate one-time cost from
   per-request cost); and whether that latency, under realistic typing cadence with debouncing applied,
   produces diagnostics a developer experiences as *during* the edit rather than noticeably behind it.
   `cyv watch`'s existing debounce constant SHALL NOT be assumed correct here without measuring — it was
   tuned for file-save events, not for a per-keystroke event source.
6. WHERE the measured cost of a debounced, document-scoped run — including the shadow-file cost from
   Requirement 4 — exceeds what a reviewer of this spec judges acceptable for a live editing loop, that
   measurement SHALL be recorded as the evidence 0013 needs to decide whether a warm-session capability
   is required. This spec assumes today's cold, one-shot-per-request cost throughout; building a
   warm-session capability is explicitly 0013's work, not this spec's.

## Requirement 3 — Honest participation

**User story:** As a developer whose file happens to be claimed by a subprocess analyzer, I want to be
told it isn't being live-checked, rather than see a clean editor and a failing CI run.

1. By default, only `exec.type: 'node'` analyzers SHALL participate in save-independent, debounced
   diagnostics — the same restriction `cyv watch` already applies, for the same reason: a `process`
   analyzer cannot hold warm state between invocations and pays a fresh spawn cost on every run.
2. WHERE an analyzer is excluded for this reason, the server SHALL publish that exclusion per affected
   document, naming the analyzer and the reason. A file whose only claiming analyzer is excluded SHALL
   be reported as unchecked, never as passing — the same principle Requirement 4.4 of 0001 states for a
   whole run, applied to one document.
3. The exclusion SHALL be visible through at least one surface that requires no special client support:
   an informational diagnostic anchored in the affected document, so a plain LSP client shows it
   alongside real findings. A richer, checkyourvibe-specific surface MAY exist in addition, never
   instead.
4. WHEN a document claimed by an excluded analyzer is saved, the server MAY still run that analyzer —
   save is infrequent enough to plausibly afford the cost — but this SHALL be enabled only once
   Requirement 2.5's measurements support it, not assumed.
5. `cyv doctor` SHALL report, per configured analyzer, whether it participates in debounced editor
   diagnostics, participates on save only, or does not participate at all — the same pattern 0003
   Requirement 1.6 already establishes for a hook falling back to working-tree scope.

## Requirement 4 — Unsaved buffers

**User story:** As a developer editing a file I have not saved, I want diagnostics that reflect what is
actually in my editor, or an honest statement that they do not — never a diagnostic that looks current
but was computed from whatever I last saved.

1. The analyzer contract SHALL NOT change to carry inline content. `AnalyzeRequest.files` remains
   absolute disk paths, and its schema remains sealed to its current fields — widening it would obligate
   every analyzer already written against protocol 1, including ones outside this repository, to handle
   content they were never asked to accept.
2. To analyze an unsaved buffer, the server SHALL write its current text to a shadow file adjacent to
   the real one, request analysis of the shadow path, and remap every returned violation's `file` back
   to the real document before publishing. The analyzer never learns the buffer exists; only the
   transport does — this is the concrete shape of "mostly a transport question" this requirement tests,
   and it costs one extra disk write, and later one delete, on top of the analyzer's own per-request
   cost measured under Requirement 2.
3. The shadow file SHALL live in the real file's own directory, never a temporary directory elsewhere.
   Directory-relative resolution — the nearest tsconfig, the nearest project file, anything an analyzer
   walks upward from a file's own path to find — gives a wrong or degraded answer from anywhere else,
   and a degraded analysis that still reports violations is worse than an honest skip, exactly as the
   solution-style-tsconfig defect already found during 0001's self-application.
4. The shadow file's name SHALL match this project's own default exclusion conventions, so a `cyv
   watch` or `cyv check --all` running concurrently in the same repository does not treat it as source.
   It SHALL be deleted immediately after its response is read, and the server SHALL remove stale shadow
   files matching its naming convention on startup, in case a previous session crashed before cleaning
   up.
5. An analyzer SHALL NOT be assumed safe to point at a shadow file. Until one is verified to behave
   correctly against a synthetic path, the server SHALL treat it as save-only: diagnostics for files it
   claims SHALL come only from saves, not from debounced edits.
6. WHEN diagnostics reflect a saved-not-current state THEN the server SHALL say so per document, on an
   ongoing basis — not once at startup. A developer five minutes into unsaved edits needs the reminder
   to still be true, not a notice they saw once and forgot.
7. WHEN the shadow-file write itself fails — a read-only mount, a permissions error, a full disk, a
   directory the editor's own process cannot write to though the user can edit within it — THEN the
   server SHALL report that document as unchecked for the failed run, exactly as Requirement 3.2 already
   requires for an excluded analyzer, rather than silently producing no diagnostic and rather than
   crashing the session. A write failure is exactly the kind of degraded path Requirement 4.3 already
   worries about for a *wrong* directory; the same honesty applies when the right directory refuses the
   write outright.

## Requirement 5 — Configuration and suppression parity

**User story:** As a developer, I want the same rule to fire, at the same severity, whether I am looking
at my editor or waiting on CI, so the editor is a preview of the gate rather than a second, disagreeing
opinion.

1. The server SHALL resolve rules per file through the same resolution path `cyv check` uses — severity
   overrides, per-path overrides with their required reasons, pack membership — never a parallel
   reimplementation that could drift from it.
2. A suppression (0008) that excludes a violation from `cyv check` SHALL exclude the same violation from
   editor diagnostics. An expired suppression SHALL surface in the editor exactly as it would in a CLI
   run, including the fact that it is an expired suppression rather than a fresh finding — dropping that
   distinction would itself be a small lie.
3. WHERE the project gates commits with `--since-baseline` (0008), the server's default view SHALL match
   what that gate actually enforces, not `cyv check`'s unfiltered default. An editor surfacing thousands
   of pre-existing violations that no gate is currently blocking on trains a developer to ignore the
   panel. WHERE no baseline gates the project, the server SHALL show everything, matching `cyv check`.
4. Configuration SHALL be re-read when `checkyourvibe.json` changes during a server session, and every
   open document's diagnostics SHALL be recomputed against the new configuration. A long-running editor
   session is far more likely than a single `cyv watch` invocation to outlive a configuration edit, and
   enforcing a superseded posture for that long is its own disagreement with CI.
5. A configuration error — a schema validation failure, a suppression naming an unknown rule, an
   override with an empty reason — SHALL be surfaced to the editor as an error, never silently ignored
   in favour of the last-known-good configuration.

## Non-goals

Formatting or style rewriting. Fixes-on-save, or any code action that edits a buffer — consistent with
Requirement 1.5's decision not to build a code-action surface at all in this version. Anything that
would call a model to explain, summarize, or triage a finding — guidance is the rule manifest's own
prose, verbatim, per the project's constraint against per-finding token cost. Project-scope rules
running over this transport — they need the whole tree, exactly as they already do not run in `file`
mode for hooks or explicit paths; the backstop remains their only surface. A warm-session or
long-lived-compilation capability — that is 0013's work; this spec only measures what 0013 needs.
Pull-model diagnostics. Multi-root sessions spanning more than one repository per server instance.

## Open questions

1. What debounce window actually produces the "during the edit" feel this spec exists to test, once
   Requirement 2.5's measurements exist? No number is defensible yet.
2. Is a permanent save-only tier (Requirement 4.5) acceptable for subprocess analyzers, or does editor
   support for a given language end up gated on shadow-file verification happening sooner than 0013's
   general warm-session answer?
3. Does the richer per-document status surface (Requirement 3.3) need a real protocol extension, or is
   the informational-diagnostic fallback sufficient on its own — making the extra surface unjustified
   complexity for a first version?
4. How should a document checked by a mix of tiers — a live node analyzer alongside a slow, save-only
   process analyzer — present its "am I fully checked right now" status without turning every open file
   into a status dashboard?
5. Is the shadow-file mechanism a bridge until the protocol grows a real inline-content request shape,
   or is "the contract stays disk-only, transports paper over it" the actual long-term position? This
   spec takes the latter for now, but the tension is real and unresolved.
6. Requirement 4.4's naming convention keeps this project's *own* tooling (`cyv watch`, `cyv check
   --all`) from treating a shadow file as source, but a create-then-immediately-delete cycle in the real
   file's own directory, many times a minute under debouncing, is still visible to whatever else is
   watching that directory — `git status`, another language server, a bundler's file watcher, a backup
   or sync tool. None of those necessarily honor this project's exclusion convention. Whether that is an
   acceptable cost or needs its own mitigation (a per-tool `.gitignore`-style pattern the server writes
   once, say) is not resolved here.
