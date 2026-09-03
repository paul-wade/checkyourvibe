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
 * Detects a `.cursor` project directory or a `cursor-agent` / `cursor` binary
 * on PATH. Never throws — an unreadable directory or an unset PATH both mean
 * "not detected", not "detection failed", so `cyv init` can plan for every
 * other agent without one plugin's filesystem hiccup aborting the whole run
 * (Requirement 4.3).
 */
async function detect(ctx: DetectContext): Promise<boolean> {
  if (await directoryExists(path.join(ctx.repoRoot, '.cursor'))) {
    return true;
  }

  try {
    return await binaryOnPath(['cursor-agent', 'cursor']);
  } catch {
    return false;
  }
}

/**
 * Renders one rule into a Cursor project rule (`.mdc`).
 *
 * MDC frontmatter must be the first bytes of the file for Cursor to parse
 * `description`/`alwaysApply` — safe here because this file is written with
 * `create-if-absent`, which owns the whole file on first write and never
 * touches it again once the user has it.
 */
function renderRule(rule: RuleManifest): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push(`description: ${JSON.stringify(rule.summary)}`);
  lines.push('alwaysApply: false');
  lines.push('---');
  lines.push('');

  lines.push(`# ${rule.id}`);
  lines.push('');
  lines.push(rule.summary);
  lines.push('');

  lines.push('## Why');
  lines.push('');
  lines.push(rule.why);
  lines.push('');

  if (rule.allowedFixes.length > 0) {
    lines.push('## Allowed fixes');
    lines.push('');
    for (const fix of rule.allowedFixes) {
      lines.push(`- ${fix}`);
    }
    lines.push('');
  }

  if (rule.notFixes.length > 0) {
    lines.push('## Not-fixes (these are themselves violations)');
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

  lines.push('## Examples');
  lines.push('');
  lines.push('### Bad');
  lines.push('');
  lines.push('```ts');
  lines.push(rule.examples.bad);
  lines.push('```');
  lines.push('');
  lines.push('### Good');
  lines.push('');
  lines.push('```ts');
  lines.push(rule.examples.good);
  lines.push('```');

  return lines.join('\n');
}

/**
 * Body for the shared workflow rule, deliberately without MDC frontmatter.
 *
 * `managed-block` only owns the delimited region — the merge in
 * `packages/core/src/merge/apply.ts` wraps this content in start/end comment
 * markers and, on first write, those markers ARE the top of the file. MDC
 * frontmatter has to be the file's first bytes to parse, so any frontmatter
 * placed inside the block would sit after the opening marker and Cursor would
 * read it as prose, not metadata. Rather than ship frontmatter that silently
 * fails to parse, this file carries none and relies on Cursor's default
 * treatment of an un-fronted `.mdc` file. Recorded here, and in the task
 * report, as a place the shared merge contract does not fit this vendor's
 * format cleanly (Requirement 7.2).
 */
function renderWorkflowBody(): string {
  return [
    'checkyourvibe hooks into Cursor after each file edit via `afterFileEdit`.',
    '',
    'If the analyzer finds violations, the hook still exits 0 — Cursor treats a',
    'non-zero exit from an `afterFileEdit` hook as a block, cancelling the edit,',
    'and an advisory check must never do that. Findings are written instead into',
    '`additional_context` in the hook\'s stdout JSON, which Cursor feeds back to',
    'the model.',
    '',
    'Before choosing a fix, run `cyv explain <rule-id>` to read the full rule',
    'guidance. Pay special attention to the listed not-fixes: those are changes',
    'that would trade one violation for another.',
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

  const hooksPath = path.join(ctx.repoRoot, '.cursor', 'hooks.json');
  const hookCommand = `${toRunnableCommand(ctx.cyvCommand)} hook cursor`;
  // Notes the owner left on the dashboard arrive the way findings do (spec 0042
  // Requirement 1.1). Silent and exit 0 when nothing is unread, so it costs an
  // edit almost nothing.
  const notesCommand = `${toRunnableCommand(ctx.cyvCommand)} comments --hook cursor`;
  const hooksContent = JSON.stringify(
    {
      version: 1,
      hooks: {
        afterFileEdit: [
          { type: 'command', command: hookCommand },
          { type: 'command', command: notesCommand },
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
    // wholesale-replace `afterFileEdit` and delete another tool's hook.
    ownershipMarker: 'hook cursor',
    description: 'Register the checkyourvibe afterFileEdit hook in .cursor/hooks.json.',
  });

  for (const rule of ctx.rules) {
    const rulePath = path.join(ctx.repoRoot, '.cursor', 'rules', `cyv-${rule.id}.mdc`);
    writes.push({
      path: rulePath,
      strategy: 'create-if-absent',
      content: renderRule(rule),
      description: `Create Cursor rule guidance for rule ${rule.id}.`,
    });
  }

  const workflowPath = path.join(ctx.repoRoot, '.cursor', 'rules', 'checkyourvibe.mdc');
  writes.push({
    path: workflowPath,
    strategy: 'managed-block',
    blockId: 'cursor-workflow',
    content: renderWorkflowBody(),
    description: 'Add the checkyourvibe Cursor workflow to .cursor/rules/checkyourvibe.mdc.',
  });

  // Only the adapter whose agent the orchestrating lane names writes this,
  // and the body comes from core so all six say the same thing
  // (spec 0041 Requirements 1.1, 1.2).
  const orchestration = orchestrationWrite('cursor', workflowPath, ctx.orchestration);
  if (orchestration !== undefined) {
    writes.push(orchestration);
  }

  return writes;
}

/**
 * Parses Cursor's `afterFileEdit` payload.
 *
 * Per the vendor docs this event names the edited file directly at `file_path`
 * (absolute) — unlike Codex/Gemini/Antigravity, no working-tree fallback is
 * needed here (Requirement 1.2). Throws on anything else; the CLI shim
 * catches, warns, and exits 0 rather than obstructing the user's edit
 * (Requirement 5.4) — that degrade-on-parse-failure policy belongs in the
 * shim, not here.
 */
function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Cursor afterFileEdit payload is not valid JSON.', { cause });
  }

  if (!isJSONObject(parsed)) {
    throw new Error('Cursor afterFileEdit payload is not a JSON object.');
  }

  const rawPath = parsed['file_path'];
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('Cursor afterFileEdit payload has no file_path.');
  }

  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);

  const hookEventName = parsed['hook_event_name'];
  const event =
    typeof hookEventName === 'string' && hookEventName.length > 0
      ? hookEventName
      : 'afterFileEdit';

  return { files: [filePath], event, scope: 'files' };
}

/**
 * Formats the hook's response.
 *
 * Vendor behaviour these exit codes rely on (Requirement 2.5): for Cursor,
 * exit 0 means success and Cursor parses stdout as JSON; exit 2 means BLOCK
 * the action outright. `afterFileEdit` is observational — the edit has
 * already happened — so a block would cancel work the user already did.
 * checkyourvibe's checks are advisory (Requirement 2.3 forbids blocking here),
 * so this always exits 0 and, when there are violations, carries them in
 * `additional_context` — the field Cursor surfaces to the model for an
 * observational hook — instead of stderr, which Cursor does not read back
 * into the conversation for this event.
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
    stdout: JSON.stringify({ additional_context: parts.join('\n') }),
    stderr: '',
    exitCode: 0,
  };
}

const cursorPlugin: AgentPlugin = {
  id: 'cursor',
  name: 'Cursor CLI',
  surfaces: ['hook', 'instructions', 'guidance', 'mcp'],
  detect,
  plan,
  parseHookPayload,
  formatResult,
};

export default cursorPlugin;
