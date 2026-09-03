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
 * Detects an `.agents` workspace directory or an `antigravity` / `agy` binary
 * on PATH. Never throws — an unreadable directory or an unset PATH both mean
 * "not detected", not "detection failed", so `cyv init` can plan for every
 * other agent without one plugin's filesystem hiccup aborting the whole run
 * (Requirement 4.3).
 *
 * Only the workspace `.agents` directory is checked, per the task's vendor
 * facts: there is also a global hooks location (`~/.gemini/config/hooks.json`),
 * but detecting on that would key an *Antigravity* plugin off a *Gemini*
 * directory that has nothing to do with this repo, and could false-positive
 * for any machine with Gemini CLI installed but no Antigravity workspace at
 * all. The task is explicit that the workspace location is the one to use.
 */
async function detect(ctx: DetectContext): Promise<boolean> {
  if (await directoryExists(path.join(ctx.repoRoot, '.agents'))) {
    return true;
  }

  try {
    return await binaryOnPath(['antigravity', 'agy']);
  } catch {
    return false;
  }
}

/**
 * Renders one rule's guidance section for the combined rules file.
 *
 * See `renderRulesFile` for why this is one section in one file rather than
 * one file per rule under `.agents/skills/`.
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
 * Renders all rule guidance into ONE file, `.agents/skills/checkyourvibe-rules.md`.
 *
 * The task's vendor facts confirm skills live under `.agents/skills/`, but say
 * nothing about the internal packaging: whether each skill needs its own
 * directory, whether a `SKILL.md` filename is required, or what frontmatter
 * (if any) that file must carry. Inventing a per-rule `.agents/skills/cyv-<id>/
 * SKILL.md` layout with guessed frontmatter would be exactly the kind of file
 * an agent silently ignores because the shape is wrong — worse than writing
 * nothing, because `cyv init` would report success. Requirement 6.3 says that
 * where an agent has no *confirmed* packaged-guidance surface, the plugin
 * should declare that surface absent rather than write files the agent will
 * ignore. Here the *location* is confirmed but the *packaging* is not, so this
 * takes the same fallback `adapter-gemini` uses for a fully-unconfirmed
 * surface: one plain markdown file, placed at the one location the docs do
 * confirm, linked from `AGENTS.md`. This choice is recorded here and repeated
 * in the task report (Requirement 7.2).
 */
function renderRulesFile(rules: readonly RuleManifest[]): string {
  const lines: string[] = [];

  lines.push('# checkyourvibe rule guidance');
  lines.push('');
  lines.push(
    'Antigravity CLI documents that skills live under `.agents/skills/`, but not the ' +
      'per-skill file layout or frontmatter, so every rule is rendered into this single ' +
      'file instead of one skill per rule. See `AGENTS.md` for the workflow this file ' +
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
 * Antigravity CLI reads `AGENTS.md` as its instructions file (per the task's
 * vendor facts), so `managed-block` is used the same way `adapter-gemini` uses
 * it for `GEMINI.md`. The blockId is `checkyourvibe-workflow` rather than the
 * `workflow` id other adapters use for their own instructions file, because
 * `AGENTS.md` is a shared, cross-agent filename other tooling (including this
 * repository's own project conventions) may also write managed blocks into —
 * a generic `workflow` id would risk colliding with one of those.
 */
function renderWorkflowBody(): string {
  return [
    'checkyourvibe hooks into Antigravity CLI after each edit tool call via `PostToolUse`.',
    '',
    'If the analyzer finds violations, the hook still exits 0 — Antigravity CLI treats',
    'exit code 2 from a hook as a block, cancelling the action, and an advisory check',
    'must never do that. Findings are written instead into the hook\'s stdout JSON, which',
    'Antigravity CLI feeds back to the model.',
    '',
    'Before choosing a fix, run `cyv explain <rule-id>` to read the full rule guidance in',
    '`.agents/skills/checkyourvibe-rules.md`. Pay special attention to the listed',
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

  // `<repoRoot>/.agents/hooks.json`, per the task's vendor facts — there is
  // also a global location (`~/.gemini/config/hooks.json`), but that would
  // apply the hook to every workspace the user has, not just this one, and
  // the task is explicit that the workspace file is the one to use.
  const hooksPath = path.join(ctx.repoRoot, '.agents', 'hooks.json');
  const hookCommand = `${toRunnableCommand(ctx.cyvCommand)} hook antigravity`;
  // Notes the owner left on the dashboard arrive the way findings do (spec 0042
  // Requirement 1.1). Silent and exit 0 when nothing is unread, so it costs an
  // edit almost nothing.
  const notesCommand = `${toRunnableCommand(ctx.cyvCommand)} comments --hook antigravity`;
  const hooksContent = JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            // Matches every tool, because the vendor documents that matchers
            // accept a regular expression but names no tool identifiers for
            // Antigravity CLI, unlike Gemini's `write_file`/`replace`/`edit`.
            // A guessed identifier that did not match would fire on nothing
            // and report nothing. Narrowing is left to the analyzer, which
            // already no-ops on non-source files.
            matcher: '.*',
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
    path: hooksPath,
    strategy: 'json-merge',
    content: hooksContent,
    // Without this marker, re-planning would either duplicate our own entry
    // on every run or (worse, per `mergeArray` in `packages/core/src/merge/apply.ts`)
    // wholesale-replace `PostToolUse` and delete another tool's hook.
    ownershipMarker: 'hook antigravity',
    description: 'Register the checkyourvibe PostToolUse hook in .agents/hooks.json.',
  });

  const agentsMdPath = path.join(ctx.repoRoot, 'AGENTS.md');
  writes.push({
    path: agentsMdPath,
    strategy: 'managed-block',
    blockId: 'antigravity-workflow',
    content: renderWorkflowBody(),
    description: 'Add the checkyourvibe Antigravity CLI workflow to AGENTS.md.',
  });

  // Only the adapter whose agent the orchestrating lane names writes this,
  // and the body comes from core so all six say the same thing
  // (spec 0041 Requirements 1.1, 1.2).
  const orchestration = orchestrationWrite('antigravity', agentsMdPath, ctx.orchestration);
  if (orchestration !== undefined) {
    writes.push(orchestration);
  }

  const rulesPath = path.join(ctx.repoRoot, '.agents', 'skills', 'checkyourvibe-rules.md');
  writes.push({
    path: rulesPath,
    strategy: 'create-if-absent',
    content: renderRulesFile(ctx.rules),
    description:
      'Create combined checkyourvibe rule guidance for Antigravity CLI at .agents/skills/checkyourvibe-rules.md.',
  });

  return writes;
}

/**
 * Defensive, ordered list of field names tried when looking for the edited
 * path inside a `PostToolUse` payload.
 *
 * The task's vendor facts are explicit that Antigravity documents `toolCall.args`
 * as context but names no field within it for the edited path, and that the
 * path is merely "presumably somewhere under `toolCall.args`" — a guess the
 * vendor docs themselves do not make. This list is this plugin's own guess at
 * plausible names, borrowed from the fields Cursor and Gemini actually
 * document for the same purpose, ordered from most to least specific. It is
 * explicit, bounded, and visibly a guess rather than a fact — Requirement 1.5
 * forbids inferring a path by parsing a diff or command string, but trying a
 * short, named list of candidate field keys is not that. If none of these
 * match, `parseHookPayload` falls back to `scope: 'working-tree'` rather than
 * silently misreading another field as a path.
 */
export const ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS = [
  'absolute_path',
  'file_path',
  'filePath',
  'path',
] as const;

/**
 * Parses Antigravity CLI's `PostToolUse` payload.
 *
 * Per Requirement 1.5, this never scans the payload for anything that merely
 * looks like a path and never parses a diff or command string to recover one
 * — only the exact, named candidates in `ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS`
 * are tried, in order, first against `toolCall.args` and then, defensively,
 * against the payload's top level (the vendor docs describe neither shape
 * precisely enough to rule either out). When none match, the result is
 * `scope: 'working-tree'` with an empty `files` array rather than a guess.
 *
 * Throws ONLY when `raw` is not valid JSON at all. A payload that parses but
 * has no `toolCall.args` object, or one with none of the candidate fields, is
 * NOT malformed — Antigravity documents no path field at all, so its absence
 * is exactly the well-formed-but-unresolvable case the working-tree fallback
 * exists for (see the doc comment on `AgentPlugin.parseHookPayload`).
 * Requirement 5.4's degrade-on-parse-failure policy (warn and exit 0) belongs
 * in the CLI shim that catches this throw, not here.
 */
function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Antigravity CLI PostToolUse payload is not valid JSON.', { cause });
  }

  const eventRaw = isJSONObject(parsed) ? parsed['event'] : undefined;
  const event = typeof eventRaw === 'string' && eventRaw.length > 0 ? eventRaw : 'PostToolUse';

  const toolCall = isJSONObject(parsed) ? parsed['toolCall'] : undefined;
  const args = isJSONObject(toolCall) ? toolCall['args'] : undefined;
  const argFields = isJSONObject(args) ? args : undefined;

  if (argFields !== undefined) {
    for (const field of ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS) {
      const rawPath = argFields[field];
      if (typeof rawPath === 'string' && rawPath.length > 0) {
        const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
        return { files: [filePath], event, scope: 'files' };
      }
    }
  }

  if (isJSONObject(parsed)) {
    for (const field of ANTIGRAVITY_HOOK_CANDIDATE_PATH_FIELDS) {
      const rawPath = parsed[field];
      if (typeof rawPath === 'string' && rawPath.length > 0) {
        const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
        return { files: [filePath], event, scope: 'files' };
      }
    }
  }

  return { files: [], event, scope: 'working-tree' };
}

/**
 * Formats the hook's response.
 *
 * Vendor behaviour these exit codes rely on (Requirement 2.5): the task's
 * vendor facts state plainly that "exit 2 blocks" and "feedback is returned
 * via stdout JSON, as with Gemini and Codex" for Antigravity CLI. checkyourvibe's
 * checks are advisory (Requirement 2.3 forbids blocking here), so this always
 * exits 0 with empty stderr.
 *
 * The *field name* stdout uses to carry feedback is, like the edited-path
 * field, undocumented for Antigravity. This plugin reuses Gemini's
 * `hookSpecificOutput.additionalContext` shape rather than inventing a new
 * one, on the theory — stated here explicitly as a guess, not a fact — that
 * the vendor facts' mention of a *shared* global hooks location
 * (`~/.gemini/config/hooks.json`) suggests Antigravity CLI's hook engine is
 * built on, or shares a JSON contract with, Gemini CLI's. If that theory is
 * wrong, the effect is a hook that exits cleanly but whose feedback the model
 * never reads — degraded, not broken, and consistent with this project's
 * "advisory layer degrades, never obstructs" rule (Requirement 5.4).
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

const antigravityPlugin: AgentPlugin = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  surfaces: ['hook', 'instructions', 'guidance', 'mcp'],
  unverifiedSurfaces: [
    {
      surface: 'hook',
      reason:
        'The vendor facts name no actual PostToolUse matcher tool identifiers and no field name for the edited path. This plugin matches every tool and tries a short list of plausible path field names, falling back to `scope: \'working-tree\'` if none match.',
    },
    {
      surface: 'guidance',
      reason:
        'The stdout field that carries feedback is undocumented for Antigravity. This plugin reuses Gemini\'s `hookSpecificOutput.additionalContext` shape on the theory that the hook engine shares a JSON contract with Gemini\'s; if wrong, the model never reads it.',
    },
  ],
  detect,
  plan,
  parseHookPayload,
  formatResult,
};

export default antigravityPlugin;
