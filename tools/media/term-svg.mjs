#!/usr/bin/env node
// Render captured terminal output as an SVG, for the README.
//
//   node tools/media/term-svg.mjs <input.txt> <output.svg> ["Title"]
//
// SVG rather than a screenshot, deliberately. The text stays selectable and
// searchable, it scales on any display, it diffs as text in review, and it is a
// few kilobytes instead of a few hundred. It is also regeneratable: every image
// in the README comes from a command in tools/media/capture.mjs, so an image
// cannot quietly outlive the behaviour it claims to show — which is the same
// reason this project does not let a number appear without its provenance.
//
// Colour is applied from line shape rather than from ANSI codes: `cyv` correctly
// emits no colour when its stdout is not a terminal, so there are no codes to
// parse when capturing to a file.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PALETTE = {
  ground: '#0B1017',
  chrome: '#111826',
  ink: '#E8E3D9',
  muted: '#6E7B8C',
  rule: '#1E2836',
  error: '#FF5C1A',
  warn: '#B8873F',
  ok: '#4FB286',
  ident: '#8FB8D8',
};

const CHAR_W = 7.8;
const LINE_H = 19;
const PAD_X = 18;
const PAD_TOP = 44;
const PAD_BOTTOM = 16;

function esc(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/**
 * Split one line into coloured runs, by the shapes `cyv` actually prints.
 *
 * Ordered from most specific to least: a mis-ordered check here would colour a
 * rule id as a file path and quietly misrepresent the output the image exists to
 * show.
 */
function runs(line) {
  const out = [];
  const push = (text, fill, weight) => {
    if (text.length > 0) out.push({ text, fill, weight });
  };

  // "  error    <path>:12:3  rule-id  message"
  const finding = /^(\s*)(error|warning)(\s+)(\S+?:\d+:\d+)(\s+)(\S+)(\s+)(.*)$/.exec(line);
  if (finding) {
    const [, lead, level, s1, loc, s2, rule, s3, message] = finding;
    push(lead, PALETTE.ink);
    push(level, level === 'error' ? PALETTE.error : PALETTE.warn, 600);
    push(s1, PALETTE.ink);
    push(loc, PALETTE.muted);
    push(s2, PALETTE.ink);
    push(rule, PALETTE.ident, 600);
    push(s3, PALETTE.ink);
    push(message, PALETTE.ink);
    return out;
  }

  // "    not: <pattern> — <why> [would trip <rule>]"
  const notFix = /^(\s*)(not:)(.*)$/.exec(line);
  if (notFix) {
    const [, lead, marker, rest] = notFix;
    push(lead, PALETTE.ink);
    push(marker, PALETTE.error, 600);
    const trip = /^(.*?)(\[would trip [^\]]+\])(.*)$/.exec(rest);
    if (trip) {
      push(trip[1], PALETTE.muted);
      push(trip[2], PALETTE.ident);
      push(trip[3], PALETTE.muted);
    } else {
      push(rest, PALETTE.muted);
    }
    return out;
  }

  // "    - an allowed fix"
  const fix = /^(\s*)(- )(.*)$/.exec(line);
  if (fix) {
    push(fix[1], PALETTE.ink);
    push(fix[2], PALETTE.ok, 600);
    push(fix[3], PALETTE.ink);
    return out;
  }

  // "3 errors, 0 warnings, 1 file checked"
  const summary = /^(\d+ errors?, \d+ warnings?, .*)$/.exec(line);
  if (summary) {
    push(line, /^0 errors/.test(line) ? PALETTE.ok : PALETTE.error, 600);
    return out;
  }

  // "$ cyv check src/orders.ts"
  if (line.startsWith('$ ')) {
    push('$ ', PALETTE.muted);
    push(line.slice(2), PALETTE.ink, 600);
    return out;
  }

  // The unconditional notices, and any other indented aside.
  if (/^\s{2,}\S/.test(line)) {
    push(line, PALETTE.muted);
    return out;
  }

  push(line, PALETTE.ink, 600);
  return out;
}

function render(lines, title) {
  const cols = lines.reduce((max, l) => Math.max(max, l.length), 0);
  const width = Math.ceil(cols * CHAR_W) + PAD_X * 2;
  const height = lines.length * LINE_H + PAD_TOP + PAD_BOTTOM;

  // Each line is one `<text>` element containing its coloured runs.
  //
  // The runs were emitted as bare `<tspan>` inside a `<g>` at first. A `tspan`
  // is only valid inside a `text`, so every image rendered as an empty terminal
  // window — and the mistake survived because it was "verified" by pulling the
  // strings back out of the file with a regex, which proves the content is in
  // the file and says nothing about whether a renderer draws it. Checking the
  // artifact instead of the result is the exact failure this project exists to
  // catch, so: these are now checked by rendering them.
  const body = lines
    .map((line, i) => {
      const y = PAD_TOP + i * LINE_H;
      let x = PAD_X;
      const spans = runs(line)
        .map((run) => {
          const span = `<tspan x="${x.toFixed(1)}" fill="${run.fill}"${
            run.weight ? ` font-weight="${run.weight}"` : ''
          }>${esc(run.text)}</tspan>`;
          x += run.text.length * CHAR_W;
          return span;
        })
        .join('');
      if (spans === '') return '';
      return `<text y="${y}">${spans}</text>`;
    })
    .filter(Boolean)
    .join('\n    ');

  const dots = ['#FF5F57', '#FEBC2E', '#28C840']
    .map((c, i) => `<circle cx="${20 + i * 17}" cy="20" r="5.5" fill="${c}" opacity="0.85"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title ?? 'terminal output')}">
  <rect width="${width}" height="${height}" rx="8" fill="${PALETTE.ground}"/>
  <rect width="${width}" height="34" rx="8" fill="${PALETTE.chrome}"/>
  <rect y="26" width="${width}" height="8" fill="${PALETTE.chrome}"/>
  <line x1="0" y1="34" x2="${width}" y2="34" stroke="${PALETTE.rule}" stroke-width="1"/>
  ${dots}
  ${title ? `<text x="${width / 2}" y="24" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" fill="${PALETTE.muted}" letter-spacing="1.4">${esc(title)}</text>` : ''}
  <g font-family="ui-monospace,SFMono-Regular,'Cascadia Mono',Consolas,monospace" font-size="13" xml:space="preserve">
    ${body}
  </g>
</svg>
`;
}

const [, , input, output, title] = process.argv;
if (!input || !output) {
  console.error('usage: term-svg.mjs <input.txt> <output.svg> ["Title"]');
  process.exit(2);
}

const text = await readFile(input, 'utf8');
const lines = text.replace(/\r/g, '').replace(/\s+$/, '').split('\n');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, render(lines, title), 'utf8');
console.log(`${output} — ${lines.length} lines`);
