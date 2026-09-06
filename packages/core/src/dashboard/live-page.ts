import { esc } from './render.js';
import { topNavHtml } from './nav.js';
import { dashboardCss } from './styles.js';
import { boardClientScript } from './board-client.js';
import { relativeTime } from './home.js';
import { summarizeGate } from './gate-health.js';
import { detectStall, idleLanes } from '../executor/stall.js';
import { replayLaneRuntimes } from '../executor/replay.js';
import { buildBoardModel, type BoardModel } from './board-model.js';

import type { SessionView } from './session-manager.js';
import type { HookDecisionRecord, LifecycleEvent } from '../cli/hook.js';
import type { DispatchLog } from '../executor/store.js';
import type { LaneDeclaration } from '../executor/lane.js';
import type { ParsedSpec } from './review/specs.js';
import type { CommentStore } from './review/comments.js';

export interface LivePageInput {
  project: string;
  projectName: string;
  now: number;
  decisions: readonly HookDecisionRecord[];
  lifecycleEvents: readonly LifecycleEvent[];
  log: DispatchLog;
  /** The comment store the board model reads, so both surfaces agree. */
  comments: CommentStore;
  /**
   * A board model already built, so a caller comparing surfaces can hand every
   * one of them the same model. Absent, this page builds its own from the log
   * and the comments — the same way the board does.
   */
  model?: BoardModel;
  sessions: readonly SessionView[];
  lanes: readonly LaneDeclaration[];
  specs?: readonly ParsedSpec[];
}

export async function buildLivePage(input: LivePageInput): Promise<LivePageInput> {
  return input;
}

export function renderLivePage(input: LivePageInput): string {
  const now = input.now;

  const gate = summarizeGate(input.decisions, now);
  const gateAge = gate.lastWriteAt ? relativeTime(now, Date.parse(gate.lastWriteAt)) : 'no evidence yet';
  const judgedCount = gate.considered - gate.unjudged;
  let gateStatus = gate.unjudged > 0 ? `GATE COULD NOT CHECK ${gate.unjudged} EDIT${gate.unjudged === 1 ? '' : 'S'}` : `gate judged ${judgedCount} edits`;
  if (!gate.lastWriteAt) gateStatus = 'NO EDITS JUDGED YET';

  const runtimes = replayLaneRuntimes(input.lanes, input.log.records);
  const openWorkExists = input.log.records.some(r => r.closed === undefined) || 
                         (input.specs !== undefined && input.specs.some(s => s.sections.some(sec => sec.tasks.some(t => !t.done))));
  const stall = openWorkExists ? detectStall({ runtimes, records: input.log.records, openWorkExists, now: new Date(now), intervalMinutes: 30 }) : undefined;
  
  const editingNowMs = gate.lastWriteAt ? Date.parse(gate.lastWriteAt) : 0;
  // EDITING_WINDOW_MS is 5 mins (300000 ms) in board-render.ts
  const isEditingNow = Number.isFinite(editingNowMs) && now - editingNowMs <= 300_000;
  
  let orchestratorStatus = 'No live session — nothing has fired a hook';
  if (stall !== undefined) {
    orchestratorStatus = 'ORCHESTRATOR STALLED';
  } else if (input.sessions.length > 0) {
    orchestratorStatus = isEditingNow ? 'EDITING NOW' : 'LIVE SESSION';
  }
  
  let orchestratorAge = 'no evidence yet';
  if (stall !== undefined && stall.lastOpenedAt !== undefined) {
    orchestratorAge = relativeTime(now, Date.parse(stall.lastOpenedAt));
  } else if (input.sessions.length > 0) {
    const activeEvent = input.lifecycleEvents.filter(e => input.sessions.some(s => s.sessionId === e.sessionId)).pop();
    if (activeEvent !== undefined) orchestratorAge = relativeTime(now, Date.parse(activeEvent.at));
  }

  const activeSessions = input.sessions.filter(s => s.alive);
  const sessionCount = activeSessions.length;
  const sessionText = `${sessionCount} live session${sessionCount === 1 ? '' : 's'}`;
  const sessionEvent = input.lifecycleEvents.at(-1);
  const sessionAge = sessionEvent !== undefined ? relativeTime(now, Date.parse(sessionEvent.at)) : 'no evidence yet';

  const board =
    input.model ??
    buildBoardModel({
      log: input.log,
      comments: input.comments,
      lanes: input.lanes,
      now,
    });

  // From the board's model rather than replayed a second time here. The board
  // counts a lane free when the dispatches executing on it are fewer than its
  // cap; replaying the log again gave a different answer for the same lanes,
  // which is the disagreement this page exists to make impossible.
  const idle = board.status?.idle ?? idleLanes(runtimes).length;
  const totalLanes = board.status?.totalLanes ?? input.lanes.length;
  const laneText = `${idle} free / ${totalLanes} total lanes`;
  const dispatchEvent = input.log.records.at(-1);
  const laneAge = dispatchEvent !== undefined ? relativeTime(now, Date.parse(dispatchEvent.openedAt)) : 'no evidence yet';

  // Read from the board's own model rather than counting the log again. The
  // first version of this counted every succeeded dispatch ever and reported
  // 41 waiting for review beside a board showing 6 — a second source of truth,
  // which is how two surfaces come to disagree.
  const executing = board.inMotion.filter((card) => card.outcome === undefined).length;
  const waitingForReview = board.inMotion.length - executing;
  const dispatchText = `${executing} executing, ${waitingForReview} waiting for review`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.projectName)} · Live</title>
<style>${dashboardCss()}</style>
<style>
.signal-table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
.signal-table th, .signal-table td { border: 1px solid var(--cyv-outline-variant); padding: 0.5rem; text-align: left; }
.signal-table th { background: var(--cyv-surface-container); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md" data-project="${esc(input.project)}">
<div class="cyv-page">
${topNavHtml(input.projectName, input.project, '/live')}
<main class="cyv-content max-w-4xl mx-auto p-4">
  <h1>Live Signals</h1>
  <div style="margin-bottom: 2rem;">
    <span class="board-live-badge font-mono-sm text-on-surface-variant" id="board-live-badge" role="status" data-live="not connected">
      <span class="board-dot board-live-dot bg-outline"></span>
      <span class="board-live-label">not connected</span>
      <span class="board-live-age" data-epoch="${now}">showing the page as it loaded</span>
    </span>
  </div>
  <table class="signal-table">
    <thead>
      <tr>
        <th>Signal</th>
        <th>What it says now</th>
        <th>Where it comes from</th>
        <th>How old that evidence is</th>
        <th>What would change it</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>the SSE badge</td>
        <td id="sse-wording">not connected</td>
        <td>the SSE stream</td>
        <td id="sse-age">no evidence yet</td>
        <td>A change in the network connection to the server.</td>
      </tr>
      <tr>
        <td>the gate badge</td>
        <td>${esc(gateStatus)}</td>
        <td>.cyv-review/decisions.jsonl</td>
        <td>${esc(gateAge)}</td>
        <td>A hook fires and records a decision.</td>
      </tr>
      <tr>
        <td>the orchestrator line</td>
        <td>${esc(orchestratorStatus)}</td>
        <td>the decision log</td>
        <td>${esc(orchestratorAge)}</td>
        <td>The orchestrator dispatches or a session connects.</td>
      </tr>
      <tr>
        <td>sessions</td>
        <td>${esc(sessionText)}</td>
        <td>.cyv-review/lifecycle.ndjson</td>
        <td>${esc(sessionAge)}</td>
        <td>A session starts or stops and fires its lifecycle hook.</td>
      </tr>
      <tr>
        <td>lanes</td>
        <td>${esc(laneText)}</td>
        <td>.cyv-review/dispatches.ndjson</td>
        <td>${esc(laneAge)}</td>
        <td>A dispatch opens or closes on a lane.</td>
      </tr>
      <tr>
        <td>dispatches</td>
        <td>${esc(dispatchText)}</td>
        <td>.cyv-review/dispatches.ndjson</td>
        <td>${esc(laneAge)}</td>
        <td>A dispatch opens or closes.</td>
      </tr>
    </tbody>
  </table>
</main>
</div>
<script>
${boardClientScript()}
var badge = document.getElementById('board-live-badge');
if (badge !== null) {
  var observer = new MutationObserver(function() {
    var wording = document.getElementById('sse-wording');
    var label = badge.querySelector('.board-live-label');
    if (wording !== null && label !== null) {
      wording.textContent = label.textContent;
    }
    var ageCell = document.getElementById('sse-age');
    var ageLabel = badge.querySelector('.board-live-age');
    if (ageCell !== null && ageLabel !== null) {
      ageCell.textContent = ageLabel.textContent;
    }
  });
  observer.observe(badge, { attributes: true, subtree: true, childList: true });
}
</script>
</body>
</html>`;
}
