# analyzer-csharp

A checkyourvibe analyzer for C#, built on Roslyn (`Microsoft.CodeAnalysis.CSharp`) and run as a
subprocess. It implements the published protocol in `docs/protocol/` and
`docs/writing-an-analyzer.md` only — it does not import, reference, or depend on any
`@checkyourvibe/*` package.

## Layout

- `src/` — the .NET console project (`CheckYourVibe.Analyzer.CSharp`, target `net9.0`). Reads one
  `AnalyzeRequest` as JSON from stdin, writes one `AnalyzeResponse` as JSON to stdout, exits 0 (or
  non-zero on a malformed request).
- `analyzer.manifest.json` — the static manifest: protocol 1, id `csharp`, `match: ["**/*.cs"]`,
  and the `core-cs` rule pack (`no-dynamic`, `no-unchecked-cast`, `no-null-forgiving`,
  `no-empty-catch`).
- `fixtures/` — one `<rule>.bad.cs` / `<rule>.ok.cs` pair per rule. The `.ok.cs` file is a genuine
  false-positive guard (a similar-looking but legitimate construct), not just an empty file.
- `test/run-fixtures.mjs` — builds the analyzer and drives it as a real subprocess against every
  fixture, asserting the exact rule id / line / column of every expected violation and asserting
  zero violations on the `.ok.cs` guard. Node-builtin only, no dependencies, no test framework.

## What this analyzer resolves and what it does not

This analyzer does not read a `.csproj`, `.sln`, `Directory.Build.props`, `global.json`, NuGet
package references, or project references. It compiles each request's files together against the
.NET runtime's trusted platform assemblies — the same base class library available to every
process on the machine. That is enough for files that use only framework types and types defined
in the same request.

It is not enough for code that depends on:

- third-party NuGet packages (a type from any package the request does not include),
- other projects or source files in the same solution that are not in the request,
- project-specific compilation options (nullable context, `LangVersion`, `DefineConstants`, etc.).

When a file uses a type that is not resolvable in this minimal compilation, the analyzer reports
the file in `degraded` with a reason a human can act on. The core then withholds the semantic
rules (`no-dynamic`, `no-unchecked-cast`) for that file instead of reporting findings derived
from a partial type graph. The syntax rules (`no-null-forgiving`, `no-empty-catch`) still run,
because they do not depend on the missing references.

In practice this means the analyzer is reliable for self-contained C# files and for small sets of
sibling files passed together, and it is not reliable for projects that need a real build graph.
A proper C# integration would start from a `.csproj` and resolve its references; this analyzer does
not do that, and its README should not pretend otherwise.

## Build

```
cd packages/analyzer-csharp/src
dotnet build -c Release
```

## Run the fixture tests

From the repository root:

```
node packages/analyzer-csharp/test/run-fixtures.mjs
```

This builds the analyzer itself, so a separate build step is not required first.

## Run the protocol conformance suite

From the repository root, once `packages/core` is built:

```
node packages/core/dist/cli/index.js verify-analyzer packages/analyzer-csharp/analyzer.manifest.json
```

## Manual smoke test

```
echo '{"protocol":1,"repoRoot":"<repo-root>","mode":"file","files":["<absolute-path-to.cs-file>"],"rules":{"no-dynamic":{"severity":"error"}}}' | dotnet packages/analyzer-csharp/src/bin/Release/net9.0/CheckYourVibe.Analyzer.CSharp.dll
```
