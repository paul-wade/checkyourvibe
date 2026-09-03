# 0035 — One dashboard, several projects: design

Resolves the three questions the requirements left open.

## The registry lives in the user's home directory

`~/.cyv/projects.json`, a list of absolute paths.

A dashboard is a per-machine tool: it shows what this developer has open on this
laptop. Putting the list in a repository raises a question with no good answer —
which repository owns the list of its neighbours? — and makes the set of
projects a thing that gets committed and then goes stale for everyone else.

The cost is that the list does not travel between machines. That is the right
cost: the paths would not survive the trip anyway.

Registration is explicit (R2.2). `cyv dashboard --add <path>` and `--remove`,
both refusing a path with no `checkyourvibe.json` and saying so.

## One server, several projects

Not a server per project with an index.

The failure-isolation argument for one-per-project is real but is answered more
cheaply: every read of a project's state is already defensive, because a project
may have no `.cyv-review/` at all. A project whose state is missing or
unparseable renders as *that project could not be read*, with the reason, and
the others render normally. That is the same three-state honesty the panels
already implement, applied one level up.

The cost of one-per-project is a process and a port for each, on a machine where
process count is already a complaint. One server it is.

## Reading a project without trusting it

Every project's state comes from files it owns:

| what | file |
|---|---|
| last run, findings | `.cyv-review/latest-run.json` |
| in flight, lanes | `.cyv-review/dispatches.ndjson` |
| comments | `.cyv-review/comments.json` |
| recorded health | `.cyv-review/health.json` |
| rules, packs, lanes | `checkyourvibe.json` |

Each is read with the parser that already exists for it. No project's state is
computed from another's, and each carries its own measurement time (R3.3), so
two projects worked on at once cannot make each other look current.

Nothing is scanned. A directory becomes a project because someone said so.

## The overview row

One row per project (R5.1), carrying only what decides whether to open it:

```
storageflow      ● 3 need you      2 in flight     checked 4m ago
catburgler       ○ nothing         idle            checked 2h ago
checkyourvibe    ○ nothing         1 in flight     never checked
```

Everything else is behind the project. With one project registered the overview
is skipped and its page is the home page (R1.2) — grouping machinery that earns
nothing is not shown.

## What leaves the headline

Requirement 6 decided this: `215 files` and `19 rules` are configuration facts
that do not change between runs. They move to where configuration is reported.
`tests pass` and `tasks` stay, because they answer "is it broken" and "how far
along".

"Clean against itself" goes entirely. A project's headline states that project's
state; the tool's own repository is one project among the rest (R1.3).

## Comments across projects

A comment is written into the project it concerns (R4.1). The watcher takes a
list of project roots instead of one, and reports which project a new comment
came from, so an agent working in one is not blind to a note on another (R4.2).

A single-project store is unchanged on disk (R4.3) — the watcher's cursor file
gains a per-project key rather than the store changing shape.

## Not doing

- **Converging with `cyv dashboard`** (the rules browser, spec 0006). Two
  servers on two ports today. They answer different questions — what rules exist
  versus what is happening — and merging them is a larger decision than this.
- **Any cross-project aggregate.** A total findings count across projects is a
  number nobody acts on.
