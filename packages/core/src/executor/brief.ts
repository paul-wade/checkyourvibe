/**
 * The brief the orchestrating session is given about its own run (spec 0041
 * Requirement 1).
 *
 * `checkyourvibe.json` marks one lane `orchestrator: true`, and until this
 * existed nothing told the session that started in that folder. It learned the
 * hook reports violations, and nothing about the thing it was actually there to
 * do: plan the run, spread it across the other subscriptions, and review what
 * comes back. Three observed consequences are recorded in the spec's
 * introduction, and all three are the same failure — the tool knew and did not
 * say.
 *
 * One function generates the body, and every adapter writes the same text
 * (Requirement 1.2), because a brief that drifts per agent is a brief nobody
 * can trust to describe the run.
 *
 * Two things this may never contain (Requirement 1.4, and 0011 Requirements
 * 7.1 and 8.3): a ranking of any vendor's models, and any claim about an
 * account's remaining capacity. The core has no reading of either. A cap here
 * is the self-imposed number from the configuration, said as such.
 */
import { configuredLanes, maxConcurrentDispatches } from '../config/lanes.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import type { PlannedWrite } from '../protocol/agent.js';
import { agentCommandFor } from './invocation.js';
import { findProgram } from './program.js';
import { describeLane, type LaneExecutionMode, type ResolvedLaneDeclaration } from './lane.js';

/** A lane as the brief describes it: its declaration plus what was found on PATH. */
export interface LaneAvailability {
  lane: ResolvedLaneDeclaration;
  /**
   * The program the lane's agent runs, when this build maps its agent id to
   * one. `undefined` means no mapping exists, which is a different state from a
   * mapping whose program is absent.
   */
  program?: string;
  /**
   * Whether that program was found on PATH. `undefined` when there was nothing
   * to look for — a `subagent` lane spawns nothing, so its availability is not
   * a PATH question.
   */
  onPath?: boolean;
}

export interface BriefInput {
  lanes: readonly LaneAvailability[];
  /** Resolved `executor.maxConcurrentDispatches` (Requirement 3.1). */
  maxConcurrentDispatches: number;
}

function laneLine(entry: LaneAvailability): string {
  const { lane } = entry;
  const cap = `cap ${lane.concurrencyCap}`;
  const kinds = lane.models.map((offering) => offering.kind);
  const kindText = kinds.length === 0 ? 'no task kinds declared' : kinds.join(', ');

  let availability: string;
  if (lane.executes === 'subagent') {
    availability = 'run by this session as a sub-agent; nothing is spawned';
  } else if (entry.program === undefined) {
    availability = 'no program mapping in this build';
  } else if (entry.onPath === true) {
    availability = `\`${entry.program}\` found on PATH`;
  } else {
    availability = `\`${entry.program}\` NOT on PATH — contributes no capacity until installed`;
  }

  return `- ${describeLane(lane)} — ${cap}, ${kindText}. ${availability}.`;
}

function executionNote(mode: LaneExecutionMode): string {
  return mode === 'subagent'
    ? 'You are the only lane declared, so you execute dispatched work yourself, as a sub-agent ' +
        'of this session. `cyv dispatch` opens the record and writes the prompt; you do the work; ' +
        '`cyv dispatch --close <id>` takes the after snapshot, runs the gates and classifies the ' +
        'outcome by what actually changed.'
    : 'Dispatched work runs on the lanes below, not here. Your capacity is for planning, review ' +
        'and integration.';
}

/**
 * The body of the `orchestration` managed block.
 *
 * Returned without the block delimiters; the adapter wraps it, because the
 * comment syntax belongs to the file being written.
 */
export function orchestrationBrief(input: BriefInput): string {
  const orchestrator = input.lanes.find((entry) => entry.lane.orchestrator);
  const dispatchable = input.lanes.filter(
    (entry) => entry.lane.acceptsDispatch && !entry.lane.orchestrator,
  );

  const lines: string[] = [];

  lines.push('## You are the orchestrating session');
  lines.push('');
  if (orchestrator === undefined) {
    // Reached when an adapter asks for a brief from lanes that declare no
    // orchestrator. The block names that state and points at `cyv doctor`.
    lines.push(
      'No lane in `checkyourvibe.json` declares `orchestrator: true`, so this block should not ' +
        'have been written. Run `cyv doctor`.',
    );
    return lines.join('\n');
  }

  lines.push(
    `This repository declares lane \`${orchestrator.lane.id}\` as the orchestrator, and that is ` +
      'you. You plan the run, dispatch its work, and review what comes back.',
  );
  lines.push('');
  lines.push(executionNote(orchestrator.lane.executes));
  lines.push('');

  lines.push('### The lanes');
  lines.push('');
  if (dispatchable.length === 0) {
    lines.push(
      'No other lane accepts dispatched work. Every lane below is either reserved or absent; ' +
        '`cyv dispatch` will say which when it refuses.',
    );
  }
  for (const entry of input.lanes) {
    lines.push(laneLine(entry));
  }
  lines.push('');
  lines.push(
    `At most ${input.maxConcurrentDispatches} dispatch(es) may be open across every lane at once ` +
      '(`executor.maxConcurrentDispatches`). Each lane also has its own cap, above. Both numbers ' +
      'are self-imposed configuration, not a reading of any account: cyv has no view of a ' +
      "subscription's remaining capacity and never claims one.",
  );
  lines.push('');

  lines.push('### Running work');
  lines.push('');
  lines.push(
    '- A task is a checkbox in a spec\'s `tasks.md` with an `_Exec:` line naming its lane, its ' +
      'gates and the files it owns. That line is the declaration `cyv dispatch` reads.',
  );
  lines.push(
    '- `cyv plan <spec>` groups the open tasks into waves that can run at once — disjoint file ' +
      'scopes, dependencies satisfied. It dispatches nothing.',
  );
  lines.push(
    '- How wide a run can be is decided when `tasks.md` is written, not when it is dispatched. ' +
      '`AGENTS.md`, under "Planning for parallel execution", is how to write tasks that can run ' +
      'at once.',
  );
  lines.push(
    '- `cyv dispatch` opens one. The scheduler refuses the second of two dispatches whose ' +
      'declared files overlap, so how wide a run can be was decided when `tasks.md` was written.',
  );
  lines.push(
    '- **Do not edit the repository while a dispatch is running.** The outcome is classified by ' +
      'comparing snapshots taken before and after; your edits land in that diff and are ' +
      "attributed to the executor's work.",
  );
  lines.push('');

  lines.push('### Staying legible');
  lines.push('');
  lines.push(
    '- `cyv comments` shows notes the owner left on the dashboard, and writes a reply back. Read ' +
      'them when you start and between waves; a note that goes unread for an hour is the failure ' +
      'this command exists to prevent.',
  );
  lines.push(
    '- `cyv acknowledge <id>` takes an item off "needs you" once it needs nothing more.',
  );
  lines.push(
    '- `cyv orchestrator` records what you are doing, self-reported. A session that says nothing ' +
      'is indistinguishable from one that died.',
  );
  lines.push(
    '- If you are relieving an orchestrator that stopped, the run is readable from disk alone: ' +
      'the dispatch log holds every open record, and a dispatch whose process is gone is reported ' +
      'as abandoned rather than running. Read it before opening anything new.',
  );

  return lines.join('\n');
}

/**
 * The orchestration write for one adapter, or `undefined` when that adapter's
 * agent is not the orchestrator (spec 0041 Requirement 1.1).
 *
 * Every adapter calls this rather than composing its own block, so the six of
 * them cannot drift into six different descriptions of one run — which is what
 * Requirement 1.2 asks for by saying the block is generated "by one function in
 * core". An adapter supplies only what is genuinely its own: its id, and where
 * its instructions file lives.
 */
export function orchestrationWrite(
  agentId: string,
  instructionsPath: string,
  orchestration: BriefInput | undefined,
): PlannedWrite | undefined {
  if (orchestration === undefined) return undefined;
  const orchestrator = orchestration.lanes.find((entry) => entry.lane.orchestrator);
  if (orchestrator === undefined || orchestrator.lane.agentId !== agentId) return undefined;

  return {
    path: instructionsPath,
    strategy: 'managed-block',
    blockId: `${agentId}-orchestration`,
    content: orchestrationBrief(orchestration),
    description: `Brief the orchestrating session in ${instructionsPath}.`,
  };
}

/**
 * Build a `BriefInput` from the repository's configuration and this machine's
 * PATH.
 *
 * Availability is read here, once, rather than by each adapter: an adapter
 * knows where its own instructions file is and nothing about lanes, and six
 * copies of a PATH probe would be six chances for the brief to disagree with
 * `cyv doctor` about which programs exist.
 */
export async function resolveBriefInput(
  config: CheckYourVibeConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<BriefInput | undefined> {
  const lanes = configuredLanes(config);
  if (!lanes.some((lane) => lane.orchestrator)) return undefined;

  const entries: LaneAvailability[] = [];
  for (const lane of lanes) {
    if (lane.executes === 'subagent') {
      entries.push({ lane });
      continue;
    }
    const spec = agentCommandFor(lane.agentId);
    if (spec === undefined) {
      entries.push({ lane });
      continue;
    }
    const launcher = await findProgram(spec.program, env, cwd);
    entries.push({ lane, program: spec.program, onPath: launcher !== undefined });
  }

  return { lanes: entries, maxConcurrentDispatches: maxConcurrentDispatches(config) };
}
