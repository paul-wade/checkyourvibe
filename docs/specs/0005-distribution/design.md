# 0005 — Distribution and installers: Design

## Introduction

**Written after the fact, on 2026-09-02.** Thirteen of this spec's fourteen
tasks landed without a `design.md`, and `tools/spec-workflow.mjs` reports the
gap because one task is still open: work was being dispatched against decisions
nobody wrote down. This recovers the decisions from the tasks that made them and
from the packages they produced, so that the one remaining task — a decision, not
code — is made against a written record rather than a memory.

## The decision that is left, and why it is last

**T5010, "decide what becomes public", is the only open task, and it is not an
implementation task.** Every package carries `private: true`. Removing it is a
release decision, and it is deliberately the last thing done because an
accidental publish cannot be unpublished.

The cost of leaving it unmade is larger than it looks from inside this
repository. Packages that are `private: true` with `workspace:*` dependencies
cannot be installed by anything that is not this checkout. A project that adopts
checkyourvibe therefore cannot run it in CI — CI has no way to install it — and
its only guarantee layer is a local pre-commit hook, which protects a machine
rather than a branch. This is not hypothetical; it is the state of the first
project to adopt the tool.

So the decision is: which packages become public, at what version, and under
what name. It should be made deliberately and it should be made soon, because
every downstream adoption is degraded until it is.

## Publishing is not one package

**Decided:** the tool ships as seven tarballs — core, the analyzers that are
packages, and the adapters — not as one bundle.

**Found the hard way (T5012):** `@checkyourvibe/core` declared no dependency on
any adapter package, so installing core alone produced a tool with no agent
integration at all, and `cyv init` printed five `Cannot find module` lines and
configured nothing. Agent integration is the entire point of the tool, so a core
that cannot reach an adapter is not a smaller install, it is a broken one.

The general shape of the mistake is worth keeping: a package graph that is
correct as a dependency graph can still be wrong as a *product*, and only
installing it somewhere clean shows the difference.

**Also found (T5011):** three of the four analyzers were not packages at all.
An analyzer that exists only as a path inside this checkout cannot be depended
on by a config written for someone else's repository.

## Generated references must be portable, not local

**Decided:** anything `cyv init` writes into a user's repository names a
published package or a bare command, never a path into a checkout.

The generated agent glue previously embedded an absolute path to a local clone.
`doctor` already detected that as drift when the path moved, which made the
problem visible but did not make it acceptable — a reference that is only valid
on one machine is not distribution.

Two consequences carried into tasks: `init` from a published package writes
portable references (T5004), and `cyvCommand` survives an upgrade (T5003) so
that the embedded command keeps resolving after the tool that wrote it changes.

**T5014** found the same class of defect one level up: `init` could not
configure an analyzer for any repository except this one.

## Degrade in the right direction when a toolchain is absent

**Decided:** a user without a .NET toolchain gets a working tool without the C#
analyzer, and is told which analyzer is unavailable and why (T5005).

This follows the project's third principle. The alternative — refusing to
install, or installing and then failing at first run — treats an absent
toolchain as an error when it is an ordinary fact about a machine. What is not
acceptable is silence: an analyzer that is quietly not running is the exact
failure mode principle 2 exists to prevent.

## Two install paths, deliberately

**Decided:** `install.sh` and `install.ps1` (T5007, T5013) serve the
local-clone workflow, and the npm packages serve everyone else. Keeping both is
not indecision — the clone workflow is how this repository is developed, and a
script that only works on one platform would make Windows a second-class
development environment for a project developed on it.

## The proof is an install into an empty directory

**Decided:** this spec's acceptance is T5009 — pack the tarballs, install them
into an empty directory outside this repository, and run `init` then `check` on a
small real project.

This is principle 1 applied to packaging. The first pass found four defects,
including T5012 above; none of them were visible to any test in this repository,
because every test runs inside the checkout where paths resolve and workspace
links exist. The second pass, after the fixes, ran the whole flow: `init` wrote a
portable config naming `@checkyourvibe/analyzer-typescript`, `check` reported
real findings with their guidance and `notFixes`, `doctor` reported every surface
ok and confirmed the embedded command resolved to a bare `cyv`, and `explain`
printed a rule with its pack, evidence and owning analyzer.

## Rejected

**One version per package.** Rejected in favour of one version, one source of
truth (T5001). Independently versioned packages that must be installed together
turn every upgrade into a compatibility matrix, and the packages are not
independently useful.

**Publishing before T5009 passed.** Rejected on the same reasoning as the
principle it comes from: the tests all passed while the tool was unusable
outside its own checkout.

## Open

- **T5010 itself.** Which packages become public, at what version, under what
  name. Stated at the top of this document because it is the whole remaining
  scope of the spec.
- **What `cyv upgrade` (T5006) owes a user whose rule manifests changed
  underneath them.** The command updates generated glue; whether it should also
  report which rules appeared or disappeared since the installed version is not
  settled here, and overlaps 0018's metrics.
