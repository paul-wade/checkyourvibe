# 0050 — notFix closure check

Status: active. Date: 2026-09-05.

## Problem

A rule's `notFixes` entries claim that a tempting wrong fix would trip a
named rule. Today the conformance suite verifies only that the named rule
id exists (`checkNotFixReferences`). Nothing verifies the claim itself. A
notFix can name a rule that does not, in fact, report on the shortcut, and
the analyzer still passes conformance. The interlock graph is therefore a
set of promises, not a property.

## Requirement

1. Every `notFix` that names a `rule` SHALL also carry `example`: source
   text, in the analyzer's language, in which that shortcut has been
   applied.
2. The conformance suite SHALL run the analyzer on every such `example`
   with all rules enabled and SHALL fail the analyzer when the named
   `rule` does not appear among the violations for that example.
3. The conformance suite SHALL fail the analyzer when a `notFix` names a
   `rule` but carries no `example`. A graph with unverified edges is not
   closed.
4. A `notFix` with no `rule` MAY carry an `example`; it is not executed.
5. Every analyzer in this repository whose manifest has rule-bearing
   notFixes SHALL pass the check: analyzer-typescript (50 edges),
   analyzer-rust (6), analyzer-csharp (2), analyzer-unreal (2).
6. A closure failure is a real finding about the product. The fix is
   either a detection gap in the named rule (fix the rule) or a false
   claim in the notFix (fix or drop the edge). It is never a weaker check.

## Non-goals

- Rendering `example` on any surface (terminal, dashboard, site).
  `cyv explain --json` will include it because it dumps the manifest.
- Requiring that the source rule stop reporting on the example. Whether
  the shortcut fully escapes the source rule is reported as information,
  not enforced.
- Measuring what agents actually do. That is spec 0048 and the A/B work.
