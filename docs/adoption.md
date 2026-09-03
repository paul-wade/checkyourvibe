# Adopting checkyourvibe on an existing codebase

## The barrier

A team turning this on for the first time is not looking at zero violations. They are
looking at hundreds or thousands, on code nobody currently has time to touch, written before
these rules existed. Telling that team "fix everything, then turn it on" is not a path to
adoption. It is a polite way of telling them not to bother, and the honest ones will hear it
that way.

So the tool has to work the other way around: record what is already broken, stop it from
getting worse, and let the team pay it down on their own schedule — without ever pretending
the debt isn't there. That is the whole point of what follows. It is not a feature tour; it
is the order you actually do these things in.

## Step 1 — take a baseline

```
cyv baseline
```

This runs a full check, reports how many violations it found, and asks for confirmation
before writing anything (`--yes` skips the prompt for a non-interactive first run). Nothing
is written until you confirm — taking or replacing a baseline is always a deliberate act,
never a side effect of a check.

```
This run found 4123 violation(s) across the repository.
No baseline exists yet; this will create one.
Write the baseline? [y/N] y
Baseline written: 4123 violation(s) recorded against commit 8f2c1a9.
These are now deferred, not fixed. They still exist, and every run of `cyv check`
continues to know about them; use `cyv baseline --status` to track burn-down.
```

That last line is the whole idea in one sentence. What gets written is a committed file,
`checkyourvibe.baseline.json`, one entry per line so a pull request diff shows exactly what
was added or removed:

```
{"path":"src/legacy/report.ts","ruleId":"no-any","fingerprint":"3f9a7c…","occurrence":0,"line":42}
```

Each entry identifies a violation by rule, repo-relative path, and a hash of the normalized
violating snippet — not `file:line`. A `file:line` identity breaks the moment someone adds an
import above the finding; every line after it shifts, and the baseline stops matching
something that never actually changed. Identity here survives that. It does not survive an
edit that rewrites the snippet itself — that reads as a brand-new violation, on purpose: the
alternative, treating a rewritten violation as "the same one" because it still trips the same
rule, risks a genuinely different problem quietly inheriting an old entry's already-known
status. One extra line in a report is a cheaper mistake than a new violation nobody sees.

## Step 2 — gate new code

```
cyv check --since-baseline
```

This is what belongs in CI. It hides violations the baseline already knows about from the
main list, and reports the rest — the ones that are actually new. A violation that moved but
didn't change (an unrelated edit shifted its line) is recognized as the same one, not
reported as fresh. A new violation in a file that already has baselined debt is still
reported: the baseline is per-violation, not per-file, so touching a bad file doesn't grant
immunity to add more bad code to it.

Plain `cyv check`, with no flag, shows you everything — old and new violations both, and it
exits non-zero if any of them are errors. That is deliberate (Requirement 2.5): a user who
types `cyv check` sees the truth, not a filtered view. `--since-baseline` is what you opt
into for the gate; it is never the default.

## Step 3 — burn down deliberately

```
cyv baseline --status
```

```
Baseline taken 2026-08-01T00:00:00.000Z against commit 8f2c1a9.
3811 baselined violation(s) remain, out of 4123 recorded.

By rule:
   1204  no-any
    892  no-non-null-assertion
    ...

By file (worst first):
     61  src/legacy/report.ts
     54  src/legacy/exporter.ts
     ...

312 baselined entries no longer match anything and can be dropped (the underlying
violation appears to be fixed) — run `cyv baseline` to shrink the baseline.
```

No score, no streak, no percentage bar — a number and a direction, by rule and by file. The
by-file list is where effort actually pays: a handful of files carrying dozens of instances
of the same rule are worth fixing before scattered one-off violations, because one pattern
fix clears many entries at once. `--status` also flags baseline entries whose rule has since
been disabled entirely (dead weight worth pruning) and entries that no longer match anything
current (fixed, but not yet reflected — re-run `cyv baseline` to drop them).

## A baseline is deferred debt, not a solution

Every run of `cyv check` — with or without `--since-baseline`, baseline hidden from the list
or not — prints how many violations the baseline is currently carrying:

```
  3811 violations deferred by the baseline (hidden by --since-baseline).
```

This line cannot be turned off, and it prints even on a run that otherwise looks clean. The
reason is not nagging: a team that has forgotten it is carrying four thousand deferred
findings is worse off than a team that never adopted the tool at all, because the first team
believes a green run means the code is clean, and the second team never had that illusion.
Baselined violations are deferred. They are never invisible. If this line ever stopped
printing, the baseline would have quietly turned into a lie.

## The pre-commit hook — and what actually stops a bad commit

```
cyv install-hooks
```

installs a pre-commit hook (native git hooks, husky, or lefthook, detected automatically)
that runs `cyv check --staged --strict` before a commit is allowed. Be clear about what that
buys you: `git commit --no-verify` skips it entirely. A hook only runs if the person or agent
committing chooses to let it. **CI is the layer that cannot be bypassed, and it is the layer
you should actually rely on** — the hook is a fast local warning, not the backstop.

The installed hook is baseline-aware. It checks for `checkyourvibe.baseline.json` at commit time
and runs `cyv check --staged --strict --since-baseline` when one is present, falling back to
`cyv check --staged --strict` when it is not. That test happens in the hook rather than being
baked in, because passing `--since-baseline` on a repository with no baseline would fail every
commit. So installing the hook on a codebase that already carries debt blocks new violations
without blocking every commit that touches an old file — and the deferred total is still
reported on each run, because that line cannot be turned off.

## Suppressions: a reason and an expiry, never a bare ignore

A baseline defers everything that existed when it was taken, wholesale. Sometimes you want to
say "not this one, specifically, and here is why" — for one violation, going forward, not
because it predates the tool. That is what a suppression is for, declared in
`checkyourvibe.json`:

```json
{
  "suppressions": [
    {
      "ruleId": "no-any",
      "target": "src/legacy/exporter.ts",
      "reason": "Third-party callback signature has no usable type until the next major bump.",
      "expires": "2026-12-01"
    }
  ]
}
```

`reason` and `expires` are both required — there is no bare ignore directive anywhere in this
tool, on purpose. An exemption with no stated reason and no end date is functionally
permanent and indistinguishable, six months later, from an oversight nobody caught. Naming
the reason forces the decision to be a decision, made by someone, for a stated cause; the
expiry forces it to be revisited rather than fossilizing. A suppression naming a rule that no
longer exists is treated as a configuration error, not silently ignored — that is almost
always a rule rename nobody propagated, and the loader stops the run rather than quietly
doing nothing.

`cyv check` applies suppressions on every run, not just under `--since-baseline`, and reports
the count on every run too, the same way it reports baselined violations:

```
  6 active suppressions, 2 expiring within 30 days. 4 findings suppressed this run.
```

An expired suppression stops suppressing automatically, and the run names it specifically the
moment its violation reappears — not just a count going up, but the rule, the target, and the
original reason, so whoever sees it knows exactly what lapsed and why it existed.

The suppression above matches by rule and path. It defers every occurrence of that rule under
the path, including violations written next month, so a new mistake in a covered file is hidden
without anyone deciding it should be. Every run names these unpinned suppressions for that
reason:

```
  1 of those is unpinned — they suppress every occurrence of their rule under a path, including
  findings not yet written:
    no-any on "src/**" — Adoption sweep, tracked in TICKET-1.
```

To defer one specific finding instead, pin the suppression to the same durable identity the
baseline uses. Ask for it by location, and paste what comes back:

```
cyv check --pin src/legacy/exporter.ts:42 \
  --reason "Third-party callback signature has no usable type until the next major bump."
```

```json
{
  "ruleId": "no-any",
  "target": "src/legacy/exporter.ts",
  "reason": "Third-party callback signature has no usable type until the next major bump.",
  "expires": "2026-12-01",
  "fingerprint": "d6a7cd2a7371b1a15d543196979ff74fdb027023ebf187d5d329be11055c77fd",
  "occurrence": 0
}
```

That object goes into the `suppressions` array in `checkyourvibe.json` exactly as printed. It is
the only thing on stdout, so `cyv check --pin … | pbcopy` works; the explanation of what it defers,
and the usual suppression notice, go to stderr.

`--pin` runs a real check against the file you named and reads the identity off the finding it
reported there, so the values are the ones the loader will match — `fingerprint` is a hash of the
offending snippet and `occurrence` is that finding's index among identical snippets in the file.
Neither is a number anyone can work out by reading the source, which is why the tool hands them
over rather than asking you to transcribe them from `checkyourvibe.baseline.json`.

`--reason` is required, because a suppression must say why and the tool does not know. `--expires`
is optional and defaults to 90 days out; the run says which date it chose. If the line carries more
than one finding, `--pin` refuses to guess and lists them, so narrow it with a column
(`--pin src/legacy/exporter.ts:42:31`) or a rule (`--rule no-any`):

```
2 findings at src/legacy/exporter.ts:42, and a pinned suppression names exactly one:
    no-any at 42:26
    no-any at 42:34
  Narrow it with a column (--pin file:line:column) or a rule (--rule <id>).
```

`fingerprint` and `occurrence` go together, and a pinned `target` is an exact path rather than a
glob; the loader rejects any other combination. Together the four fields name one finding, so a
pinned suppression defers exactly one and a violation added to the same file afterwards is still
reported. The fingerprint alone is not enough to pin anything: it hashes the offending snippet,
and for a rule like `no-any` that snippet is the word `any`, which is identical everywhere — which
is also why two `any`s on one line differ only in `occurrence`, and why the column selector exists.

## When the numbers don't move

This is the normal case, not a malfunction. Gating new code stops the debt from growing; it
does nothing on its own to shrink it. If nobody is spending deliberate time against the
baseline, `cyv baseline --status` will report the same count next week that it reported this
week, and that is an accurate report, not a broken one.

What the status command is for is telling you where a fixing session is worth the most: the
files at the top of the by-file list, especially where one rule dominates, are where a single
afternoon clears the most entries. Entries under a rule that's been disabled are free —
they cost nothing to remove, only a `cyv baseline` re-run to drop them. If the "no longer
match anything" count keeps climbing between status checks, debt is actually shrinking even
if nobody is watching it happen; re-run `cyv baseline` periodically to let the file reflect
that and stop carrying entries for problems that are already fixed.

## What this will and won't do

It will let a team turn this on today, on a codebase this size, without fixing anything
first. It will stop new violations from being added starting the moment CI enforces
`--since-baseline`. It will keep the size and location of existing debt visible instead of
letting it disappear into a passing check. It will not fix a single line of code — burn-down
is a deliberate, human decision, on a schedule the team sets. It will not stop a determined
commit with `--no-verify`. And a baseline, however it's phrased, is not progress — it
is a record of exactly how much progress still has to happen.
