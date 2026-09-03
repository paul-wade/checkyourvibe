# Rust analyzer

A subprocess analyzer for `.rs` files, built on `syn`. Four rules: `no-unwrap`,
`no-panic-in-library`, `no-unsafe-block`, `no-ignored-result`.

## Build

```
cargo build --release
```

The manifest invokes `cargo run --release --quiet --manifest-path ./Cargo.toml` rather than a
built binary path directly. A native binary's name differs by platform — `analyzer-rust` on Unix,
`analyzer-rust.exe` on Windows — and `target/` is not committed, so a manifest naming one would
resolve on the machine that wrote it and nowhere else. That is precisely the kind of failure this
project treats as worse than an error: the analyzer would not crash, it would simply never load, and
the report would come back clean.

Going through `cargo` costs a process launch and a freshness check per run. If that becomes the
dominant cost, it belongs in the caching work (roadmap 0013), not in a platform-specific path here.

## Where this rule model fits Rust badly

Honestly: narrowly.

The premise behind the TypeScript pack is that the type system can be escaped — `any`, `as`, `!`,
`@ts-ignore` — and that each escape has neighbouring escapes an agent will reach for instead. That
premise is what makes the `notFixes` interlock valuable there. Rust does not have that shape. Its
compiler already refuses most of what a linter elsewhere has to discover: an unused `Result` warns,
`unsafe` is explicit and scoped, and a panic cannot be mistaken for a normal return.

So this pack is not a safety net under a weak type system. It is a guardrail against four habits the
compiler permits:

- `.unwrap()` in library code, where the caller has no way to recover from your assumption.
- `todo!()` / `unimplemented!()` reaching a commit.
- an `unsafe` block with no written `// SAFETY:` justification — the compiler checks nothing here,
  and the comment is the only artifact a reviewer has.
- `let _ = ...` silencing a `#[must_use]` or a `Result`.

`cargo check` and `clippy` remain the primary tools. This analyzer adds a project-wide, configurable
layer with the same guidance-and-dead-ends model as every other pack, and it is worth having for
that consistency rather than for its coverage.

The interlock is correspondingly thinner. `no-unsafe-block` is terminal: its plausible non-fixes
(an ordinary comment without a `SAFETY:` marker, hoisting `unsafe` to the function signature) do not
launder the problem into a different rule in this pack, and inventing an edge to make the graph look
denser would teach an agent to distrust the edges that are real.

## Fixtures

`fixtures/*.bad.rs` must each produce exactly one finding for the matching rule; `fixtures/*.ok.rs`
must produce none. The `.ok.rs` files are false-positive guards, not merely clean code — `.unwrap()`
inside a `#[cfg(test)]` module is a test asserting, not a library making an assumption, and a `main`
returning `Result` is not a library at all.

```
node test/run-fixtures.mjs
```
