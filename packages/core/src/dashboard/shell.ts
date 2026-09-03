/**
 * The page shell every dashboard page renders into: stylesheet, top bar, and
 * the one client script (spec 0040 Requirement 1).
 *
 * Ported from the phone-first review UI this dashboard replaces. Nothing here
 * reads disk or git; a page hands over a body and gets a document back.
 */
import { esc } from './render.js';

export type ShellTab = 'home' | 'diff' | 'docs' | 'rules';

export interface ShellOptions {
  /** The project root every link on the page carries as `?p=`. */
  project: string;
  projectName: string;
  /** More than one project is registered, so the name is a way back to the selector. */
  showProjects: boolean;
  /** Short muted text at the right of the top bar. */
  badge?: string;
  /**
   * Pre-rendered HTML that stands in for the project name in the top bar. The
   * home page uses it for the project selector and the check indicator; other
   * pages leave it out and show the name.
   */
  topBarHtml?: string;
  /** Which tab is underlined. */
  active?: ShellTab;
  /**
   * When true the nav collapses to one row: tabs on the left, navExtraHtml in
   * the middle, project name (small, muted, truncated) on the right. No title
   * row, no second row. Height 44px. Used by the diff page to give the iframe
   * maximum screen space.
   */
  compact?: boolean;
  /**
   * Pre-rendered HTML inserted between the tabs and the project name in the
   * compact nav row. Used by the diff page for the instance selector.
   * Only rendered when compact is true.
   */
  navExtraHtml?: string;
}

/** `?p=<root>` for every link that must stay inside the project being viewed. */
export function projectQuery(root: string): string {
  return `?p=${encodeURIComponent(root)}`;
}

/**
 * Paths of the four tabs. Docs keeps its old path so a bookmark taken from the
 * review UI still lands somewhere.
 */
export const TAB_PATHS: Readonly<Record<ShellTab, string>> = {
  home: '/',
  diff: '/diff',
  docs: '/files',
  rules: '/rules',
};

export const CSS = `
/*
 * Read on a phone, away from the machine, to answer one question: is there
 * anything here I have to deal with.
 *
 * Three rules this sheet is built on, all borrowed from the tool itself.
 *
 * Green never means "good". It means "measured". A number the tool has not
 * verified is not allowed to wear the colour of one it has — the same
 * substitution the analyzer refuses to make between a syntax finding and a
 * semantic one.
 *
 * Orange appears at most twice, and only on something needing a human decision.
 * If it is everywhere it means nothing. Here it marks the needs-you region and
 * the ids inside it; the same colour on an abandoned dispatch or an outcome
 * that needs a person is the same item, seen from the region it came from.
 *
 * No cards. Cards imply a pile of equally weighted independent objects. This is
 * one narrative with one thing at the top that matters more than the rest.
 */
:root{
  --ground:#0B1017;
  --raised:#111826;
  --ink:#E8E3D9;
  --rule:#1E2836;
  --muted:#6E7B8C;
  --signal:#FF5C1A;
  --measured:#4FB286;
  --stale:#B8873F;
}
@media(prefers-color-scheme:light){
  :root{--ground:#F5F3EF;--raised:#FFFFFF;--ink:#12181F;--rule:#DCD6CC;--muted:#5C6672;
        --signal:#D4400A;--measured:#1F7A54;--stale:#8A6420}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--ground);color:var(--ink);
  font:400 15px/1.55 ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  padding:0 0 96px;
  padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);
}
a{color:inherit}
.label{
  font:600 10px/1 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
  letter-spacing:.16em;text-transform:uppercase;color:var(--muted);
}
.mono{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-variant-numeric:tabular-nums}
.mut{color:var(--muted)}
.small{font-size:12px}
.err{color:var(--signal);font-size:13px;min-height:1em}
.nav{
  position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;
  padding:calc(10px + env(safe-area-inset-top)) 20px 0;
  background:color-mix(in srgb,var(--ground) 88%,transparent);
  backdrop-filter:blur(12px);border-bottom:1px solid var(--rule);
}
.nav .who{display:flex;align-items:center;gap:12px;flex:1 1 100%;min-width:0}
.nav .who a{text-decoration:none;font-weight:600}
.nav .who select{
  flex:0 1 auto;max-width:100%;width:auto;padding:6px 8px;font-size:14px;font-weight:600;
  background:var(--raised);color:var(--ink);border:1px solid var(--rule);border-radius:2px;
}
.nav .check{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;font-size:13px}
.nav .sp{flex:1}
.nav .badge{font-size:12px;color:var(--muted)}
.tabs{display:flex;gap:2px;flex-wrap:wrap}
.nav .tabs{flex:1 1 100%;margin:0 -20px;padding:0 20px}
.tab{display:inline-flex;align-items:center;gap:7px;padding:10px 14px;text-decoration:none;
  color:var(--muted);border-bottom:2px solid transparent;
  font:600 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase}
.tab:hover{color:var(--ink)}
.tab.on{color:var(--ink);border-bottom-color:var(--signal)}
.tab .live,.tab .dead{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}
.tab .live{background:var(--measured)}
.tab .dead{background:var(--rule)}
.ev{display:inline-flex;align-items:center;gap:5px;font:500 10px/1 ui-monospace,Consolas,monospace;
    letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.ev::before{content:"";width:7px;height:7px;border-radius:50%;flex:none}
.ev.now::before{background:var(--measured)}
.ev.recorded::before{background:var(--stale)}
.ev.unknown::before{background:transparent;border:1px solid var(--muted)}
.ev.signal::before{background:var(--signal)}
.ev.ink::before{background:var(--ink)}
.ev.stale::before{background:var(--stale)}
.ev.muted::before{background:var(--muted)}
.sect{padding:26px 20px;border-bottom:1px solid var(--rule)}
.sect>header{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
.sect>header .n{margin-left:auto;font:650 13px/1 ui-monospace,Consolas,monospace;color:var(--muted)}
.sect .empty{margin:0;font-size:14px;color:var(--muted)}
.sect.attention{background:
  linear-gradient(90deg,color-mix(in srgb,var(--signal) 9%,transparent),transparent 62%)}
.sect.attention>header .label{color:var(--signal)}
.sect.attention>header .n{color:var(--signal)}
.need{display:block;padding:14px 0;border-top:1px solid var(--rule)}
.need:first-of-type{border-top:0}
.need .q{margin:0 0 4px;font-size:16px;font-weight:600;line-height:1.4}
.need .what{display:block;font-size:14px;color:var(--muted);margin-bottom:4px}
.need .detail{display:block;font-size:12px;color:var(--muted);line-height:1.5}
.need .acts{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.need .loc{display:block;margin-top:6px}
.need .loc .id{color:var(--signal)}
.sub{margin-top:18px}
.sub>.label{display:block;margin-bottom:6px}
.line{padding:9px 0;border-top:1px solid var(--rule)}
.line:first-of-type{border-top:0}
.line .t{font-weight:600}
.line .meta{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:3px;font-size:13px;color:var(--muted)}
.line .files{display:block;font-size:12px;color:var(--muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line .actions{display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap}
.ok{color:var(--measured)}
.bad{color:var(--signal)}
button.stop{border-color:var(--muted)}
button.stop.armed{background:var(--signal);color:#fff;border-color:var(--signal)}
.lane{padding:10px 0;border-top:1px solid var(--rule)}
.lane:first-of-type{border-top:0}
.lane .head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.lane .head .id{font-weight:600}
.lane .tag{font:600 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);border:1px solid var(--rule);padding:3px 6px;border-radius:2px}
.lane .more{margin-top:4px;font-size:13px;color:var(--muted)}
.lane .more code,.sect code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;
  background:var(--raised);padding:1px 5px;border-radius:3px}
.happen{border-top:1px solid var(--rule);padding:14px 0}
.happen:first-of-type{border-top:0}
.happen summary{cursor:pointer;list-style:none;font-weight:600;letter-spacing:-.01em}
.happen summary::-webkit-details-marker{display:none}
.happen summary::before{content:"+ ";color:var(--muted);font-family:ui-monospace,monospace}
.happen[open] summary::before{content:"- "}
.happen .body{padding-top:8px}
.happen .body p{margin:.6em 0;font-size:14px;color:color-mix(in srgb,var(--ink) 82%,var(--muted))}
.happen .body code{font-family:ui-monospace,Consolas,monospace;font-size:.87em;
  background:var(--raised);padding:1px 5px;border-radius:3px}
.spec{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--rule);
      text-decoration:none}
.spec:first-of-type{border-top:0}
.spec .num{font:650 11px/1 ui-monospace,Consolas,monospace;color:var(--muted);flex:none;width:34px}
.spec .nm{flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spec .ct{font:600 11px/1 ui-monospace,Consolas,monospace;color:var(--muted);flex:none}
.spec .track{flex:none;width:64px;height:2px;background:var(--rule);position:relative}
.spec .track i{position:absolute;inset:0 auto 0 0;background:var(--ink)}
.spec.done .nm{color:var(--muted)}
.spec.done .track i{background:var(--muted)}
.spec.empty .track{background:transparent;border-top:1px dashed var(--rule)}
.commit{padding:8px 0;border-top:1px solid var(--rule);display:flex;gap:11px;align-items:baseline}
.commit:first-of-type{border-top:0}
.commit .h{font:500 11px/1 ui-monospace,Consolas,monospace;color:var(--muted);flex:none}
.commit .s{flex:1;font-size:13px}
.f{padding:8px 0;border-top:1px solid var(--rule)}
.f:first-of-type{border-top:0}
.f small{display:block;color:var(--muted);font-size:12px}
.cm{padding:14px 0;border-top:1px solid var(--rule)}
.cm.addressed{opacity:.5}
.cm.agent{border-left:3px solid var(--ink);padding-left:12px}
.cm .meta{font:500 10px/1.4 ui-monospace,Consolas,monospace;color:var(--muted);letter-spacing:.04em}
.cm .meta .who{color:var(--ink)}
.cm .body{margin-top:7px;white-space:pre-wrap}
.row{margin-top:9px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.compose{margin-top:18px;display:flex;flex-direction:column;gap:8px}
.compose .task{max-width:220px}
button,a.ghost{
  font:600 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;
  background:transparent;color:var(--ink);border:1px solid var(--rule);
  border-radius:2px;padding:9px 14px;cursor:pointer;
}
a.ghost{display:inline-block;text-decoration:none}
button:hover,button:focus-visible,a.ghost:hover,a.ghost:focus-visible{border-color:var(--muted)}
button.primary{background:var(--ink);color:var(--ground);border-color:var(--ink)}
button[disabled]{opacity:.5;cursor:default}
textarea,input{
  width:100%;background:var(--raised);color:var(--ink);border:1px solid var(--rule);
  border-radius:2px;padding:11px 12px;font:inherit;font-size:16px;
}
textarea:focus,input:focus,button:focus-visible,a:focus-visible,select:focus-visible{
  outline:2px solid var(--signal);outline-offset:2px;
}
.fab{
  position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;gap:9px;align-items:center;
  padding:11px 16px calc(11px + env(safe-area-inset-bottom));
  background:color-mix(in srgb,var(--ground) 94%,transparent);
  backdrop-filter:blur(12px);border-top:1px solid var(--rule);
}
.difit{width:100%;height:calc(100vh - 44px);height:calc(100dvh - 44px);border:0;display:block}
.nav.compact{flex-wrap:nowrap;padding:0 12px;height:44px;align-items:center;gap:0}
.nav.compact .tabs{flex:none;margin:0;padding:0;display:flex;gap:0}
.nav.compact .tab{padding:0 10px;height:44px;border-bottom-width:2px}
.nav.compact .extra{display:flex;align-items:center;padding:0 8px}
.nav.compact .extra select{padding:4px 6px;font-size:13px;font-weight:600;
  background:var(--raised);color:var(--ink);border:1px solid var(--rule);border-radius:2px}
.nav.compact .cname{margin-left:auto;font-size:11px;color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.hidden{display:none}
pre{background:var(--raised);padding:12px;border-radius:3px;overflow-x:auto;font-size:13px}
.doc{padding:20px}
.doc h1,.doc h2,.doc h3{letter-spacing:-.02em}
.doc a{color:var(--ink)}
.sec{padding:14px 20px;border-bottom:1px solid var(--rule)}
.sec .md{white-space:pre-wrap;overflow-wrap:anywhere}
.sec .md:not(.rendered){font-family:ui-monospace,Consolas,monospace;font-size:13px}
.secbar{margin-top:8px}
.cform{margin-top:10px}
footer.label{display:block;padding:26px 20px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/**
 * One script for every page. Controls are found by class and read their
 * arguments from data attributes: an inline handler attribute is parsed as
 * HTML before JavaScript, so a quote inside a JSON-encoded path ended the
 * attribute early and the button did nothing. Delegation avoids that class of
 * defect entirely.
 */
export const CLIENT = `
(function(){
  var project=document.body.dataset.project||'';
  function q(){return '?p='+encodeURIComponent(project);}
  function post(url,data){
    data.p=project;
    return fetch(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(data)}).then(function(r){
        return r.json().catch(function(){return {};}).then(function(d){return {ok:r.ok,data:d};});
      });
  }
  function fail(el,r,fallback){
    if(!el)return;
    el.textContent=(r&&r.data&&r.data.error)||fallback;
  }

  // A half-typed reply outlives a state change: the poll reloads only while
  // nothing on the page is dirty (0040 R1.5).
  document.addEventListener('input',function(e){
    var t=e.target;
    if(!t||t.tagName==='SELECT')return;
    document.body.dataset.dirty='1';
    var bar=document.getElementById('savebar');
    if(bar)bar.hidden=false;
  });

  var pollEl=document.querySelector('[data-poll]');
  if(pollEl){
    var last=null;
    var poll=function(){
      fetch(pollEl.dataset.poll).then(function(r){return r.json();}).then(function(s){
        var k=String(s.key);
        if(last!==null&&k!==last&&!document.body.dataset.dirty)location.reload();
        last=k;
      }).catch(function(){
        // Loss of the poll is not an error the reader can act on; the page
        // simply stays as it was until the next tick.
        var age=document.getElementById('poll-state');
        if(age)age.textContent='poll lost; showing the last read';
      });
    };
    setInterval(poll,5000);poll();
  }

  document.addEventListener('change',function(e){
    var sel=e.target&&e.target.closest?e.target.closest('.project-select'):null;
    if(!sel)return;
    location.href='/?p='+encodeURIComponent(sel.value);
  });

  document.addEventListener('change',function(e){
    var sel=e.target&&e.target.closest?e.target.closest('.difit-select'):null;
    if(!sel)return;
    location.href='/diff?d='+encodeURIComponent(sel.value)+'&p='+encodeURIComponent(project);
  });

  var armed=null;
  function disarm(){
    if(!armed)return;
    armed.btn.classList.remove('armed');
    armed.btn.textContent='stop';
    clearTimeout(armed.timer);
    armed=null;
  }

  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.closest)return;

    // Two taps: the first arms, the second sends. A scroll that lands on the
    // button once cannot stop a dispatch (0040 R6.3).
    var stop=t.closest('.stop');
    if(stop){
      if(armed&&armed.btn===stop){
        var id=stop.dataset.dispatch;
        var err=stop.parentElement?stop.parentElement.querySelector('.err'):null;
        disarm();
        stop.disabled=true;
        stop.textContent='stopping';
        post('/api/stop',{dispatchId:id}).then(function(r){
          if(r.ok){location.reload();return;}
          stop.disabled=false;stop.textContent='stop';
          fail(err,r,'could not stop '+id);
        });
        return;
      }
      disarm();
      stop.classList.add('armed');
      stop.textContent='confirm stop';
      armed={btn:stop,timer:setTimeout(disarm,6000)};
      return;
    }
    if(armed)disarm();

    var tell=t.closest('.act-tell');
    if(tell){
      var ta=document.getElementById('reply');
      var rt=document.getElementById('reply-task');
      if(ta){
        var pf=tell.dataset.prefill||'';
        ta.value=ta.value?ta.value+'\\n'+pf:pf;
        document.body.dataset.dirty='1';
      }
      if(rt&&tell.dataset.task)rt.value=tell.dataset.task;
      var exch=document.getElementById('exchange');
      if(exch)exch.scrollIntoView({behavior:'smooth'});
      if(ta)ta.focus();
      return;
    }

    var dismiss=t.closest('.act-dismiss');
    if(dismiss){
      dismiss.disabled=true;
      var dId=dismiss.dataset.item;
      var dErr=dismiss.parentElement?dismiss.parentElement.querySelector('.err'):null;
      post('/api/acknowledge',{itemId:dId}).then(function(r){
        if(r.ok){location.reload();return;}
        dismiss.disabled=false;
        fail(dErr,r,'could not acknowledge '+dId);
      });
      return;
    }

    var closeBtn=t.closest('.act-close');
    if(closeBtn){
      closeBtn.disabled=true;
      var cId=closeBtn.dataset.dispatch;
      var cErr=closeBtn.parentElement?closeBtn.parentElement.querySelector('.err'):null;
      post('/api/stop',{dispatchId:cId}).then(function(r){
        if(r.ok){location.reload();return;}
        closeBtn.disabled=false;
        fail(cErr,r,'could not close '+cId);
      });
      return;
    }

    var addressed=t.closest('.addressed-btn');
    if(addressed){
      addressed.disabled=true;
      post('/api/comment/status',{id:Number(addressed.dataset.id),status:'addressed'}).then(function(r){
        if(r.ok){delete document.body.dataset.dirty;location.reload();return;}
        addressed.disabled=false;
        fail(document.getElementById('post-err'),r,'could not mark #'+addressed.dataset.id+' addressed');
      });
      return;
    }

    var postBtn=t.closest('.post-btn');
    if(postBtn){
      var ta=document.getElementById('reply');
      var task=document.getElementById('reply-task');
      var body=ta?ta.value.trim():'';
      if(!body)return;
      postBtn.disabled=true;
      var payload={body:body};
      if(task&&task.value.trim())payload.task=task.value.trim();
      post('/api/comment',payload).then(function(r){
        postBtn.disabled=false;
        if(r.ok){ta.value='';delete document.body.dataset.dirty;location.reload();return;}
        fail(document.getElementById('post-err'),r,'could not post');
      });
      return;
    }

    var open=t.closest('.cbtn');
    if(open){
      var form=open.closest('.sec').querySelector('.cform');
      form.hidden=!form.hidden;
      if(!form.hidden)form.querySelector('textarea').focus();
      return;
    }
    var cancel=t.closest('.ccancel');
    if(cancel){
      var cf=cancel.closest('.cform');
      cf.hidden=true;cf.querySelector('textarea').value='';
      delete document.body.dataset.dirty;
      return;
    }
    var cpost=t.closest('.cpost');
    if(cpost){
      var sec=cpost.closest('.sec');
      var btn=sec.querySelector('.cbtn');
      var cta=cpost.closest('.cform').querySelector('textarea');
      var text=cta.value.trim();
      if(!text)return;
      cpost.disabled=true;
      post('/api/comment',{file:btn.dataset.file,anchor:btn.dataset.anchor,body:text}).then(function(r){
        cpost.disabled=false;
        if(r.ok){delete document.body.dataset.dirty;location.reload();return;}
        fail(cpost.closest('.cform').querySelector('.err'),r,'could not post');
      });
      return;
    }

    var save=t.closest('.savebtn');
    if(save){
      var ed=document.getElementById('editor');
      if(!ed)return;
      save.disabled=true;
      post('/api/save',{file:ed.dataset.file,mtime:Number(ed.dataset.mtime),content:ed.value}).then(function(r){
        save.disabled=false;
        if(r.ok){delete document.body.dataset.dirty;location.href=save.dataset.view;return;}
        fail(document.getElementById('saveerr'),r,'save failed');
      });
      return;
    }

    var start=t.closest('.difit-start');
    if(start){
      var busy=document.getElementById('difitbusy');
      start.disabled=true;
      if(busy)busy.textContent='starting difit, this can take a few seconds';
      post('/api/difit/start',{id:start.dataset.id}).then(function(r){
        if(r.ok){location.reload();return;}
        start.disabled=false;
        fail(busy,r,'could not start difit');
      });
    }
  });
})();
`;

/** Inlined so every page load does not 404 on a /favicon.ico this server never routes. */
const FAVICON = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="%23FF5C1A" stroke-width="2"/>' +
    '<path d="M5 8.5l2 2 4-4.5" fill="none" stroke="%23FF5C1A" stroke-width="2"/></svg>',
);

const TAB_ORDER: readonly ShellTab[] = ['home', 'diff', 'docs', 'rules'];

/** The four tabs, each carrying the project query so navigation stays inside one project. */
export function tabsHtml(project: string, active: ShellTab | undefined): string {
  const q = projectQuery(project);
  return TAB_ORDER.map((tab) => {
    const on = tab === active ? ' on' : '';
    return `<a class="tab${on}" href="${TAB_PATHS[tab]}${q}">${tab}</a>`;
  }).join('');
}

export function shell(title: string, body: string, opts: ShellOptions): string {
  const home = `${TAB_PATHS.home}${projectQuery(opts.project)}`;
  const who =
    opts.topBarHtml ??
    `<a href="${home}" title="${opts.showProjects ? 'choose a project' : esc(opts.projectName)}">${esc(opts.projectName)}</a>`;
  const badge = opts.badge === undefined ? '' : `<span class="badge">${esc(opts.badge)}</span>`;
  const navHtml = opts.compact === true
    ? `<div class="nav compact"><nav class="tabs">${tabsHtml(opts.project, opts.active)}</nav>${opts.navExtraHtml !== undefined ? `<div class="extra">${opts.navExtraHtml}</div>` : ''}<span class="cname">${esc(opts.projectName)}</span></div>`
    : `<div class="nav"><div class="who">${who}<span class="sp"></span>${badge}</div>\n<nav class="tabs">${tabsHtml(opts.project, opts.active)}</nav></div>`;
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,${FAVICON}">
<style>${CSS}</style></head><body data-project="${esc(opts.project)}">
${navHtml}
${body}
<script>${CLIENT}</script></body></html>`;
}

