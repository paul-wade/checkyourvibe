using Microsoft.CodeAnalysis;

namespace CheckYourVibe.Analyzer.CSharp;

/// <summary>
/// Gathers metadata references for the full base class library so that single-file compilations
/// resolve ordinary framework types (System.Object, System.Console, System.Linq, ...) without
/// requiring a .csproj. Uses the runtime's trusted platform assemblies list -- the same mechanism
/// Roslyn scripting hosts use -- rather than a hand-picked handful of typeof(...).Assembly.Location
/// references, which would silently miss whole namespaces a real file might use.
/// </summary>
internal static class StandardReferences
{
    private static IReadOnlyList<MetadataReference>? _cached;

    public static IReadOnlyList<MetadataReference> Get(out string? error)
    {
        if (_cached is not null)
        {
            error = null;
            return _cached;
        }

        var trustedAssembliesRaw = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(trustedAssembliesRaw))
        {
            error = "The .NET runtime did not report TRUSTED_PLATFORM_ASSEMBLIES; the base class library could not be located.";
            return Array.Empty<MetadataReference>();
        }

        var paths = trustedAssembliesRaw.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        var references = new List<MetadataReference>(paths.Length);

        foreach (var path in paths)
        {
            if (!File.Exists(path))
            {
                continue;
            }

            try
            {
                references.Add(MetadataReference.CreateFromFile(path));
            }
            catch (IOException ex)
            {
                // A handful of trusted-platform entries are not metadata files (resource-only
                // assemblies and similar), so skipping them is correct — but swallowing the
                // exception silently is not, and this analyzer ships a rule saying so.
                // stderr is the protocol's channel for exactly this: the core folds it into the
                // response's diagnostics, so a reference set that quietly lost half its assemblies
                // becomes visible instead of producing confidently wrong findings.
                Console.Error.WriteLine($"skipped non-metadata reference {path}: {ex.Message}");
            }
        }

        if (references.Count == 0)
        {
            error = "No usable assemblies were found among TRUSTED_PLATFORM_ASSEMBLIES; the base class library could not be located.";
            return Array.Empty<MetadataReference>();
        }

        _cached = references;
        error = null;
        return references;
    }
}
