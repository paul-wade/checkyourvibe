# checkyourvibe

Code standards that hold when an agent is writing the code.

- **A compiler decides, not a model.** Same input, same verdict, every run.
- **Agent-native rule interlocking.** Tells agents how to fix findings and explicitly blocks the evasion shortcuts (`notFix` dead-ends) they reach for when trying to bypass standard linters.
- **Zero API token cost required.** Turns idle flat-rate subscriptions into a 24/7 background worker pool with automatic rate-limiting and parallel CLI lane scheduling.
- **Smart model tiering & empirical escalation.** Runs the smallest model capable of each task, escalating to higher tiers only when AST compiler gates fail.
- **Async dashboard Q&A.** Moves interaction out of synchronous chat streams into a localhost dashboard where agents work continuously and request human input only when needed.

<p align="center">
  <img src="docs/media/interlock.svg" alt="cyv check reporting a finding with its allowed fixes and the dead ends each would trip" width="880">
</p>

## Why a rules file wasn't enough

You wrote the `CLAUDE.md`. It worked for a while, then the context got long and the agent stopped
caring. Stronger wording didn't help. It can't: you're asking a sampling process to be reliable.

checkyourvibe still writes guidance into your agent's format, and that part is still advisory. But
the guidance is not what enforces the standard. A compiler is, one layer below, where the model
can't reach it.

```
  advisory    instructions, MCP     agent may read it, may ignore it
  gate        pre-edit hook         the edit is denied before it lands
  record      post-edit hook        what happened, whatever the agent chose
  guarantee   git hook, CI          ts-morph, Roslyn, ast, syn
```

The gate and the guarantee both run whether or not the agent agrees. The pre-edit hook inspects the
proposed content and refuses the tool call, so the write never happens. The bottom layer runs on the
diff regardless, and doesn't care whether the agent read the guidance or wrote the code at all.

The advisory layer is allowed to be flaky. Nothing depends on it.

Be precise about what each layer buys, because the difference is measurable. A post-edit hook cannot
undo a write that already landed, and a model knows it: probed on 2026-09-06, one read the guidance,
reasoned that "the hook's exit status does not undo the write", and declined. That is why the record
row is named for what it does rather than for what it prevents.

The gate row is the one that prevents. It runs on the edit tools and on `Bash`, because a hook
matching only edits never sees `echo ... > file.ts` — an escape route in exactly the sense the
notFixes below describe. A denied edit comes back carrying the rule and its notFixes, so the model
reads why the shortcut it was about to take is refused at the moment it is refused, rather than
afterwards. What it still cannot see is a write made by something other than the agent's tools; that
is what the git hook is for.

## Rules that cover each other (Agent-Native Evasion Defense)

<p align="center">
  <img src="docs/media/interlock-graph.svg" alt="The TypeScript rules drawn as a graph: 14 rules connected by 47 notFix edges" width="620">
</p>

Standard linters were built for humans who make honest mistakes. When an AI agent encounters a standard linter error, it attempts **satisficing**—finding the cheapest language shortcut to silence the check.

`checkyourvibe` replaces passive error messages with an **interlocked dead-end graph (`notFix`)** across every supported language analyzer:

- **TypeScript:** Reach for `as` to escape `no-any` and `no-as-cast` is waiting. Reach for `@ts-ignore` to escape that and `no-ts-comment` catches it.
- **C#:** Cast to `dynamic` to bypass type checks and `no-dynamic` triggers. Use `!` to force nullability and `no-null-forgiving` blocks it. Swallow errors in `catch {}` and `no-empty-catch` traps it.
- **Python:** Silence exceptions with `except Exception: pass` and `no-bare-except` flags it. Use `assert` for runtime validation and `no-assert-for-validation` blocks it.
- **Rust:** Escape `Result`/`Option` handling with `.unwrap()` and `no-unwrap` catches it. Ignore unused results with `let _ = res` and `no-ignored-result` traps it. Bypass checks with `unsafe` and `no-unsafe-block` triggers.

An agent reading a finding sees both lists: what to do, and which shortcuts lead somewhere worse.

### Empirical Benchmarking & Not-Fix Proof

`checkyourvibe` includes an automated benchmark harness (`packages/core/src/benchmark/`) that tests AI agents against deliberate code violation fixtures under `control` (raw linter error) vs. `graph` (full CYV interlock) conditions. 

The harness measures:
- **Not-Fix Avoidance Rate:** Percentage of trials where the agent avoids prohibited shortcuts.
- **First-Pass Gate Rate:** Percentage of trials passing compiler gates on the initial turn.
- **Violation Ping-Pong Reduction:** Elimination of recursive loops between adjacent failing rules.

See the live telemetry output in [docs/media/benchmark-proof-report.md](docs/media/benchmark-proof-report.md).

## 24/7 background execution on flat-rate subscriptions

Metered agent work gets expensive fast. Flat-rate plans don't, and most developers hold several that sit idle most of the day. `checkyourvibe` turns those CLI subscriptions into a continuous background worker pool that operates 24/7 with zero required metered API tokens.

Ships with **Claude Code, Codex, Cursor, Gemini and Antigravity**, through each one's own hook, instructions, guidance and MCP surfaces.

### One subscription drives. The rest are capacity.

```
   you ──▶ orchestrator          ┌──▶ Claude Code    2 of 3 running
           (one subscription)    │
                │                ├──▶ Codex          0 of 2 running
                ├── which agent? ┤
                │                ├──▶ Cursor         cooling down
                └── which model? │
                                 └──▶ Gemini         0 of 2 running
                    ▲
              localhost dashboard: what's running, where, and why
```

**Which agent** spreads the load across parallel CLI lanes. The scheduler knows exactly how many dispatches each lane has in flight, automatically handles rate-limiting, and routes work into cooldown windows until capacity recovers.

**Which model** is assigned per task using empirical escalation. A flat-rate plan bounds total token throughput in a rolling window. Spending a top-tier model on a rename across forty files wastes the window before a design decision shows up.

A task declares what kind of work it is, each lane declares which of its models can handle that kind, and the dispatch takes the smallest model available. If compiler gates fail, the orchestrator retries one step up and records why. Escalation follows an empirical gate failure rather than a guess.

An executor never requires a metered API key. Billed metered lanes are opt-in by name and never an automatic fallback or escalation target.

### Scope locking & parallel planning (`cyv plan`)

To prevent multi-agent collisions, tasks in `docs/specs/**/tasks.md` declare explicit `files=` ownership boundaries. `cyv plan` analyzes dependencies and groups open tasks into non-overlapping execution waves. Multiple background lanes execute simultaneously across the workspace without git merge conflicts or file clobbering.

## `cyv explain`

<p align="center">
  <img src="docs/media/explain.svg" alt="cyv explain showing a rule's pack, evidence kind, owning analyzer, and whether it is enabled" width="880">
</p>

Pack, what the rule reads, which analyzer owns it, whether it's enabled here, and which other rules
point at it.

## Install

```sh
git clone <this repository>
cd checkyourvibe
./install.sh          # or ./install.ps1 on Windows
```

Then, from the project you want to check:

```sh
cyv init              # detect your agents, write the glue
cyv check --all       # see where you stand
cyv install-hooks     # wire the git backstop
cyv install-ci        # detect your CI system and offer it a gate
```

`cyv install-hooks --with-drift-check` adds a second gate to the hook: `cyv doctor`,
so a commit is refused when the generated agent glue no longer matches what `cyv init`
would write. It is off unless asked for, skipped automatically part-way through a
rebase or merge, and skipped for one commit with `CYV_SKIP_DRIFT=1 git commit`.

`cyv install-ci` reads the files actually in the repository — `.github/workflows/`,
`.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/config.yml`, `azure-pipelines.yml`,
`bitbucket-pipelines.yml`, `.travis.yml` — plus the lockfile and hook framework, and
plans a gate for what it found. "No CI system detected" is a statement, not a failure.
Nothing is written without a plan, a diff and a confirmation, and an existing config
file is appended to inside a managed block rather than replaced.

[docs/getting-started.md](docs/getting-started.md) walks the first run end to end.

## Rules

Analyzers are modules you add. The core is the engine and the protocol; it carries no language of
its own, so it needs no .NET SDK, no Rust toolchain and no Python to install. Add the ones you want
and `checkyourvibe.json` names them.

Four exist today: TypeScript (ts-morph), C# (Roslyn), Python (`ast`), Rust (`syn`). A fifth needs no
change to the core. They speak a versioned JSON contract, so listing what rules exist never boots a
language toolchain.

No rule names a framework, ORM, cloud provider or logging library. A rule whose guidance names a
package stops being true when you switch packages.

**`core-ts`**

| Rule | Catches |
|---|---|
| `no-any` | `any`, written or inferred |
| `no-as-cast` | `x as T`, angle brackets, double casts through `unknown` |
| `no-non-null-assertion` | `!` on values, fields and variable declarations |
| `no-ts-comment` | `@ts-ignore` and `@ts-expect-error` in any comment style |
| `no-useless-types` | `object`, `Function`, `{}` |
| `no-console` | Global `console`; takes `allowedMethods` |
| `no-swallowed-catch` | A `catch` that neither rethrows, reports nor handles |
| `no-broad-catch-rethrow` | `catch (e) { throw e; }` |
| `no-floating-promise` | A Promise neither awaited, returned nor handled |

**`strict-boundaries`** (data crossing into the program)

| Rule | Catches |
|---|---|
| `no-json-parse-cast` | Casting `JSON.parse` or `res.json()` without validating |
| `no-unsafe-index-access` | Reading an index that may not exist |
| `no-unsafe-array-narrowing` | `Array.isArray` on `unknown`, which narrows to `any[]` |
| `no-non-null-index-write` | Writing past the end of an array |

**`test-quality`**

| Rule | Catches |
|---|---|
| `no-tautological-assertion` | An assertion comparing a value to itself |

**`core-cs`** — `no-dynamic`, `no-unchecked-cast`, `no-null-forgiving`, `no-empty-catch`

**`core-py`** — `no-bare-except`, `no-mutable-default-arg`, `no-assert-for-validation`, `no-star-import`

**`core-rust`** — `no-unwrap`, `no-panic-in-library`, `no-unsafe-block`, `no-ignored-result`

Write your own with `cyv new-rule`. It scaffolds the rule, its manifest, a fixture pair and a test,
and won't let the dead-end list ship empty.

## Adopting an existing codebase

You won't pass on the first run. Take a baseline, gate new code against it, burn down the rest.

```sh
cyv baseline                     # record what's already there
cyv check --since-baseline       # only new violations
cyv baseline --status            # what's left, and where
```

Every run still reports the deferred count, so a green check never means the debt vanished.

Suppressions carry a reason and an expiry. There's no bare ignore directive. Full path in
[docs/adoption.md](docs/adoption.md).

## Beyond the CLI

```sh
cyv dashboard        # launch the interactive async control center
cyv doctor           # check generated agent glue hasn't drifted
cyv check --sarif    # GitHub code scanning, with the dead ends attached
cyv watch            # re-run as files change
```

`cyv dashboard` serves as your async control center:
- **Interactive Q&A:** Agents executing in background lanes post questions to the dashboard when encountering design ambiguities. You answer on your time without stalling other active lanes or babysitting a chat prompt.
- **Live Lane & Queue Monitoring:** Real-time visibility into active dispatches, cooldown states, model tiers, and non-overlapping file wave groupings (`cyv plan`).
- **Zero-Toolchain Manifest Inspector:** Reads static manifests directly. No language analyzer or SDK runs to render the page, so you can inspect every rule and interlock graph before installing a compiler.

## Licence

MIT.
