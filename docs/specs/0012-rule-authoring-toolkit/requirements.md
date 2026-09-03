# 0012 — Rule authoring toolkit: Requirements

**Status:** complete
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

`cyv new-rule`, scaffolding a rule, its manifest entry template, its fixture pair, and its test.
The roadmap's framing: rule count grows only as fast as authoring is cheap, and a scaffold that
forces the `notFixes` graph to be filled in — rather than leaving it for later — is how the
interlock stays a property of the pack instead of a happy accident that depends on the author
remembering.

## Outcome

The command detects the target analyzer's rule interface from `src/rule.ts`, refuses a rule id
that already exists in the analyzer's manifest, never overwrites a file that is already there, and
supports `--dry-run` to print what it would create without writing anything. What it generates is a
rule source file whose manifest object has every `RuleGuidance` field present as an unmissable
`TODO:`-prefixed placeholder — including a `notFixes` entry with a `rule` field commented as only
valid pointing at a sibling rule in the same analyzer — plus a `.bad`/`.ok` fixture pair and a test
file with `it.todo` stubs naming the two obligations a real test has to discharge.

It targets `packages/analyzer-typescript` by default and any analyzer directory via `--analyzer`,
detected by regex-matching an `export interface` in `src/rule.ts` whose body contains both
`manifest:` and `check`, and by checking `src/util.ts` for an exported `makeViolation` to decide
whether to generate a call to it or a bare TODO.

## The finding: a scaffolded rule does not run

A file created by `cyv new-rule` compiles, its `it.todo` test passes trivially, and it sits in
neither the analyzer's rule exports (`src/rules/index.ts`) nor its `analyzer.manifest.json`. `cyv
check` therefore neither loads it nor mentions it anywhere in its output. There is no error, no
warning, no skipped-file entry — the run simply looks exactly like one where the new rule was never
authored.

That exact omission had already happened twice in this repository before this spec was written: a
rule pack that expanded to nothing because nothing referenced it, and a finished rule whose manifest
entry was never added. Both looked like a clean pass. Neither was caught by a test, because the test
for the rule itself passed — the gap was entirely outside what a rule's own test can see.

The command's answer is not to close the gap silently but to say it out loud. After scaffolding (or
under `--dry-run`, before writing anything), it prints the exact wiring steps still required:
export the rule from the analyzer's index, add its manifest entry, fill in every placeholder because
a manifest whose `why` still reads `TODO` is guidance an agent will follow literally, declare its
`notFixes`, and finally run `cyv verify-analyzer` against the manifest. **A scaffold that produces
something inert without saying so is a trap, not a convenience** — the omission it invites is
indistinguishable from success until someone goes looking for the rule that should have fired and
does not find it. Any future generator in this project should be held to the same standard: silence
about what it did not finish is the failure mode, not the missing wiring itself.

## Open question: should `new-rule` register the rule itself?

Left open rather than decided.

**For automatic registration:** it closes the exact gap the finding above describes. If the command
added the export and the manifest entry itself, the two-lines-missing failure could not recur,
because there would be nothing left for the author to forget.

**Against it:** a scaffolded rule's `check` function returns `[]` unconditionally and its manifest
is TODO prose. Automatic registration means that placeholder — with `why: 'TODO: explain why...'`
and a `notFixes.pattern` that reads `TODO: describe a tempting non-fix` — becomes reachable from a
real `cyv check` run the moment the file is created, before the author has written a single line of
actual logic. A rule that matches nothing is invisible and harmless; a rule that is registered,
matches nothing yet, and carries TODO guidance in its manifest is worse than the current gap, because
`verify-analyzer` and a stray `cyv explain` could both surface placeholder text as if it were shipped
guidance. The current design treats "scaffolded" and "registered" as a real boundary an author
crosses deliberately, once the manifest prose is no longer a placeholder, and prints the checklist
so the crossing is not accidental in the other direction — forgotten, not just deferred.

## Requirements met

1. Validates the rule id (`^[a-z][a-z0-9-]*$`) before touching the filesystem.
2. Detects the analyzer's rule interface from `src/rule.ts`; errors clearly for an analyzer that
   does not expose one, naming the file it looked at.
3. Reads existing rule ids from `analyzer.manifest.json` and refuses a duplicate before generating
   anything.
4. Never overwrites: every target path is checked for existence up front, and the whole scaffold is
   rejected — not partially written — if any one of the four target files already exists.
5. `--dry-run` performs every check above, including the duplicate-id and existing-file checks, and
   prints the would-create list and the wiring notice without writing.
6. Generated rule source has a `RuleManifest` with every `RuleGuidance` field present, a `notFixes`
   entry whose `rule` field is commented as only valid pointing at a sibling rule in the same
   analyzer, and a `check` function stub that returns `[]`.
7. Generated fixtures and test file are non-empty, syntactically loadable, and the test file's
   `describe` block names the rule id.
8. Exit code 2 and a message on stderr for every rejection path (unknown flag, missing rule id,
   duplicate id, existing file, undetectable rule interface); exit 0 with the file list on success
   or under `--dry-run`.

## Non-goals

Writing the rule's actual detection logic — that is left entirely to the author; the scaffold's job
ends at a compiling, well-shaped placeholder. Automatic registration (see the open question above).
Scaffolding a rule for an analyzer whose rule interface this command cannot detect, such as the
subprocess analyzers, which have no `src/rule.ts` to introspect.
