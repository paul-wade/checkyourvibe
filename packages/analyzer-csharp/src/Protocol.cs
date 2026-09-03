using System.Text.Json;
using System.Text.Json.Nodes;

namespace CheckYourVibe.Analyzer.CSharp;

/// <summary>
/// The subset of AnalyzeRequest this analyzer needs, parsed permissively from a JsonNode so that
/// malformed input can be diagnosed field-by-field rather than surfacing a generic deserialization
/// exception.
/// </summary>
internal sealed class AnalyzeRequest
{
    public required string RepoRoot { get; init; }
    public required string Mode { get; init; }
    public required List<string> Files { get; init; }

    /// <summary>Rule id -> configured severity. A rule id absent here must not run.</summary>
    public required Dictionary<string, string> RuleSeverities { get; init; }

    /// <summary>
    /// Parses and validates the top-level shape of an AnalyzeRequest. Returns null and populates
    /// <paramref name="error"/> when the request is malformed in a way that should produce a
    /// diagnostic-only response rather than a crash.
    /// </summary>
    public static AnalyzeRequest? TryParse(string json, out string? error)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException ex)
        {
            error = $"Request body is not valid JSON: {ex.Message}";
            return null;
        }

        if (root is not JsonObject obj)
        {
            error = "Request body must be a JSON object.";
            return null;
        }

        if (!obj.TryGetPropertyValue("protocol", out var protocolNode) || protocolNode is null
            || protocolNode.GetValueKind() != JsonValueKind.Number || protocolNode.GetValue<int>() != 1)
        {
            error = "Request field \"protocol\" must be present and equal to 1.";
            return null;
        }

        if (!obj.TryGetPropertyValue("repoRoot", out var repoRootNode) || repoRootNode is null
            || repoRootNode.GetValueKind() != JsonValueKind.String)
        {
            error = "Request field \"repoRoot\" must be present and be a string.";
            return null;
        }

        if (!obj.TryGetPropertyValue("mode", out var modeNode) || modeNode is null
            || modeNode.GetValueKind() != JsonValueKind.String
            || (modeNode.GetValue<string>() != "file" && modeNode.GetValue<string>() != "project"))
        {
            error = "Request field \"mode\" must be present and be either \"file\" or \"project\".";
            return null;
        }

        if (!obj.TryGetPropertyValue("files", out var filesNode) || filesNode is not JsonArray filesArray)
        {
            error = "Request field \"files\" must be present and be an array of strings.";
            return null;
        }

        var files = new List<string>();
        foreach (var item in filesArray)
        {
            if (item is null || item.GetValueKind() != JsonValueKind.String)
            {
                error = "Request field \"files\" must contain only strings.";
                return null;
            }
            files.Add(item.GetValue<string>());
        }

        if (!obj.TryGetPropertyValue("rules", out var rulesNode) || rulesNode is not JsonObject rulesObj)
        {
            error = "Request field \"rules\" must be present and be an object keyed by rule id.";
            return null;
        }

        var ruleSeverities = new Dictionary<string, string>();
        foreach (var (ruleId, ruleConfigNode) in rulesObj)
        {
            if (ruleConfigNode is not JsonObject ruleConfigObj
                || !ruleConfigObj.TryGetPropertyValue("severity", out var severityNode)
                || severityNode is null
                || severityNode.GetValueKind() != JsonValueKind.String
                || (severityNode.GetValue<string>() != "error" && severityNode.GetValue<string>() != "warning"))
            {
                error = $"Request field \"rules.{ruleId}.severity\" must be \"error\" or \"warning\".";
                return null;
            }
            ruleSeverities[ruleId] = severityNode.GetValue<string>();
        }

        error = null;
        return new AnalyzeRequest
        {
            RepoRoot = repoRootNode.GetValue<string>(),
            Mode = modeNode.GetValue<string>(),
            Files = files,
            RuleSeverities = ruleSeverities,
        };
    }
}

internal sealed record Violation
{
    public required string File { get; init; }
    public required int Line { get; init; }
    public required int Column { get; init; }
    public int? EndLine { get; init; }
    public int? EndColumn { get; init; }
    public required string RuleId { get; init; }
    public required string Message { get; init; }
    public required string Snippet { get; init; }
    public required string Severity { get; init; }
}

internal sealed record SkippedFile
{
    public required string File { get; init; }
    public required string Reason { get; init; }
}

internal sealed record Diagnostic
{
    public required string Level { get; init; }
    public required string Message { get; init; }
}

internal sealed record DegradedResolution
{
    public required List<string> Files { get; init; }
    public required string Reason { get; init; }
}

internal sealed class AnalyzeResponse
{
    public int Protocol { get; init; } = 1;
    public List<Violation> Violations { get; init; } = new();
    public List<SkippedFile> Skipped { get; init; } = new();
    public List<Diagnostic> Diagnostics { get; init; } = new();
    public List<DegradedResolution> Degraded { get; init; } = new();

    /// <summary>Writes this response to stdout as the ONLY thing stdout carries.</summary>
    public void WriteTo(TextWriter writer)
    {
        var obj = new JsonObject
        {
            ["protocol"] = Protocol,
            ["violations"] = new JsonArray(Violations.Select(v =>
            {
                var vObj = new JsonObject
                {
                    ["file"] = v.File,
                    ["line"] = v.Line,
                    ["column"] = v.Column,
                    ["ruleId"] = v.RuleId,
                    ["message"] = v.Message,
                    ["snippet"] = v.Snippet,
                    ["severity"] = v.Severity,
                };
                if (v.EndLine is not null) vObj["endLine"] = v.EndLine;
                if (v.EndColumn is not null) vObj["endColumn"] = v.EndColumn;
                return (JsonNode)vObj;
            }).ToArray()),
            ["skipped"] = new JsonArray(Skipped.Select(s => (JsonNode)new JsonObject
            {
                ["file"] = s.File,
                ["reason"] = s.Reason,
            }).ToArray()),
            ["diagnostics"] = new JsonArray(Diagnostics.Select(d => (JsonNode)new JsonObject
            {
                ["level"] = d.Level,
                ["message"] = d.Message,
            }).ToArray()),
        };

        if (Degraded.Count > 0)
        {
            obj["degraded"] = new JsonArray(Degraded.Select(d => (JsonNode)new JsonObject
            {
                ["files"] = new JsonArray(d.Files.Select(f => (JsonNode)JsonValue.Create(f)).ToArray()),
                ["reason"] = d.Reason,
            }).ToArray());
        }

        writer.Write(obj.ToJsonString());
    }
}
