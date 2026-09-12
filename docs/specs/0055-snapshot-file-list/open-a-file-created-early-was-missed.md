# Open: a file created early in a dispatch was not observed

Found 2026-09-06, immediately after spec 0055 landed. **Unproven.** Recorded
so it is not lost.

## What was seen

The `t51-spec-editor` dispatch declared two files and created both. Its
outcome reported only one:

```
observed on disk: 1 path(s) changed — packages/core/src/dashboard/spec-editor.ts
outcome succeeded — changed 1 declared file(s) and every gate passed
```

`packages/core/test/dashboard/spec-editor.test.ts` was created by the same
dispatch, exists, is untracked, is not ignored, is listed by
`git ls-files --others --exclude-standard`, and contains 25 passing tests.
It was not observed.

Modification times: the missed test file 00:59, the observed source file
01:01. The file that vanished is the one written *earlier*.

## Why it is not the obvious cause

The snapshot's own tests cover exactly this case. `snapshot.test.ts` writes
`src/added.ts` after the before-snapshot and asserts it appears in
`diffSnapshots`. That test passes, and the full suite is green at 1335 tests.
So detection of newly created files works when the ordering is clean.

## Hypothesis

A race between taking the before-snapshot and starting the executor. If the
before-snapshot is still enumerating, or completes after the executor has
begun writing, a file created in that window is captured in BOTH snapshots
with the same digest and therefore reads as unchanged.

The timestamps fit: the earlier-written file is the one that disappeared.

This would predate spec 0055 rather than be caused by it, but 0055 made it
far more likely to bite, because the snapshot now completes in milliseconds
instead of seconds and the ordering matters more when both events are fast.

## Why it matters

A missed write is worse than a false one. `produced-nothing` and
`out-of-scope-write` both depend on the changed set being complete. If a
dispatch can create a file the observation never sees, then an agent can
write outside its declared ownership and be recorded as clean, which is the
one thing this classification exists to prevent.

## How to settle it

Instrument the dispatch to log the wall-clock time the before-snapshot
completes and the time the executor process starts, then run a dispatch whose
task writes a file immediately. If the write lands before the snapshot
completes, the hypothesis holds and the fix is to fully persist the
before-snapshot before spawning.

Also worth checking: whether `takeSnapshot` and `persistSnapshot` are awaited
to completion on the dispatch-open path, or whether the spawn is scheduled
alongside them.

## Hypothesis disproven

The race hypothesis above is wrong. `packages/core/src/executor/run.ts:153`
awaits `takeSnapshot` to completion and only then awaits `runChild`, so the
before-snapshot cannot still be enumerating when the executor starts. The
timestamp coincidence was a red herring.

## Next suspect, with a reason

`run.ts:159-161` does not judge the raw diff. It splits it first:

```
const split = await splitGeneratedPaths(request.repoRoot, diffSnapshots(before, after));
const changedPaths = split.authored;
```

The comment explains why: a gate that compiles the project leaves build output
behind, and ownership is a claim about what the executor authored, so generated
paths are separated before judgement. `executor/ignored.ts` decides which is
which, and its own doc comment says `.gitignore` is the repository's statement
of what is generated.

So a path classified as generated disappears from `changedPaths` even though
the snapshot saw it perfectly well. That matches the symptom exactly: the
observation line reports the authored set, not the diff.

`git check-ignore` run afterwards reports the file as NOT ignored, so this is
not simply a gitignore match. Things to check next, in order:

1. Whether `splitGeneratedPaths` was asked about the right paths, in the right
   form. Repo-relative versus absolute, and forward versus backslash
   separators on Windows, are the obvious ways `git check-ignore` gets asked
   the wrong question and answers unhelpfully.
2. Whether a `check-ignore` failure is treated as "generated" rather than
   "authored". A failure that defaults toward generated would silently drop
   real writes, which is the wrong direction to fail in: an unknown path
   should be judged, not excused.
3. Whether the vitest gate running during the dispatch touched that file's
   mtime or wrote alongside it in a way the split then attributed to the gate.

Suspect 2 is the one worth checking first, because it would be a silent
failure biased toward exonerating the executor, and that is precisely the
direction this project exists to distrust.

## Suspect 2 cleared, and the design is right

`splitGeneratedPaths` fails in the safe direction. When `git check-ignore`
cannot be asked, it returns every changed path as `authored`, `generated`
empty, and an `undetermined` note saying so. Nothing is silently excused. Exit
1 is correctly treated as the answer "none of these are ignored" rather than a
failure.

So the wrong-direction failure this file worried about does not exist here.

## What is left

Only a mismatch in how the path is spelled on each side, or a diff that did
not contain the file to begin with. Both sides pass through
`normalizeOwnedPath`, so a separator or relativity mismatch would have to
survive that.

This now needs instrumentation rather than reading: log the raw
`diffSnapshots` output alongside `split.authored` for one dispatch that
creates two files, and see which of the two stages loses the path. Until then
it stays open, and dispatch verdicts should be checked against `git status`
rather than trusted on their own.

## Resolved as far as this code path goes

A regression test now drives `run.ts` directly and asserts a dispatch observes
every file it creates, carrying the raw diff alongside the authored set. It
passes. So the snapshot, the diff and the generated/authored split are all
correct at this level, and the loss came from outside them.

The blind spot that hid it is now closed. The dispatch carries the raw diff,
the generated set and the `undetermined` note through to its output, and prints
`N path(s) treated as generated and excluded from the judgement — <paths>`
whenever the split discards anything. Silent when it discards nothing.

That is the real fix. A judgement that drops paths without saying so cannot be
audited, and this is twice in one night that a verdict was wrong in a way
nothing in the output could reveal. If it recurs, the output will now name
which stage lost the path.

Leaving this file open rather than closing it, because the original loss was
never explained — only made visible if it happens again.
