# Overnight work queue

Work waiting to be dispatched, ordered so the next item can be picked without
re-deciding. Each entry names the lane it should go to and why.

Placement follows Requirement 9.1 of spec 0011: the smallest capable executor.
Mechanical transformation with a checkable outcome goes to a free or spare lane;
work whose failure is expensive stays where the strongest model is.

## Ready to dispatch — mechanical, gate-checkable

- **Adapter header sweep.** Four adapters were found carrying headers describing
  a relative `../core` import the code no longer uses. Those four were fixed;
  the remaining adapters have not been read against their code.
  _Lane: any. Gate: `cyv-check`, plus the full suite._
- **`docs/STATUS.md` entry for the night.** The review dashboard reads this file
  for its changelog. It has no entry for anything landed since the squash.
  _Lane: any. Gate: the dashboard renders it._
- **Fixture harness for `analyzer-comments`.** It is covered by vitest, so the
  coverage guard passes, but it is the only analyzer without a
  `test/run-fixtures.mjs`, which is what CI's fixture step iterates.
  _Lane: any. Gate: `node packages/analyzer-comments/test/run-fixtures.mjs`._
- **`cyv check --report` documentation.** The flag landed with `--help` text but
  `docs/getting-started.md` and `docs/adoption.md` still describe the old
  output shape.
  _Lane: any. Gate: read the docs against a real run._

## Needs judgment — keep on the strongest lane

- **Requirement 3.6, blocked dispatches.** A work item stranded by cooldown
  currently surfaces as a `no-eligible-lane` refusal. Distinguishing "blocked
  for lack of an escalation target" needs cross-lane escalation on rate
  exhaustion (3.3), which is not built.
- **In-field hand edits are invisible to `cyv upgrade`.** Rewriting a paragraph
  in place leaves no stray line, so it reads as generated output for an older
  rule and gets replaced. Fixing it means each adapter recording provenance
  when it generates.
- **Task-kind set.** Two values exist because Requirement 8.1 names two in its
  own text. The spec's open questions leave the final set undecided.

## Owner's decision, not an agent's

- **T5010 — what becomes public.** Removing `private: true` cannot be undone.
- **Lane misconfiguration severity.** `cyv doctor` treats a lane naming an
  unconfigured agent as `[error]` with exit 2, matching an unresolvable
  analyzer. Softening it to drift is a one-line change if that is too strict.
