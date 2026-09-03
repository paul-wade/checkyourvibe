#!/usr/bin/env node
// Draw the notFix interlock from the analyzer manifests.
//
//   node tools/interlock-svg.mjs            write docs/media/interlock-graph.svg
//   node tools/interlock-svg.mjs --check    exit 1 if the file on disk is stale
//
// WHY THIS IS GENERATED AND NOT DRAWN
//
// The checked-in drawing this replaces was hand-made, and it silently stopped
// being true: `no-module-augmentation` shipped in spec 0038 and never appeared
// in it, so the picture described a rule pack that had not existed for weeks.
// Nothing reported that, because nothing could.
//
// A project whose argument is that prose is advisory and a gate is a fact cannot
// ship a hand-maintained diagram of its own rule graph. `--check` is the gate:
// add a rule, forget the picture, and the commit fails.
//
// The drawing lives here rather than in the site repository because it is
// derived from the manifests, and the generator has to sit with the thing it
// reads. The site vendors a copy.
//
// WHAT THE LAYOUT ENCODES
//
// Three rules absorb most of the graph — `no-as-cast`, `no-any` and
// `no-ts-comment` — because nearly every tempting fix is cast it, widen it, or
// suppress it. They are drawn large, in the accent, at the centre of the ring
// they are pointed at. Everything else sits on the ring. A rule with no edges
// at all is drawn dashed rather than omitted: having no tempting escape is a
// fact about that rule, not an absence of data.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANIFEST = path.join(ROOT, 'packages/analyzer-typescript/analyzer.manifest.json');
const OUT = path.join(ROOT, 'docs/media/interlock-graph.svg');

/** The site's own tokens, so the drawing cannot drift from the page either. */
const INK = {
  night: '#0a1416',
  stock: '#e8e1d2',
  flame: '#f0512a',
  smoke: '#8a9294',
  hair: '#2b3a3d',
};

const W = 1180;
const H = 700;
const CX = W / 2;
const CY = H / 2 + 8;

/**
 * Every rule id in the pack begins `no-`. Printed fifteen times it costs the
 * horizontal room the labels need once the drawing is scaled into a text
 * column, and it distinguishes nothing. The caption restores it in words.
 */
function shortLabel(id) {
  return id.startsWith('no-') ? id.slice(3) : id;
}

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function readGraph() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const rules = manifest.rules ?? [];
  const ids = rules.map((r) => r.id);
  const known = new Set(ids);

  const edges = [];
  for (const rule of rules) {
    for (const notFix of rule.notFixes ?? []) {
      // A notFix without a `rule` is still a dead end, but it names no node to
      // draw an arrow to. Those are counted, not drawn.
      if (notFix.rule !== undefined && known.has(notFix.rule)) {
        edges.push({ from: rule.id, to: notFix.rule });
      }
    }
  }

  const inDeg = new Map(ids.map((id) => [id, 0]));
  const outDeg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
  }
  return { ids, edges, inDeg, outDeg };
}

/**
 * The rules most fixes run into go to the middle; the rest keep the ring.
 *
 * A hub is a rule absorbing at least 60% of what the most-pointed-at rule
 * absorbs. That threshold, not a fixed count: today it selects three — cast it,
 * widen it, suppress it, at 13, 12 and 9 of 50 — and a pack that grows a fourth
 * universal escape will show it rather than leave it on the ring.
 *
 * A gap-based cut was tried first and picked two, because the fall from 12 to 9
 * and from 9 to 6 are both 3 and the tie broke early. The count came out of the
 * arithmetic rather than the shape of the graph, which is the wrong reason for a
 * picture to say something.
 */
function splitHubs(ids, inDeg) {
  const most = Math.max(0, ...ids.map((id) => inDeg.get(id) ?? 0));
  if (most === 0) return { hubs: [], ring: [...ids] };
  const hubs = ids
    .filter((id) => (inDeg.get(id) ?? 0) >= most * 0.6)
    .sort((a, b) => (inDeg.get(b) ?? 0) - (inDeg.get(a) ?? 0));
  return { hubs, ring: ids.filter((id) => !hubs.includes(id)) };
}

function layout(ids, inDeg) {
  const { hubs, ring } = splitHubs(ids, inDeg);
  const pos = new Map();

  // Hubs sit in a row rather than on a diagonal. On a diagonal their labels
  // landed on each other's circles: the vertical spread was smaller than the
  // radii, which grow with in-degree, so the busiest graph was the least
  // legible one. A row gives every label its own horizontal band.
  const step = 250;
  hubs.forEach((id, i) => {
    const t = hubs.length === 1 ? 0 : i - (hubs.length - 1) / 2;
    pos.set(id, { x: CX + t * step, y: CY, hub: true });
  });

  const rx = 392;
  const ry = 246;
  ring.forEach((id, i) => {
    // Start at the top and go clockwise; the offset keeps a node off the exact
    // top, where the caption sits.
    const a = (i / ring.length) * Math.PI * 2 - Math.PI / 2 + 0.16;
    pos.set(id, { x: CX + Math.cos(a) * rx, y: CY + Math.sin(a) * ry, hub: false });
  });

  return { pos, hubs, ring };
}

function edgePath(a, b, rTo) {
  // Bow every edge toward the middle so parallel runs separate instead of
  // stacking into one thick line.
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const k = 0.22;
  const cx = mx + (CX - mx) * k;
  const cy = my + (CY - my) * k;

  // Stop short of the target's rim so the arrowhead sits against the circle
  // rather than inside it. The direction is the meaning of the edge — fixing
  // the rule at the tail is what trips the rule at the head — so an edge drawn
  // without a head states half of what it is for.
  const dx = b.x - cx;
  const dy = b.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const stop = rTo + 5.5;
  const ex = b.x - (dx / len) * stop;
  const ey = b.y - (dy / len) * stop;

  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
}

function render(graph) {
  const { ids, edges, inDeg, outDeg } = graph;
  const { pos, hubs } = layout(ids, inDeg);

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" ` +
      `aria-label="The interlock: ${edges.length} arrows across ${ids.length} rules. Each arrow is a remediation that would trip the rule it points at. ` +
      `${hubs.map((h) => `${h} absorbs ${inDeg.get(h)}`).join('; ')}.">`,
  );

  parts.push(
    `<style>` +
      `.e{fill:none;stroke:${INK.hair};stroke-width:1.1;opacity:.55}` +
      `.e.hot{stroke:${INK.flame};stroke-width:1.25;opacity:.42}` +
      `.n circle{fill:${INK.night};stroke:${INK.smoke};stroke-width:1.5}` +
      `.n.hub circle{stroke:${INK.flame};stroke-width:2.5}` +
      `.n.iso circle{stroke:${INK.hair};stroke-dasharray:3 3}` +
      `.n text{font:600 19px ui-monospace,Consolas,"DejaVu Sans Mono",monospace;fill:${INK.stock}}` +
      `.n.hub text{font-size:25px;fill:${INK.flame}}` +
      `.n.iso text{fill:${INK.smoke}}` +
      `.cap{font:600 17px ui-monospace,Consolas,monospace;fill:${INK.smoke};letter-spacing:.14em}` +
      `</style>`,
  );

  parts.push(
    `<defs>` +
      `<marker id="h" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M0,0 L8,4 L0,8 z" fill="${INK.hair}"/></marker>` +
      `<marker id="hh" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M0,0 L8,4 L0,8 z" fill="${INK.flame}" opacity=".7"/></marker>` +
      `</defs>`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="${INK.night}"/>`);

  const radiusOf = (id) => {
    const p = pos.get(id);
    return p !== undefined && p.hub ? 17 + (inDeg.get(id) ?? 0) * 1.1 : 7;
  };

  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (a === undefined || b === undefined) continue;
    const hot = hubs.includes(e.to);
    parts.push(
      `<path class="e${hot ? ' hot' : ''}" marker-end="url(#${hot ? 'hh' : 'h'})" d="${edgePath(a, b, radiusOf(e.to))}"/>`,
    );
  }

  for (const id of ids) {
    const p = pos.get(id);
    if (p === undefined) continue;
    const into = inDeg.get(id) ?? 0;
    const outOf = outDeg.get(id) ?? 0;
    const isolated = into === 0 && outOf === 0;
    const cls = ['n', p.hub ? 'hub' : '', isolated ? 'iso' : ''].filter(Boolean).join(' ');
    const r = p.hub ? 17 + into * 1.1 : 7;
    const dy = p.hub ? -r - 14 : p.y < CY ? -15 : 27;
    parts.push(
      `<g class="${cls}">` +
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"/>` +
        `<text x="${p.x.toFixed(1)}" y="${(p.y + dy).toFixed(1)}" text-anchor="middle">${esc(shortLabel(id))}</text>` +
        `</g>`,
    );
  }

  parts.push(
    `<text class="cap" x="${CX}" y="26" text-anchor="middle">` +
      `${edges.length} DEAD ENDS ACROSS ${ids.length} RULES · EVERY NAME READS no-…</text>`,
  );
  parts.push(`</svg>`);
  return parts.join('\n');
}

const graph = await readGraph();
const svg = `${render(graph)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = await readFile(OUT, 'utf8');
  } catch {
    current = '';
  }
  if (current !== svg) {
    console.error(
      'The interlock drawing is stale. A rule or a notFix changed and the picture did not.\n' +
        '  Run: node tools/interlock-svg.mjs',
    );
    process.exit(1);
  }
  console.log(`  ✓ interlock drawing matches the manifest (${graph.ids.length} rules, ${graph.edges.length} dead ends)`);
} else {
  await writeFile(OUT, svg, 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUT)} — ${graph.ids.length} rules, ${graph.edges.length} dead ends.`);
}
