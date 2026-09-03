/**
 * The pages behind the docs and diff tabs (spec 0040 Requirement 7), ported
 * from the review UI as pure renderers: the server resolves files, comments
 * and difit state, and hands each page what it needs.
 */
import { esc } from './render.js';
import { exchangeEntryHtml } from './home.js';
import { projectQuery, shell, type ShellOptions } from './shell.js';
import type { DiffInstanceState, ExchangeEntry } from './view-model.js';

export interface DocsSpecRow {
  id: string;
  name: string;
  done: number;
  total: number;
  href: string;
}

export interface DocsCommit {
  hash: string;
  when: string;
  subject: string;
}

/** One STATUS.md entry, already rendered by the status-log reader. */
export interface DocsStatusEntry {
  titleHtml: string;
  bodyHtml: string;
}

export interface DocsDocument {
  file: string;
  when: string;
  kb: string;
  /** The `docs/specs/<id>/` folder the file sits in, where it sits in one. */
  specId?: string;
}

export interface DocsPageInput {
  specs: readonly DocsSpecRow[];
  commits: readonly DocsCommit[];
  status: readonly DocsStatusEntry[];
  documents: readonly DocsDocument[];
}

export interface ViewSection {
  title: string;
  anchor: string;
  source: string;
  comments: readonly ExchangeEntry[];
}

export interface ViewPageInput {
  file: string;
  sections: readonly ViewSection[];
  editHref: string;
  vendorScriptHref: string;
}

export interface EditPageInput {
  file: string;
  source: string;
  /** Epoch milliseconds of the file when it was read; the save is refused if it moved. */
  mtime: number;
  viewHref: string;
}

export interface DiffComment {
  file: string;
  line: number | null;
  body: string;
}

export interface DiffPageInput {
  instances: readonly DiffInstanceState[];
  currentId: string;
  comments: readonly DiffComment[];
}

function fileLinks(doc: DocsDocument, q: string, label: string): string {
  const f = encodeURIComponent(doc.file);
  return `<div class="f"><a href="/view?f=${f}&amp;${q}">${esc(label)}</a>
    <small>${esc(doc.when)} · ${esc(doc.kb)} kB · <a href="/edit?f=${f}&amp;${q}">edit</a></small></div>`;
}

function specRowHtml(spec: DocsSpecRow): string {
  const num = /^(\d+)/.exec(spec.id)?.[1] ?? '';
  const cls = spec.total === 0 ? ' empty' : spec.done === spec.total ? ' done' : '';
  const width = spec.total === 0 ? 0 : Math.round((spec.done / spec.total) * 100);
  return `<a class="spec${cls}" href="${esc(spec.href)}">
    <span class="num">${esc(num)}</span><span class="nm">${esc(spec.name)}</span>
    <span class="ct">${spec.done}/${spec.total}</span>
    <span class="track"><i style="width:${width}%"></i></span></a>`;
}

/** The docs tab: spec ledger, recent commits, the status log, then every markdown file. */
export function renderDocsPage(input: DocsPageInput, opts: ShellOptions): string {
  const q = projectQuery(opts.project).slice(1);

  // Active specs first; finished and not-yet-started ones stay visible but recede.
  const rank = (s: DocsSpecRow): number => (s.total === 0 ? 2 : s.done === s.total ? 1 : 0);
  const specRows = [...input.specs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const ledger = specRows.length === 0
    ? '<p class="empty">No spec yet. A folder under <code>docs/specs/</code> with a <code>tasks.md</code> would appear here.</p>'
    : specRows.map(specRowHtml).join('');

  const commits = input.commits.length === 0
    ? '<p class="empty">No commits read.</p>'
    : input.commits.map(
        (c) => `<div class="commit"><span class="h">${esc(c.hash)}</span><span class="s">${esc(c.subject)}</span><span class="mut small">${esc(c.when)}</span></div>`,
      ).join('');

  const happened = input.status.length === 0
    ? ''
    : `<section class="sect"><header><span class="label">What happened</span></header>
        ${input.status.map((e, i) => `<details class="happen"${i === 0 ? ' open' : ''}>
          <summary>${e.titleHtml}</summary><div class="body">${e.bodyHtml}</div></details>`).join('')}
      </section>`;

  const bySpec = new Map<string, DocsDocument[]>();
  const other: DocsDocument[] = [];
  for (const doc of input.documents) {
    if (doc.specId === undefined) {
      other.push(doc);
      continue;
    }
    const list = bySpec.get(doc.specId);
    if (list === undefined) bySpec.set(doc.specId, [doc]);
    else list.push(doc);
  }
  const specBlocks = [...bySpec.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([id, list]) => {
      const name = id.replace(/^\d+-/, '').replace(/-/g, ' ');
      const num = /^(\d+)/.exec(id)?.[1] ?? '';
      const rows = [...list]
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((d) => fileLinks(d, q, d.file.split('/').pop() ?? d.file));
      return `<section class="sect"><header><span class="label">${esc(num)} ${esc(name)}</span>
        <span class="n">${rows.length}</span></header>${rows.join('')}</section>`;
    });
  const otherRows = [...other]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((d) => fileLinks(d, q, d.file));

  const body = `<section class="sect"><header><span class="label">Specs</span><span class="n">${specRows.length}</span></header>${ledger}</section>
    <section class="sect"><header><span class="label">Recent commits</span><span class="n">${input.commits.length}</span></header>${commits}</section>
    ${happened}
    ${specBlocks.join('')}
    <details class="sect"><summary>Everything else (${otherRows.length})</summary>${otherRows.join('')}</details>`;
  return shell('docs', body, { ...opts, active: 'docs' });
}

/**
 * The markdown renderer runs in the browser against the vendored library, with
 * the same hardening the review UI carried: raw HTML in a document is shown as
 * text, link and image targets are limited to safe schemes, and links do not
 * hand the opener to the target. Agent-authored files render as text, never as
 * live markup.
 */
const VIEW_SCRIPT = `
(function(){
  var escHtml=function(s){return String(s).replace(/[&<>"]/g,function(c){
    return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;';});};
  var safeHref=function(h){return /^(https?:\\/\\/|\\/|#|\\.{0,2}\\/)/i.test(String(h||''))?String(h):'#';};
  var r=window.marked?new marked.Renderer():null;
  if(r){
    r.html=function(t){return escHtml(typeof t==='string'?t:((t&&(t.raw!==undefined?t.raw:t.text))||''));};
    // Newer renderers receive one token; older ones receive (href, title, text).
    r.link=function(){
      var a=arguments[0];
      var obj=a&&typeof a==='object';
      var href=safeHref(obj?a.href:a);
      var text=obj?(a.text||''):(arguments[2]||'');
      return '<a href="'+escHtml(href)+'" rel="noopener noreferrer">'+escHtml(text)+'</a>';
    };
    r.image=function(){
      var a=arguments[0];
      var obj=a&&typeof a==='object';
      var src=safeHref(obj?a.href:a);
      var alt=obj?(a.text||''):(arguments[2]||'');
      return '<img src="'+escHtml(src)+'" alt="'+escHtml(alt)+'">';
    };
  }
  var els=document.querySelectorAll('.md');
  for(var i=0;i<els.length;i++){
    var el=els[i];
    var src=decodeURIComponent(el.dataset.src);
    if(window.marked){el.innerHTML=marked.parse(src,{renderer:r});el.classList.add('rendered');}
    else el.textContent=src;
  }
})();
`;

/**
 * One document, split at its `##` headings so each section can be commented
 * on. Without script the escaped source is the page (0040 R7.2).
 */
export function renderViewPage(input: ViewPageInput, opts: ShellOptions): string {
  const blocks = input.sections.map((s, i) => {
    const id = s.anchor === '' ? `s${i}` : s.anchor;
    const title = s.title === '' ? 'this section' : s.title;
    return `<div class="sec" data-anchor="${esc(id)}">
      <div class="md" data-src="${esc(encodeURIComponent(s.source))}">${esc(s.source)}</div>
      <div class="secbar">
        <button class="anchor-btn cbtn" data-file="${esc(input.file)}" data-anchor="${esc(id)}" data-title="${esc(title)}">comment</button>
      </div>
      <div class="cform" hidden>
        <textarea rows="3" placeholder="Comment on ${esc(title)}…"></textarea>
        <div class="row"><button class="cpost">post</button><button class="ccancel">cancel</button><span class="err"></span></div>
      </div>
      ${s.comments.map((c) => exchangeEntryHtml(c, opts.project)).join('')}
    </div>`;
  });
  const body = `<h1 class="doc" style="font-size:1.05rem;margin:0">${esc(input.file)}
      <a class="mut" style="float:right;font-size:.8rem" href="${esc(input.editHref)}">edit</a></h1>
    ${blocks.join('')}
    <script src="${esc(input.vendorScriptHref)}"></script>
    <script>${VIEW_SCRIPT}</script>`;
  return shell(input.file, body, { ...opts, active: 'docs' });
}

/** Guarded editing: the save carries the mtime the page was opened with, and the server refuses a stale one. */
export function renderEditPage(input: EditPageInput, opts: ShellOptions): string {
  const body = `<div class="doc"><h1 style="font-size:1.05rem">edit <span class="mut">${esc(input.file)}</span></h1>
    <p class="mut small">Saving is refused if an agent changed this file while you had it open.</p>
    <textarea id="editor" rows="26" data-file="${esc(input.file)}" data-mtime="${input.mtime}">${esc(input.source)}</textarea>
    <div class="row" id="savebar" hidden>
      <button class="savebtn primary" data-view="${esc(input.viewHref)}">save</button>
      <a class="mut" href="${esc(input.viewHref)}">cancel</a>
    </div>
    <div class="err" id="saveerr"></div></div>`;
  return shell(`edit ${input.file}`, body, { ...opts, active: 'docs' });
}

/**
 * difit embedded, one tab per diff. The nav collapses to a single row with a
 * select for instance switching; the iframe points at the same-origin /frame
 * route so the page works on any device without knowing the host.
 */
export function renderDiffPage(input: DiffPageInput, opts: ShellOptions): string {
  const q = projectQuery(opts.project).slice(1);
  const current =
    input.instances.find((entry) => entry.id === input.currentId) ??
    input.instances.find((entry) => entry.up) ??
    input.instances.at(0);
  if (current === undefined) {
    const body = `<section class="sect"><header><span class="label">Diff</span></header>
      <p class="empty">No diff instance is configured; the working, staged and branch diffs would appear here.</p></section>`;
    return shell('diff', body, { ...opts, active: 'diff' });
  }

  const selectHtml = `<select class="difit-select" aria-label="which diff">${input.instances.map((entry) => {
    const label = `${entry.label} · ${entry.up ? 'running' : 'not running'}`;
    const sel = entry.id === current.id ? ' selected' : '';
    return `<option value="${esc(entry.id)}"${sel}>${esc(label)}</option>`;
  }).join('')}</select>`;

  const commentBlock = input.comments.length > 0
    ? `<details class="sect" open><summary>${input.comments.length} review comment(s)</summary>
        ${input.comments.map((c) => {
          const where = c.line === null ? c.file : `${c.file}:${c.line}`;
          return `<div class="sec"><div class="mut mono">${esc(where)}</div><div>${esc(c.body)}</div></div>`;
        }).join('')}</details>`
    : '';

  const panel = current.up
    ? `<iframe class="difit" src="/frame?d=${encodeURIComponent(current.id)}&amp;${q}" title="${esc(current.description)}"></iframe>`
    : `${commentBlock}<section class="sect"><p class="mut">${esc(current.description)}</p>
        <p class="mut">Not running.</p>
        <p class="row"><button class="difit-start" data-id="${esc(current.id)}">start it</button>
        <span class="mut mono" id="difitbusy"></span></p></section>`;

  const body = current.up ? `${commentBlock}${panel}` : panel;
  return shell('diff', body, { ...opts, active: 'diff', compact: true, navExtraHtml: selectHtml });
}

