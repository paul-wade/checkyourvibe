# 0065 — A repository's own conventions, enforced

**Project:** rules
**Status:** proposed
**Created:** 2026-09-08
**Constrained by:** 0064 — the failure worth preventing is a stale local precedent

## What the measurement says

A generated repository of thirty modules, eight written in a superseded style,
the first plausible example among them. One task: add a unit test. The
repository's convention is to resolve the subject from a container; the common
answer is to construct it directly.

| condition | followed the convention |
|---|---|
| nothing installed | 0 / 15 |
| the convention written in `CLAUDE.md` | 3 / 15 |
| a `PreToolUse` gate that refuses the wrong write | **5 / 5** |

Documentation was in the agent's context before it did anything, named the
file, named the call, named the anti-pattern, and warned that stale examples
existed. It lost to one file in the repository that contradicted it, four times
in five. A gate at the moment of the write recovered every trial, and every
gated trial still produced a file — the denial did not cause abandonment.

## The gap

The gate in that experiment was hand-written for that violation. cyv could not
have produced it.

`new AccountService(new AccountRepository(db), clock)` is correct, idiomatic,
type-safe TypeScript. Run through this project's own analyzers it reports
**zero findings across twenty rules**. It is wrong only in that repository, and
only because that repository decided otherwise.

Everything cyv ships is a thing that is wrong everywhere: `any`, an `as` cast,
a swallowed catch. The failure that costs a growing codebase is a thing that is
wrong *here*.

## The shape this must not take

**cyv must not grow its own pattern language.** ESLint has one, Semgrep has
one, both are mature, and a third would be exactly the reinvention this project
has avoided elsewhere. What cyv adds is the gate at the moment of the write,
the not-fixes carried on the denial, and the record of what happened — over
rules whose matching someone else already solved.

`packages/analyzer-eslint/` already exists and is the right bridge. It runs
ESLint through its Node API and maps messages into cyv `Violation`s. It is
untracked, unlisted in `checkyourvibe.json`, and `eslint` is not a dependency,
so `import('eslint')` fails and it falls back to a hardcoded check. The design
is there; the last mile is not connected.

## Requirements

### 1. The bridge works

**1.1** The ESLint analyzer is a first-class analyzer package: tracked,
declared in `checkyourvibe.json`'s `analyzers`, and with `eslint` as a
dependency of the package that needs it.

**1.2** A repository that has an ESLint configuration gets its ESLint findings
through `cyv check`, `cyv hook` and every gate, with the ESLint rule id
carried as the cyv rule id so `cyv explain` and the not-fixes machinery can
address it.

**1.3** A repository with no ESLint configuration is unaffected. The analyzer
reports nothing and says why in diagnostics rather than failing the run.

### 2. A local convention can carry guidance

**2.1** cyv's value on a denial is the guidance, not the refusal. A local rule
must be able to carry its own remediation text and its own not-fixes — the
shortcuts that look like fixes and are not — the way a built-in rule does.

**2.2** Where that text lives is a design question this spec does not settle.
It must not require publishing an npm package to say "in `test/**`, resolve the
service from the container".

### 3. Honesty about what is enforced

**3.1** `cyv check` reports which analyzers ran and which produced nothing, so
a convention that is silently not being enforced is visible. A rule that is
configured but never fires because its analyzer could not load is the failure
mode this whole spec exists to prevent, repeated one level down.

**3.2** The benchmark's convention condition uses this path rather than a
bespoke hook, so what is measured is what a user would get. Until then its
result is labelled as an oracle.

## What would make this wrong

If a local convention expressed through ESLint recovers the fixture no better
than `CLAUDE.md` did, the mechanism is not the gate and this spec is built on a
misreading. The convention condition is now capable of producing that answer,
and it should be run before the bridge is finished rather than after.
