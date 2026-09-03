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

async function detect(ctx: DetectContext): Promise<boolean> {
  const settingsPath = path.join(ctx.homeDir, '.claude', 'settings.json');
  if (await fileExists(settingsPath)) {
    return true;
  }

  const pathEnv = process.env.PATH ?? '';
  if (pathEnv.length === 0) {
    return false;
  }

  const candidateNames = new Set<string>();
  candidateNames.add('claude');

  if (process.platform === 'win32') {
    const pathext = process.env.PATHEXT ?? '.EXE';
    for (const ext of pathext.split(path.delimiter)) {
      if (ext.length > 0) {
        candidateNames.add(`claude${ext.toLowerCase()}`);
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

function renderRuleAgent(rule: RuleManifest): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push(`name: cyv-${rule.id}`);
  lines.push(`description: ${JSON.stringify(rule.summary)}`);
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

async function plan(ctx: PlanContext): Promise<PlannedWrite[]> {
  const writes: PlannedWrite[] = [];

  const settingsPath = path.join(ctx.homeDir, '.claude', 'settings.json');
  const runnable = toRunnableCommand(ctx.cyvCommand);
  const hookCommand = `${runnable} hook claude-code`;
  // Notes the owner left on the dashboard reach the session the way findings
  // do, rather than waiting for the session to think of asking (spec 0042
  // Requirement 1.1). It reads two small files and exits 0 in silence when
  // there is nothing unread, so it costs an edit almost nothing.
  const notesCommand = `${runnable} comments --hook claude-code`;
  const settingsContent = JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: hookCommand }],
          },
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: notesCommand }],
          },
        ],
        // Claude Code's `Stop` event can refuse to end a turn, which is the one
        // contract among the six agents that can hold a turn open until a note
        // has been read (Requirement 1.2). Without it a note left while the
        // agent was mid-task waits for the next edit, and there may not be one.
        Stop: [{ hooks: [{ type: 'command', command: notesCommand }] }],
      },
    },
    null,
    2,
  );

  writes.push({
    path: settingsPath,
    strategy: 'json-merge',
    content: settingsContent,
    // The invoked subcommand, not the absolute path: a moved checkout changes
    // the path, and a stale entry we can no longer recognise would linger in
    // the user's settings forever. Every hook entry we generate ends with this.
    //
    // `hook claude-code` also matches `comments --hook claude-code`, so one
    // marker owns both entries and neither is orphaned by an upgrade.
    ownershipMarker: 'hook claude-code',
    description: 'Register the checkyourvibe post-edit and notes hooks in Claude Code settings.',
  });

  // Written to CLAUDE.md and not to AGENTS.md, which the codex, antigravity and
  // devin adapters write. That is not a duplicate of the same guidance in two
  // files: Claude Code reads CLAUDE.md and does not read AGENTS.md, so an agent
  // configured only through AGENTS.md receives none of this. Anthropic's own
  // documented workaround for the gap is an `@AGENTS.md` import or a symlink,
  // both of which are the user's choice to make, not this adapter's.
  //
  // What goes here is Claude-Code-specific: how its hook reports a violation.
  // Repository instructions belong in AGENTS.md, which is where a reader who
  // has both files should expect to find them.
  const claudeMdPath = path.join(ctx.repoRoot, 'CLAUDE.md');
  const workflowBody = [
    'checkyourvibe hooks into Claude Code after each TypeScript edit.',
    'If the analyzer finds violations, the hook exits with code 2 and writes the',
    'remediation guidance to stderr so Claude Code can act on it before the user does.',
    'Before choosing a fix, run `cyv explain <rule-id>` to read the full rule guidance.',
    'Pay special attention to the listed not-fixes: those are changes that would trade one violation for another.',
  ].join('\n\n');

  writes.push({
    path: claudeMdPath,
    strategy: 'managed-block',
    blockId: 'claude-code-workflow',
    content: workflowBody,
    description: 'Add the checkyourvibe Claude Code workflow to CLAUDE.md.',
  });

  // Only the adapter whose agent the orchestrating lane names writes this,
  // and the body comes from core so all six say the same thing
  // (spec 0041 Requirements 1.1, 1.2).
  const orchestration = orchestrationWrite('claude-code', claudeMdPath, ctx.orchestration);
  if (orchestration !== undefined) {
    writes.push(orchestration);
  }

  for (const rule of ctx.rules) {
    const agentPath = path.join(ctx.homeDir, '.claude', 'agents', `cyv-${rule.id}.md`);
    writes.push({
      path: agentPath,
      strategy: 'create-if-absent',
      content: renderRuleAgent(rule),
      description: `Create Claude Code agent guidance for rule ${rule.id}.`,
    });
  }

  return writes;
}

function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Claude Code PostToolUse payload is not valid JSON.', { cause });
  }

  if (!isJSONObject(parsed)) {
    throw new Error('Claude Code PostToolUse payload is not a JSON object.');
  }

  const toolInput = parsed['tool_input'];
  if (!isJSONObject(toolInput)) {
    throw new Error('Claude Code PostToolUse payload has no tool_input object.');
  }

  let rawPath: unknown = toolInput['file_path'];
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    rawPath = toolInput['filePath'];
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('Claude Code PostToolUse payload has no file_path or filePath in tool_input.');
  }

  const filePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(process.cwd(), rawPath);

  const hookEventName = parsed['hook_event_name'];
  const event =
    typeof hookEventName === 'string' && hookEventName.length > 0
      ? hookEventName
      : 'PostToolUse';

  return { files: [filePath], event };
}

function formatResult(violations: Violation[], ctx: FormatContext): HookResult {
  if (violations.length === 0) {
    const count = ctx.files.length;
    return {
      stdout: `Checked ${count} file${count === 1 ? '' : 's'}.`,
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

  // Only an error blocks, matching `exitCodeFor`. Exit 2 hands stderr back to
  // the model as something it must act on before continuing; a warning is
  // written to stdout instead, which Claude Code surfaces without treating the
  // edit as failed.
  const blocking = violations.some((violation) => violation.severity === 'error');

  if (!blocking) {
    return {
      stdout: parts.join('\n'),
      stderr: '',
      exitCode: 0,
    };
  }

  return {
    stdout: '',
    stderr: parts.join('\n'),
    exitCode: 2,
  };
}

const claudeCodePlugin: AgentPlugin = {
  id: 'claude-code',
  name: 'Claude Code',
  surfaces: ['hook', 'instructions', 'guidance', 'mcp'],
  detect,
  plan,
  parseHookPayload,
  formatResult,
};

export default claudeCodePlugin;
