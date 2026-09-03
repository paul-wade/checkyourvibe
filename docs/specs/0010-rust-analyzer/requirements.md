# 0010 — Rust analyzer: Requirements

**Status:** complete
**Created:** 2026-08-27
**Depends on:** 0001

## Introduction

A fourth analyzer, for Rust, on `syn` and `proc-macro2` and no other third-party dependency. The
roadmap framed this as the interesting case for the opposite reason from Python: not a language
missing a type system, but a language whose compiler already refuses most of what a rule like this
would catch. If the rule model does not fit Rust, that was worth knowing before it was tried on
anything else with a strong type system.

## Outcome

It fits only narrowly, and that is the finding, not a caveat on top of one.

The TypeScript pack exists because a static type system has escapes — `any`, `as`, `!`,
`@ts-ignore` — and each escape has neighbouring escapes an agent will reach for instead, which is
what makes a `notFixes` interlock valuable there. Rust does not offer that shape. An unused
`Result` warns at compile time, `unsafe` is explicit and lexically scoped, and a panic cannot be
mistaken for a normal return. `cargo check` and `clippy` already do most of the job this project's
rule model exists to do elsewhere.

What is left is four habits the compiler permits without comment: `.unwrap()`/`.expect()` in
library code, `todo!()`/`unimplemented!()` reaching a commit, an `unsafe` block with no written
justification, and `let _ = ...` silencing a `#[must_use]` or `Result`. The `core-rust` pack
(`no-unwrap`, `no-panic-in-library`, `no-unsafe-block`, `no-ignored-result`) covers exactly that —
a guardrail against habits, not a safety net under a weak type system — and it passes 11/11
conformance. It is worth having for consistency with every other pack, not for its coverage.

## A manifest can pass conformance and still be unloadable anywhere else

The manifest's `exec` declaration originally named `./target/release/analyzer-rust.exe` directly.
It passed all 11 conformance checks — on the machine that wrote it.

Conformance checks the shape of a manifest: does it declare a valid `exec`, do its rules have the
required fields, does every `notFixes.rule` reference resolve. It cannot check whether the named
executable exists anywhere but the machine running the check, and a native binary's name is not
portable — `analyzer-rust` on Unix, `analyzer-rust.exe` on Windows — while `target/` itself is
gitignored and never committed. On any other machine the analyzer would not have crashed. It would
have loaded nothing, `cyv check` would have reported zero violations for every Rust file, and the
report would have come back clean. A clean report and an analyzer that silently never ran produce
the same output.

The manifest now invokes `cargo run --release --quiet --manifest-path ./Cargo.toml`, which resolves
on any machine with the toolchain installed, at the cost of a process launch and a freshness check
per invocation. **Conformance proves a manifest is well-formed. It does not prove the thing it
points at exists anywhere but here** — that has to be checked by running the manifest somewhere
else, which no automated gate in this repository currently does for a compiled analyzer.

## A terminal rule is an honest rule

`no-unsafe-block`'s `notFixes` entries have no `rule` field. An ordinary comment without a
`SAFETY:` marker and hoisting `unsafe` into the function signature are both named as tempting
non-fixes, but neither is pointed at a sibling rule in the pack, because neither actually launders
the problem into one. The other three `core-rust` rules cross-reference each other — swapping
`.unwrap()` for `.expect()` still trips `no-panic-in-library`; forcing a value out with
`unsafe { ... }` still trips `no-unsafe-block` — because those substitutions really do move the
violation somewhere else in the pack. `no-unsafe-block` has no such neighbour to point to.

The scaffold in 0012 could have manufactured one anyway — pointed the ordinary-comment non-fix at
`no-unsafe-block` itself, say, just to make the interlock graph look denser and every rule appear
interconnected. That would have been worse than leaving the edge absent. A `notFixes.rule` is a
claim that trading one violation for a specific other one is a known move; an invented edge is a
false claim, and the value of every true edge in the graph depends on readers being able to trust
that the graph contains only true ones. An absent edge says "this dead end goes nowhere in this
pack." A manufactured one says something false about where it goes.

## Requirements met

1. Reads one `AnalyzeRequest` from stdin, writes one `AnalyzeResponse` to stdout, nothing else on
   stdout; a caught panic becomes a well-formed error response and a non-zero exit, not a Rust
   backtrace on stdout.
2. A file that fails to parse becomes a `skipped` entry with its reason.
3. A malformed request produces a well-formed response whose diagnostics explain the problem, and a
   non-zero exit.
4. Test-context detection (`#[test]`, `#[cfg(test)]`, and boolean combinations of `cfg` predicates
   via `all`/`any`/`not`) excludes `.unwrap()` inside tests from `no-unwrap`, because a test
   asserting is not a library making an assumption.
5. `fixtures/*.bad.rs` each produce exactly one finding for the matching rule; `fixtures/*.ok.rs`
   produce none, including the false-positive guards — `.unwrap()` in `#[cfg(test)]`, a `main`
   returning `Result`, an ordinary non-`SAFETY:` comment before an `unsafe` block.
6. No third-party dependency beyond `syn`, `proc-macro2`, and `serde`/`serde_json` for the protocol
   itself, and no package manager was run outside `cargo`.
7. `node test/run-fixtures.mjs` builds the release binary, resolves `exec` from the manifest exactly
   as `cyv check` would, and drives every fixture pair plus a malformed-request case.

## Not registered by default

The analyzer is built and conformant but is **not** listed in this repository's `checkyourvibe.json`
— only `typescript` and `csharp` are registered there. There is no Rust source in this repository to
check, and registering an analyzer that will never match a file would add a `cargo`-toolchain
prerequisite and a process-launch cost on every `cyv check` for no benefit.

## Non-goals

Replacing `cargo check` or `clippy`. Anything that requires borrow-checker or trait-resolution
information — this analyzer reads `syn`'s syntax tree only, the same evidence class as the Python
analyzer, and every rule declares `evidence: 'syntax'` accordingly. A rule for any habit the
compiler already refuses to compile.
