import { stat } from 'node:fs/promises';
import path from 'node:path';
import { orchestrationWrite, toRunnableCommand } from '@checkyourvibe/core';
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
 * Detects a `.gemini` config directory (project or user scope) or a `gemini`
 * binary on PATH. Never throws — an unreadable directory or an unset PATH both
 * mean "not detected", not "detection failed", so `cyv init` can plan for
 * every other agent without one plugin's filesystem hiccup aborting the whole
 * run (Requirement 4.3).
 */
async function detect(ctx: DetectContext): Promise<boolean> {
  if (await directoryExists(path.join(ctx.repoRoot, '.gemini'))) {
    return true;
  }

  if (await directoryExists(path.join(ctx.homeDir, '.gemini'))) {
    return true;
  }

  try {
    return await binaryOnPath(['gemini']);
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
 * Renders all rule guidance into ONE file, `.gemini/checkyourvibe-rules.md`.
 *
 * Gemini CLI supports "extensions" and "skills", but neither's on-disk format
 * is documented with enough confidence to target safely. Requirement 6.3 says
 * that where an agent has no packaged-guidance surface, a plugin should
 * declare that surface absent rather than write files the agent will ignore —
 * inventing an extension manifest from guesswork would be exactly that.
 * Falling back to one plain markdown file is honest about the gap: it is
 * readable by a human, linkable from `GEMINI.md`, and does not pretend to be a
 * Gemini-native skill/extension package. Recorded here and in the task report
 * as a per-rule guidance surface that was not confidently identified
 * (Requirement 7.2).
 */
function renderRulesFile(rules: readonly RuleManifest[]): string {
  const lines: string[] = [];

  lines.push('# checkyourvibe rule guidance');
  lines.push('');
  lines.push(
    'Gemini CLI has no documented per-rule guidance surface (no confirmed skill or ' +
      'extension format for this), so every rule is rendered into this single file ' +
      'instead of one file per rule. See `GEMINI.md` for the workflow this file ' +
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
 * Body for the shared workflow block written into `GEMINI.md`.
 *
 * Gemini CLI reads `GEMINI.md` as its instructions file, the same role
 * `CLAUDE.md` plays for Claude Code, so `managed-block` is used the same way.
 */
function renderWorkflowBody(): string {
  return [
    'checkyourvibe hooks into Gemini CLI after each `write_file` / `replace` / `edit`',
    'tool call via `AfterTool`.',
    '',
    'If the analyzer finds violations, the hook still exits 0 — Gemini CLI treats',
    'exit code 2 from a hook as BLOCK, cancelling the tool call, and an advisory',
    'check must never do that. Findings are written instead into',
    '`hookSpecificOutput.additionalContext` in the hook\'s stdout JSON, which',
    'Gemini CLI feeds back to the model.',
    '',
    'Before choosing a fix, run `cyv explain <rule-id>` to read the full rule',
    'guidance in `.gemini/checkyourvibe-rules.md`. Pay special attention to the',
    'listed not-fixes: those are changes that would trade one violation for another.',
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

  // Project scope (`<repoRoot>/.gemini/settings.json`), per the researched
  // vendor facts — user scope (`~/.gemini/settings.json`) also exists but
  // would apply the hook to every repo the user has, not just this one.
  const settingsPath = path.join(ctx.repoRoot, '.gemini', 'settings.json');
  const hookCommand = `${toRunnableCommand(ctx.cyvCommand)} hook gemini`;
  // Notes the owner left on the dashboard arrive the way findings do (spec 0042
  // Requirement 1.1). Silent and exit 0 when nothing is unread, so it costs an
  // edit almost nothing.
  const notesCommand = `${toRunnableCommand(ctx.cyvCommand)} comments --hook gemini`;
  const settingsContent = JSON.stringify(
    {
      hooks: {
        AfterTool: [
          {
            matcher: 'write_file|replace|edit',
            hooks: [
              {
                name: 'checkyourvibe',
                type: 'command',
                command: hookCommand,
                timeout: 30000,
              },
              {
                name: 'checkyourvibe-notes',
                type: 'command',
                command: notesCommand,
                timeout: 30000,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );

  writes.push({
    path: settingsPath,
    strategy: 'json-merge',
    content: settingsContent,
    // Without this marker, re-planning would either duplicate our own entry
    // on every run or (worse, per `mergeArray` in `packages/core/src/merge/apply.ts`)
    // wholesale-replace `AfterTool` and delete another tool's hook.
    ownershipMarker: 'hook gemini',
    description: 'Register the checkyourvibe AfterTool hook in .gemini/settings.json.',
  });

  const geminiMdPath = path.join(ctx.repoRoot, 'GEMINI.md');
  writes.push({
    path: geminiMdPath,
    strategy: 'managed-block',
    blockId: 'gemini-workflow',
    content: renderWorkflowBody(),
    description: 'Add the checkyourvibe Gemini CLI workflow to GEMINI.md.',
  });

  // Only the adapter whose agent the orchestrating lane names writes this,
  // and the body comes from core so all six say the same thing
  // (spec 0041 Requirements 1.1, 1.2).
  const orchestration = orchestrationWrite('gemini', geminiMdPath, ctx.orchestration);
  if (orchestration !== undefined) {
    writes.push(orchestration);
  }

  const rulesPath = path.join(ctx.repoRoot, '.gemini', 'checkyourvibe-rules.md');
  writes.push({
    path: rulesPath,
    strategy: 'create-if-absent',
    content: renderRulesFile(ctx.rules),
    description:
      'Create combined checkyourvibe rule guidance for Gemini CLI at .gemini/checkyourvibe-rules.md.',
  });

  return writes;
}

/**
 * Defensive list of field names that might hold the edited path inside
 * `tool_input`, in the order they are tried.
 *
 * The vendor docs for Gemini CLI's `AfterTool` event document `tool_input` as
 * "the original tool arguments" but do not name which key inside it carries a
 * file path for a given tool (`write_file`, `replace`, `edit` each could use a
 * different key, and none is documented). This list is a guess at plausible
 * names, ordered from most to least specific, NOT a confirmed schema —
 * Requirement 1.5 forbids inferring a path by parsing a diff or command
 * string, but trying a short, named list of candidate field keys is not that:
 * it is explicit, bounded, and visibly a guess rather than a fact. If a
 * vendor update renames the field to something outside this list, parsing
 * falls back to `scope: 'working-tree'` rather than silently misreading
 * another field as a path.
 */
export const GEMINI_HOOK_CANDIDATE_PATH_FIELDS = [
  'absolute_path',
  'file_path',
  'filePath',
  'path',
] as const;

/**
 * Parses Gemini CLI's `AfterTool` payload.
 *
 * Per Requirement 1.5, this never scans the payload for anything that merely
 * looks like a path and never parses a diff or command string to recover one
 * — only the exact, named candidates in `GEMINI_HOOK_CANDIDATE_PATH_FIELDS`
 * are tried, in order, against `tool_input`. When none match, the result is
 * `scope: 'working-tree'` with an empty `files` array rather than a guess.
 *
 * Throws ONLY when `raw` is not valid JSON at all (Requirement 5.4's
 * degrade-on-parse-failure policy belongs in the CLI shim, which catches,
 * warns, and exits 0). A payload that parses but has no `tool_input` object,
 * or a `tool_input` with none of the candidate fields, is not malformed —
 * it is simply a payload this plugin cannot resolve to explicit files, and
 * that is exactly what the working-tree fallback exists for.
 */
function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Gemini CLI AfterTool payload is not valid JSON.', { cause });
  }

  const toolInput = isJSONObject(parsed) ? parsed['tool_input'] : undefined;
  const inputFields = isJSONObject(toolInput) ? toolInput : undefined;

  if (inputFields !== undefined) {
    for (const field of GEMINI_HOOK_CANDIDATE_PATH_FIELDS) {
      const rawPath = inputFields[field];
      if (typeof rawPath === 'string' && rawPath.length > 0) {
        const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
        return { files: [filePath], event: 'AfterTool', scope: 'files' };
      }
    }
  }

  return { files: [], event: 'AfterTool', scope: 'working-tree' };
}

/**
 * Formats the hook's response.
 *
 * Vendor behaviour these exit codes rely on (Requirement 2.5): for Gemini
 * CLI, exit 0 means success and stdout is parsed as JSON; exit 2 means BLOCK,
 * with stderr becoming the rejection reason shown to the user. `AfterTool`
 * fires after the tool call already completed, so a block there would not
 * undo the edit — it would just interrupt the agent's turn. checkyourvibe's
 * checks are advisory (Requirement 2.3 forbids blocking here), so this always
 * exits 0 with empty stderr, and violations are carried in
 * `hookSpecificOutput.additionalContext` — the field the vendor docs name as
 * the channel a hook uses to feed the model more context. Per the vendor docs
 * ("Your script must not print any plain text to stdout other than the final
 * JSON object"), stdout here is always exactly one JSON object and nothing
 * else — no leading/trailing text, no console.log noise.
 */
function formatResult(violations: Violation[], _ctx: FormatContext): HookResult {
  if (violations.length === 0) {
    return {
      stdout: JSON.stringify({ decision: 'allow' }),
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
      decision: 'allow',
      hookSpecificOutput: {
        additionalContext: parts.join('\n'),
      },
    }),
    stderr: '',
    exitCode: 0,
  };
}

const geminiPlugin: AgentPlugin = {
  id: 'gemini',
  name: 'Gemini CLI',
  surfaces: ['hook', 'instructions', 'guidance', 'mcp'],
  unverifiedSurfaces: [
    {
      surface: 'hook',
      reason:
        'The vendor docs for Gemini CLI\'s `AfterTool` event document `tool_input` as the original tool arguments but do not name which key inside it carries a file path. This plugin tries a short list of plausible field names and falls back to `scope: \'working-tree\'` if none match.',
    },
  ],
  detect,
  plan,
  parseHookPayload,
  formatResult,
};

export default geminiPlugin;
