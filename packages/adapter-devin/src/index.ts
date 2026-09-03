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
 * Detects a `.devin` directory in the repository, a `~/.config/devin` user
 * config directory, or a `devin` binary on PATH. Never throws — an unreadable
 * directory or an unset PATH both mean "not detected", not "detection failed",
 * so `cyv init` can plan for every other agent without one plugin's filesystem
 * hiccup aborting the whole run (Requirement 4.3).
 *
 * `devin --help` names `~/.config/devin/config.json` as the user config file,
 * and the CLI keeps its per-repository state — skills, MCP servers, hooks — in
 * a `.devin` directory inside the checkout. On Windows the user config lives
 * under `%APPDATA%` rather than `~/.config`, which is why the binary on PATH is
 * the third signal rather than the only one.
 */
async function detect(ctx: DetectContext): Promise<boolean> {
  if (await directoryExists(path.join(ctx.repoRoot, '.devin'))) {
    return true;
  }

  if (await directoryExists(path.join(ctx.homeDir, '.config', 'devin'))) {
    return true;
  }

  try {
    return await binaryOnPath(['devin']);
  } catch {
    return false;
  }
}

/**
 * Renders one rule as a Devin skill.
 *
 * `devin skills paths` names `.devin/skills/<skill-name>/SKILL.md` as a project
 * skill location and `devin skills show <name>` prints the frontmatter it read,
 * so both the layout and the `name` / `description` frontmatter keys are
 * confirmed rather than guessed. That makes this the per-rule surface
 * `adapter-codex` and `adapter-antigravity` had to fall back to a single
 * combined file for.
 *
 * The description is JSON-encoded so a summary containing a colon or a quote
 * stays a single valid YAML scalar.
 */
function renderRuleSkill(rule: RuleManifest): string {
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

/**
 * Body for the shared workflow block written into `AGENTS.md`.
 *
 * `devin rules list` reports `AGENTS [Standard] always-on` for a repository
 * carrying an `AGENTS.md`, so this is the instructions file Devin reads. The
 * block id is namespaced by the plugin id because `AGENTS.md` is shared ground
 * — `adapter-codex` and `adapter-antigravity` write their own blocks into the
 * same file.
 */
function renderWorkflowBody(): string {
  return [
    'checkyourvibe hooks into the Devin CLI after each edit or write tool call via',
    '`PostToolUse`.',
    '',
    'If the analyzer finds violations, the hook still exits 0, and the findings travel in',
    "`hookSpecificOutput.additionalContext` in the hook's stdout JSON, which Devin reads",
    'back to the model. An advisory check does not cancel an action.',
    '',
    'Before choosing a fix, run `cyv explain <rule-id>` to read the full rule guidance,',
    'which is also installed as one Devin skill per rule under `.devin/skills/`. Pay',
    'special attention to the listed not-fixes: those are changes that would trade one',
    'violation for another.',
  ].join('\n');
}

/**
 * The tool names whose payloads carry an edited path.
 *
 * Observed by running the CLI against a `PostToolUse` hook that logged every
 * `tool_name` it was handed: a file rewrite arrives as `write`, a string
 * replacement as `edit`, and a file read as `read`. The matcher is a regular
 * expression, and this one is unanchored, so a longer edit tool name
 * containing either word matches too.
 */
const EDIT_TOOL_MATCHER = 'edit|write';

/**
 * Builds the plugin's writes. MUST NOT touch the filesystem (Requirement 4 /
 * the `AgentPlugin.plan` contract) — everything here is pure string assembly,
 * and `packages/core/src/merge/apply.ts` is what actually reads and writes
 * these paths later.
 */
async function plan(ctx: PlanContext): Promise<PlannedWrite[]> {
  const writes: PlannedWrite[] = [];

  // `<repoRoot>/.devin/hooks.v1.json`. Devin reads hooks from this file with
  // the event names at its root, and from a `hooks` key in the user config
  // file; a hook registered in either was observed to run. The repository file
  // is the one written here, because it applies to this checkout alone rather
  // than to every project the user opens.
  //
  // The entry shape — a matcher paired with a list of `{ type, command,
  // timeout }` hooks — is the same one Claude Code uses, and `timeout` is set
  // to a value large enough not to cut the analyzer short under either unit
  // the field could carry: a hook left running for five seconds finished under
  // both `timeout: 2` and `timeout: 2000`, so the unit was never established.
  const hooksPath = path.join(ctx.repoRoot, '.devin', 'hooks.v1.json');
  const hookCommand = `${toRunnableCommand(ctx.cyvCommand)} hook devin`;
  // Notes the owner left on the dashboard arrive the way findings do (spec 0042
  // Requirement 1.1). Silent and exit 0 when nothing is unread, so it costs an
  // edit almost nothing.
  const notesCommand = `${toRunnableCommand(ctx.cyvCommand)} comments --hook devin`;
  const hooksContent = JSON.stringify(
    {
      PostToolUse: [
        {
          matcher: EDIT_TOOL_MATCHER,
          hooks: [
            {
              type: 'command',
              command: hookCommand,
              timeout: 30000,
            },
            {
              type: 'command',
              command: notesCommand,
              timeout: 30000,
            },
          ],
        },
      ],
    },
    null,
    2,
  );

  writes.push({
    path: hooksPath,
    strategy: 'json-merge',
    content: hooksContent,
    // The invoked subcommand rather than the absolute path: a moved checkout
    // changes the path, and an entry we could no longer recognise as ours would
    // either be duplicated on the next run or take another tool's hook with it
    // when the array is replaced.
    ownershipMarker: 'hook devin',
    description: 'Register the checkyourvibe PostToolUse hook in .devin/hooks.v1.json.',
  });

  const agentsMdPath = path.join(ctx.repoRoot, 'AGENTS.md');
  writes.push({
    path: agentsMdPath,
    strategy: 'managed-block',
    blockId: 'devin-workflow',
    content: renderWorkflowBody(),
    description: 'Add the checkyourvibe Devin CLI workflow to AGENTS.md.',
  });

  // Only the adapter whose agent the orchestrating lane names writes this,
  // and the body comes from core so all six say the same thing
  // (spec 0041 Requirements 1.1, 1.2).
  const orchestration = orchestrationWrite('devin', agentsMdPath, ctx.orchestration);
  if (orchestration !== undefined) {
    writes.push(orchestration);
  }

  for (const rule of ctx.rules) {
    const skillPath = path.join(ctx.repoRoot, '.devin', 'skills', `cyv-${rule.id}`, 'SKILL.md');
    writes.push({
      path: skillPath,
      strategy: 'create-if-absent',
      content: renderRuleSkill(rule),
      description: `Create Devin skill guidance for rule ${rule.id}.`,
    });
  }

  return writes;
}

/**
 * Parses Devin's `PostToolUse` payload.
 *
 * A payload observed from a real run carries `hook_event_name`, `tool_name`,
 * `tool_input`, `tool_use_id`, `tool_response`, `session_id` and `prompt_id`,
 * and the edit tools put an absolute path in `tool_input.file_path`. That path
 * is read by name and nothing else is scanned for something path-shaped, which
 * Requirement 1.5 forbids.
 *
 * Throws only when `raw` is not valid JSON. The registered matcher admits the
 * edit tools, but the same event fires for every tool, and a tool with no
 * `file_path` is a well-formed payload that names no file — that case yields
 * `scope: 'working-tree'` rather than a guess or a thrown error.
 */
function parseHookPayload(raw: string): HookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('Devin CLI PostToolUse payload is not valid JSON.', { cause });
  }

  let event = 'PostToolUse';
  if (isJSONObject(parsed)) {
    const hookEventName = parsed['hook_event_name'];
    if (typeof hookEventName === 'string' && hookEventName.length > 0) {
      event = hookEventName;
    }
  }

  const toolInput = isJSONObject(parsed) ? parsed['tool_input'] : undefined;
  const rawPath = isJSONObject(toolInput) ? toolInput['file_path'] : undefined;

  if (typeof rawPath === 'string' && rawPath.length > 0) {
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
    return { files: [filePath], event, scope: 'files' };
  }

  return { files: [], event, scope: 'working-tree' };
}

/**
 * Formats the hook's response.
 *
 * A hook that wrote `{"hookSpecificOutput":{"hookEventName":"PostToolUse",
 * "additionalContext":"..."}}` to stdout and exited 0 was observed to have that
 * text read back to the model, which is the channel used here. checkyourvibe's
 * checks are advisory (Requirement 2.3 forbids blocking), so this always exits
 * 0 with empty stderr, and the exit codes Devin treats as a block were never
 * exercised.
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

/**
 * `mcp` is declared because `devin mcp add --scope project` writes a
 * `.devin/mcp_config.json` and `devin mcp list` reads the servers back, the
 * same standing the other adapters declare the surface on. `plan` writes no MCP
 * server, as no other adapter does either.
 *
 * `executor` is not declared, even though a Devin lane is dispatchable through
 * `packages/core/src/executor/invocation.ts`. That table names agent ids
 * directly and no adapter declares the surface, so declaring it here alone
 * would read as the other four agents lacking a capability they have.
 */
const devinPlugin: AgentPlugin = {
  id: 'devin',
  name: 'Devin CLI',
  surfaces: ['hook', 'instructions', 'guidance', 'mcp'],
  detect,
  plan,
  parseHookPayload,
  formatResult,
};

export default devinPlugin;
