using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CheckYourVibe.Analyzer.CSharp;

/// <summary>A rule finding before it is stamped with the configured severity and rule id.</summary>
internal sealed record Finding(SyntaxNode Node, string Message);

internal static class Rules
{
    public const string NoDynamic = "no-dynamic";
    public const string NoUncheckedCast = "no-unchecked-cast";
    public const string NoNullForgiving = "no-null-forgiving";
    public const string NoEmptyCatch = "no-empty-catch";

    public static readonly string[] AllIds = { NoDynamic, NoUncheckedCast, NoNullForgiving, NoEmptyCatch };

    /// <summary>
    /// `dynamic` skips the type checker entirely, so this rule needs the semantic model: an
    /// identifier that merely spells "dynamic" (a local variable, parameter, or method named that,
    /// which is legal because dynamic is a contextual keyword) must not be confused with an actual
    /// use of the dynamic type. Only nodes the compiler itself resolved to TypeKind.Dynamic count.
    /// </summary>
    public static IEnumerable<Finding> NoDynamicRule(SyntaxTree tree, SemanticModel model)
    {
        var root = tree.GetRoot();
        foreach (var node in root.DescendantNodes().OfType<IdentifierNameSyntax>())
        {
            if (node.Identifier.ValueText != "dynamic")
            {
                continue;
            }

            var typeInfo = model.GetTypeInfo(node);
            if (typeInfo.Type is { TypeKind: TypeKind.Dynamic })
            {
                yield return new Finding(node, "The \"dynamic\" type bypasses compile-time type checking for every member access and call made through it.");
            }
        }
    }

    /// <summary>
    /// A direct cast expression asks the runtime to fail with an exception if the value is not
    /// what was claimed. This rule only flags casts where that failure is a real possibility: an
    /// explicit reference conversion (a downcast to a derived or unrelated reference type) or an
    /// unboxing conversion (object to a value type). It does not flag numeric conversions between
    /// primitives, boxing, upcasts, user-defined conversions, or anything involving `dynamic` — all
    /// of those either cannot fail this way or are a different concern. Classifying the conversion
    /// requires the semantic model; syntax alone cannot tell a safe upcast from a risky downcast.
    /// </summary>
    public static IEnumerable<Finding> NoUncheckedCastRule(SyntaxTree tree, SemanticModel model, List<string> degradedNotes)
    {
        var root = tree.GetRoot();
        foreach (var node in root.DescendantNodes().OfType<CastExpressionSyntax>())
        {
            var targetTypeInfo = model.GetTypeInfo(node.Type);
            var operandTypeInfo = model.GetTypeInfo(node.Expression);

            var targetType = targetTypeInfo.Type;
            var operandType = operandTypeInfo.Type;

            if (targetType is null || operandType is null)
            {
                // A typeless expression (the `null` literal, `default`, a method group, a lambda
                // with no natural type, ...) has no static type to classify by design, not because
                // anything failed to resolve. None of those can be observed to fail at runtime the
                // way an unchecked downcast can, so this is a silent, ordinary skip.
                continue;
            }

            if (targetType.TypeKind == TypeKind.Error || operandType.TypeKind == TypeKind.Error)
            {
                // The type of one side genuinely could not be bound -- most often because this file
                // references a type defined elsewhere in a project we were not given. We cannot
                // honestly classify a conversion we do not have both ends of, so this specific cast
                // is skipped rather than guessed at (Requirement 3.2). It is not a whole-file
                // failure: the rest of the file may still be fully resolvable.
                degradedNotes.Add($"line {LineOf(node)}: cast operand or target type could not be resolved; this cast was not evaluated by no-unchecked-cast.");
                continue;
            }

            var conversion = model.Compilation.ClassifyConversion(operandType, targetType);

            if (!conversion.Exists || conversion.IsNumeric || conversion.IsUserDefined || conversion.IsDynamic)
            {
                continue;
            }

            if (conversion.IsExplicit && (conversion.IsReference || conversion.IsUnboxing))
            {
                yield return new Finding(
                    node,
                    $"Direct cast from \"{operandType}\" to \"{targetType}\" can throw at runtime if the value is not actually a \"{targetType}\".");
            }
        }
    }

    /// <summary>
    /// The null-forgiving operator tells the compiler to stop checking something the author has
    /// not actually verified. Purely syntactic: the postfix `!` (SuppressNullableWarningExpression)
    /// is a distinct syntax kind from both the inequality operator `!=` and logical negation `!x`,
    /// so no semantic information is needed to tell them apart.
    /// </summary>
    public static IEnumerable<Finding> NoNullForgivingRule(SyntaxTree tree)
    {
        var root = tree.GetRoot();
        foreach (var node in root.DescendantNodes().OfType<PostfixUnaryExpressionSyntax>())
        {
            if (node.IsKind(SyntaxKind.SuppressNullableWarningExpression))
            {
                yield return new Finding(node, "The \"!\" null-forgiving operator asserts a value is not null without checking it.");
            }
        }
    }

    /// <summary>
    /// A catch block that runs no code at all, or only a control-flow statement that does nothing
    /// with the error, discards the failure it caught: nothing observes it, nothing responds to it,
    /// and nothing propagates it. A block that rethrows (`throw;`), logs, returns a fallback value,
    /// or does anything else observable is not flagged -- only the block that provably does nothing.
    /// </summary>
    public static IEnumerable<Finding> NoEmptyCatchRule(SyntaxTree tree)
    {
        var root = tree.GetRoot();
        foreach (var node in root.DescendantNodes().OfType<CatchClauseSyntax>())
        {
            var statements = node.Block.Statements;
            var swallows = statements.Count == 0
                || statements.All(IsSwallowingStatement);

            if (swallows)
            {
                yield return new Finding(node, "This catch block swallows the exception: it runs no code that handles, logs, or rethrows it.");
            }
        }
    }

    private static bool IsSwallowingStatement(StatementSyntax statement)
    {
        if (statement.IsKind(SyntaxKind.EmptyStatement))
        {
            return true;
        }

        if (statement.IsKind(SyntaxKind.ContinueStatement) || statement.IsKind(SyntaxKind.BreakStatement))
        {
            return true;
        }

        if (statement.IsKind(SyntaxKind.ReturnStatement) && statement is ReturnStatementSyntax { Expression: null })
        {
            return true;
        }

        return false;
    }

    private static int LineOf(SyntaxNode node) => node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
}
