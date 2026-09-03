import type { RuleManifest } from '../protocol/index.js';
import {
  buildInterlockGraph,
  buildResultsView,
  buildTrend,
  buildNeverFiredView,
  buildBaselineView,
  buildSuppressionsView,
  buildRuleDebtMap,
  buildFileHeatView,
  radialLayout,
  suppressionScope,
  unattachedDebtRuleIds,
  type BaselineView,
  type FileHeatEntry,
  type FileHeatView,
  type InterlockGraph,
  type NeverFiredView,
  type ResultsView,
  type RuleDebt,
  type SuppressionsView,
  type Trend,
  type TrendPoint,
} from './model.js';
import type { RunRecord } from './history.js';
import type { LatestRun, LatestViolation } from './latest.js';
import { MAX_RECORDED_VIOLATIONS } from './latest.js';
import type { DispatchAttention, ExecutorLaneView, ExecutorView } from './executor-view.js';
import { laneBillingLabel, type LaneDeclaration } from '../executor/lane.js';
import type {
  DispatchRecord,
  LaneIneligibility,
  SchedulingRefusal,
} from '../executor/dispatch.js';
import type { DispatchOutcomeKind } from '../executor/outcome.js';
import type { Baseline, Suppression } from '../baseline/index.js';
import {
  evidenceLabel,
  guidanceSections,
  NOT_FIX_TARGET_VERB,
  type GuidanceSection,
} from '../guidance/templates.js';

/** Escape for HTML text and attribute contexts. */
export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

/**
 * Inlined so the page stays a single self-contained response. Without it every
 * load asked for /favicon.ico, which the dashboard's server does not route, so
 * a page that works perfectly logged a 404 to the console on arrival.
 */
const FAVICON = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="%230b57d0" stroke-width="2"/>' +
    '<path d="M5 8.5l2 2 4-4.5" fill="none" stroke="%230b57d0" stroke-width="2"/></svg>',
);

const CSS = `
:root{--bg:#fff;--fg:#16181d;--mut:#606770;--line:#e4e6ea;--acc:#0b57d0;--code:#f4f5f7;
      --err:#b3261e;--warn:#8a6100;--ok:#1a7f37;--card:#fafbfc;--edge:#9aa3af}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--mut:#98a1ad;--line:#252a32;
      --acc:#8ab4f8;--code:#161a20;--err:#f2b8b5;--warn:#f5c26b;--ok:#5fd77d;--card:#141821;--edge:#4a5260}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);padding:16px 16px 64px;max-width:1000px;
  margin-inline:auto;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--acc);text-decoration:none}
h1{font-size:1.4rem;margin:.2em 0 .1em}
h2{font-size:1.1rem;margin:1.8em 0 .5em;border-bottom:1px solid var(--line);padding-bottom:.3em}
.lede{color:var(--mut);margin:0 0 1.2em;max-width:62ch}
code{background:var(--code);padding:.12em .35em;border-radius:4px;font-size:.87em;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto;font-size:.85em}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
svg{display:block;margin:0 auto;max-width:100%;height:auto}
.node circle{fill:var(--card);stroke:var(--acc);stroke-width:2}
.node.iso circle{stroke:var(--edge);stroke-dasharray:4 3}
.node text{font-size:13px;fill:var(--fg);font-family:ui-monospace,monospace}
.edge{stroke:var(--edge);fill:none;stroke-width:1.4;opacity:.75}
.legend{color:var(--mut);font-size:.84rem;margin-top:10px;text-align:center}
.rule{border:1px solid var(--line);border-radius:10px;padding:14px;margin:12px 0;background:var(--card)}
.rule h3{margin:0 0 .2em;font-size:1rem;font-family:ui-monospace,monospace}
.meta{font-size:.76rem;color:var(--mut);margin-bottom:.7em}
.pill{display:inline-block;background:var(--code);border-radius:99px;padding:1px 9px;margin-right:6px}
.pill.err{color:var(--err)}.pill.warn{color:var(--warn)}
.sec{margin-top:.8em}
.sec b{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);
  margin-bottom:.3em;font-weight:600}
ul{margin:.2em 0;padding-left:1.2em}
li{margin:.15em 0}
.notfix{border-left:3px solid var(--warn);padding-left:10px;margin:.35em 0}
.notfix .p{font-weight:600}
.notfix .r{font-size:.78rem;color:var(--mut)}
.ex{display:grid;gap:10px;grid-template-columns:1fr}
@media(min-width:760px){.ex{grid-template-columns:1fr 1fr}}
.warnbox{border:1px solid var(--warn);border-radius:8px;padding:10px 12px;margin:1em 0;
  background:var(--card);font-size:.9rem}
.okbox{border:1px solid var(--ok);border-radius:8px;padding:10px 12px;margin:1em 0;
  background:var(--card);font-size:.9rem}
.emptybox{border:1px dashed var(--edge);border-radius:8px;padding:10px 12px;margin:1em 0;
  background:var(--card);font-size:.9rem;color:var(--mut)}
.pill.ok{color:var(--ok)}
.trend-table{border-collapse:collapse;width:100%;font-size:.85rem}
.trend-table th,.trend-table td{padding:4px 10px;border-bottom:1px solid var(--line);text-align:left;
  white-space:nowrap}
.trend-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:1em 0}
.filters input,.filters select{background:var(--code);color:var(--fg);border:1px solid var(--line);
  border-radius:8px;padding:8px 10px;font-size:16px}
.filters input{flex:1;min-width:180px}
.hidden{display:none}
.graph-grid{display:grid;gap:24px;grid-template-columns:1fr}

.graph-block h3{margin:.6em 0 .2em;font-size:1rem;font-family:ui-monospace,monospace}
.graph-block .sub{color:var(--mut);font-size:.78rem;margin-bottom:.4em}
.filegroup{border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0;
  background:var(--card)}
.filegroup h3{margin:0 0 .4em;font-size:.92rem;font-family:ui-monospace,monospace;font-weight:600}
.filegroup .sub{color:var(--mut);font-weight:400;font-size:.78rem}
.findings{list-style:none;padding:0;margin:0}
.findings li{padding:.28em 0;border-top:1px solid var(--line);font-size:.88rem}
.findings li:first-child{border-top:0}
.findings .msg{color:var(--mut)}
.pill.debt{color:var(--warn)}
.expired-row{opacity:.85}
.expired-row .pill{color:var(--err)}
.suppression-list{padding-left:1.2em}
.suppression-list li{margin:.3em 0}
#freshness{display:flex;align-items:center;gap:.5em;font-size:.82rem}
#freshness::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--ok);
  display:inline-block;flex:none}
#freshness.stale::before{background:var(--err)}
#freshness.stale{color:var(--err)}
`;

const CLIENT = `
const q=document.getElementById('q');
const cat=document.getElementById('cat');
function apply(){
  const term=(q.value||'').toLowerCase();
  const c=cat.value;
  let shown=0;
  for(const el of document.querySelectorAll('.rule')){
    const okCat=!c||el.dataset.category===c;
    const okTerm=!term||el.dataset.haystack.includes(term);
    const show=okCat&&okTerm;
    el.classList.toggle('hidden',!show);
    if(show)shown++;
  }
  document.getElementById('count').textContent=shown+' shown';
}
q.addEventListener('input',apply);
cat.addEventListener('change',apply);
`;

/**
 * Polls `/volatile.html` — the same panels (results, trend, never-fired,
 * file heat, baseline, suppressions), re-rendered from the same on-disk
 * sources `renderDashboard` reads at startup — and swaps them in place, so a
 * page left open keeps showing current data without a full reload.
 *
 * The rule browser and interlock graph below `#volatile` are deliberately
 * NOT re-fetched: manifests are static (see this page's own lede), so
 * re-polling them would buy nothing and would fight the search/category
 * filter's live DOM state for no reason.
 *
 * `#freshness` is the visible tell between fresh and stale data (constraint
 * 3): a green dot and "updated Ns ago" while polling succeeds, a red dot and
 * "refresh failed" the moment a poll doesn't — so a reader never has to
 * guess whether what's on screen is current or whether the page simply
 * stopped updating in the background.
 */
function refreshClient(volatileHref: string): string {
  return `
(function(){
  var VOLATILE=${JSON.stringify(volatileHref)};
  var panel=document.getElementById('volatile');
  var status=document.getElementById('freshness');
  if(!panel||!status)return;
  var lastOk=Date.now();
  var failed=false;
  function paint(){
    var secs=Math.round((Date.now()-lastOk)/1000);
    var ago=secs<2?'just now':secs+'s ago';
    status.textContent=failed
      ? ('Refresh failed — showing data from '+ago)
      : ('Live — updated '+ago+' — refreshing every 15s');
    status.classList.toggle('stale',failed);
  }
  function poll(){
    fetch(VOLATILE,{cache:'no-store'}).then(function(r){
      if(!r.ok)throw new Error('bad status '+r.status);
      return r.text();
    }).then(function(html){
      panel.innerHTML=html;
      lastOk=Date.now();
      failed=false;
      paint();
    }).catch(function(){
      failed=true;
      paint();
    });
  }
  setInterval(paint,1000);
  setInterval(poll,15000);
  paint();
})();
`;
}

/**
 * Where the rules page sits relative to the dashboard it is one tab of (spec
 * 0040 Requirement 7.3): the link back, and the query the poll has to carry so
 * it re-reads the same project.
 */
export interface RulesPageNav {
  homeHref: string;
  volatileHref: string;
}

function severityPill(severity: string): string {
  const cls = severity === 'error' ? 'err' : 'warn';
  return `<span class="pill ${cls}">${esc(severity)}</span>`;
}

/** The text drawn beside a node: its id, then how many dead ends point at it and how many it declares. */
function nodeLabel(node: { id: string; inDegree: number; outDegree: number }): string {
  return `${node.id} (${node.inDegree}↓ ${node.outDegree}↑)`;
}

/**
 * Advance width of one character at the 13px ui-monospace the node labels are
 * set in, and the gap between a node and its label. Both are used to reserve
 * horizontal room for the labels, which sit outside the circle the nodes are
 * placed on.
 */
const LABEL_CHAR_WIDTH = 7.8;
const LABEL_GAP = 14;

/** Lay out one analyzer/pack's rules as a labelled circle. */
function renderGraph(graph: InterlockGraph, index: number): string {
  // The canvas has to fit the circle plus the longest label extending out from
  // it. Reserving a fixed margin instead is what clipped `no-unchecked-cast`
  // to `no-unchecke` and `no-tautological-assertion` off the left edge
  // entirely: at 13px monospace that label is over 250px wide, and the margin
  // was 90.
  const widestLabel =
    Math.max(...graph.nodes.map((node) => nodeLabel(node).length), 0) * LABEL_CHAR_WIDTH;
  const radius = Math.max(150, graph.nodes.length * 22);
  const gutterX = LABEL_GAP + widestLabel + 10;
  const gutterY = 34;
  const width = 2 * (radius + gutterX);
  const height = 2 * (radius + gutterY);
  const cx = width / 2;
  const cy = height / 2;
  const points = radialLayout(
    graph.nodes.map((n) => n.id),
    cx,
    cy,
    radius,
  );
  const at = new Map(points.map((p) => [p.id, p]));

  const edgePaths = graph.edges
    .map((edge) => {
      const a = at.get(edge.from);
      const b = at.get(edge.to);
      if (a === undefined || b === undefined) return '';
      // Bow each edge toward the centre so opposing pairs stay distinguishable.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const qx = mx + (cx - mx) * 0.55;
      const qy = my + (cy - my) * 0.55;
      const title = `${edge.from} → ${edge.to}: ${edge.pattern}`;
      return `<path class="edge" d="M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}" marker-end="url(#arrow-${index})"><title>${esc(title)}</title></path>`;
    })
    .join('');

  const nodeMarks = graph.nodes
    .map((node) => {
      const p = at.get(node.id);
      if (p === undefined) return '';
      const iso = graph.isolated.includes(node.id) ? ' iso' : '';
      const anchor = p.x < cx - 10 ? 'end' : p.x > cx + 10 ? 'start' : 'middle';
      const dx = anchor === 'end' ? -14 : anchor === 'start' ? 14 : 0;
      const dy = anchor === 'middle' ? (p.y < cy ? -14 : 20) : 4;
      const label = nodeLabel(node);
      return `<g class="node${iso}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10"><title>${esc(node.summary)}</title></circle>` +
        `<text x="${(p.x + dx).toFixed(1)}" y="${(p.y + dy).toFixed(1)}" text-anchor="${anchor}">${esc(label)}</text></g>`;
    })
    .join('');

  const isolatedNote =
    graph.isolated.length > 0
      ? `<div class="warnbox"><b>${graph.isolated.length} rule${graph.isolated.length === 1 ? '' : 's'} isolated within the ${esc(graph.group)} ${graph.kind}:</b>
         ${graph.isolated.map((id) => `<code>${esc(id)}</code>`).join(' ')}.
         An isolated rule is not wrong, but nothing else in the same ${graph.kind} points at it and it points at nothing —
         so an agent that trips it has no signposted dead ends to avoid.</div>`
      : '';

  return `<div class="graph-block"><h3><code>${esc(graph.group)}</code></h3>
<div class="sub">${graph.nodes.length} rules</div>
<div class="wrap">
<svg viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" width="${width.toFixed(0)}" height="${height.toFixed(0)}" role="img"
     aria-label="Directed graph of rules and their notFixes in ${esc(graph.group)}">
  <defs><marker id="arrow-${index}" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6"
    orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--edge)"/></marker></defs>
  ${edgePaths}${nodeMarks}
</svg></div>
<div class="legend">${graph.nodes.length} rules · ${graph.edges.length} rule-to-rule dead ends ·
${graph.danglingPatterns.length} dead ends that are simply bad ideas</div>
${isolatedNote}</div>`;
}

function renderGraphs(graphs: InterlockGraph[]): string {
  return `<h2>The interlock</h2>
<p class="lede">Each arrow is a <code>notFix</code>: a remediation that looks like a fix but would trip
a rule in the same pack or analyzer. Rules from different analyzers never share edges, because a
violation in one analyzer cannot be a dead end for a rule in another. This is what stops an agent
trading one violation for another, and it is the one thing a scrolling report cannot show you.</p>
<div class="graph-grid">
${graphs.map((graph, index) => renderGraph(graph, index)).join('')}
</div>`;
}

/** Hand-drawn line chart of total violations across recorded runs, oldest to newest. */
function renderTotalChart(points: TrendPoint[]): string {
  const width = 640;
  const height = 200;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 12;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const max = Math.max(1, ...points.map((p) => p.total));

  const coords = points.map((p, i) => {
    const x = padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = padT + innerH - (p.total / max) * innerH;
    return { x, y, p };
  });

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const dots = coords
    .map((c) => {
      const title = `${c.p.timestamp} (${c.p.commit.slice(0, 7)}): ${c.p.total} violation(s)`;
      return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="var(--acc)"><title>${esc(title)}</title></circle>`;
    })
    .join('');

  const axisY0 = padT + innerH;
  return `<div class="wrap"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
     aria-label="Total violations over time, ${points.length} runs">
  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${axisY0}" stroke="var(--line)"/>
  <line x1="${padL}" y1="${axisY0}" x2="${width - padR}" y2="${axisY0}" stroke="var(--line)"/>
  <text x="2" y="${padT + 8}" font-size="10" fill="var(--mut)">${max}</text>
  <text x="2" y="${axisY0 + 4}" font-size="10" fill="var(--mut)">0</text>
  <path d="${path}" fill="none" stroke="var(--acc)" stroke-width="2"/>
  ${dots}
</svg></div>`;
}

/** A small inline sparkline for one rule's per-run counts. Not a standalone chart — a table cell. */
function sparkline(values: number[]): string {
  const width = 90;
  const height = 22;
  const max = Math.max(1, ...values);
  const n = values.length;

  const points = values
    .map((v, i) => {
      const x = n === 1 ? width / 2 : (i / (n - 1)) * width;
      const y = height - (v / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="var(--acc)" stroke-width="1.5"/></svg>`;
}

interface RuleTrendRow {
  id: string;
  series: number[];
  latest: number;
  delta: number;
}

function ruleTrendRows(points: TrendPoint[]): RuleTrendRow[] {
  const ids = new Set<string>();
  for (const point of points) {
    for (const id of Object.keys(point.ruleCounts)) ids.add(id);
  }

  return [...ids]
    .map((id) => {
      const series = points.map((point) => point.ruleCounts[id] ?? 0);
      const latest = series.at(-1) ?? 0;
      const previous = series.length > 1 ? (series.at(-2) ?? 0) : latest;
      return { id, series, latest, delta: latest - previous };
    })
    .sort((a, b) => b.latest - a.latest || a.id.localeCompare(b.id));
}

function deltaLabel(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return '±0';
}

/** Per-rule counts over time: a table, not a multi-series chart — many series overlaid is unreadable on a phone. */
function renderRuleTrendTable(points: TrendPoint[]): string {
  const rows = ruleTrendRows(points);
  if (rows.length === 0) {
    return '<p class="lede">No rule produced a finding in any recorded run.</p>';
  }

  const body = rows
    .map(
      (row) => `<tr><td><code>${esc(row.id)}</code></td><td class="num">${row.latest}</td>
        <td class="num">${esc(deltaLabel(row.delta))}</td><td>${sparkline(row.series)}</td></tr>`,
    )
    .join('');

  return `<div class="wrap"><table class="trend-table">
    <thead><tr><th>rule</th><th>latest</th><th>vs previous run</th><th>trend</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/**
 * Requirement 4.5: fewer than two runs cannot show a direction, so this is a
 * distinct message rather than a chart with one point plotted on it.
 */
function renderTrend(trend: Trend): string {
  if (trend.kind === 'insufficient-data') {
    const detail =
      trend.runCount === 0
        ? 'No runs have been recorded yet.'
        : `Only ${trend.runCount} run has been recorded.`;
    return `<h2>Trend</h2>
<div class="emptybox"><b>Not enough data for a trend.</b> ${detail} A chart of a single point would imply
a direction that does not exist. Run <code>cyv check --record-history</code> again after your next change
to start one — trends need at least two runs.</div>`;
  }

  return `<h2>Trend</h2>
<p class="lede">Total violations across ${trend.points.length} recorded runs, oldest to newest.</p>
${renderTotalChart(trend.points)}
<h3>Per-rule counts over time</h3>
${renderRuleTrendTable(trend.points)}`;
}

/** An elapsed time as "just now", "12s ago", "3m ago" or "2h ago". */
function relativeTime(from: string, now: number): string {
  const then = Date.parse(from);
  if (Number.isNaN(then)) return from;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 2) return 'just now';
  if (secs < 90) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * Absolute paths are what analyzers report (the protocol requires it), but they
 * are not what a reader wants to look at: the repository prefix is identical on
 * every row and pushes the part that differs off to the right.
 */
function relativeToRepo(file: string, repoRoot: string): string {
  if (repoRoot === '') return file;
  const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const path = file.replace(/\\/g, '/');
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/**
 * A commit that is not a real sha — the placeholder a repository with no
 * commits yet produces — must not be abbreviated. `(uncommitted)` sliced to ten
 * characters reads as a corrupted hash rather than as a state.
 */
function commitLabel(commit: string): string {
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 10) : commit;
}

/** Group findings by file, most findings first, so the worst file is the one you read. */
function byFile(violations: readonly LatestViolation[]): Array<[string, LatestViolation[]]> {
  const groups = new Map<string, LatestViolation[]>();
  for (const v of violations) {
    const bucket = groups.get(v.file);
    if (bucket === undefined) groups.set(v.file, [v]);
    else bucket.push(v);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/**
 * The panel that answers the question someone actually opens this page with:
 * is something running, and if not, what do I have to fix.
 *
 * It leads the page because a rule catalogue does not answer that. Findings are
 * listed with file, line and message, grouped by file, because a total is not
 * something you can act on — the previous version of this page reported
 * "12 violations" and gave a reader no way to learn what any of them were.
 */
function renderNow(latest: LatestRun | null, now: number, repoRoot: string): string {
  if (latest === null) {
    return `<h2>Latest run</h2>
<div class="emptybox">No run has been recorded yet. Run <code>cyv check --all</code> and reload:
every check records what it found, with no flag to remember.</div>`;
  }

  if (latest.status === 'running') {
    const scope =
      latest.filesChecked === undefined
        ? `<code>${esc(latest.mode)}</code>`
        : `${latest.filesChecked} file(s), <code>${esc(latest.mode)}</code>`;
    return `<h2>Latest run</h2>
<div class="okbox"><b>Running now.</b> Checking ${scope}, started ${esc(relativeTime(latest.startedAt, now))}.</div>`;
  }

  const took = Math.max(0, Date.parse(latest.finishedAt) - Date.parse(latest.startedAt));
  const tookText = Number.isNaN(took) ? '' : ` in ${(took / 1000).toFixed(1)}s`;
  const when = esc(relativeTime(latest.finishedAt, now));
  const scope = `${latest.filesChecked} file(s) checked, <code>${esc(latest.mode)}</code>, commit <code>${esc(commitLabel(latest.commit))}</code>`;

  if (latest.violationCount === 0) {
    return `<h2>Latest run</h2>
<div class="okbox"><b>Clean.</b> ${scope} — finished ${when}${esc(tookText)}.</div>`;
  }

  const groups = byFile(latest.violations);
  const truncated =
    latest.violationCount > latest.violations.length
      ? `<div class="sub">Showing the first ${latest.violations.length} of ${latest.violationCount}.
         The record is capped at ${MAX_RECORDED_VIOLATIONS} findings; run <code>cyv check --all</code>
         in a terminal for the rest.</div>`
      : '';

  const files = groups
    .map(([file, list]) => {
      const rows = list
        .map(
          (v) =>
            `<li><code>${v.line}:${v.column}</code> <b>${esc(v.ruleId)}</b> ${severityPill(v.severity)}
             <span class="msg">${esc(v.message)}</span></li>`,
        )
        .join('');
      return `<div class="filegroup"><h3><code>${esc(relativeToRepo(file, repoRoot))}</code> <span class="sub">${list.length} finding(s)</span></h3>
<ul class="findings">${rows}</ul></div>`;
    })
    .join('');

  return `<h2>Latest run</h2>
<div class="warnbox"><b>${latest.violationCount} finding(s)</b> in ${groups.length} of ${scope}.
Finished ${when}${esc(tookText)}.</div>
${truncated}
${files}`;
}

/**
 * Requirement 7.2/7.3: "never run" and "ran clean" must read as different
 * states, not both collapse to a bare "0". The `no-history` branch says so in
 * words; a recorded run with no violations gets the "0 violations" headline
 * and an `okbox` instead.
 */
function renderResults(view: ResultsView): string {
  if (view.kind === 'no-history') {
    return `<h2>Results</h2>
<div class="emptybox"><b>Analysis has never been run.</b> This is not the same as a clean project — it
means nobody has recorded a result yet. Run <code>cyv check --record-history</code> to take the first
one.</div>`;
  }

  const { record, runCount } = view;
  const clean = record.totalViolations === 0;
  const box = clean ? 'okbox' : 'warnbox';
  const headline = clean
    ? '<b>0 violations</b> in the most recently recorded run.'
    : `<b>${record.totalViolations} violation${record.totalViolations === 1 ? '' : 's'}</b> in the most recently recorded run.`;

  const rows = Object.entries(record.ruleCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => `<tr><td><code>${esc(id)}</code></td><td class="num">${count}</td></tr>`)
    .join('');

  const table =
    record.totalViolations > 0
      ? `<div class="wrap"><table class="trend-table">
          <thead><tr><th>rule</th><th>count</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : '';

  return `<h2>Results</h2>
<div class="${box}">${headline} ${record.filesChecked} file(s) checked, commit
<code>${esc(record.commit.slice(0, 12))}</code>, ${esc(record.timestamp)}.
(${runCount} run${runCount === 1 ? '' : 's'} recorded in total.)</div>
${table}`;
}

/**
 * Requirement 5: never-fired rules must read as a problem to investigate, not
 * a success — and must never be confused with a rule that simply isn’t
 * enabled (those are excluded before this function is ever called; see
 * `computeNeverFired`).
 */
function renderNeverFired(view: NeverFiredView): string {
  if (view.kind === 'no-history') {
    return `<h2>Never-fired rules</h2>
<div class="emptybox"><b>No run history yet.</b> Whether an enabled rule has never fired or simply hasn’t
been checked look identical with zero data, so this view withholds judgment rather than guessing. Run
<code>cyv check --record-history</code> at least once.</div>`;
  }

  if (view.kind === 'no-evidence') {
    return `<h2>Never-fired rules</h2>
<div class="okbox"><b>No violations have been recorded in ${view.runCount} run(s), so this view has
nothing to say yet.</b> Every rule is trivially "never fired" when nothing fired at all — that is a
fact about the codebase being clean, not evidence about any rule. Judgment resumes once some rule
finds something and others stay silent.</div>`;
  }

  if (view.rules.length === 0) {
    return `<h2>Never-fired rules</h2>
<div class="okbox">Every enabled rule has fired at least once across ${view.runCount} recorded run(s).</div>`;
  }

  const items = view.rules
    .map((rule) => `<li><code>${esc(rule.id)}</code> — ${esc(rule.summary)}</li>`)
    .join('');

  return `<h2>Never-fired rules</h2>
<div class="warnbox"><b>${view.rules.length} enabled rule(s) have produced no finding across
${view.runCount} recorded run(s), while other rules found ${view.totalFindings} violation(s).</b>
That asymmetry is the signal: a rule silent while its neighbours fire is redundant, mis-targeted at
something that does not occur in this codebase, or silently broken — and the third case is invisible
everywhere except here.
<ul>${items}</ul></div>`;
}

/** Files ranked by their latest recorded count, with a per-file sparkline reusing the rule trend's rendering. */
function fileHeatTable(files: FileHeatEntry[]): string {
  const body = files
    .map(
      (f) => `<tr><td><code>${esc(f.path)}</code></td><td class="num">${f.latest}</td>
        <td class="num">${esc(deltaLabel(f.delta))}</td><td>${sparkline(f.series)}</td></tr>`,
    )
    .join('');

  return `<div class="wrap"><table class="trend-table">
    <thead><tr><th>file</th><th>latest</th><th>vs previous tracked run</th><th>trend</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/**
 * docs/ROADMAP.md, "0031 — The dashboard as something you would leave open":
 * per-file heat and which files are getting worse rather than better,
 * computed only from runs whose recorded `fileCounts` this dashboard
 * actually has — never invented from the latest run alone (constraint: a
 * single run has no "worse" or "better" to report, only a snapshot).
 *
 * Four states rather than three on the page, but they collapse to the same
 * three-way discipline as `renderNeverFired`/`renderBaseline`: `no-history`
 * and `no-file-data` are both "no data", just for two different reasons
 * worth naming separately (see `buildFileHeatView`'s doc comment); `no-evidence`
 * is "data, nothing to say"; `heat` is the real finding.
 */
function renderFileHeat(view: FileHeatView): string {
  if (view.kind === 'no-history') {
    return `<h2>File heat</h2>
<div class="emptybox"><b>No run history yet.</b> Run <code>cyv check --record-history</code> to start
recording which files carry findings.</div>`;
  }

  if (view.kind === 'no-file-data') {
    return `<h2>File heat</h2>
<div class="emptybox"><b>${view.runCount} run(s) recorded, but all of them predate per-file tracking.</b>
That is a gap in what was recorded, not a claim that no file has findings — run
<code>cyv check --record-history</code> again to start collecting it.</div>`;
  }

  if (view.kind === 'no-evidence') {
    return `<h2>File heat</h2>
<div class="okbox"><b>${view.runsWithFileData} of ${view.runCount} recorded run(s) tracked per-file
counts, and every one of them is zero.</b> No file has carried a finding in any tracked run — a fact
about the codebase, not a sign that file tracking is broken.</div>`;
  }

  const worse = view.files
    .filter((f) => f.delta > 0)
    .sort((a, b) => b.delta - a.delta || a.path.localeCompare(b.path));

  const worseSection =
    worse.length > 0
      ? `<h3>Getting worse</h3>
<p class="lede">Files whose latest tracked count rose since the previous run that tracked files.</p>
${fileHeatTable(worse)}`
      : `<div class="okbox">No file's count rose since the previous run that tracked files.</div>`;

  const coverageNote =
    view.runsWithFileData < view.runCount
      ? ` (${view.runCount - view.runsWithFileData} earlier run(s) predate per-file tracking and are not reflected below.)`
      : '';

  return `<h2>File heat</h2>
<p class="lede">Ranked by latest tracked count, across ${view.runsWithFileData} run(s) that recorded
per-file counts.${esc(coverageNote)}</p>
${fileHeatTable(view.files)}
${worseSection}`;
}

function countTable(rows: [string, number][], headLabel: string): string {
  const body = rows
    .map(([key, count]) => `<tr><td><code>${esc(key)}</code></td><td class="num">${count}</td></tr>`)
    .join('');
  return `<div class="wrap"><table class="trend-table">
    <thead><tr><th>${esc(headLabel)}</th><th>count</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/**
 * Requirement 5: baseline burn-down, read from the baseline file as it
 * exists on disk. This is deliberately NOT "remaining after checking
 * against the current tree" — the dashboard never runs an analyzer to
 * render itself, so it cannot verify whether a recorded entry still matches
 * anything (`cyv baseline --status` does that, live). What follows is
 * exactly what was recorded, said as that and nothing more, per Requirement
 * 5.5: a number and a direction, no scores, no streaks, no celebration.
 */
function renderBaseline(view: BaselineView): string {
  const lede = `<p class="lede">What the baseline file on disk currently records — not verified against
the current tree. Run <code>cyv baseline --status</code> for what remains after checking.</p>`;

  if (view.kind === 'no-baseline') {
    return `<h2>Baseline</h2>${lede}
<div class="emptybox"><b>No baseline has been taken.</b> This says nothing about debt — nobody has
run <code>cyv baseline</code> yet. A repository with no baseline could be spotless or could have
thousands of violations recorded nowhere; this view cannot tell which.</div>`;
  }

  if (view.kind === 'empty') {
    return `<h2>Baseline</h2>${lede}
<div class="okbox"><b>Baseline taken ${esc(view.takenAt)} against commit
<code>${esc(view.commit.slice(0, 12))}</code> — 0 entries recorded.</b> Someone ran
<code>cyv baseline</code> and there was nothing to defer. That is a stronger claim than
"no baseline": the repository was checked, not merely unvisited.</div>`;
  }

  return `<h2>Baseline</h2>${lede}
<div class="warnbox"><b>${view.total} entr${view.total === 1 ? 'y' : 'ies'} recorded</b>, taken
${esc(view.takenAt)} against commit <code>${esc(view.commit.slice(0, 12))}</code>.</div>
<h3>By rule</h3>
${countTable(view.byRule, 'rule')}
<h3>By file (worst first)</h3>
${countTable(view.byFile, 'file')}`;
}

/**
 * How much one suppression covers, in the words `cyv check` uses for the same
 * split: a broad one matches a rule id against a path glob and covers
 * violations written after it, a pinned one names one recorded finding by
 * snippet fingerprint (see `suppressionScope`).
 */
function scopeCell(suppression: Suppression): string {
  if (suppressionScope(suppression) === 'pinned') {
    const at =
      suppression.occurrence === undefined
        ? 'fingerprint'
        : `fingerprint, occurrence ${suppression.occurrence}`;
    return `<span class="pill">pinned</span> <span class="msg">one finding (${esc(at)})</span>`;
  }
  return `<span class="pill debt">broad</span> <span class="msg">every match, including
    violations added later</span>`;
}

function suppressionRow(suppression: Suppression, expired: boolean): string {
  const cls = expired ? ' class="expired-row"' : '';
  const badge = expired ? '<span class="pill">EXPIRED</span> ' : '';
  return `<tr${cls}><td>${badge}<code>${esc(suppression.ruleId)}</code></td>
    <td><code>${esc(suppression.target)}</code></td>
    <td>${scopeCell(suppression)}</td>
    <td>${esc(suppression.reason)}</td>
    <td>${esc(suppression.expires)}</td></tr>`;
}

/**
 * Requirement 3.6 and Requirement 3.3: suppressions read from
 * `checkyourvibe.json` as configured, with an expired suppression rendered
 * visibly apart from an active one (`.expired-row`) — an expired
 * suppression is not currently suppressing anything, and showing it beside
 * an active one without distinction would be a false statement about what
 * this configuration is presently hiding.
 *
 * Each row states its scope. A broad suppression carries only a rule id and a
 * path glob and covers every occurrence under it, including violations written
 * after it (T8009); a pinned one carries a snippet fingerprint and names one
 * recorded finding. `cyv check`'s notice names its broad suppressions
 * separately along the same line, and a page that rendered both alike would
 * describe a wholesale adoption suppression and a pinned one as the same act.
 *
 * The count shown here is "suppressions configured", not "findings currently
 * hidden" — `cyv check` is the only place that second number is real, because
 * only it evaluates suppressions against live violations.
 */
function renderSuppressions(view: SuppressionsView): string {
  const lede = `<p class="lede">A suppression names a rule and a path glob. A <b>broad</b> one covers
every match of that glob, including violations added after it was written; a <b>pinned</b> one carries
a snippet fingerprint and covers one recorded finding. The counts below are what is configured to
suppress, not a count of findings currently hidden — <code>cyv check</code> reports how many
violations an actual run suppressed.</p>`;

  if (view.kind === 'not-configured') {
    return `<h2>Suppressions</h2>${lede}
<div class="emptybox"><b>No suppressions are configured.</b> <code>checkyourvibe.json</code> has no
<code>suppressions</code> entry. Says nothing about whether this codebase needs any.</div>`;
  }

  if (view.kind === 'empty') {
    return `<h2>Suppressions</h2>${lede}
<div class="okbox"><b>Suppressions are configured, and the list is currently empty.</b> Someone
turned this on; nothing is presently deferred through it.</div>`;
  }

  const rows =
    view.active.map((s) => suppressionRow(s, false)).join('') +
    view.expired.map((s) => suppressionRow(s, true)).join('');

  const table = `<div class="wrap"><table class="trend-table">
    <thead><tr><th>rule</th><th>target</th><th>scope</th><th>reason</th><th>expires</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  const broad = view.active.filter((s) => suppressionScope(s) === 'broad').length;
  const pinned = view.active.length - broad;
  const summary = `<div class="warnbox"><b>${view.active.length} active suppression(s)</b> —
${broad} broad, ${pinned} pinned. ${view.expiringWithin30DaysCount} expiring within 30 days.
${view.expired.length > 0 ? `${view.expired.length} EXPIRED and no longer suppressing anything (marked below).` : ''}</div>`;

  return `<h2>Suppressions</h2>${lede}${summary}${table}`;
}

/**
 * Read a named section's plain-content lines from the shared
 * `guidanceSections(rule)`, rather than reading `rule.summary` / `rule.why` /
 * etc. directly. The values are identical either way — the point is that this
 * function, not a second reimplementation of it, is the one place that
 * decides what a rule's guidance sections are (spec 0032, Requirement 1.4).
 */
function sectionLines(sections: readonly GuidanceSection[], heading: string): string[] {
  return sections.find((section) => section.heading === heading)?.lines ?? [];
}

/**
 * Beside-the-rule debt pills (Requirement 3.6). `debt` is `undefined` for a
 * rule with neither an active suppression nor a baseline entry, and the
 * empty string is returned for it — no "0 of everything" row, which would
 * read as an annotation where there is none.
 *
 * Broad and pinned suppressions get separate pills for the reason
 * `buildRuleDebtMap` counts them separately: a rule carrying a broad
 * suppression is a rule switched off wherever that glob reaches, and summing
 * it with a pinned one would hide that.
 */
function debtPills(debt: RuleDebt | undefined): string {
  if (debt === undefined) {
    return '';
  }
  const pills: string[] = [];
  if (debt.baselineEntries > 0) {
    const noun = debt.baselineEntries === 1 ? 'baseline entry' : 'baseline entries';
    pills.push(`<span class="pill debt">${debt.baselineEntries} ${noun}</span>`);
  }
  if (debt.broadSuppressions > 0) {
    const noun = debt.broadSuppressions === 1 ? 'broad suppression' : 'broad suppressions';
    pills.push(`<span class="pill debt">${debt.broadSuppressions} ${noun}</span>`);
  }
  if (debt.pinnedSuppressions > 0) {
    const noun = debt.pinnedSuppressions === 1 ? 'pinned suppression' : 'pinned suppressions';
    pills.push(`<span class="pill debt">${debt.pinnedSuppressions} ${noun}</span>`);
  }
  return pills.join('');
}

/**
 * The debt that has no rule below to sit beside (Requirement 3.6).
 *
 * A baseline entry or suppression naming a rule this configuration does not
 * enable produces no pill anywhere in the browser. Left unsaid, the reader
 * reads the pills as the whole of the recorded debt. Named here, the gap is
 * part of what the page reports — the same fact `cyv baseline --status`
 * reports as a baseline entry whose rule is no longer enabled.
 */
function unattachedDebtNote(ruleIds: string[]): string {
  if (ruleIds.length === 0) {
    return '';
  }
  const list = ruleIds.map((id) => `<code>${esc(id)}</code>`).join(' ');
  return `<div class="warnbox"><b>${ruleIds.length} rule id(s) carry a baseline entry or an active
suppression, and this configuration does not enable them</b>, so no rule below is annotated with
them: ${list}. A rule that was renamed or turned off leaves its recorded debt behind, and
<code>cyv baseline --status</code> reports the same entries against the current tree.</div>`;
}

function renderRule(rule: RuleManifest, debt: RuleDebt | undefined): string {
  const evidence = evidenceLabel(rule);
  const sections = guidanceSections(rule);

  const summary = sectionLines(sections, 'Summary')[0] ?? '';
  const why = sectionLines(sections, 'Why')[0] ?? '';
  const allowedFixes = sectionLines(sections, 'Allowed fixes');
  const example = sectionLines(sections, 'Example');
  const exampleBad = example[0] ?? '';
  const exampleGood = example[1] ?? '';
  const notFixEntries =
    sections.find((section) => section.heading === 'Not fixes')?.notFixEntries ?? [];

  const haystack = [
    rule.id,
    rule.category,
    summary,
    why,
    evidence,
    ...allowedFixes,
    ...notFixEntries.map((n) => `${n.pattern} ${n.because}`),
  ]
    .join(' ')
    .toLowerCase();

  const notFixes = notFixEntries
    .map(
      (n) => `<div class="notfix"><span class="p">${esc(n.pattern)}</span> — ${esc(n.because)}
        ${n.rule !== undefined ? `<div class="r">${NOT_FIX_TARGET_VERB} <code>${esc(n.rule)}</code></div>` : ''}</div>`,
    )
    .join('');

  return `<div class="rule" data-category="${esc(rule.category)}" data-haystack="${esc(haystack)}">
  <h3>${esc(rule.id)}</h3>
  <div class="meta">${severityPill(rule.severity)}<span class="pill">${esc(rule.category)}</span>
    ${rule.pack !== undefined ? `<span class="pill">${esc(rule.pack)}</span>` : ''}
    <span class="pill">${esc(rule.scope)}</span>
    <span class="pill">${esc(evidence)}</span>${debtPills(debt)}</div>
  <div>${esc(summary)}</div>
  <div class="sec"><b>Why</b>${esc(why)}</div>
  <div class="sec"><b>Allowed fixes</b><ul>${allowedFixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>
  <div class="sec"><b>Not fixes</b>${notFixes || '<em>None recorded.</em>'}</div>
  <div class="sec"><b>Example</b><div class="ex">
    <div><div class="r">bad</div><pre><code>${esc(exampleBad)}</code></pre></div>
    <div><div class="r">good</div><pre><code>${esc(exampleGood)}</code></pre></div>
  </div></div>
  ${rule.optionsSchema !== undefined ? `<div class="sec"><b>Options</b><pre><code>${esc(JSON.stringify(rule.optionsSchema, null, 2))}</code></pre></div>` : ''}
</div>`;
}

/**
 * The executor surface's panels (spec 0011 Requirement 10). Rendered from
 * `buildExecutorView`, which folds the dispatch log on disk and derives nothing
 * else. No meter, percentage, or cost figure is drawn for any lane, because no
 * source this project can read supplies one (Requirements 7.1, 9.6, 10.5).
 */

function outcomePillClass(kind: DispatchOutcomeKind): string {
  if (kind === 'succeeded') return 'ok';
  if (
    kind === 'produced-nothing' ||
    kind === 'out-of-scope-write' ||
    kind === 'changed-files-unexpectedly' ||
    kind === 'did-not-complete'
  ) {
    return 'err';
  }
  return 'warn';
}

/** Why a lane was not a candidate, in the words the scheduler recorded (Requirements 7.3, 8.4). */
function ineligibilityText(reason: LaneIneligibility): string {
  switch (reason.reason) {
    case 'lane-not-declared':
      return 'no lane with this id is declared';
    case 'not-the-named-lane':
      return `the dispatch named lane <code>${esc(reason.namedLaneId)}</code>, so this lane was not considered`;
    case 'metered-not-named':
      return 'metered — billed per use, and the core never selects a metered lane on its own; it has to be named explicitly';
    case 'no-model-for-kind':
      return `declares no model for <code>${esc(reason.taskKind)}</code> work`;
    case 'in-cooldown':
      return `in cooldown since ${esc(reason.since)}, after a <code>${esc(reason.cause)}</code> outcome — not the same state as being at its cap`;
    case 'at-concurrency-cap':
      return `at its declared concurrency cap: ${reason.inFlight} of ${reason.concurrencyCap} running — not the same state as cooldown`;
    case 'at-global-cap':
      return `the run is at <code>executor.maxConcurrentDispatches</code>: ${reason.openDispatches} of ${reason.maxConcurrentDispatches} open across every lane — this lane may have room, the run does not`;
    default:
      return 'not a candidate';
  }
}

function refusalDetail(refusal: SchedulingRefusal): string {
  if (refusal.reason === 'overlapping-ownership') {
    const rows = refusal.conflicts
      .map(
        (conflict) =>
          `<li>overlaps dispatch <code>${esc(conflict.withDispatchId)}</code> on lane
           <code>${esc(conflict.laneId)}</code>, on ${conflict.paths.map((p) => `<code>${esc(p)}</code>`).join(', ')}</li>`,
      )
      .join('');
    return `<b>Refused before it ran: overlapping file ownership.</b> Two dispatches that would run at
      the same time declared the same paths, and the second was not scheduled. Nothing was dispatched,
      so no file was written by it.<ul>${rows}</ul>`;
  }

  const rows = refusal.rejections
    .map(
      (rejection) =>
        `<li><code>${esc(rejection.laneId)}</code> — ${ineligibilityText(rejection.reason)}</li>`,
    )
    .join('');
  return `<b>Blocked: no lane was a candidate.</b> The work was not dropped and was not retried against
    an exhausted lane; it is recorded here waiting for a lane, or for an escalation target to be
    configured.<ul>${rows}</ul>`;
}

/** What a person is being asked to look at, said in full rather than as a link to a record. */
function renderAttention(item: DispatchAttention, now: number): string {
  const head = `<h3><code>${esc(item.dispatchId)}</code> <span class="sub">work
    <code>${esc(item.workId)}</code> · ${esc(item.taskKind)} · ${esc(relativeTime(item.at, now))}</span></h3>`;
  const task = `<div class="msg">${esc(item.task)}</div>`;

  if (item.cause.kind === 'refusal') {
    return `<div class="filegroup">${head}${task}<div class="sec">${refusalDetail(item.cause.refusal)}</div></div>`;
  }

  const { outcome, assignment } = item.cause;
  const scope =
    outcome.outOfScopePaths.length > 0
      ? `<li><b>Wrote outside its declared ownership</b>
         ${outcome.outOfScopePaths.map((p) => `<code>${esc(p)}</code>`).join(' ')} — recorded as failed
         regardless of the exit code or the gate results.</li>`
      : '';
  const gates =
    outcome.failedGates.length > 0
      ? `<li><b>Gates that did not pass</b> ${outcome.failedGates.map((g) => `<code>${esc(g)}</code>`).join(' ')}</li>`
      : '';

  return `<div class="filegroup">${head}${task}
<ul class="findings">
  <li><b>Outcome</b> <span class="pill ${outcomePillClass(outcome.kind)}">${esc(outcome.kind)}</span>
    <span class="msg">${esc(outcome.summary)}</span></li>
  <li><b>Lane and model</b> <code>${esc(assignment.laneId)}</code> ·
    <code>${esc(assignment.model)}</code> ·
    ${esc(laneBillingLabel({ kind: assignment.billing, permitsBilledOverage: assignment.permitsBilledOverage }))}</li>
  <li><b>Files observed to change</b> ${outcome.changedPaths.length === 0 ? 'none' : outcome.changedPaths.map((p) => `<code>${esc(p)}</code>`).join(' ')}</li>
  ${scope}${gates}
</ul></div>`;
}

/** The objective the model was requested under (Requirements 9.1, 9.3). */
function modelObjective(record: DispatchRecord): string {
  const escalation = record.escalation;
  if (escalation !== undefined && escalation.reason === 'gate-failure') {
    return `the next-stronger model in this lane's own ordering for this task kind, moved to after an
      observed gate failure. Escalation up an ordering follows a gate that actually failed; it is never
      a prediction that a task will need more.`;
  }
  return `the weakest model this lane declares for this task kind. No setting asks a lane for its
    strongest as a matter of course — a window spent on a mechanical change is a window a later task
    does not have.`;
}

function dispatchCard(record: DispatchRecord, now: number): string {
  const assignment = record.assignment;
  const billing = laneBillingLabel({
    kind: assignment.billing,
    permitsBilledOverage: assignment.permitsBilledOverage,
  });
  const escalation = record.escalation;
  const escalationLine =
    escalation === undefined
      ? ''
      : `<li><b>Escalated to this lane</b> <span class="msg">moved from lane
         <code>${esc(escalation.fromLaneId)}</code> model <code>${esc(escalation.fromModel)}</code> to lane
         <code>${esc(assignment.laneId)}</code> model <code>${esc(assignment.model)}</code>, because of
         <code>${esc(escalation.reason)}</code>: ${esc(escalation.detail)}. It follows dispatch
         <code>${esc(escalation.priorDispatchId)}</code>, which keeps its own record.</span></li>`;

  const closed = record.closed;
  const stateLine =
    closed === undefined
      ? `<li><b>State</b> <span class="pill">in flight</span> <span class="msg">Opened
         ${esc(relativeTime(record.openedAt, now))} (${esc(record.openedAt)}) and not yet closed. This is
         read from disk, so it renders whether or not the session that started it is still running.</span></li>`
      : `<li><b>Outcome</b> <span class="pill ${outcomePillClass(closed.outcome.kind)}">${esc(closed.outcome.kind)}</span>
         <span class="msg">${esc(closed.outcome.summary)} Closed ${esc(relativeTime(closed.closedAt, now))}.</span></li>`;

  const reportLine =
    closed === undefined
      ? ''
      : `<li><b>What the executor reported</b> <span class="msg">status
         <code>${esc(closed.report.status)}</code>${closed.report.exitCode === undefined ? '' : `, exit code <code>${closed.report.exitCode}</code>`}${closed.report.rateLimited ? ', explicit rate-limit error' : ''}.
         Recorded, not trusted: the outcome above comes from comparing the declared files on disk before
         and after, never from the exit code or the executor's own account of itself.</span></li>`;

  const gateLine =
    closed === undefined || closed.gateResults.length === 0
      ? ''
      : `<li><b>Gates</b> ${closed.gateResults
          .map(
            (gate) =>
              `<span class="pill ${gate.passed ? 'ok' : 'err'}">${esc(gate.gate)}</span>${gate.detail === undefined ? '' : ` <span class="msg">${esc(gate.detail)}</span>`}`,
          )
          .join(' ')}</li>`;

  const changedLine =
    closed === undefined
      ? ''
      : `<li><b>Files observed to change</b> ${closed.outcome.changedPaths.length === 0 ? 'none' : closed.outcome.changedPaths.map((p) => `<code>${esc(p)}</code>`).join(' ')}</li>`;

  return `<div class="filegroup">
<h3><code>${esc(record.dispatchId)}</code> <span class="sub">attempt ${record.attempt} of work
  <code>${esc(record.workId)}</code></span></h3>
<div class="msg">${esc(record.declaration.task)}</div>
<ul class="findings">
  ${stateLine}
  <li><b>Lane</b> <code>${esc(assignment.laneId)}</code> <span class="pill">${esc(billing)}</span>
    ${assignment.orchestrator ? '<span class="pill">orchestrator</span>' : ''}
    <span class="msg">Agent <code>${esc(assignment.agentId)}</code>. Chosen with
    ${assignment.declaredHeadroomAtSchedule} declared headroom at the moment it was scheduled — the
    eligible lane with the most takes the work. Declared headroom is the lane's self-imposed cap minus
    what was running on it, not a reading of the account.</span></li>
  <li><b>Model requested</b> <code>${esc(assignment.model)}</code> <span class="msg">Under one
    objective: ${modelObjective(record)}</span></li>
  <li><b>Task kind</b> <code>${esc(record.declaration.taskKind)}</code>
    <span class="msg">${record.declaration.expectsFileChanges ? 'Declared up front as expected to change files.' : 'Declared up front as expected to change no files, so its result is judged by its gates alone.'}</span></li>
  <li><b>Paths it may write</b> ${record.declaration.ownedPaths.map((p) => `<code>${esc(p)}</code>`).join(' ') || 'none declared'}</li>
  <li><b>Gates named for it</b> ${record.declaration.gates.map((g) => `<code>${esc(g)}</code>`).join(' ') || 'none declared'}</li>
  ${escalationLine}${reportLine}${gateLine}${changedLine}
</ul></div>`;
}

/**
 * The billing note for a metered lane, saying where that fact came from. A
 * declared lane carries its own billing; a lane the page knows only from the
 * log is metered because a refusal recorded it being passed over for being one.
 */
function meteredBillingLine(lane: ExecutorLaneView): string {
  if (!lane.meteredNotNamed) return '';
  if (lane.declared) {
    return `<li><b>Billing</b> <span class="msg">This lane is declared as metered — billed per use,
       and is named in the configuration's list of metered lanes to enable. The core never selects a
       metered lane on its own; it is reached only by a dispatch that names it.</span></li>`;
  }
  if (lane.hasRecords) return '';
  return `<li><b>Billing</b> <span class="msg">The log records this lane being passed over for being
     metered — billed per use. The core never selects a metered lane on its own; it is reached only
     by a dispatch that names it. Whether it is configured to permit billed overage is not
     something any recorded entry says, so nothing is claimed about it here.</span></li>`;
}

function renderLane(lane: ExecutorLaneView, now: number): string {
  const pills: string[] = [];
  if (lane.cooldown !== undefined) pills.push('<span class="pill err">cooldown</span>');
  if (lane.atCap) pills.push('<span class="pill warn">at declared cap</span>');
  // "Accepting dispatches" is only said about a lane the page has something to
  // say about. A lane the log names once, in a refusal, and has never run
  // anything is left without that claim.
  if (pills.length === 0 && (lane.declared || lane.hasRecords)) {
    pills.push('<span class="pill ok">accepting dispatches</span>');
  }
  if (lane.orchestrator) pills.push('<span class="pill">orchestrator</span>');
  if (lane.billingLabel !== undefined) {
    pills.push(`<span class="pill">${esc(lane.billingLabel)}</span>`);
  } else if (lane.meteredNotNamed) {
    pills.push(`<span class="pill warn">${esc(laneBillingLabel({ kind: 'metered', permitsBilledOverage: false }))}</span>`);
  }

  const cap = lane.concurrency.declaredCap;
  const capSource =
    lane.concurrency.source === 'declaration'
      ? "this lane's own declaration"
      : 'a scheduling refusal in the log that named this lane at its cap';
  const runningLine =
    cap === undefined
      ? `<li><b>Running</b> <span class="msg">${lane.concurrency.running} dispatch(es) open on this
         lane. No declared concurrency cap for it is on hand, so no &ldquo;of N&rdquo; is shown rather
         than a denominator being invented.</span></li>`
      : `<li><b>Running</b> <span class="msg">${lane.concurrency.running} of ${cap}, against a cap taken
         from ${capSource}. The cap is a self-imposed number the core will not exceed, not a reading of
         the vendor's real rate limit — no agent CLI reports one.</span></li>`;

  const cooldown = lane.cooldown;
  const cooldownLine =
    cooldown === undefined
      ? '<li><b>Cooldown</b> <span class="msg">Not in cooldown.</span></li>'
      : `<li><b>Cooldown</b> <span class="msg">In cooldown since ${esc(cooldown.since)}
         (${esc(relativeTime(cooldown.since, now))}), after dispatch <code>${esc(cooldown.dispatchId)}</code>
         closed as <code>${esc(cooldown.reason)}</code>. This is a behavioural inference from that past
         outcome, not a live reading of the account, and it clears only when a later dispatch on this
         lane changes its declared files. Being in cooldown and being at the concurrency cap look the
         same from outside — no new dispatch is scheduled either way — and they are separate states with
         separate causes.</span></li>`;

  const declarationLine = lane.declared
    ? ''
    : `<li><b>Declaration</b> <span class="msg">This lane is named by the dispatch log; no lane
       declaration was supplied to this page, so its cap and model lineup are known only as far as the
       log recorded them.</span></li>`;

  const agentLine =
    lane.agentId === undefined ? '' : `<li><b>Agent</b> <code>${esc(lane.agentId)}</code></li>`;

  const meteredLine = meteredBillingLine(lane);

  const neverRanLine =
    lane.hasRecords || lane.declared
      ? ''
      : `<li><b>Dispatches</b> <span class="msg">No dispatch in this log ran on this lane; it is named
         only by a scheduling refusal.</span></li>`;

  return `<div class="filegroup"><h3><code>${esc(lane.label)}</code> <span class="sub">${pills.join(' ')}</span></h3>
<ul class="findings">${runningLine}${cooldownLine}${meteredLine}${neverRanLine}${agentLine}${declarationLine}</ul></div>`;
}

/**
 * One lane as its declaration reads, for a repository that declared lanes and
 * has not dispatched anything (spec 0011 Requirements 1.4, 10.5).
 *
 * Every line is a configured value read back. No running count, cooldown, or
 * cap-in-use appears, because the log holds nothing those could be counted
 * from, and a lane card that looked like the dispatch-state one would read as a
 * lane that has been scheduled. A metered lane carries its billing here, as it
 * does everywhere it is named.
 */
function renderDeclaredLane(lane: LaneDeclaration): string {
  const pills: string[] = [];
  const billing = laneBillingLabel(lane.billing);
  pills.push(
    lane.billing.kind === 'metered'
      ? `<span class="pill warn">${esc(billing)}</span>`
      : `<span class="pill">${esc(billing)}</span>`,
  );
  if (lane.orchestrator) pills.push('<span class="pill">orchestrator</span>');

  const meteredLine =
    lane.billing.kind === 'metered'
      ? `<li><b>Billing</b> <span class="msg">Metered — billed per use. The core never selects a
         metered lane on its own; it is reached only by a dispatch that names it, and this repository
         has opted into it by name in its configuration.</span></li>`
      : `<li><b>Billing</b> <span class="msg">${esc(billing)} — a CLI authenticated against a plan
         already held, not billed per dispatch.</span></li>`;

  const models = lane.models
    .map(
      (offering) =>
        `<li><code>${esc(offering.kind)}</code>: ${offering.ordering
          .map((model) => `<code>${esc(model)}</code>`)
          .join(' &rarr; ')}</li>`,
    )
    .join('');

  return `<div class="filegroup"><h3><code>${esc(lane.id)}</code> <span class="sub">${pills.join(' ')}</span></h3>
<ul class="findings">
  <li><b>Agent</b> <code>${esc(lane.agentId)}</code></li>
  <li><b>Declared cap</b> <span class="msg">${lane.concurrencyCap} simultaneous dispatch(es). This is
     the configured ceiling the core will not exceed, not a reading of the vendor's rate limit, and
     nothing has run against it.</span></li>
  ${meteredLine}
  <li><b>Models offered</b> <span class="msg">Strongest first, as this lane's own declaration orders
     them. The core requests the last entry for a dispatch of that kind and moves up the ordering only
     after a gate fails.</span><ul>${models}</ul></li>
</ul></div>`;
}

/**
 * Requirement 10.4: everything that needs a person is on the page, so no
 * dispatch record has to be opened to find it. The empty case says which of two
 * facts it is reporting — no dispatches recorded at all, or dispatches recorded
 * and none of them needing anybody — and, where the repository declares lanes,
 * shows those declarations underneath without either fact being softened.
 */
export function renderExecutor(view: ExecutorView, now: number = Date.now()): string {
  if (view.kind === 'no-dispatches') {
    const detail = view.logPresent
      ? `A dispatch log exists under <code>.cyv-review/</code> and holds no readable entry — it is
         empty, or every line in it was rejected as unparseable rather than guessed at.`
      : `No dispatch log has been written under <code>.cyv-review/</code>: nothing has been dispatched
         from this repository.`;
    const declared = view.declaredLanes ?? [];
    const declaredSection =
      declared.length === 0
        ? ''
        : `
<h3>Declared lanes</h3>
${declared.map((lane) => renderDeclaredLane(lane)).join('')}`;
    return `<h2>Executor dispatches</h2>
<div class="emptybox"><b>No dispatches are recorded.</b> ${detail}</div>${declaredSection}`;
  }

  const attention =
    view.attention.length === 0
      ? `<div class="okbox"><b>Nothing needs a person.</b> ${view.recordCount} dispatch(es) and
         ${view.refusalCount} scheduling refusal(s) recorded.</div>`
      : `<div class="warnbox"><b>${view.attention.length} item(s) need a person.</b> Each is stated in
         full below.</div>
${view.attention.map((item) => renderAttention(item, now)).join('')}`;

  const inFlight =
    view.inFlight.length === 0
      ? `<div class="emptybox">No dispatch is in flight. ${view.recordCount} dispatch(es) are recorded
         and every one of them has a close entry.</div>`
      : view.inFlight.map((record) => dispatchCard(record, now)).join('');

  const omitted =
    view.omittedCompleted > 0
      ? `<div class="sub">Showing the ${view.completed.length} most recent; ${view.omittedCompleted}
         older completed dispatch(es) are in the log and not listed.</div>`
      : '';

  const completed =
    view.completed.length === 0
      ? '<div class="emptybox">No dispatch has completed yet.</div>'
      : `${omitted}${view.completed.map((record) => dispatchCard(record, now)).join('')}`;

  const unreadable =
    view.unparseableLines > 0
      ? `<div class="warnbox"><b>${view.unparseableLines} line(s) in the dispatch log could not be
         read</b> and are not counted anywhere above. A partially understood entry is skipped rather
         than filled in, so nothing shown here is a guess.</div>`
      : '';

  const lanes =
    view.lanes.length === 0
      ? '<div class="emptybox">No lane is named by any recorded dispatch.</div>'
      : view.lanes.map((lane) => renderLane(lane, now)).join('');

  return `<h2>Executor dispatches</h2>
${unreadable}
<h3>Needs a person</h3>
${attention}
<h3>In flight</h3>
${inFlight}
<h3>Recently completed</h3>
${completed}
<h3>Lanes</h3>
${lanes}`;
}

/**
 * Baseline and suppression inputs for `renderDashboard` (Requirement 3.6,
 * Requirement 5). Bundled into one named interface, per this repository's
 * style rule, rather than spread across further positional parameters on a
 * function that already takes six.
 */
export interface DashboardDebtInput {
  /** `null` when no baseline file exists — see `buildBaselineView`. */
  baseline: Baseline | null;
  /** Whether `checkyourvibe.json` declares a `suppressions` key at all. */
  suppressionsConfigured: boolean;
  suppressions: readonly Suppression[];
  repoRoot: string;
  now?: Date;
}

/**
 * The panels that change between requests without a restart — results,
 * trend, never-fired, file heat, baseline, suppressions — as distinct from
 * the interlock graph and rule browser below them, which are rendered once
 * at startup because manifests are static (see `cli/dashboard.ts`'s own
 * comment on that split).
 *
 * Exported so `cli/dashboard.ts` can serve exactly this fragment from
 * `/volatile.html` for the client-side poll (constraint 3) to swap in,
 * without duplicating which panels count as "volatile" in two places.
 *
 * Reads nothing itself — `history` and `debt` are already the parsed,
 * on-disk state by the time they reach this function, same as
 * `renderDashboard`'s own inputs. No analyzer runs here either.
 */
export function renderVolatilePanels(
  rules: RuleManifest[],
  history: RunRecord[],
  debt?: DashboardDebtInput,
  latest: LatestRun | null = null,
  now: number = Date.now(),
  executor: ExecutorView | null = null,
): string {
  // The executor panels do not depend on a rule being enabled: dispatch state is
  // recorded by the executor surface, not by an analyzer, and a repository with
  // no rules resolved can still have dispatches to report.
  const executorPanels = executor === null ? '' : renderExecutor(executor, now);

  if (rules.length === 0) {
    return executorPanels;
  }

  const baselineView = buildBaselineView(debt?.baseline ?? null);
  const suppressionsView = buildSuppressionsView(
    debt?.suppressions ?? [],
    debt?.suppressionsConfigured ?? false,
    debt?.repoRoot ?? '',
    debt?.now,
  );

  return `${renderNow(latest, now, debt?.repoRoot ?? '')}
${executorPanels}
${renderResults(buildResultsView(history))}
${renderTrend(buildTrend(history))}
${renderNeverFired(buildNeverFiredView(rules, history))}
${renderFileHeat(buildFileHeatView(history))}
${renderBaseline(baselineView)}
${renderSuppressions(suppressionsView)}`;
}

export function renderDashboard(
  rules: RuleManifest[],
  analyzerIds: string[],
  history: RunRecord[] = [],
  ruleAnalyzers?: Record<string, string>,
  debt?: DashboardDebtInput,
  latest: LatestRun | null = null,
  executor: ExecutorView | null = null,
  nav?: RulesPageNav,
): string {
  const graphs = buildInterlockGraph(rules, ruleAnalyzers);
  const categories = [...new Set(rules.map((r) => r.category))].sort();

  const baselineView = buildBaselineView(debt?.baseline ?? null);
  const suppressionsView = buildSuppressionsView(
    debt?.suppressions ?? [],
    debt?.suppressionsConfigured ?? false,
    debt?.repoRoot ?? '',
    debt?.now,
  );
  const ruleDebt = buildRuleDebtMap(baselineView, suppressionsView);

  const empty =
    rules.length === 0
      ? `<div class="warnbox"><b>No rules are enabled.</b> That is not a clean bill of health — it means
         configuration resolved to nothing. Check <code>packs</code> and <code>rules</code> in
         <code>checkyourvibe.json</code>, or run <code>cyv init</code>.</div>`
      : '';

  // The freshness indicator lives outside `#volatile` on purpose: it is a
  // statement about the client's own poll ("did the last fetch succeed, and
  // how long ago"), not about the panel content itself, so it must survive
  // `#volatile.innerHTML` being replaced wholesale on every poll rather than
  // being regenerated (and briefly blanked) along with it.
  const freshnessBar =
    rules.length > 0 || executor !== null
      ? `<p id="freshness" class="lede" aria-live="polite">Live — refreshing every 15s.</p>`
      : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${FAVICON}">
<title>checkyourvibe — rules</title><style>${CSS}</style></head><body>
${nav === undefined ? '' : `<p class="lede"><a href="${esc(nav.homeHref)}">&larr; dashboard</a></p>`}
<h1>checkyourvibe rules</h1>
<p class="lede">${rules.length} rule${rules.length === 1 ? '' : 's'} from
${analyzerIds.length} analyzer${analyzerIds.length === 1 ? '' : 's'}
(${analyzerIds.map((a) => `<code>${esc(a)}</code>`).join(', ') || 'none'}).
Run state is read from disk — no analyzer is executed to render this page.</p>
${empty}
${freshnessBar}
<div id="volatile">${renderVolatilePanels(rules, history, debt, latest, Date.now(), executor)}</div>
${rules.length > 0 ? renderGraphs(graphs) : ''}
<h2>Rules <span class="pill" id="count">${rules.length} shown</span></h2>
<p class="lede">Each rule lists its evidence kind: <code>semantic</code> findings come from a type system,
<code>syntax</code> findings from shape alone, and the difference is confidence rather than importance.
Omitted is shown as <code>unspecified</code>. A rule with recorded debt also carries its baseline-entry
and active-suppression counts, broad and pinned shown apart.</p>
${unattachedDebtNote(unattachedDebtRuleIds(ruleDebt, rules))}
<div class="filters">
  <input id="q" placeholder="Search rules, reasons, fixes…" autocomplete="off">
  <select id="cat"><option value="">All categories</option>
    ${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
</div>
${rules.map((rule) => renderRule(rule, ruleDebt.get(rule.id))).join('')}
<script>${CLIENT}</script>
<script>${refreshClient(nav === undefined ? '/volatile.html' : nav.volatileHref)}</script>
</body></html>`;
}
