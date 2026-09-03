using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace CheckYourVibe.Analyzer.CSharp;

/// <summary>
/// Subprocess entry point for the checkyourvibe C# analyzer. Reads one AnalyzeRequest as JSON from
/// stdin, writes one AnalyzeResponse as JSON to stdout, and exits 0. stdout carries nothing but the
/// response; anything for a human goes to stderr, per the protocol's exec.type: "process" contract.
/// </summary>
internal static class Program
{
    // The protocol's violation.schema.json refers to a "SNIPPET_MAX_LENGTH" constant by name but
    // never publishes its value anywhere in docs/protocol/ or docs/writing-an-analyzer.md. The only
    // place it is actually defined is packages/core/src/protocol/violation.ts (200), which a non-Node
    // analyzer has no business reading. This is a documentation defect -- see the task report.
    private const int SnippetMaxLength = 200;

    private static int Main()
    {
        string requestText;
        try
        {
            requestText = Console.In.ReadToEnd();
        }
        catch (Exception ex)
        {
            return Fail($"Could not read the request from stdin: {ex.Message}");
        }

        var request = AnalyzeRequest.TryParse(requestText, out var parseError);
        if (request is null)
        {
            // TryParse sets parseError on every failure path, but the compiler
            // cannot prove that from the signature. Asserting it with `!` would
            // trip this analyzer's own no-null-forgiving rule and, worse, turn a
            // future refactor of TryParse into a null reference at runtime. A
            // real fallback costs nothing and cannot be wrong.
            return Fail(parseError ?? "The request could not be parsed, and no reason was recorded.");
        }

        var response = new AnalyzeResponse();

        try
        {
            Analyze(request, response);
        }
        catch (Exception ex)
        {
            // Never let an unhandled exception put a stack trace on stdout: log it there for a
            // human, and fold it into the response as a diagnostic so the core sees it too.
            Console.Error.WriteLine(ex.ToString());
            response.Diagnostics.Add(new Diagnostic { Level = "error", Message = $"Analyzer crashed: {ex.Message}" });
            foreach (var file in request.Files)
            {
                if (!response.Skipped.Any(s => s.File == file))
                {
                    response.Skipped.Add(new SkippedFile { File = file, Reason = "Analyzer crashed before this file could be processed." });
                }
            }
        }

        response.WriteTo(Console.Out);
        return 0;
    }

    /// <summary>Writes a well-formed but diagnostic-only response for a malformed request, per Requirement 2.4.</summary>
    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        var response = new AnalyzeResponse();
        response.Diagnostics.Add(new Diagnostic { Level = "error", Message = message });
        response.WriteTo(Console.Out);
        return 1;
    }

    private static void Analyze(AnalyzeRequest request, AnalyzeResponse response)
    {
        var enabledRules = new HashSet<string>(request.RuleSeverities.Keys);
        if (enabledRules.Count == 0)
        {
            return;
        }

        var references = StandardReferences.Get(out var referenceError);
        if (referenceError is not null)
        {
            // The standard library itself could not be located -- this is the genuinely degraded
            // case Requirement 3.2 is about, not the ordinary "this file references a type defined
            // elsewhere" case. Every file is reported skipped rather than risking findings derived
            // from a compilation with no usable type system at all.
            response.Diagnostics.Add(new Diagnostic { Level = "error", Message = referenceError });
            foreach (var file in request.Files)
            {
                response.Skipped.Add(new SkippedFile { File = file, Reason = "Standard library references could not be resolved; see diagnostics." });
            }
            return;
        }

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        var trees = new List<SyntaxTree>();
        var treesByFile = new Dictionary<SyntaxTree, string>();

        foreach (var file in request.Files)
        {
            string source;
            try
            {
                source = File.ReadAllText(file);
            }
            catch (Exception ex)
            {
                response.Skipped.Add(new SkippedFile { File = file, Reason = $"Could not read file: {ex.Message}" });
                continue;
            }

            var tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: file);
            trees.Add(tree);
            treesByFile[tree] = file;
        }

        if (trees.Count == 0)
        {
            return;
        }

        // All requested files are compiled together (rather than one compilation per file) so that
        // types defined in one of them resolve when referenced from another -- the closest this
        // project-less analyzer can get to real project semantics without requiring a .csproj
        // (Requirement 2.5).
        var compilation = CSharpCompilation.Create(
            assemblyName: "CheckYourVibeAnalysis",
            syntaxTrees: trees,
            references: references,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var coreObjectType = compilation.GetSpecialType(SpecialType.System_Object);
        if (coreObjectType.TypeKind == TypeKind.Error)
        {
            response.Diagnostics.Add(new Diagnostic { Level = "error", Message = "The compilation could not resolve System.Object from the supplied references; no rules were evaluated." });
            foreach (var file in request.Files)
            {
                response.Skipped.Add(new SkippedFile { File = file, Reason = "Base class library types did not resolve; see diagnostics." });
            }
            return;
        }

        // The compilation is only as good as its reference set. If a file uses a type,
        // namespace, or assembly that is not in the trusted-platform list, the semantic
        // model will silently report an error type and any rule that consults it is guessing.
        // Detect those files here so the core can withhold evidence: semantic findings.
        var degradedFiles = DetectDegradedFiles(compilation, treesByFile);
        if (degradedFiles.Count > 0)
        {
            response.Degraded.Add(new DegradedResolution
            {
                Files = degradedFiles,
                Reason =
                    "One or more types, namespaces, or assembly references used in these files could not " +
                    "be resolved. This analyzer does not read a .csproj, package references, or project " +
                    "references; it compiles each request against only the .NET runtime's trusted platform " +
                    "assemblies. Files that depend on other projects or NuGet packages are analyzed with an " +
                    "incomplete type graph, so semantic findings for them are not reported.",
            });
        }

        foreach (var tree in trees)
        {
            var file = treesByFile[tree];
            var model = compilation.GetSemanticModel(tree);
            var degradedNotes = new List<string>();
            var findings = new List<(string ruleId, Finding finding)>();

            if (enabledRules.Contains(Rules.NoDynamic))
            {
                foreach (var f in Rules.NoDynamicRule(tree, model))
                {
                    findings.Add((Rules.NoDynamic, f));
                }
            }

            if (enabledRules.Contains(Rules.NoUncheckedCast))
            {
                foreach (var f in Rules.NoUncheckedCastRule(tree, model, degradedNotes))
                {
                    findings.Add((Rules.NoUncheckedCast, f));
                }
            }

            if (enabledRules.Contains(Rules.NoNullForgiving))
            {
                foreach (var f in Rules.NoNullForgivingRule(tree))
                {
                    findings.Add((Rules.NoNullForgiving, f));
                }
            }

            if (enabledRules.Contains(Rules.NoEmptyCatch))
            {
                foreach (var f in Rules.NoEmptyCatchRule(tree))
                {
                    findings.Add((Rules.NoEmptyCatch, f));
                }
            }

            foreach (var note in degradedNotes)
            {
                response.Diagnostics.Add(new Diagnostic { Level = "warn", Message = $"{file}: {note}" });
            }

            foreach (var (ruleId, finding) in findings.OrderBy(f => f.finding.Node.GetLocation().GetLineSpan().StartLinePosition))
            {
                response.Violations.Add(ToViolation(file, ruleId, finding, request.RuleSeverities[ruleId]));
            }
        }
    }

    private static Violation ToViolation(string file, string ruleId, Finding finding, string severity)
    {
        var span = finding.Node.GetLocation().GetLineSpan();
        return new Violation
        {
            File = file,
            Line = span.StartLinePosition.Line + 1,
            Column = span.StartLinePosition.Character + 1,
            EndLine = span.EndLinePosition.Line + 1,
            EndColumn = span.EndLinePosition.Character + 1,
            RuleId = ruleId,
            Message = finding.Message,
            Snippet = Snippet(finding.Node.ToString()),
            Severity = severity,
        };
    }

    private static string Snippet(string text)
    {
        var collapsed = string.Join(' ', text.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
        return collapsed.Length <= SnippetMaxLength
            ? collapsed
            : collapsed[..(SnippetMaxLength - 1)] + "…";
    }

    /// <summary>
    /// Diagnostic IDs that mean "the compilation could not resolve a symbol because a reference,
    /// a using, or an assembly is missing." These are the only compiler errors that describe an
    /// incomplete type graph rather than an ordinary user code error, and they are the honest signal
    /// that the analyzer is guessing.
    ///
    /// CS0246: The type or namespace name could not be found (are you missing a using directive or
    ///        an assembly reference?).
    /// CS0234: The type or namespace name does not exist in the namespace.
    /// CS0012: The type is defined in an assembly that is not referenced.
    /// CS0006: Metadata file could not be found.
    ///
    /// Other common compiler errors are deliberately excluded:
    /// - Syntax errors (CS1xxx, CS1513, etc.) are user code errors, not missing references.
    /// - CS0103 / CS1061 mean a name or member is missing in an otherwise resolvable context.
    ///   These are usually genuine user code errors; treating them as degraded resolution would
    ///   wrongly blame the analyzer's reference set for a typo in the file.
    /// </summary>
    private static readonly HashSet<string> DegradedDiagnosticIds = new(StringComparer.Ordinal)
    {
        "CS0246",
        "CS0234",
        "CS0012",
        "CS0006",
    };

    /// <summary>
    /// Scans the compilation for the diagnostic IDs that indicate a missing reference or unresolved
    /// external type. Returns the absolute paths of the source files that contain at least one such
    /// diagnostic. A diagnostic with no source tree is treated as a compilation-wide reference
    /// failure and every requested file is reported as degraded.
    /// </summary>
    private static List<string> DetectDegradedFiles(CSharpCompilation compilation, Dictionary<SyntaxTree, string> treesByFile)
    {
        var degradedFiles = new HashSet<string>();

        foreach (var diagnostic in compilation.GetDiagnostics())
        {
            if (diagnostic.Severity != DiagnosticSeverity.Error)
            {
                continue;
            }

            if (!DegradedDiagnosticIds.Contains(diagnostic.Id))
            {
                continue;
            }

            var sourceTree = diagnostic.Location.SourceTree;
            if (sourceTree is not null && treesByFile.TryGetValue(sourceTree, out var file))
            {
                degradedFiles.Add(file);
            }
            else
            {
                // A reference failure with no source location (for example, a metadata file that
                // could not be loaded) makes the whole compilation untrustworthy.
                foreach (var fileInRequest in treesByFile.Values)
                {
                    degradedFiles.Add(fileInRequest);
                }
            }
        }

        return [.. degradedFiles];
    }
}
