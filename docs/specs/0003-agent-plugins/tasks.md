# 0003 — Agent plugin expansion: Tasks

**Status:** active

## Wave 1 — Contract changes the research forced

Both of these were required before a line of plugin code could be written, which is itself the
headline finding: reading four vendors' documentation invalidated three assumptions the contract was
built on.

- [x] **T3000** `HookPayload.scope`
  Only Claude Code and Cursor name the edited file. Codex's payload has no path field at all; Gemini
  and Antigravity bury it somewhere undocumented. Plugins that cannot resolve a path return
  `scope: 'working-tree'` and the hook checks uncommitted changes. Parsing a patch body to recover a
  filename is explicitly forbidden.
  _Exec: executor=self model=opus gates=tsc files=packages/core/src/protocol/agent.ts_

- [x] **T2009** `toml-merge` strategy
  Codex stores configuration as `config.toml`. Without this the merge layer has nowhere to write, so
  Codex cannot be configured at all. Narrow read-modify-write, no TOML library.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/merge/**,packages/core/src/protocol/agent.ts_

## Wave 2 — The plugins

- [x] **T3001** Cursor CLI
  `afterFileEdit` names the path directly, so no working-tree fallback. Exit 2 BLOCKS on Cursor, so
  violations report at exit 0 with findings in `additional_context` on stdout.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/adapter-cursor/**_

- [x] **T3002** Gemini CLI
  Ordered candidate path fields; working-tree fallback when none match. Per-rule guidance surface
  could not be confirmed, so it is declared absent rather than inventing a format.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/adapter-gemini/**_

- [x] **T3004** Antigravity CLI
  The least documented of the four. Seven distinct guesses recorded in source comments, including two
  that stack in one plugin: the path field and the stdout feedback shape.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/adapter-antigravity/**_

- [x] **T3003** Codex CLI
  Blocked on T2009 — TOML config. Also the only agent whose payload cannot name a file at all, so it
  is working-tree scope unconditionally.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/adapter-codex/**_

## Wave 3 — Integration

- [x] **T3005** Multi-agent `init` and `doctor`
  Plan for every detected agent in one run with one combined diff; one plugin failing to plan must not
  fail the whole run. `doctor` reports per-agent status including installed-but-unconfigured and
  configured-but-uninstalled.

  One defect closed on the way in. A plugin whose `detect` threw was already reported under `Not in
  plan:`, but a plugin whose `plan` threw was not reported anywhere: it contributes no writes, so it
  left no trace in the diff, while the header above still listed it under `Agents that will be
  configured`. The run said it had configured an agent it had written nothing for. Plan failures now
  join detection failures under `Not in plan:` with the plugin's own message, and the run still exits
  0 and applies every other agent.

  Verified by running `cyv init --yes --allow-outside-repo` from a staged installed package against a
  scratch git repository: one plan, one combined diff, four agents configured and the undetected one
  listed under `Not in plan:`; then `cyv doctor` in the same repository reporting per-agent status.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/cli/init.ts,packages/core/src/cli/doctor.ts,packages/core/test/cli/**_

- [x] **T3006** Surface unverified integrations in `doctor`
  Raised by T3004: a plugin can be built on guesses the contract has no way to express. A user whose
  Antigravity feedback silently goes to an undocumented field deserves to know it is best-effort.
  Add a way for a plugin to declare which surfaces are unverified, and report it.

  `AgentPlugin.unverifiedSurfaces` carries a surface and the observation that makes it a guess;
  `cyv doctor` prints an `[unverified]` line per distinct reason for any agent that is configured or
  detected, and does not change the exit code — a best-effort surface is not drift.

  The declaration is now validated where a plugin is loaded rather than trusted. An adapter can come
  from anyone, and a malformed entry that reached the report would print `undefined: undefined` beside
  an agent's name, which tells a reader nothing about how far to trust the integration. A surface that
  is not in the protocol, a missing reason, an empty reason, or a non-array all fail the load loudly.

  Verified against the real CLI: `cyv doctor` in a scratch repository prints one `[unverified]` line
  for Gemini's hook path field and two for Antigravity's hook and guidance surfaces, alongside `[ok]`
  for the same agents, and exits 0.
  _Exec: executor=claude model=sonnet gates=tsc,test files=packages/core/src/protocol/agent.ts,packages/core/src/cli/doctor.ts_

- [x] **T3007** The verdict (Requirement 7)
  Write up every change the four plugins forced on the shared contract, and judge plainly whether the
  abstraction held.
  _Exec: executor=self model=opus gates= files=docs/specs/0003-agent-plugins/verdict.md_

## Contract changes forced so far

| # | Change | Forced by |
|---|---|---|
| 1 | `HookPayload.scope` — files vs working-tree | Codex, Gemini, Antigravity not naming the edited path |
| 2 | `toml-merge` strategy | Codex using `config.toml` |
| 3 | `parseHookPayload` doc: throw vs working-tree, and where the line falls per vendor | Cursor and Gemini drawing it differently for what looked like the same case |
| 4 | `blockId` namespaced by plugin id | Two plugins colliding on the same shared file — a defect, not evolution |
| 5 | Merge helpers exported from the core barrel | Codex needing `quoteTomlString` from another package |
| 6 | `AgentPlugin.unverifiedSurfaces` — a surface declared best-effort, with its reason | Antigravity, built on stacked guesses |

**Verdict written: see `verdict.md`.** Six changes across four new plugins, and every one additive —
a new optional field, a new strategy in an existing union, a clarified doc, a widened export. None
required restructuring the interface and no plugin needed an escape hatch, which is the test that
matters. The abstraction held; one entry was a genuine defect. The sixth change was still open when
the verdict was written and is now closed by T3006 — `unverifiedSurfaces` is another optional field,
so it does not change the verdict.

## Found by running `cyv init --yes` on this repository

- [x] **T3010** `--yes` sets up every detected agent, including ones writing outside the repository
  Both halves are closed, and both were checked against the real CLI.

  Scope: `--yes` confirms the plan rather than enlarging it. Adopting a newly-detected agent needs
  its own `--adopt`, held by the test `--yes on a repo with configured agents does not adopt a newly
  detected one, and lists skipped agents`.

  Disclosure: writes landing outside the repository root are planned separately, excluded from a
  blanket `--yes`, and reported as `Skipped N machine-wide write(s). Re-run with
  --allow-outside-repo to apply them.` Confirmed the way this task was found in the first place —
  by running `cyv init --yes` against a real HOME and then reading `~/.codex/config.toml`, which was
  not touched.

- [x] **T3011** The global claude-code hook nags in every project that never opted in
  Fixed and guarded. `runHook` resolves the config first and returns 0 with no output when there is
  none, because a repository that has not opted in is not a problem to report. The message is
  reserved for a repository that HAS a config the hook could not use, which stays loud.

  Verified by running the real hook, not by reading the code: a scratch git repository with no
  `checkyourvibe.json`, a genuine claude-code payload on stdin, exit 0 and not one byte on stdout or
  stderr. Two tests hold the distinction apart — `exits 0 quietly when checkyourvibe.json is
  missing` asserts both streams are empty, and `exits 0 with a warning when checkyourvibe.json
  exists but cannot be used` asserts the warning is still there.

- [x] **T3012** `cyv init --yes` blocked on a prompt it was told not to ask
  The hang was `maybeOfferBaseline`, which ended in `confirm(false, ...)` regardless of `--yes`.
  `confirm` only skips its prompt when stdin is not a TTY, so an interactive run opened a readline
  interface nobody was going to type into and sat there until the 60s timeout. Under a test runner
  that inherited a terminal, that is a hang; from a plain terminal it is a prompt `--yes` promised
  not to show.

  `maybeOfferBaseline` now takes `yes`. The violation count and the pointer to `docs/adoption.md`
  still print, because that is the useful part of the offer. The baseline itself is not written:
  recording every existing violation as deferred debt is too large a side effect to infer from a
  flag that only means "do not ask me".

  Why it went unnoticed: every test in `init.test.ts` runs with stdin detached, which is the one
  condition under which the prompt skips itself, and two of them assert `isTTY` is not true. The new
  test fakes the TTY so the prompt is live and fails on the clock if `--yes` reaches it again.
  Verified against the real CLI, not just the runner: `cyv init --yes` in a scratch repo with one
  violation finishes in 0.86s, prints the count and the new message, and never prompts.
