# 0064 — Fixtures where the wrong answer has precedent

**Project:** benchmark
**Status:** proposed
**Created:** 2026-09-08
**Constrained by:** 0059 enforcement harness — an arm is an environment, not a prompt

## Why the measurement is stuck

Eight pooled passes on `claude-haiku-4-5`, 88 trials per arm, 880 trials. Any
hook takes the pass rate from 66% to 84–88%. The four treated arms sit within
four points of each other and their ordering has changed three times as the
sample grew.

The reason is in the same report. Across 176 enforcing trials the gate denied a
write in **sixteen**. Nine times in ten the enforcing arms run the same
experiment as the advisory arms: the model writes an acceptable fix first time
and no denial ever happens. Splitting the enforcing arms by whether the gate
actually fired leaves eight trials against seven — the comparison the project
exists to make, made on fifteen trials.

Every fixture is one file holding one seeded violation, and the correct fix is
visible inside it. More passes buy precision on a difference that is not being
created.

## What was measured

A generated service repository, one task, no hooks, identical text every time:
*"Add a unit test for the coupon service covering the case where the id is not
found."* The repository's convention is to build the subject through the
container in `test/support/factory.ts`; the common answer is to construct the
service and its repository directly.

| repository | modules | written the old way | where they sit | followed |
|---|---|---|---|---|
| uniform | 3 | 0 | — | 2 / 2 |
| uniform | 30 | 0 | — | 5 / 5 |
| minority legacy | 30 | 8 (27%) | first in the listing | **0 / 4** |
| majority legacy | 30 | 20 (67%) | first in the listing | **0 / 3** |
| minority legacy | 30 | 8 (27%) | past the target | **4 / 4** |

**Size does not defeat the model, and neither does proportion. Position does.**

At thirty uniform modules it followed the convention every time: a consistent
repository advertises its own convention and one directory listing finds it.

With eight of thirty modules in an older style *placed where a listing shows
them first*, it constructed the subject directly in every trial. With the same
eight placed past the target, it followed the convention in every trial. Same
count, same size, same task, same target module.

So the variable is **which precedent is found first**, not how much stale code
exists. One stale file at the top of a listing outweighs seven buried ones.
The model finds a real file in this codebase doing what it was going to do
anyway, and the search ends there.

This is the documented failure mode observed directly: models default to the
common pattern and are insensitive to local deviation, and *implicit assumption
errors* — believing this codebase works the way codebases generally do — are
the largest single error category in the published analyses.

## Requirements

### 1. A generator, with inconsistency as its parameter

**1.1** A generated repository has N feature modules over a shared kernel: a
container, an injected clock, a typed config module, a wrapped HTTP client, a
`Result` type, an error taxonomy, a cursor-pagination helper, a transaction
runner, and a test factory that resolves a subject through the container.

**1.2** The generator takes the number of modules, the number written in the
superseded style, **and where those sit** — first in the listing, scattered
through it, or past the target. Position is the independent variable; the
count and the size are context. This is the correction the probe forced: the
count alone predicts nothing.

**1.2.1** Placement must not be confounded with naming. A stale module whose
name marks it as a duplicate is a different experiment from one indistinguishable
by name, and the generator must be able to produce the second.

**1.3** A generated repository type-checks under the same strict settings this
project uses, at every size and every mix. A fixture that does not compile
cannot distinguish the model's mistake from a broken fixture.

**1.4** The generator emits no third-party dependency. A trial that runs an
install measures the registry, and the trap does not need one.

### 2. Tasks, each with a documented failure family

**2.1** Each task names a file to write, and a check that reads the tree and
answers whether the repository's convention was followed. The check reports
*wrote*, *followed* and *bypassed* separately, because a trial can build the
right scaffolding and then ignore it.

**2.2** The first task is the DI bypass — the one the owner watched happen and
the one measured above. Further tasks follow the same shape: N+1 versus the
repository's batch method, two writes versus the transaction runner,
`Date.now()` versus the injected clock, a bare `fetch` versus the wrapped
client, a thrown error versus the error taxonomy, `process.env` versus the
config module, offset versus cursor paging.

**2.3** A task's text never names the convention. If the prompt says which way
is right, nothing is being measured about whether the model can tell.

### 3. What the arms are for

**3.1** The five existing arms are unchanged: they differ by environment, not
by prompt.

**3.2** A condition in which the model fails without a hook is what gives the
arms something to differ about. The suite reports, per condition, how often the
gate fired — a condition where it fires rarely is reported as such rather than
averaged in.

**3.3** The single-file fixtures stay. They are the floor: they show the
analyzers fire at all. This suite measures what the floor cannot reach.

### 4. Honesty

**4.1** The probe above is fourteen trials. Nothing from it is reported as a
rate until it has run at the declared minimum per cell, across more than one
task family.

**4.2** If the model follows the conventions as well in a mixed repository as
in a uniform one once N is adequate, the report says so. The design is worth
building because it can produce that answer.

**4.3** The placement result puts a cheap rival on the table, and the suite
must be able to measure it rather than assume it loses: if making the current
pattern the first thing found — a canonical example, a naming convention, an
index — recovers the trial as well as a gate does, that is a finding and it is
reported. This is the first fixture with a base rate low enough to tell.

## What this changes about the product's claim

cyv is not selling a bigger context window or a better prompt. Neither helps
here, because the model is not confused — it is correctly copying a real
precedent from the repository it was given. What is missing is something that
knows which precedent is current and refuses the other.

That is also the honest scope of the claim: the first week is uniform and
nothing contradicts anything. The failure does not begin at a hundred
endpoints. It begins the first time one corner is left behind.
