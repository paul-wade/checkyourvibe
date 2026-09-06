/**
 * The /specs page and the small server-side markdown preview that backs it.
 *
 * Pure rendering: this module makes no disk calls. The route in
 * `packages/core/src/cli/dashboard.ts` supplies the file list and any open
 * file. The page ships with an inline script; no client framework, no CDN.
 */
import { esc } from './render.js';
import { topNavHtml as sharedNavHtml } from './nav.js';
import { dashboardCss, specPageCss } from './styles.js';
import type { SpecDirectory, SpecFile } from './spec-editor.js';

interface SpecOpenState {
  file: string;
  content: string;
  holder: string;
  readOnly: boolean;
  lockedBy?: string | undefined;
}

export interface SpecPageInput {
  project: string;
  projectName: string;
  directories: SpecDirectory[];
  open?: SpecOpenState;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client script
// ---------------------------------------------------------------------------

const CLIENT_SCRIPT = `
(function(){
  var project = document.body.dataset.project || '';
  var storageKey = 'cyv_spec_holder:' + project;
  function getHolder(){
    var h = localStorage.getItem(storageKey);
    if(h) return h;
    h = '';
    for(var i=0;i<16;i++) h += Math.floor(Math.random()*16).toString(16);
    localStorage.setItem(storageKey, h);
    return h;
  }
  function q(obj){
    var p = new URLSearchParams();
    if(project) p.set('p', project);
    for(var k in obj){
      var v = obj[k];
      if(v !== undefined && v !== null && v !== '') p.set(k, String(v));
    }
    return '?' + p.toString();
  }
  function post(url, data){
    return fetch(url + q({}), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){ return { ok: r.ok, status: r.status, data: d }; });
    });
  }
  function release(file, holder){
    if(!file || !holder) return;
    var data = JSON.stringify({ file: file, holder: holder });
    if(navigator.sendBeacon){
      navigator.sendBeacon('/api/spec/release' + q({}), new Blob([data], { type: 'application/json' }));
    } else {
      fetch('/api/spec/release' + q({}), { method: 'POST', headers: { 'content-type': 'application/json' }, body: data, keepalive: true });
    }
  }

  var holder = getHolder();
  document.querySelectorAll('.specs-file').forEach(function(a){
    var f = a.dataset.file;
    if(f) a.href = '/specs' + q({ f: f, h: holder });
  });

  var url = new URL(location.href);
  var f = url.searchParams.get('f');
  if(f && !url.searchParams.get('h')){
    url.searchParams.set('h', holder);
    location.replace(url.toString());
    return;
  }

  document.body.addEventListener('click', function(e){
    var t = e.target;
    if(!t || !t.closest) return;

    var save = t.closest('.specs-save');
    if(save){
      var file = save.dataset.file;
      var holder = save.dataset.holder;
      var ta = document.getElementById('spec-source');
      if(!file || !holder || !ta) return;
      var content = ta.value;
      save.disabled = true;
      post('/api/spec/write', { file: file, content: content, holder: holder }).then(function(r){
        save.disabled = false;
        var err = document.getElementById('spec-err');
        if(r.ok && r.data && r.data.ok){
          if(err) err.textContent = 'saved';
          document.body.dataset.locked = 'false';
          release(file, holder);
          return;
        }
        var msg = (r.data && r.data.error) || 'save failed';
        if(r.data && r.data.holder) msg = msg + ' held by ' + r.data.holder;
        if(err) err.textContent = msg;
      });
      return;
    }

    var close = t.closest('.specs-close');
    if(close){
      var file = close.dataset.file;
      var holder = close.dataset.holder;
      if(file && holder) release(file, holder);
      document.body.dataset.locked = 'false';
      location.href = '/specs' + q({});
      return;
    }

    var toggle = t.closest('.specs-preview-toggle');
    if(toggle){
      var preview = document.getElementById('spec-preview');
      var ta = document.getElementById('spec-source');
      if(!preview || !ta) return;
      if(!preview.hidden){
        preview.hidden = true;
        toggle.textContent = 'preview';
        return;
      }
      var content = ta.value;
      post('/api/spec/preview', { markdown: content }).then(function(r){
        if(r.ok && r.data && typeof r.data.html === 'string'){
          preview.innerHTML = r.data.html;
          preview.hidden = false;
          toggle.textContent = 'edit';
        }
      });
      return;
    }
  });

  window.addEventListener('beforeunload', function(){
    var ta = document.getElementById('spec-source');
    var close = document.querySelector('.specs-close');
    var file = (ta && ta.dataset.file) || (close && close.dataset.file);
    var holder = (ta && ta.dataset.holder) || (close && close.dataset.holder);
    if(!file || !holder || document.body.dataset.locked === 'false') return;
    release(file, holder);
  });
})();
`;

// ---------------------------------------------------------------------------
// Markdown preview renderer
// ---------------------------------------------------------------------------

function safeSpecHref(raw: string): string {
  const url = raw.trim();
  if (/^(https?:\/\/|mailto:|\/|#|[.]{0,2}\/)/i.test(url)) return url;
  return '#';
}

function renderInline(input: string): string {
  let out = '';
  let text = '';
  let i = 0;

  function flushText(): void {
    if (text !== '') {
      out += esc(text);
      text = '';
    }
  }

  while (i < input.length) {
    const c = input[i];
    if (c === '`') {
      flushText();
      const end = input.indexOf('`', i + 1);
      if (end === -1) {
        text += c;
        i += 1;
        continue;
      }
      const code = input.slice(i + 1, end);
      out += `<code>${esc(code)}</code>`;
      i = end + 1;
      continue;
    }

    if (c === '[') {
      flushText();
      const close = input.indexOf(']', i);
      if (close !== -1 && input.charAt(close + 1) === '(') {
        const parenClose = input.indexOf(')', close + 2);
        if (parenClose !== -1) {
          const label = input.slice(i + 1, close);
          const rawUrl = input.slice(close + 2, parenClose);
          const safe = safeSpecHref(rawUrl);
          out += `<a href="${esc(safe)}" rel="noopener noreferrer">${renderInline(label)}</a>`;
          i = parenClose + 1;
          continue;
        }
      }
    }

    if (c === '*' && input.charAt(i + 1) === '*') {
      flushText();
      const end = input.indexOf('**', i + 2);
      if (end !== -1) {
        out += `<strong>${renderInline(input.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
      text += '**';
      i += 2;
      continue;
    }

    if (c === '*') {
      flushText();
      const end = input.indexOf('*', i + 1);
      if (end !== -1) {
        out += `<em>${renderInline(input.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
      text += c;
      i += 1;
      continue;
    }

    text += c;
    i += 1;
  }

  flushText();
  return out;
}

export function renderSpecMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  let inFence = false;
  let fenceContent: string[] = [];
  let currentList: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];

  function flushPara(): void {
    if (para.length > 0) {
      blocks.push(`<p>${renderInline(para.join(' '))}</p>`);
      para = [];
    }
  }

  function flushList(): void {
    if (currentList !== null) {
      const tag = currentList.type === 'ul' ? 'ul' : 'ol';
      const items = currentList.items.map((item) => `<li>${renderInline(item)}</li>`).join('');
      blocks.push(`<${tag}>${items}</${tag}>`);
      currentList = null;
    }
  }

  for (const line of lines) {
    if (inFence) {
      if (/^```\s*$/.test(line)) {
        inFence = false;
        blocks.push(`<pre><code>${esc(fenceContent.join('\n'))}</code></pre>`);
        fenceContent = [];
      } else {
        fenceContent.push(line);
      }
      continue;
    }

    if (/^```/.test(line)) {
      flushPara();
      flushList();
      inFence = true;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushPara();
      flushList();
      const level = heading[1]?.length ?? 1;
      const title = heading[2]?.trim() ?? '';
      blocks.push(`<h${level}>${renderInline(title)}</h${level}>`);
      continue;
    }

    const ul = /^[-*+]\s+(.+)$/.exec(line);
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ul !== null || ol !== null) {
      flushPara();
      const type = ul !== null ? 'ul' : 'ol';
      const text = (ul?.[1] ?? ol?.[1] ?? '').trim();
      if (currentList === null || currentList.type !== type) {
        flushList();
        currentList = { type, items: [] };
      }
      currentList.items.push(text);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }

    if (currentList !== null && /^\s+/.test(line)) {
      const last = currentList.items.at(-1);
      if (last !== undefined) {
        currentList.items.splice(currentList.items.length - 1, 1, last + ' ' + line.trim());
      }
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  if (inFence) {
    blocks.push(`<pre><code>${esc(fenceContent.join('\n'))}</code></pre>`);
  }

  flushList();
  flushPara();

  return blocks.join('\n');
}

// ---------------------------------------------------------------------------
// Page renderer
// ---------------------------------------------------------------------------

function url(path: string, project: string, extra: Record<string, string>): string {
  const params = new URLSearchParams();
  params.set('p', project);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== '') params.set(k, v);
  }
  return `${path}?${params.toString()}`;
}

export function renderSpecPage(input: SpecPageInput): string {
  const openAttr = input.open ? 'true' : 'false';
  const lockedAttr = input.open && !input.open.readOnly ? 'true' : 'false';

  function fileHtml(file: SpecFile): string {
    return `<li><a class="specs-file" data-file="${esc(file.repoRelativePath)}" href="${esc(url('/specs', input.project, {}))}">${esc(file.name)}</a></li>`;
  }

  function dirHtml(dir: SpecDirectory): string {
    return `<section class="specs-dir">
      <h2>${esc(dir.name)}</h2>
      <ul>${dir.files.map(fileHtml).join('')}</ul>
    </section>`;
  }

  function editorSection(open: SpecOpenState): string {
    const previewContent = open.readOnly ? renderSpecMarkdown(open.content) : '';
    const previewHidden = open.readOnly ? '' : 'hidden';
    const editorOrReadonly = open.readOnly
      ? ''
      : `<textarea id="spec-source" class="specs-source" data-file="${esc(open.file)}" data-holder="${esc(open.holder)}">${esc(open.content)}</textarea>`;
    const closeHolder = open.readOnly ? '' : esc(open.holder);
    const saveBar = open.readOnly
      ? ''
      : `<div class="specs-fab"><button class="specs-save" type="button" data-file="${esc(open.file)}" data-holder="${esc(open.holder)}">save</button><span class="specs-err" id="spec-err"></span></div>`;

    return `<section class="specs-editor" id="spec-editor">
      <div class="specs-file-bar">
        <span class="specs-file-path">${esc(open.file)}</span>
        <div class="specs-file-actions">
          ${open.readOnly
            ? '<span class="specs-readonly-badge">read only</span>'
            : '<button class="specs-preview-toggle" type="button">preview</button>'}
          <button class="specs-close" type="button" data-file="${esc(open.file)}" data-holder="${closeHolder}">close</button>
        </div>
      </div>
      ${open.readOnly
        ? `<div class="specs-locked-notice">Locked by <strong>${esc(open.lockedBy ?? 'someone')}</strong>.</div>`
        : ''}
      <div class="specs-editor-panes">
        ${editorOrReadonly}
        <div id="spec-preview" class="specs-preview" ${previewHidden}>${previewContent}</div>
      </div>
      ${saveBar}
    </section>`;
  }

  const topNavHtml = sharedNavHtml(input.projectName, input.project, '/specs');

  const listHtml = input.directories.length === 0
    ? '<p class="specs-empty">No specs found.</p>'
    : input.directories.map(dirHtml).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(input.projectName)} · Specs</title>
<style>${dashboardCss()}${specPageCss()}</style>
</head>
<body class="specs-body" data-project="${esc(input.project)}" data-locked="${lockedAttr}">
${topNavHtml}
<main class="specs-layout" id="spec-layout" data-open="${openAttr}">
${input.open ? editorSection(input.open) : ''}
<section class="specs-list" id="spec-list">
  <header class="specs-list-header"><span class="specs-count">${String(input.directories.length)} spec${input.directories.length === 1 ? '' : 's'}</span></header>
  ${input.error ? `<p class="specs-error">${esc(input.error)}</p>` : ''}
  ${listHtml}
</section>
</main>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}
