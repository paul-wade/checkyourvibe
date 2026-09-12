# 0061 — A local Postgres index, and proving it stays in step

**Status:** experimental
**Created:** 2026-09-07
**Constrained by:** 0051 Requirement 5.1 — every fact has exactly one owner

## What this is

A local Supabase stack alongside cyv, for three things files are genuinely bad
at: signing in without copying a token, updating a page from the data rather
than by watching files, and asking whether something is *similar* to something
else.

It is explicitly an experiment. The measurement in Requirement 5 decides
whether it ships, and the honest outcome may be that it does not.

## Requirement 1 — Postgres indexes; it does not own

1.1. These keep their existing owner and remain the source of truth, because
the CLI reads them and git carries them: the dispatch log, the comment store,
lane declarations, spec and task files, and the rule manifests.

1.2. Postgres SHALL hold a **projection** of those: synced, queryable,
searchable, and watchable. A projection that disagrees with its source is
wrong by definition and SHALL be rebuilt from source, never reconciled toward.

1.3. Postgres SHALL own outright only facts with no file home today: sessions
and their status, users and auth, embeddings, and dashboard state. Ownership
here is real ownership; those are not projected from anywhere.

1.4. No reader SHALL require Postgres to be running. `cyv check`, `cyv
dispatch` and the hook keep working with the stack down. Postgres makes things
fast and joinable; it never becomes load-bearing for enforcement.

## Requirement 2 — Forced lock-step

The failure mode of any index is silent drift, and this project has already
recorded three cases of a system carrying on while wrong.

2.1. Every projected row SHALL carry the **content hash and byte offset** of
the source record it came from, so agreement is checkable rather than assumed.

2.2. A **sync generation** SHALL be recorded per source file: its size, its
mtime, its content hash, and the last offset ingested. Sync is append-driven
where the source is append-only, which the dispatch log and comment store are.

2.3. A reader SHALL be able to demand lock-step: verify the projection is
current against the source before answering, and if it is not, either sync
first or answer from the files. Under lock-step a stale answer is not
permitted.

2.4. Drift SHALL be **detectable without a full rescan**: comparing the stored
source hash and offset against the file on disk is cheap and is the check
2.3 performs.

2.5. Any detected drift SHALL be surfaced as a needs-you item naming the source
and the divergence, not repaired silently. A projection that quietly fixes
itself hides how often it breaks, which is precisely what Requirement 5 must
measure.

## Requirement 3 — Auth

3.1. The dashboard SHALL authenticate through the local auth service, so
reaching it does not require copying a token that dies on restart.

3.2. The token mechanism SHALL remain as the fallback for when the stack is
down, per Requirement 1.4.

## Requirement 4 — Similarity

4.1. Rules, findings and notFixes SHALL be embedded and searchable by
similarity, to answer: does a rule already cover what this person is
describing; is this finding the same defect as that one in different words;
which past dispatches resemble this one.

4.2. A similarity answer SHALL always show what it matched and how closely.
An unexplained "these are the same" is a claim, and this project does not ship
claims without evidence.

## Requirement 5 — The experiment that decides this

Adopt nothing on faith. Measure, and record the numbers here.

5.1. **How easily does it drift?** Instrument a real working session and count:
how many times the projection was behind when read, by how much, and after
which operations. A dispatch writing 200 log lines, a concurrent agent, an
external edit, the stack restarting mid-run.

5.2. **What does lock-step cost?** Measure the added latency of the
verify-before-answer path in 2.3 against answering from files directly. If
lock-step costs more than reading the file, the index has negative value for
that query and SHALL be bypassed for it.

5.3. **What does it cost to run?** One stack is eleven containers. Measure
memory and startup against the 10 GB WSL cap set on 2026-09-07, and against a
dispatch running at the same time. Three idle stacks starved this machine and
killed three dispatches; one stack must not repeat that.

5.4. **Is the sync ever wrong rather than merely late?** A row disagreeing with
its source is a different and worse failure than a row being behind. Count them
separately. One instance of the former should stop this experiment.

5.5. If drift is frequent, or lock-step costs more than reading files, or the
stack cannot coexist with a dispatch, this spec SHALL be closed as failed and
the reasoning recorded. That is a legitimate outcome.

## Non-goals

- Postgres as the source of truth for anything git carries.
- pg_graphql or a graph engine for the interlock graph. It is 60 edges; that is
  a map in memory.
- Multi-user or hosted anything. Single developer, local stack.
