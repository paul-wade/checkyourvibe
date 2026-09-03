<!-- checkyourvibe:start:claude-code-workflow -->
checkyourvibe hooks into Claude Code after each TypeScript edit.

If the analyzer finds violations, the hook exits with code 2 and writes the

remediation guidance to stderr so Claude Code can act on it before the user does.

Before choosing a fix, run `cyv explain <rule-id>` to read the full rule guidance.

Pay special attention to the listed not-fixes: those are changes that would trade one violation for another.
<!-- checkyourvibe:end:claude-code-workflow -->