# 0055 — Ask git which files exist before hashing them

**Status:** active
**Created:** 2026-09-06
**Amends:** 0011

## Problem

`packages/core/src/executor/snapshot.ts` walks the working tree and hashes
every file it finds, reading the full bytes of each to produce a sha256. It
has no ignore logic of its own. `.gitignore` is consulted later, by
`executor/ignored.ts`, and only to exclude ignored paths from the *ownership
judgement* — after they have already been walked and read.

Measured on this repository, 2026-09-06:

| | |
|---|---|
| Files git tracks | 540 |
| Files on disk | 125,807 |
| Bytes on disk | 645 MB |

Each dispatch attempt takes a before and an after snapshot, so one attempt
reads 645 MB and performs roughly a quarter of a million file opens to learn
about 540 files, then discards most of the result. Cost scales with the size
of the build and dependency tree rather than with the size of the repository.

This is not a large-repository concern. It is already the dominant cost of a
dispatch here, and it blocks the end-to-end benchmark plan, which requires
cloning real applications — all of which carry dependency trees.

## Requirement

1. The snapshot SHALL obtain its candidate path list from git before hashing
   anything: tracked files, plus untracked files that are not ignored.
2. A path git reports as ignored SHALL NOT be read or hashed. It is already
   excluded from the ownership judgement, so hashing it produces nothing.
3. The observation SHALL remain whole-repository by default in the sense that
   matters: any write to a path in that candidate set, inside or outside the
   declared ownership, is still visible. Narrowing the *hashing* to git's view
   must not narrow the *judgement*.
4. When git cannot be asked — not a repository, git absent, command failure —
   the snapshot SHALL fall back to the current full walk rather than silently
   observing nothing, and SHALL report that it did.

## Non-goals

- Incremental or partial snapshots, filesystem monitors, sparse checkouts.
  Those are scale work and should wait for a repository that needs them; this
  change alone moves the ceiling further than any of them.
- Changing what an out-of-scope write means, or which paths the ownership
  judgement covers.
