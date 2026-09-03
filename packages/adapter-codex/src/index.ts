import { stat } from 'node:fs/promises';
import path from 'node:path';
import { orchestrationWrite, quoteTomlString, toRunnableCommand } from '@checkyourvibe/core';
import type {
  AgentPlugin,
  DetectContext,
  FormatContext,
  HookPayload,
  HookResult,
  PlanContext,
  PlannedWrite,
  RuleManifest,
  Violation,
} from '@checkyourvibe/core';

function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function binaryOnPath(names: readonly string[]): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  if (pathEnv.length === 0) {
    return false;
  }

  const candidateNames = new Set<string>(names);

  if (process.platform === 'win32') {
    const pathext = process.env.PATHEXT ?? '.EXE';
    for (const name of names) {
      for (const ext of pathext.split(path.delimiter)) {
        if (ext.length > 0) {
          candidateNames.add(`${name}${ext.toLowerCase()}`);
        }
      }
    }
  }

  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const name of candidateNames) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Detects a `~/.codex` config directory or a `codex` binary on PATH. Never
 * throws — an unreadable directory or an unset PATH both mean "not detected",
 * not "detection failed", so `cyv init` can plan for every other agent without
 * one plugin's filesystem hiccup aborting the whole run (Requirement 4.3).
 *
 * Codex stores its user-level config in `~/.codex/config.toml`, so the
 * directory's presence is the cleanest positive signal. The repo is not the
 * right place to look: unlike some agents, Codex does not keep project-level
 * settings inside the checkout by default.
 */
async function detect(ctx: DetectContext): Promise<boolean> {
  if (await directoryExists(path.join(ctx.homeDir, '.codex'))) {
    return true;
  }

  try {
    return await binaryOnPath(['codex']);
  } catch {
    return false;
  }
}

/**
 * Renders one rule's guidance section for the combined rules file.
 *
 * There is no per-rule surface here the way `adapter-cursor` has one `.mdc`
 * file per rule or `adapter-claude-code` has one subagent file per rule — see
 * `renderRulesFile` for why. This only formats a single rule's content so
 * `renderRulesFile` can concatenate one section per rule.
 */
function renderRuleSection(rule: RuleManifest): string {
  const lines: string[] = [];

  lines.push(`## ${rule.id}`);
  lines.push('');
  lines.push(rule.summary);
  lines.push('');

  lines.push('### Why');
  lines.push('');
  lines.push(rule.why);
  lines.push('');

  if (rule.allowedFixes.length > 0) {
    lines.push('### Allowed fixes');
    lines.push('');
    for (const fix of rule.allowedFixes) {
      lines.push(`- ${fix}`);
    }
    lines.push('');
  }

  if (rule.notFixes.length > 0) {
    lines.push('### Not-fixes (these are themselves violations)');
    lines.push('');
    for (const notFix of rule.notFixes) {
      lines.push(`- ${notFix.pattern}`);
      lines.push(`  because: ${notFix.because}`);
      if (notFix.rule !== undefined) {
        lines.push(`  rule: ${notFix.rule}`);
      }
    }
    lines.push('');
  }

  lines.push('### Examples');
  lines.push('');
  lines.push('#### Bad');
  lines.push('');
  lines.push('```ts');
  lines.push(rule.examples.bad);
  lines.push('```');
  lines.push('');
  lines.push('#### Good');
  lines.push('');
  lines.push('```ts');
  lines.push(rule.examples.good);
  lines.push('```');

  return lines.join('\n');
}

/**
 * Renders all rule guidance into ONE file, `.codex/checkyourvibe-rules.md`.
 *
 * Codex CLI has no documented per-rule guidance surface (no confirmed skill or
 * extension format for this), so every rule is rendered into this single file
 * instead of one file per rule. Requirement 6.3 says that where an agent has no
 * packaged-guidance surface, a plugin should declare that surface absent rather
 * than write files the agent will ignore — inventing a per-rule `.md` layout
 * from guesswork would be exactly that. Falling back to one plain markdown file
 * is honest about the gap: it is readable by a human, linkable from `AGENTS.md`,
 * and does not pretend to be a Codex-native package.
 */
function renderRulesFile(rules: readonly RuleManifest[]): string {
  const lines: string[] = [];

  lines.push('# checkyourvibe rule guidance');
  lines.push('');
  lines.push(
    'Codex CLI has no documented per-rule guidance surface (no confirmed skill or ' +
      'extension format for this), so every rule is rendered into this single file ' +
      'instead of one file per rule. See `AGENTS.md` for the workflow this file ' +
      'supports.',
  );
  lines.push('');

  for (const rule of rules) {
    lines.push(renderRuleSection(rule));
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * Body for the shared workflow block written into `AGENTS.md`.
 *
 * Codex CLI reads `AGENTS.md` as one of its instruction files, the same role
 * `GEMINI.md` plays for Gemini CLI, so `managed-block` is used the same way.
 * The block id is `checkyourvibe-workflow` because `AGENTS.md` is shared ground
 * — other tooling (including `adapter-antigravity`) may also write managed
 * blocks into it, and a generic `workflow` id would risk colliding with one of
 * those.
 */
function renderWorkflowBody(): string {
  return [
    'checkyourvibe hooks into Codex CLI after each tool call via `PostToolUse`.',
    '',
    'If the analyzer finds violations, the hook still exits 0 — Codex CLI treats',
    'exit code 2 from a hook as a block, cancelling the tool call, and an advisory',
    'check must never do that. Findings are written instead into',
    '`hookSpecificOutput.additionalContext` in the hook\'s stdout JSON, with',
    '`hookEventName` set to `PostToolUse`, which Codex CLI feeds back to the model.',
    '',
    'Before choosing a fix, run `cyv explain <rule-id>` to read the full rule',
    'guidance in `.codex/checkyourvibe-rules.md`. Pay special attention to the listed',
    'not-fixes: those are changes that would trade one violation for another.',
  ].join('\n');
}

/**
 * Builds the plugin's writes. MUST NOT touch the filesystem (Requirement 4 /
 * the `AgentPlugin.plan` contract) — everything here is pure string assembly,
 * and `packages/core/src/merge/apply.ts` is what actually reads and writes
 * these paths later.
 */
async function plan(ctx: PlanContext): Promise<PlannedWrite[]> {
  const writes: PlannedWrite[] = [];

  // `~/.codex/config.toml`, per the researched vendor facts. Codex stores its
  // hook configuration as TOML, not JSON, so this write uses the `toml-merge`
  // strategy. The entry is an array-of-tables at `hooks.PostToolUse.hooks`;
  // `mergeToml` in `packages/core/src/merge/toml.ts` adds the `[[...]]` header
  // and parent `[hooks.PostToolUse]` table when they are missing, so the
  // `content` here is only the key = value lines of our entry. The command is
  // quoted with `quoteTomlString` because a Windows path contains backslashes
  // that would otherwise silently corrupt the TOML.
  const configPath = path.join(ctx.homeDir, '.codex', 'config.toml');
  const hookCommand = `${toRunnableCommand(ctx.cyvCommand)} hook codex`;
  const entryLines: string[] = [];
  entryLines.push(`command = ${quoteTomlString(hookCommand)}`);
  if (process.platform === 'win32') {
    entryLines.push(`commandWindows = ${quoteTomlString(hookCommand)}`);
  }

  writes.push({
    path: configPath,
    strategy: 'toml-merge',
    content: entryLines.join('\n'),
    tomlTableArrayPath: 'hooks.PostToolUse.hooks',
    ownershipMarker: 'hook codex',
    description: 'Register the checkyourvibe PostToolUse hook in ~/.codex/config.toml.',
  });

  // No notes hook here, unlike the other five adapters (spec 0042 Requirement
  // 1.1). The notes command is `cyv comments --hook codex`, which contains the
  // string `hook codex` — this entry's ownership marker. `mergeToml` treats
  // every entry containing the marker as a candidate, replaces the first and
  // deletes the rest, so a second entry would survive until the next `cyv init`
  // and then disappear without a word. The other five adapters carry both
  // commands inside one array that is replaced whole, so the same overlap is
  // harmless there.
  //
  // Fixing it means either disjoint markers — a flag rename that spec 0042
  // fixed in prose — or chaining both commands into one entry, which changes
  // what that entry's exit code means. Recorded in the spec rather than
  // guessed at.

  const agentsMdPath = path.join(ctx.repoRoot, 'AGENTS.md');
  writes.push({
    path: agentsMdPath,
    strategy: 'managed-block',
    blockId: 'codex-workflow',
    content: renderWorkflowBody(),
    description: 'Add the checkyourvibe Codex CLI workflow to AGENTS.md.',
  });

  // Only the adapter whose agent the orchestrating lane names writes this,
  // and the body comes from core so all six say the same thing
  // (spec 0041 Requirements 1.1, 1.2).
  const orchestration = orchestrationWrite('codex', agentsMdPath, ctx.orchestration);
  if (orchestration !== undefined) {
    writes.push(orchestration);
  }

  const rulesPath = path.join(ctx.repoRoot, '.codex', 'checkyourvibe-rules.md');
  writes.push({
    path: rulesPath,
    strategy: 'create-if-absent',
    content: renderRulesFile(ctx.rules),
    description:
      'Create combined checkyourvibe rule guidance for Codex CLI at .codex/checkyourvibe-rules.md.',
  });

  return writes;
}

/**
 * Parses Codex CLI's `PostToolUse` payload.
 *
 * The vendor's payload never names the edited file. For `apply_patch`, the path
 * is embedded inside `tool_input.command` as patch text, but Requirement 1.5
 * forbids parsing a patch body to recover a filename: that would be a guess
 * dressed as a fact and it would fail silently the first time the patch format
 * changed. The honest, documented fallback is `scope: 'working-tree'`: the
 * hook checks the uncommitted changes instead of one explicit file.
 *
 * This function therefore returns `files: []` and `scope: 'working-tree'` for
 * every parseable JSON payload, using `hook_event_name` when it is present and
 * a sensible default otherwise. It throws ONLY when the input is not valid JSON
 * at all — the CLI shim catches, warns, and exits 0, per the project's rule that
 * the advisory layer degrades and never obstructs editing (Requirement 5.4).
 */
function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Codex CLI PostToolUse payload is not valid JSON.', { cause });
  }

  let event = 'PostToolUse';
  if (isJSONObject(parsed)) {
    const hookEventName = parsed['hook_event_name'];
    if (typeof hookEventName === 'string' && hookEventName.length > 0) {
      event = hookEventName;
    }
  }

  return { files: [], event, scope: 'working-tree' };
}

/**
 * Formats the hook's response.
 *
 * Vendor behaviour these exit codes rely on (Requirement 2.5): for Codex CLI,
 * exit 0 means success and stdout is parsed as JSON; exit 2 means BLOCK, with
 * stderr becoming the rejection reason shown to the user. `PostToolUse` fires
 * after the tool call already completed, so a block there would not undo the
 * edit — it would just interrupt the agent's turn. checkyourvibe's checks are
 * advisory (Requirement 2.3 forbids blocking here), so this always exits 0 with
 * empty stderr, and violations are carried in `hookSpecificOutput.additionalContext`
 * — the field the vendor docs name as the channel a hook uses to feed the model
 * more context. Per the vendor docs, stdout must be valid JSON and nothing else
 * — no leading or trailing text, no console.log noise.
 */
function formatResult(violations: Violation[], _ctx: FormatContext): HookResult {
  if (violations.length === 0) {
    return {
      stdout: JSON.stringify({}),
      stderr: '',
      exitCode: 0,
    };
  }

  const parts: string[] = [];
  for (const violation of violations) {
    parts.push(`${violation.file}:${violation.line} ${violation.ruleId} ${violation.message}`);

    if (violation.guidance !== undefined) {
      parts.push(`  ${violation.guidance.summary}`);
      parts.push(`  Why: ${violation.guidance.why}`);

      if (violation.guidance.allowedFixes.length > 0) {
        parts.push('  Allowed fixes:');
        for (const fix of violation.guidance.allowedFixes) {
          parts.push(`    - ${fix}`);
        }
      }

      if (violation.guidance.notFixes.length > 0) {
        parts.push('  Non-fixes that are themselves violations:');
        for (const notFix of violation.guidance.notFixes) {
          parts.push(`    - ${notFix.pattern}`);
          parts.push(`      because: ${notFix.because}`);
          if (notFix.rule !== undefined) {
            parts.push(`      rule: ${notFix.rule}`);
          }
        }
      }
    }
  }

  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: parts.join('\n'),
      },
    }),
    stderr: '',
    exitCode: 0,
  };
}

const codexPlugin: AgentPlugin = {
  id: 'codex',
  name: 'Codex CLI',
  surfaces: ['hook', 'instructions', 'guidance', 'mcp'],
  detect,
  plan,
  parseHookPayload,
  formatResult,
};

export default codexPlugin;
