/**
 * The board page's client behaviour, produced as a string the page embeds in
 * an inline `<script>` element. Selecting a card fills the docked diff drawer;
 * selecting another replaces its contents. Acknowledge posts to the acknowledge
 * route and removes the card on success. Liveness comes from the event stream;
 * the only timer repaints the badge's "how old is this data" line and fetches
 * nothing. No framework, no remote resource: every action is a single fetch.
 */
export const BOARD_DRAWER_PATH = '/api/drawer';
export const BOARD_INSPECT_PATH = '/api/inspect';
export const BOARD_ACK_PATH = '/api/acknowledge';
export const BOARD_EXPLORER_TREE_PATH = '/api/explorer/tree';
export const BOARD_EXPLORER_READ_PATH = '/api/explorer/read';
export const BOARD_EXPLORER_WRITE_PATH = '/api/explorer/write';

function liveClientScript(): string {
  // The badge must prove liveness rather than claim it: `lastEventAt` moves only
  // when the stream actually delivers an event (or a fresh fragment lands with a
  // newer render epoch), never when a timer fires. The interval below repaints
  // the age text — it fetches nothing, so a dead stream shows a number that
  // keeps growing instead of a frozen "live".
  return String.raw`(function(){
  if (typeof EventSource !== 'function' || typeof DOMParser !== 'function') return;
  var parser = new DOMParser();
  var body = document.body || null;
  var project = body === null ? '' : (body.getAttribute('data-project') || '');
  var REGIONS = {
    status: 'board-status',
    topbar: 'board-topbar',
    todo: 'board-todo-body',
    'in-progress': 'board-in-progress-body',
    done: 'board-done-body',
    decisions: 'board-decisions',
    conversation: 'board-conversation',
    drafts: 'board-drafts',
    sessions: 'board-sessions-panel',
    lanes: 'board-lanes'
  };
  // The event stream's producer still names the kanban columns by their old
  // positions (left, center, right, recent); translate those at the boundary
  // so an event refreshes the column it means.
  var LEGACY_REGION = { left: 'todo', center: 'in-progress', right: 'decisions', recent: 'done', review: 'done', 'needs-you': 'decisions' };
  var DOT_CLASS = {
    connected: 'bg-secondary animate-pulse',
    reconnecting: 'bg-tertiary animate-pulse',
    disconnected: 'bg-error',
    connecting: 'bg-outline',
    idle: 'bg-outline'
  };
  var connection = 'connecting';
  var lastEventAt = 0;
  var openedOnce = false;
  function withToken(url) {
    var t = new URLSearchParams(window.location.search).get('t');
    if (t === null || t === '') return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(t);
  }
  function projectQuery(url) {
    if (project === '') return withToken(url);
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return withToken(url + sep + 'p=' + encodeURIComponent(project));
  }
  function badgeEl() { return document.getElementById('board-live-badge'); }
  function seedEpoch() {
    var badge = badgeEl();
    if (badge === null) return;
    var age = badge.querySelector('.board-live-age');
    if (age === null) return;
    var seeded = Number.parseInt(age.getAttribute('data-epoch') || '', 10);
    if (!Number.isNaN(seeded) && seeded > lastEventAt) lastEventAt = seeded;
  }
  function ageText(then, now) {
    var s = Math.max(0, Math.round((now - then) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function syncLive() {
    var badge = badgeEl();
    if (badge === null) return;
    var dot = badge.querySelector('.board-live-dot');
    var label = badge.querySelector('.board-live-label');
    var age = badge.querySelector('.board-live-age');
    if (dot !== null) dot.className = 'board-dot board-live-dot ' + (DOT_CLASS[connection] || DOT_CLASS.idle);
    badge.setAttribute('data-live', connection);
    var when = lastEventAt === 0 ? 'an unknown age' : ageText(lastEventAt, Date.now());
    var stateText = 'connecting…';
    var ageLine = 'no refresh has been confirmed yet';
    if (connection === 'connected') { stateText = 'live'; ageLine = 'updated ' + when; }
    else if (connection === 'reconnecting') { stateText = 'reconnecting…'; ageLine = 'showing data from ' + when; }
    else if (connection === 'disconnected') { stateText = 'not live'; ageLine = 'showing data from ' + when; }
    else if (connection === 'off') { stateText = 'live updates off'; ageLine = 'a still of the page as it loaded'; }
    if (label !== null) label.textContent = stateText;
    if (age !== null) age.textContent = ageLine;
  }
  function noteEvent() {
    lastEventAt = Date.now();
    syncLive();
  }
  function saveField(f) {
    return {
      id: f.id || '',
      draft: f.getAttribute('data-draft-body') || '',
      value: f.value,
      start: f.selectionStart,
      end: f.selectionEnd,
      scroll: f.scrollTop,
      focused: document.activeElement === f
    };
  }
  function captureState(target) {
    var result = { scroll: target.scrollTop, fields: [] };
    var nodes = target.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) result.fields.push(saveField(nodes[i]));
    return result;
  }
  function restoreField(target, s) {
    var selector = s.id !== '' ? '#' + s.id : '[data-draft-body="' + s.draft + '"]'; if (s.draft === '') selector = '#' + s.id;
    var f = target.querySelector(selector);
    if (f === null) return;
    f.value = s.value;
    if (typeof f.setSelectionRange === 'function' && typeof s.start === 'number' && typeof s.end === 'number') {
      f.setSelectionRange(s.start, s.end);
    }
    f.scrollTop = s.scroll;
    if (s.focused) f.focus();
  }
  function restoreState(target, state) {
    target.scrollTop = state.scroll;
    for (var i = 0; i < state.fields.length; i++) restoreField(target, state.fields[i]);
  }
  function insertNodes(target, doc) {
    var frag = document.createDocumentFragment();
    var child = doc.body.firstChild;
    while (child !== null) {
      var next = child.nextSibling;
      frag.appendChild(child);
      child = next;
    }
    target.replaceChildren(frag);
  }
  function updateElement(target, url, done) {
    var state = captureState(target);
    function finished() { if (typeof done === 'function') done(); }
    fetch(projectQuery(url))
      .then(function(res) { return res.text(); })
      .then(function(html) {
        var doc = parser.parseFromString(html, 'text/html');
        insertNodes(target, doc);
        restoreState(target, state);
        seedEpoch();
        syncLive();
        finished();
      })
      .catch(function() { finished(); /* the fragment will refresh on the next event */ });
  }
  // A burst of events used to mean a burst of fetches and a full DOM rebuild
  // for each one, on the main thread, with nothing between them. Thirty
  // lifecycle events in a second — which is an ordinary dispatch closing —
  // queued thirty rebuilds of the same column and the page stopped answering.
  //
  // Regions are collected instead and flushed once, de-duplicated: the same
  // region named ten times in a window is fetched once, and a region fetched
  // while its own request is still in flight is not fetched again.
  var pendingRegions = {};
  var flushHandle = null;
  var inFlight = {};
  var FLUSH_MS = 250;
  function flushRegions() {
    flushHandle = null;
    for (var name in pendingRegions) {
      if (pendingRegions[name] !== true) continue;
      delete pendingRegions[name];
      fetchRegion(name);
    }
    if (glancePending) { glancePending = false; fetchGlance(); }
  }
  function fetchRegion(name) {
    var id = REGIONS[name];
    if (id === undefined || inFlight[name] === true) return;
    var target = document.getElementById(id);
    if (target === null) return;
    inFlight[name] = true;
    updateElement(target, '/api/fragment?region=' + encodeURIComponent(name), function() {
      delete inFlight[name];
    });
  }
  function updateFragment(region) {
    var name = LEGACY_REGION[region] === undefined ? region : LEGACY_REGION[region];
    if (REGIONS[name] === undefined) return;
    pendingRegions[name] = true;
    if (flushHandle === null) flushHandle = setTimeout(flushRegions, FLUSH_MS);
  }
  // The glance page carries an element with id gl-body and subscribes to this
  // same stream. Its body is refreshed here so it goes through the same
  // parse-and-rebuild every fragment does. The board page has no such element
  // and skips it.
  // The glance page subscribes to the same stream and has the same problem.
  var glancePending = false;
  var glanceInFlight = false;
  function updateGlance() {
    if (document.getElementById('gl-body') === null) return;
    glancePending = true;
    if (flushHandle === null) flushHandle = setTimeout(flushRegions, FLUSH_MS);
  }
  function fetchGlance() {
    var target = document.getElementById('gl-body');
    if (target === null || glanceInFlight) return;
    glanceInFlight = true;
    updateElement(target, '/api/glance', function() { glanceInFlight = false; });
  }
  function refreshAll() {
    for (var region in REGIONS) updateFragment(region);
    updateGlance();
  }
  function applyEvent(data) {
    var parsed = null;
    try { parsed = JSON.parse(data); } catch (failed) { return; }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.fragments)) return;
    for (var i = 0; i < parsed.fragments.length; i++) updateFragment(parsed.fragments[i]);
    updateGlance();
  }
  seedEpoch();
  syncLive();
  // An open stream means the page never finishes loading, which is right for a
  // live board and wrong for anything trying to capture it: a headless browser
  // waits for a load that will not come. ?live=off renders the board as it
  // stands and says so on the badge rather than leaving it claiming to be live.
  if (new URLSearchParams(window.location.search).get('live') === 'off') {
    connection = 'off';
    syncLive();
    return;
  }
  var es = new EventSource(projectQuery('/api/live'));
  es.onopen = function() {
    var dropped = openedOnce;
    openedOnce = true;
    connection = 'connected';
    if (dropped) refreshAll();
    noteEvent();
  };
  es.onerror = function() {
    connection = es.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting';
    syncLive();
  };
  es.addEventListener('connected', function() { noteEvent(); });
  es.addEventListener('dispatch', function(e) { noteEvent(); applyEvent(e.data); });
  es.addEventListener('comment', function(e) { noteEvent(); applyEvent(e.data); });
  es.addEventListener('session', function(e) { noteEvent(); applyEvent(e.data); });
  es.addEventListener('orchestrator', function(e) { noteEvent(); applyEvent(e.data); });
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function() {
      connection = es.readyState === EventSource.OPEN ? 'connected' : 'reconnecting';
      syncLive();
    });
    window.addEventListener('offline', function() {
      connection = 'disconnected';
      syncLive();
    });
  }
  setInterval(syncLive, 1000);
})();`;
}

function sessionClientScript(): string {
  return String.raw`(function(){
var form=document.getElementById('board-session-form');
var list=document.getElementById('board-sessions');
var errorBox=document.getElementById('board-session-error');
var project=document.body===null?'':(document.body.getAttribute('data-project')||'');
function projectQuery(url){if(project==='')return url;var sep=url.indexOf('?')===-1?'?':'&';return url+sep+'p='+encodeURIComponent(project);}
function showError(text){if(errorBox===null)return;errorBox.textContent=text;errorBox.hidden=false;}
function clearError(){if(errorBox===null)return;errorBox.textContent='';errorBox.hidden=true;}
function errorText(r){
  var text='';
  var raw=r.body.replace(/^\s+|\s+$/g,'');
  if(raw!==''&&raw.charAt(0)!=='{'){
    try{
      var parsed=JSON.parse(raw);
      if(parsed!==null&&typeof parsed.error==='string'&&parsed.error!=='')text=parsed.error;
      if(parsed!==null&&typeof parsed.holder==='string'&&parsed.holder!=='')text+=' (held by '+parsed.holder+')';
    }catch(failed){
      text=raw.length<=240?raw:'';
    }
  }
  if(text==='')text='the server answered with status '+r.status;
  return text;
}
function post(url,payload,label){
  fetch(projectQuery(url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(res){return res.text().then(function(text){return {ok:res.ok,status:res.status,body:text};});})
    .then(function(r){
      if(!r.ok){showError(label+' failed: '+errorText(r));return;}
      clearError();
    })
    .catch(function(){showError(label+' failed: the request did not reach the server.');});
}
if(form!==null){
  form.addEventListener('submit',function(evt){
    evt.preventDefault();
    var select=form.querySelector('[name="agentId"]');
    if(select===null)return;
    var agentId=select.value;
    if(agentId===''){showError('Choose an agent.');return;}
    clearError();
    post('/api/session/start',{agentId:agentId},'Starting session');
  });
}
if(list!==null){
  list.addEventListener('click',function(evt){
    var btn=evt.target.closest('[data-action="stop-session"]');
    if(btn===null)return;
    var sessionId=btn.getAttribute('data-session');
    if(sessionId===null||sessionId==='')return;
    evt.preventDefault();
    clearError();
    post('/api/session/stop',{sessionId:sessionId},'Stopping session');
  });
}
})();`;
}

function drawerClientScript(): string {
  return String.raw`(function(){
var drawer=document.getElementById('board-drawer');
if(drawer===null)return;
if(typeof DOMParser!=='function')return;
var parser=new DOMParser();
var project=document.body===null?'':(document.body.getAttribute('data-project')||'');
function projectQuery(url){if(project==='')return url;var sep=url.indexOf('?')===-1?'?':'&';return url+sep+'p='+encodeURIComponent(project);}
var KEEP={A:1,BR:1,BUTTON:1,CODE:1,DETAILS:1,DIV:1,EM:1,H3:1,H4:1,HEADER:1,LI:1,P:1,SECTION:1,SPAN:1,STRONG:1,SUMMARY:1,TIME:1,UL:1};
var DROP={BASE:1,EMBED:1,FORM:1,FRAME:1,FRAMESET:1,IFRAME:1,INPUT:1,LINK:1,MATH:1,META:1,NOSCRIPT:1,OBJECT:1,SCRIPT:1,SELECT:1,STYLE:1,SVG:1,TEMPLATE:1,TEXTAREA:1,TITLE:1};
function attrAllowed(tag,name,value){
  if(name.indexOf('on')===0)return false;
  if(name==='class'||name==='role'||name==='datetime'||name==='title'||name==='rel')return true;
  if(name.indexOf('data-')===0||name.indexOf('aria-')===0)return true;
  if(name==='type'&&tag==='button')return true;
  if(name==='href'&&tag==='a'){
    var v=value.replace(/\s+/g,'').toLowerCase();
    return v.charAt(0)==='#'||v.indexOf('./')===0||v.indexOf('../')===0||(v.charAt(0)==='/'&&v.charAt(1)!=='/');
  }
  return false;
}
function clean(node){
  if(node.nodeType===3)return document.createTextNode(node.nodeValue||'');
  if(node.nodeType!==1)return null;
  var tag=node.tagName.toUpperCase();
  if(DROP[tag]===1)return null;
  var kids=document.createDocumentFragment();
  var child=node.firstChild;
  while(child!==null){
    var next=child.nextSibling;
    var kept=clean(child);
    if(kept!==null)kids.appendChild(kept);
    child=next;
  }
  if(KEEP[tag]!==1)return kids;
  var el=document.createElement(tag.toLowerCase());
  var attrs=node.attributes;
  for(var i=0;i<attrs.length;i++){
    var a=attrs.item(i);
    if(a!==null&&attrAllowed(tag.toLowerCase(),a.name,a.value))el.setAttribute(a.name,a.value);
  }
  el.appendChild(kids);
  return el;
}
var selected=null;
var pending=0;
// The things wanting a person live behind the bell. As a column they only
// accumulated, because nothing could leave one.
function alertsPanel(){ return document.getElementById('board-alerts'); }
function toggleAlerts(){ var p=alertsPanel(); if(p===null)return; p.hidden=!p.hidden; syncBell(); }
function closeAlerts(){ var p=alertsPanel(); if(p===null)return; p.hidden=true; syncBell(); }
function syncBell(){
  var p=alertsPanel();
  var btn=document.querySelector('.board-bell');
  if(btn!==null&&p!==null)btn.setAttribute('aria-pressed',p.hidden?'false':'true');
  var count=document.getElementById('board-bell-count');
  var body=document.getElementById('board-decisions');
  if(count===null||body===null)return;
  var n=body.querySelectorAll('.board-decision-card').length;
  count.textContent=String(n);
  count.setAttribute('data-empty',n===0?'true':'false');
}
if(typeof document.addEventListener==='function')document.addEventListener('DOMContentLoaded',syncBell);
syncBell();
function setDrawerSubject(text){
  var el=document.getElementById('board-drawer-subject');
  if(el!==null)el.textContent=text;
}
function openDrawer(){ if(drawer!==null) drawer.open=true; }
function resetTabs(){ diffLoaded=''; setTab('info'); }
function empty(text){
  var wrap=document.createElement('div');
  wrap.className='drawer';
  var p=document.createElement('p');
  p.className='drawer-empty';
  p.textContent=text;
  wrap.appendChild(p);
  return wrap;
}
function refused(text){
  var wrap=document.createElement('div');
  wrap.className='drawer drawer-refused';
  wrap.setAttribute('role','status');
  var p=document.createElement('p');
  var s=document.createElement('strong');
  s.textContent='The drawer is not available. ';
  p.appendChild(s);
  p.appendChild(document.createTextNode(text));
  wrap.appendChild(p);
  return wrap;
}
function drawerBody(){
  var body=document.getElementById('board-drawer-body');
  return body===null?document.body:body;
}
function present(node){
  if(node===null){ present(refused('the server returned an empty fragment.')); return; }
  var body=drawerBody();
  body.replaceChildren(node);
  body.scrollTop=0;
}
function errorText(r){
  var text='';
  var raw=r.body.replace(/^\s+|\s+$/g,'');
  if(raw!==''&&raw.charAt(0)==='{'){
    try{
      var parsed=JSON.parse(raw);
      if(parsed!==null&&typeof parsed==='object'&&typeof parsed.error==='string'&&parsed.error!=='')text=parsed.error;
    }catch(failed){
      text=raw.length<=240?raw:'';
    }
  }
  if(text==='')text='the server answered with status '+r.status;
  return text;
}
function insert(html){
  var doc=parser.parseFromString(html,'text/html');
  var root=doc.body.firstChild;
  if(root===null){ present(refused('the server returned an empty fragment.')); return; }
  var node=clean(root);
  if(node===null){ present(refused('the server returned an empty fragment.')); return; }
  if(node.nodeType!==1){
    var wrap=document.createElement('div');
    wrap.className='drawer';
    wrap.appendChild(node);
    node=wrap;
  }
  present(node);
}
var diffPane=document.getElementById('board-drawer-diff');
var diffLoaded='';

function setTab(name){
  if(drawer===null)return;
  drawer.setAttribute('data-tab',name);
  var body=document.getElementById('board-drawer-body');
  if(body!==null)body.hidden=name!=='info';
  if(diffPane!==null)diffPane.hidden=name!=='diff';
  var tabs=document.querySelectorAll('[data-action="drawer-tab"]');
  for(var i=0;i<tabs.length;i++)tabs[i].setAttribute('aria-pressed',tabs[i].getAttribute('data-tab')===name?'true':'false');
  if(name==='diff')loadDiff();
}
// Full screen is not decoration — a diff read in a 60vh strip is not read.
function toggleFull(btn){
  if(drawer===null)return;
  var full=drawer.classList.toggle('board-drawer--full');
  if(btn!==null){ btn.setAttribute('aria-pressed',full?'true':'false'); btn.textContent=full?'Restore':'Full screen'; }
}

// A spec when the selected card has one, otherwise the dispatch itself. Most
// dispatches are one-off briefs naming no spec, and the tab refused for every
// one of them even though the record knows exactly what they changed.
function diffSubject(){
  if(drawer===null)return null;
  var card=document.querySelector('.board-card[data-selected="true"]');
  if(card===null)return null;
  var spec=card.getAttribute('data-spec')||'';
  if(spec!=='')return {kind:'spec',id:spec};
  var dispatch=card.getAttribute('data-dispatch')||'';
  if(dispatch!=='')return {kind:'dispatch',id:dispatch};
  return null;
}
function diffLine(entry){
  var row=document.createElement('div');
  row.className='board-diffline board-diffline--'+entry.kind;
  row.textContent=entry.text;
  return row;
}
function renderDiff(data, notice){
  if(diffPane===null)return;
  var wrap=document.createElement('div');
  wrap.className='board-diffview';
  if(typeof notice==='string' && notice!==''){
    var note=document.createElement('p');
    note.className='drawer-note';
    note.textContent=notice;
    wrap.appendChild(note);
  }
  var head=document.createElement('p');
  head.className='board-diff-basis font-mono-sm';
  head.textContent=data.files.length+' file'+(data.files.length===1?'':'s')+' against '+data.base;
  wrap.appendChild(head);
  if(typeof data.error==='string'&&data.error!==''){
    var err=document.createElement('p');
    err.className='drawer-empty';
    err.textContent='git refused the diff: '+data.error;
    wrap.appendChild(err);
  }
  if(data.files.length===0&&(typeof data.error!=='string'||data.error==='')){
    var none=document.createElement('p');
    none.className='drawer-empty';
    none.textContent='Nothing this spec touched differs from '+data.base+'. Either it has already landed, or its dispatches recorded no changed paths.';
    wrap.appendChild(none);
  }
  for(var i=0;i<data.files.length;i++){
    var file=data.files[i];
    var section=document.createElement('details');
    section.className='board-difffile';
    section.open=data.files.length<=6;
    var sum=document.createElement('summary');
    sum.className='board-difffile-head font-mono-sm';
    var name=document.createElement('span');
    name.textContent=file.path;
    var counts=document.createElement('span');
    counts.className='board-difffile-counts';
    counts.textContent='+'+file.added+' \u2212'+file.removed;
    sum.appendChild(name);
    sum.appendChild(counts);
    section.appendChild(sum);
    var lines=document.createElement('div');
    lines.className='board-difflines';
    for(var j=0;j<file.lines.length;j++)lines.appendChild(diffLine(file.lines[j]));
    section.appendChild(lines);
    if(file.bodyTruncated===true){
      var more=document.createElement('p');
      more.className='drawer-note';
      more.textContent='The counts above are complete; the rest of this file’s lines are not shown.';
      section.appendChild(more);
    }
    wrap.appendChild(section);
  }
  if(data.truncated===true){
    var cut=document.createElement('p');
    cut.className='drawer-note';
    cut.textContent='Some file bodies were cut to keep this readable. Every file and its counts are here.';
    wrap.appendChild(cut);
  }
  diffPane.replaceChildren(wrap);
}
function loadDiff(){
  if(diffPane===null)return;
  var subject=diffSubject();
  if(subject===null){
    diffPane.replaceChildren(empty('Select a card to see everything it changed against the base branch.'));
    diffLoaded='';
    return;
  }
  var spec=subject.kind+':'+subject.id;
  if(diffLoaded===spec)return;
  diffLoaded=spec;
  diffPane.replaceChildren(empty('Starting difit for '+subject.id+'\u2026'));

  var instanceId='branch';
  var startUrl=projectQuery('/api/difit/start');
  var diffUrl=projectQuery('/api/spec-diff?'+subject.kind+'='+encodeURIComponent(subject.id));
  var diffData=null;
  var diffReady=false;
  var startDone=false;
  var startOk=false;
  var startMessage='';

  function tryRender(){
    if(!startDone || startOk || !diffReady) return;
    if(diffData===null){
      diffPane.replaceChildren(refused(startMessage + ' The built-in diff could not be loaded.'));
      diffLoaded='';
      return;
    }
    renderDiff(diffData, startMessage || 'Showing the built-in diff because difit is not available.');
  }

  function startFrame(){
    if(diffPane===null || diffLoaded!==spec) return;
    var wrap=document.createElement('div');
    wrap.className='board-diffview';
    var note=document.createElement('p');
    note.className='drawer-note';
    note.textContent='Showing difit.';
    var frame=document.createElement('iframe');
    frame.className='board-difit-frame';
    frame.title='Line-level diff';
    frame.src=projectQuery('/frame?d='+encodeURIComponent(instanceId));
    wrap.appendChild(note);
    wrap.appendChild(frame);
    diffPane.replaceChildren(wrap);
    frame.addEventListener('load',function(){
      if(diffLoaded!==spec) return;
      var doc=null;
      try{ doc=frame.contentDocument || (frame.contentWindow && frame.contentWindow.document); }catch(failed){}
      if(doc!==null && doc.body!==null && (doc.body.textContent||'').indexOf('difit is not running')>=0){
        startOk=false;
        startMessage='difit stopped before the page loaded. Start it again, or install it with \'npm install -g difit\' if it is missing.';
        tryRender();
      }
    });
  }

  fetch(startUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:instanceId})})
    .then(function(res){ return res.json().then(function(data){ return {ok:res.ok,data:data}; }); })
    .then(function(r){
      if(diffLoaded!==spec)return;
      startDone=true;
      if(r.ok && r.data!==null && typeof r.data==='object' && (r.data.started===true || r.data.alreadyRunning===true)){
        startOk=true;
        startFrame();
        return;
      }
      startMessage='difit is not installed or did not start. Install it with \'npm install -g difit\' or start it manually on port 4383, then try again.';
      if(!r.ok && r.data!==null && typeof r.data==='object' && typeof r.data.error==='string' && r.data.error!==''){
        startMessage=r.data.error+'. '+startMessage;
      }
      if(!diffReady){
        diffPane.replaceChildren(empty('difit is not available; loading the built-in diff\u2026'));
      }
      tryRender();
    })
    .catch(function(){
      if(diffLoaded!==spec)return;
      startDone=true;
      startMessage='the difit start request did not reach the server.';
      if(!diffReady){
        diffPane.replaceChildren(empty('difit is not available; loading the built-in diff\u2026'));
      }
      tryRender();
    });

  fetch(diffUrl)
    .then(function(res){ return res.json().then(function(data){ return {ok:res.ok,data:data}; }); })
    .then(function(r){
      if(diffLoaded!==spec)return;
      if(!r.ok || r.data===null || typeof r.data!=='object' || !Array.isArray(r.data.files)){
        diffData=null;
      }else{
        diffData=r.data;
      }
      diffReady=true;
      tryRender();
    })
    .catch(function(){
      if(diffLoaded!==spec)return;
      diffData=null;
      diffReady=true;
      tryRender();
    });
}
function urlFor(id){ return projectQuery('${BOARD_DRAWER_PATH}'+'?dispatch='+encodeURIComponent(id)); }
function selectSpec(card,specId){
  if(selected!==null&&selected!==card)selected.removeAttribute('data-selected');
  var prevSel=document.querySelector('.board-card[data-selected="true"]');
  if(prevSel!==null&&prevSel!==card)prevSel.removeAttribute('data-selected');
  card.setAttribute('data-selected','true');
  selected=card;
  pending+=1;
  var ticket=pending;
  setDrawerSubject(specId);
  openDrawer();
  resetTabs();
  present(empty('Loading the change for '+specId+'…'));
  drawer.setAttribute('aria-busy','true');
  fetch(specUrlFor(specId))
    .then(function(res){ return res.text().then(function(text){ return {ok:res.ok,status:res.status,body:text}; }); })
    .then(function(r){
      if(ticket!==pending)return;
      drawer.setAttribute('aria-busy','false');
      if(r.ok){ insert(r.body); } else { present(refused(errorText(r))); }
    })
    .catch(function(){ if(ticket!==pending)return; drawer.setAttribute('aria-busy','false'); present(refused('the request did not reach the server.')); });
}
// A card scoped to a spec opens the spec's whole change, which is what a pull
// request would carry.
function specUrlFor(id){ return projectQuery('${BOARD_DRAWER_PATH}'+'?spec='+encodeURIComponent(id)); }
function select(card,id){
  var previous=drawer.getAttribute('data-selected');
  if(previous!==null){
    var prev=document.querySelector('.board-card[data-selected="true"]');
    if(prev!==null) prev.removeAttribute('data-selected');
  }
  if(card!==null){
    card.setAttribute('data-selected','true');
    drawer.setAttribute('data-selected',id);
  }
  pending+=1;
  var ticket=pending;
  selected=card;
  setDrawerSubject(id);
  openDrawer();
  resetTabs();
  present(empty('Loading the drawer for '+id+'…'));
  drawer.setAttribute('aria-busy','true');
  fetch(urlFor(id))
    .then(function(res){ return res.text().then(function(text){ return {ok:res.ok,status:res.status,body:text}; }); })
    .then(function(r){
      if(ticket!==pending)return;
      drawer.setAttribute('aria-busy','false');
      if(r.ok){ insert(r.body); } else { present(refused(errorText(r))); }
    })
    .catch(function(err){ if(ticket!==pending)return; drawer.setAttribute('aria-busy','false'); present(refused('the request did not reach the server.')); });
}
function inspectLane(id){
  drawer.setAttribute('aria-busy','false');
  present(refused('Lane '+id+' is out of quota. The cards that run on it will stop moving until the lane resets; acknowledge the alert to clear it from this column.'));
  openDrawer();
}
function decrementColumnCount(column){
  if(column===null)return;
  var el=column.querySelector('.board-col-count');
  if(el===null)return;
  var current=Number.parseInt((el.textContent||'0').replace(/\D/g,''),10)||0;
  var n=Math.max(0,current-1);
  el.textContent=n+' card'+(n===1?'':'s');
}
function setNeedsYouEmpty(list){
  if(list===null)return;
  var p=document.createElement('p');
  p.className='board-empty';
  p.textContent='Nothing is waiting on you. A dispatch that failed, an unanswered note, or a lane out of quota would appear here.';
  list.appendChild(p);
}
function removeCard(card){
  if(card===null)return;
  var column=card.closest('.board-column');
  var list=card.parentNode;
  card.remove();
  decrementColumnCount(column);
  if(list!==null && list.children.length===0 && column!==null && column.getAttribute('data-column')==='needs-you'){ setNeedsYouEmpty(list); }
}
function ack(itemId, button){
  if(button.disabled)return;
  button.disabled=true;
  fetch(projectQuery('${BOARD_ACK_PATH}'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemId:itemId})})
    .then(function(res){ return res.text().then(function(text){ return {ok:res.ok,status:res.status,body:text}; }); })
    .then(function(r){
      if(!r.ok){ button.disabled=false; button.textContent='Acknowledge failed: '+errorText(r); return; }
      var card=button.closest('.board-card, .board-decision-card');
      if(card!==null) removeCard(card);
    })
    .catch(function(){ button.disabled=false; button.textContent='Acknowledge failed: the request did not reach the server.'; });
}
// Acknowledging one at a time is unusable when the column has accumulated for
// weeks. Each still goes through the same endpoint; this only saves the
// clicking, and stops at the first refusal rather than pretending the rest
// succeeded.
function ackAll(button){
  if(button.disabled)return;
  var body=document.getElementById('board-decisions');
  if(body===null)return;
  var buttons=[];
  var found=body.querySelectorAll('[data-action="ack"]');
  for(var i=0;i<found.length;i++)buttons.push(found[i]);
  if(buttons.length===0)return;
  button.disabled=true;
  var original=button.textContent;
  var done=0;
  function next(){
    if(done>=buttons.length){ button.disabled=false; button.textContent=original; syncBell(); return; }
    var b=buttons[done];
    done+=1;
    var id=b.getAttribute('data-item-id');
    if(id===null||id===''){ next(); return; }
    button.textContent='Clearing '+done+' of '+buttons.length+'…';
    fetch(projectQuery('${BOARD_ACK_PATH}'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemId:id})})
      .then(function(res){
        if(!res.ok){ button.disabled=false; button.textContent='Cleared '+(done-1)+'; the rest were refused'; return; }
        var card=b.closest('.board-card, .board-decision-card');
        if(card!==null)removeCard(card);
        next();
      })
      .catch(function(){ button.disabled=false; button.textContent='Cleared '+(done-1)+'; the request did not reach the server'; });
  }
  next();
}
document.addEventListener('click',function(e){
  var t0=e.target;
  var actionEl0=t0===null||typeof t0.closest!=='function'?null:t0.closest('[data-action]');
  if(actionEl0!==null){
    var action0=actionEl0.getAttribute('data-action');
    if(action0==='ack-all'){e.preventDefault();ackAll(actionEl0);return;}

    if(action0==='drawer-tab'){e.preventDefault();setTab(actionEl0.getAttribute('data-tab')||'info');return;}
    if(action0==='drawer-full'){e.preventDefault();toggleFull(actionEl0);return;}
    if(action0==='alerts'){e.preventDefault();toggleAlerts();return;}
    if(action0==='close-alerts'){e.preventDefault();closeAlerts();return;}
  }
  var t=e.target;
  var actionEl=t.closest('[data-action]');
  if(actionEl!==null){
    var action=actionEl.getAttribute('data-action');
    if(action==='ack'){
      var itemId=actionEl.getAttribute('data-item-id');
      if(itemId!==null&&itemId!==''){ e.preventDefault(); ack(itemId,actionEl); }
      return;
    }
    if(action==='inspect'){
      var card=actionEl.closest('.board-card');
      var lane=actionEl.getAttribute('data-lane');
      if(card!==null){
        var id=card.getAttribute('data-dispatch');
        if(id!==null&&id!==''){ e.preventDefault(); select(card,id); }
        return;
      }
      if(lane!==null&&lane!==''){ e.preventDefault(); inspectLane(lane); return; }
      return;
    }
    return;
  }
  if(t.closest('a,button'))return;
  var card=t.closest('.board-card');
  if(card===null)return;
  // A To Do card is a spec, and opening it shows everything that spec changed.
  var spec=card.getAttribute('data-spec');
  if(spec!==null&&spec!==''){ selectSpec(card,spec); return; }
  var id=card.getAttribute('data-dispatch');
  if(id===null||id==='')return;
  select(card,id);
});

var projectSelect = document.querySelector('.board-project-filter');
function applyProjectFilter() {
  if (projectSelect === null) return;
  var p = projectSelect.value;
  var cols = [
    { id: 'board-todo-body', emptyId: 'todo-empty', emptyText: 'No tasks match the project filter "'+p+'".', origText: 'No spec has work left that nothing is running against.' },
    { id: 'board-in-progress-body', emptyId: 'in-progress-empty', emptyText: 'No dispatches match the project filter "'+p+'".', origText: 'Nothing is running — a dispatch appears here from the moment it opens until it closes.' },
    { id: 'board-done-body', emptyId: 'done-empty', emptyText: 'No done dispatches match the project filter "'+p+'".', origText: 'No dispatch has finished and been acknowledged yet.' }
  ];
  for (var i = 0; i < cols.length; i++) {
    var col = document.getElementById(cols[i].id);
    if (col === null) continue;
    var cards = col.querySelectorAll('.board-card, .board-todo');
    var visible = 0;
    for (var j = 0; j < cards.length; j++) {
      var cardProj = cards[j].getAttribute('data-project') || '';
      var show = p === '' || cardProj === p;
      cards[j].hidden = !show;
      if (show) visible++;
    }
    var columnEl = col.closest('.board-column');
    if (columnEl !== null) {
      var countEl = columnEl.querySelector('.board-col-count');
      if (countEl !== null) countEl.textContent = visible + ' card' + (visible === 1 ? '' : 's');
    }
    
    var existingEmpty = col.querySelector('.board-quiet');
    if (visible === 0) {
      if (existingEmpty === null) {
        var quiet = document.createElement('p');
        quiet.className = 'board-quiet font-mono-sm';
        quiet.textContent = p === '' ? cols[i].origText : cols[i].emptyText;
        col.appendChild(quiet);
      } else {
        existingEmpty.textContent = p === '' ? cols[i].origText : cols[i].emptyText;
        existingEmpty.hidden = false;
      }
    } else {
      if (existingEmpty !== null) existingEmpty.hidden = true;
    }
  }
}

if (projectSelect !== null) {
  var params = new URLSearchParams(window.location.search);
  var initP = params.get('project');
  if (initP !== null) {
    projectSelect.value = initP;
  }
  applyProjectFilter();
  projectSelect.addEventListener('change', function() {
    var url = new URL(window.location.href);
    if (this.value === '') {
      url.searchParams.delete('project');
    } else {
      url.searchParams.set('project', this.value);
    }
    window.history.replaceState({}, '', url.toString());
    applyProjectFilter();
  });
}
// Apply filter after fragments update using MutationObserver
if (typeof MutationObserver !== 'undefined' && projectSelect !== null) {
  var observer = new MutationObserver(function() {
    applyProjectFilter();
  });
  var main = document.querySelector('.board-main');
  if (main !== null) {
    observer.observe(main, { childList: true, subtree: true });
  }
}
})();`;
}

function dispatchFormClientScript(): string {
  return String.raw`(function(){
var form=document.getElementById('board-form');
var result=document.getElementById('board-form-result');
var project=document.body===null?'':(document.body.getAttribute('data-project')||'');
function projectQuery(url){if(project==='')return url;var sep=url.indexOf('?')===-1?'?':'&';return url+sep+'p='+encodeURIComponent(project);}
function showResult(text,ok){ if(result===null)return; result.textContent=text; result.className='board-form-result'+(ok?' board-form-result--ok':' board-form-result--error'); }
function resetResult(){ if(result===null)return; result.textContent=''; result.className='board-form-result'; }
var dispatchBtn=document.querySelector('[data-action="dispatch"]');
if(dispatchBtn!==null){
  dispatchBtn.addEventListener('click',function(){ if(form!==null){ form.hidden=false; var first=form.querySelector('textarea,input,select'); if(first!==null) first.focus(); } });
}
if(form!==null){
  var closeBtn=form.querySelector('[data-action="close-dispatch-form"]');
  if(closeBtn!==null) closeBtn.addEventListener('click',function(){ form.hidden=true; resetResult(); });
  form.addEventListener('submit',function(evt){
    evt.preventDefault();
    if(form===null)return;
    var body = Object.fromEntries(new FormData(form));
    var task=body.task;
    var taskFile=body.taskFile;
    if((typeof task!=='string' || task==='') && (typeof taskFile!=='string' || taskFile==='')){ showResult('Write a task or choose a task file.',false); return; }
    fetch(projectQuery('/api/dispatch'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(res){ return res.text().then(function(text){ return {ok:res.ok,status:res.status,body:text}; }); })
      .then(function(r){
        if(!r.ok){ showResult(r.body.replace(/^\s+|\s+$/g,'').slice(0,240) || 'Dispatch failed with status '+r.status, false); return; }
        form.hidden=true;
        resetResult();
        form.reset();
      })
      .catch(function(){ showResult('Dispatch failed: the request did not reach the server.',false); });
  });
}
document.addEventListener('click',function(evt){
  var btn=evt.target.closest('[data-action]');
  if(btn===null)return;
  var action=btn.getAttribute('data-action');
  if(action!=='stop' && action!=='abandon' && action!=='retry')return;
  var id=btn.getAttribute('data-dispatch');
  if(id===null || id==='')return;
  evt.preventDefault();
  var message=action==='stop'?'Stop this dispatch? It will be interrupted where it is.':action==='abandon'?'Abandon this dispatch? It will be recorded as did-not-complete.':'Retry this dispatch? A new attempt will be created for the same task.';
  if(!window.confirm(message))return;
  fetch(projectQuery('/api/'+action),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dispatchId:id})})
    .then(function(res){ return res.text().then(function(text){ return {ok:res.ok,status:res.status,body:text}; }); })
    .then(function(r){ if(!r.ok){ window.alert((action==='stop'?'Stop':action==='abandon'?'Abandon':'Retry')+' failed: '+(r.body.replace(/^\s+|\s+$/g,'').slice(0,240) || 'status '+r.status)); } })
    .catch(function(){ window.alert((action==='stop'?'Stop':action==='abandon'?'Abandon':'Retry')+' failed: the request did not reach the server.'); });
});
})();`;
}

function noteClientScript(): string {
  return String.raw`(function(){
var form=document.getElementById('board-note-form');
if(form===null)return;
var project=document.body===null?'':(document.body.getAttribute('data-project')||'');
var body=document.getElementById('board-note-body');
var errorBox=document.getElementById('board-note-error');
var replying=document.getElementById('board-note-replying');
var parent=document.getElementById('board-note-parent');
var replyTarget=null;
function projectQuery(url){if(project==='')return url;var sep=url.indexOf('?')===-1?'?':'&';return url+sep+'p='+encodeURIComponent(project);}
function showError(text){if(errorBox===null)return;errorBox.textContent=text;errorBox.hidden=false;}
function clearError(){if(errorBox===null)return;errorBox.textContent='';errorBox.hidden=true;}
function errorText(r){
  var text='';
  var raw=r.body.replace(/^\s+|\s+$/g,'');
  if(raw!==''&&raw.charAt(0)==='{'){
    try{
      var parsed=JSON.parse(raw);
      if(parsed!==null&&typeof parsed==='object'&&typeof parsed.error==='string'&&parsed.error!=='')text=parsed.error;
    }catch(failed){
      text=raw.length<=240?raw:'';
    }
  }
  if(text==='')text='the server answered with status '+r.status;
  return text;
}
function resetCompose(){if(body!==null)body.value='';replyTarget=null;if(replying!==null)replying.hidden=true;if(parent!==null)parent.textContent='';clearError();}
function post(url,payload,label){
  return fetch(projectQuery(url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(res){return res.text().then(function(text){return {ok:res.ok,status:res.status,body:text};});})
    .then(function(r){if(!r.ok){showError(label+' failed: '+errorText(r));return false;}clearError();return true;})
    .catch(function(){showError(label+' failed: the request did not reach the server.');return false;});
}
function idOf(el,name){var raw=el.getAttribute(name);if(raw===null||raw==='')return null;var id=Number.parseInt(raw,10);return Number.isNaN(id)?null:id;}
form.addEventListener('submit',function(evt){
  evt.preventDefault();
  if(body===null||typeof body.value!=='string')return;
  var text=body.value.replace(/^\s+|\s+$/g,'');
  if(text===''){showError('The note is empty.');return;}
  var payload={body:text};
  if(replyTarget!==null)payload.replyTo=replyTarget;
  var orchBox=document.getElementById('board-note-orchestrator');
  if(orchBox!==null&&orchBox.checked)payload.orchestrator=true;
  post('/api/comment',payload,'Adding note').then(function(ok){
    if(ok){
      resetCompose();
      if(orchBox!==null)orchBox.checked=false;
    }
  });
});
document.addEventListener('click',function(evt){
  var t=evt.target;
  var actionEl=t.closest('[data-action]');
  if(actionEl===null)return;
  var action=actionEl.getAttribute('data-action');
  if(action==='note-reply'){
    var id=idOf(actionEl,'data-note');
    if(id===null)return;
    evt.preventDefault();
    replyTarget=id;
    if(replying!==null)replying.hidden=false;
    if(parent!==null)parent.textContent='#'+id;
    if(body!==null)body.focus();
    return;
  }
  if(action==='note-reply-cancel'){evt.preventDefault();resetCompose();return;}
  if(action==='note-status'){
    var noteId=idOf(actionEl,'data-note');
    var status=actionEl.getAttribute('data-status');
    if(noteId===null||status===null||status==='')return;
    evt.preventDefault();
    post('/api/comment/status',{id:noteId,status:status},'Updating note').then(function(ok){
      if(!ok)return;
      actionEl.textContent=status==='addressed'?'Reopen':'Mark Addressed';
      actionEl.setAttribute('data-status',status==='addressed'?'open':'addressed');
    });
    return;
  }
  if(action==='draft-save'){
    var draftId=idOf(actionEl,'data-draft');
    if(draftId===null)return;
    var ta=document.querySelector('[data-draft-body="'+draftId+'"]');
    if(ta===null)return;
    evt.preventDefault();
    post('/api/comment/draft',{id:draftId,body:ta.value},'Saving draft');
    return;
  }
  if(action==='draft-discard'){
    var draftId=idOf(actionEl,'data-draft');
    if(draftId===null)return;
    evt.preventDefault();
    post('/api/comment/draft/discard',{id:draftId},'Discarding draft').then(function(ok){
      if(!ok)return;
      var draft=document.querySelector('[data-draft="'+draftId+'"]');
      if(draft!==null) draft.remove();
    });
    return;
  }
  if(action==='send-review'){
    evt.preventDefault();
    post('/api/comment/send',{},'Sending review');
    return;
  }
});
})();`;
}

function explorerClientScript(): string {
  return String.raw`(function(){
// Guard on the body, not the wrapper. When the wrapper's id changed under it
// this block returned at its first line and the file tree, the editor and the
// preview were all silently dead.
var body=document.getElementById('board-explorer-body');
if(body===null)return;
var explorer=document.getElementById('board-explorer');
var project=document.body===null?'':(document.body.getAttribute('data-project')||'');
var holder='explorer-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
var selectedPath=null;
var treeRoot=null;
var editorPane=null;
var editorModal=null;
var monacoHost=null;
var monacoEditor=null;
var monaco=null;
var monacoLoading=false;
var monacoWaiters=[];
var previewPane=null;
var previewBtn=null;
var editorText=null;
var fileBar=null;
var saveBtn=null;
var findingsPanel=null;
var findingsList=null;
var statusLine=null;
var loadTicket=0;

function withToken(url){
  var t=new URLSearchParams(window.location.search).get('t');
  if(t===null||t==='')return url;
  return url+(url.indexOf('?')===-1?'?':'&')+'t='+encodeURIComponent(t);
}
function projectQuery(url){
  if(project==='')return withToken(url);
  var sep=url.indexOf('?')===-1?'?':'&';
  return withToken(url+sep+'p='+encodeURIComponent(project));
}

// Closed, the explorer is a 36px rail: it gives the board back the width
// rather than holding 320px whether or not anyone is reading a file.
function syncExplorerPadding(){
  if(explorer===null)return;
  var main=document.querySelector('.board-main');
  if(main!==null){
    if(explorer.open) main.classList.add('board-main--explorer');
    else main.classList.remove('board-main--explorer');
  }
  // The page reserves the rail's width, so the header stops running underneath
  // it. The class carries the state rather than :has(), which the stylesheet
  // would otherwise depend on being supported.
  if(document.body!==null){
    if(explorer.open) document.body.classList.add('board-explorer-open');
    else document.body.classList.remove('board-explorer-open');
  }
  var btn=document.querySelector('.board-explorer-toggle');
  if(btn!==null)btn.setAttribute('aria-pressed',explorer.open?'true':'false');
}
function toggleExplorer(){ if(explorer!==null){ explorer.open=!explorer.open; syncExplorerPadding(); } }
function openExplorer(){ if(explorer!==null&&!explorer.open){ explorer.open=true; syncExplorerPadding(); } }
if(explorer!==null&&typeof explorer.addEventListener==='function') explorer.addEventListener('toggle',syncExplorerPadding);
syncExplorerPadding();

function setStatus(text,ok){
  if(statusLine===null)return;
  statusLine.textContent=text;
  statusLine.className='board-explorer-status'+(ok===false?' board-explorer-status--error':ok===true?' board-explorer-status--ok':'');
}
function empty(text){
  var p=document.createElement('p');
  p.className='board-empty';
  p.textContent=text;
  return p;
}
function errorText(r){
  var text='';
  var raw=(r.body||'').replace(/^\s+|\s+$/g,'');
  if(raw!==''&&raw.charAt(0)==='{'){
    try{
      var parsed=JSON.parse(raw);
      if(parsed!==null&&typeof parsed==='object'&&typeof parsed.error==='string'&&parsed.error!=='')text=parsed.error;
      if(text===''&&parsed!==null&&typeof parsed==='object'&&typeof parsed.message==='string'&&parsed.message!=='')text=parsed.message;
    }catch(failed){
      text=raw.length<=240?raw:'';
    }
  }
  if(text==='')text='the server answered with status '+r.status;
  return text;
}
function buildEditor(){
  if(editorPane!==null)return;
  // A centred <dialog> rather than a column inside the 320px rail: the rail is
  // for finding a file, and writing in it is cramped.
  editorModal=document.createElement('dialog');
  editorModal.className='board-modal';
  editorModal.setAttribute('aria-label','File editor');
  var pane=document.createElement('div');
  pane.className='board-explorer-editor board-modal-panel';
  fileBar=document.createElement('div');
  fileBar.className='board-explorer-file-bar';
  var path=document.createElement('span');
  path.className='board-explorer-file-path font-mono-sm';
  path.id='board-explorer-file-path';
  fileBar.appendChild(path);
  var actions=document.createElement('div');
  actions.className='board-explorer-file-actions';
  saveBtn=document.createElement('button');
  saveBtn.className='cyv-btn cyv-btn-primary board-explorer-save';
  saveBtn.type='button';
  saveBtn.textContent='Save';
  saveBtn.setAttribute('aria-label','Save the open file');
  previewBtn=document.createElement('button');
  previewBtn.className='cyv-btn cyv-btn-secondary board-explorer-preview-toggle';
  previewBtn.type='button';
  previewBtn.textContent='Preview';
  previewBtn.hidden=true;
  previewBtn.setAttribute('aria-pressed','false');
  var closeBtn=document.createElement('button');
  closeBtn.className='cyv-btn cyv-btn-secondary board-modal-close';
  closeBtn.type='button';
  closeBtn.textContent='Close';
  closeBtn.setAttribute('aria-label','Close the editor');
  actions.appendChild(previewBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(closeBtn);
  fileBar.appendChild(actions);
  pane.appendChild(fileBar);
  previewBtn.addEventListener('click',function(){togglePreview();});
  closeBtn.addEventListener('click',function(){closeEditor();});

  editorText=document.createElement('textarea');
  editorText.className='board-explorer-editor-text font-mono';
  editorText.setAttribute('aria-label','File editor');
  editorText.spellcheck=false;
  pane.appendChild(editorText);

  previewPane=document.createElement('div');
  previewPane.className='board-explorer-preview';
  previewPane.hidden=true;
  pane.appendChild(previewPane);

  // Where the editor mounts. The textarea above stays: it is what save reads,
  // and it is what a person gets if the editor never loads.
  monacoHost=document.createElement('div');
  monacoHost.className='board-monaco';
  monacoHost.hidden=true;
  pane.appendChild(monacoHost);

  findingsPanel=document.createElement('div');
  findingsPanel.className='board-explorer-findings';
  findingsPanel.setAttribute('role','region');
  findingsPanel.setAttribute('aria-label','Check findings');
  findingsPanel.hidden=true;
  var findingsHead=document.createElement('h3');
  findingsHead.className='board-explorer-findings-head font-label-xs';
  findingsHead.textContent='Findings';
  findingsPanel.appendChild(findingsHead);
  findingsList=document.createElement('ul');
  findingsList.className='board-explorer-findings-list';
  findingsPanel.appendChild(findingsList);
  pane.appendChild(findingsPanel);

  statusLine=document.createElement('p');
  statusLine.className='board-explorer-status';
  pane.appendChild(statusLine);

  editorModal.appendChild(pane);
  document.body.appendChild(editorModal);
  editorPane=pane;

  saveBtn.addEventListener('click',function(){save();});
}
function openEditor(){
  if(editorModal===null||editorModal.open)return;
  editorModal.showModal();
  if(editorText!==null)editorText.focus();
  if(monacoEditor!==null)monacoEditor.layout();
}
function closeEditor(){
  if(editorModal===null||!editorModal.open)return;
  editorModal.close();
  showEditorSource();
}
function isMarkdown(path){ return /\.mdx?$/i.test(path||''); }
var LANGUAGES={ts:'typescript',tsx:'typescript',js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',json:'json',md:'markdown',mdx:'markdown',css:'css',html:'html',yml:'yaml',yaml:'yaml',sh:'shell',bash:'shell',py:'python',rs:'rust',go:'go',cs:'csharp',java:'java',sql:'sql',toml:'ini',ini:'ini',xml:'xml'};
function languageFor(path){
  var m=/\.([A-Za-z0-9]+)$/.exec(path||'');
  var ext=m===null?'':m[1].toLowerCase();
  return LANGUAGES[ext]||'plaintext';
}
// Monaco is loaded once, on the first file opened. Everything here degrades to
// the textarea if it is missing, so the editor is an improvement rather than a
// dependency.
function withMonaco(then){
  if(monaco!==null){ then(monaco); return; }
  if(typeof require!=='function'||typeof require.config!=='function'){ then(null); return; }
  if(monacoLoading){ monacoWaiters.push(then); return; }
  monacoLoading=true;
  monacoWaiters.push(then);
  try{
    require.config({paths:{vs:'/vendor/monaco'}});
    require(['vs/editor/editor.main'],function(){
      monaco=window.monaco||null;
      var waiting=monacoWaiters; monacoWaiters=[];
      for(var i=0;i<waiting.length;i++)waiting[i](monaco);
    },function(){
      var waiting=monacoWaiters; monacoWaiters=[];
      for(var j=0;j<waiting.length;j++)waiting[j](null);
    });
  }catch(failed){
    var pending=monacoWaiters; monacoWaiters=[];
    for(var k=0;k<pending.length;k++)pending[k](null);
  }
}
function mountEditor(path,content){
  withMonaco(function(m){
    if(m===null||monacoHost===null||editorText===null)return;
    monacoHost.hidden=false;
    editorText.hidden=true;
    if(monacoEditor===null){
      monacoEditor=m.editor.create(monacoHost,{
        value:content,
        language:languageFor(path),
        theme:'vs-dark',
        automaticLayout:true,
        minimap:{enabled:false},
        scrollBeyondLastLine:false,
        fontSize:13
      });
      // The textarea stays the source of truth for save, so every keystroke
      // lands there too.
      monacoEditor.onDidChangeModelContent(function(){
        if(editorText!==null&&monacoEditor!==null)editorText.value=monacoEditor.getValue();
      });
    }else{
      var model=monacoEditor.getModel();
      if(model!==null){ m.editor.setModelLanguage(model,languageFor(path)); }
      monacoEditor.setValue(content);
    }
    if(editorModal!==null&&editorModal.open&&monacoEditor!==null) monacoEditor.layout();
  });
}
// The board's fragment allowlist keeps the elements a card is built from and
// drops headings, lists and code blocks, so a document rendered through it
// arrives as unstructured text. Prose needs its own list.
var PROSE_KEEP={A:1,BLOCKQUOTE:1,BR:1,CODE:1,DEL:1,DIV:1,EM:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,HR:1,LI:1,OL:1,P:1,PRE:1,SPAN:1,STRONG:1,TABLE:1,TBODY:1,TD:1,TH:1,THEAD:1,TR:1,UL:1};
var PROSE_DROP={BASE:1,EMBED:1,FORM:1,FRAME:1,FRAMESET:1,IFRAME:1,INPUT:1,LINK:1,MATH:1,META:1,NOSCRIPT:1,OBJECT:1,SCRIPT:1,SELECT:1,STYLE:1,SVG:1,TEMPLATE:1,TEXTAREA:1,TITLE:1};
function proseAttrAllowed(tag,name,value){
  if(name.indexOf('on')===0)return false;
  if(name==='class')return true;
  if(name==='href'&&tag==='a'){
    var v=value.replace(/\s+/g,'').toLowerCase();
    // Same rule as the board's fragments: in-page and same-origin only. A
    // link out of a document renders as its text rather than as somewhere to
    // click.
    return v.charAt(0)==='#'||v.indexOf('./')===0||v.indexOf('../')===0||(v.charAt(0)==='/'&&v.charAt(1)!=='/');
  }
  return false;
}
function cleanProse(node){
  if(node.nodeType===3)return document.createTextNode(node.nodeValue||'');
  if(node.nodeType!==1)return null;
  var tag=node.tagName.toUpperCase();
  if(PROSE_DROP[tag]===1)return null;
  var kids=document.createDocumentFragment();
  var child=node.firstChild;
  while(child!==null){
    var next=child.nextSibling;
    var kept=cleanProse(child);
    if(kept!==null)kids.appendChild(kept);
    child=next;
  }
  if(PROSE_KEEP[tag]!==1)return kids;
  var el=document.createElement(tag.toLowerCase());
  var attrs=node.attributes;
  for(var i=0;i<attrs.length;i++){
    var a=attrs.item(i);
    if(a!==null&&proseAttrAllowed(tag.toLowerCase(),a.name,a.value))el.setAttribute(a.name,a.value);
  }
  el.appendChild(kids);
  return el;
}
function renderProse(target,html){
  if(typeof DOMParser!=='function')return;
  var doc=new DOMParser().parseFromString(html,'text/html');
  var frag=document.createDocumentFragment();
  var child=doc.body.firstChild;
  while(child!==null){
    var next=child.nextSibling;
    var kept=cleanProse(child);
    if(kept!==null)frag.appendChild(kept);
    child=next;
  }
  target.replaceChildren(frag);
}
function showEditorSource(){
  if(previewPane===null||editorText===null||previewBtn===null)return;
  previewPane.hidden=true;
  // The textarea only comes back when the editor is not there to show.
  var haveEditor=monacoEditor!==null&&monacoHost!==null;
  editorText.hidden=haveEditor;
  if(monacoHost!==null)monacoHost.hidden=!haveEditor;
  previewBtn.textContent='Preview';
  previewBtn.setAttribute('aria-pressed','false');
}
function togglePreview(){
  if(previewPane===null||editorText===null||previewBtn===null)return;
  if(!previewPane.hidden){ showEditorSource(); return; }
  // Rendered by the server, through the same endpoint the spec editor uses,
  // and inserted through the same parse-and-rebuild as every other fragment.
  fetch(projectQuery('/api/spec/preview'),{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({markdown:editorText.value})
  })
    .then(function(res){return res.ok?res.text():null;})
    .then(function(text){
      if(text===null){setStatus('The preview could not be rendered.',false);return;}
      var parsed=null;
      try{parsed=JSON.parse(text);}catch(failed){parsed=null;}
      var html=parsed!==null&&typeof parsed.html==='string'?parsed.html:text;
      renderProse(previewPane,html);
      previewPane.hidden=false;
      editorText.hidden=true;
      if(monacoHost!==null)monacoHost.hidden=true;
      previewBtn.textContent='Edit';
      previewBtn.setAttribute('aria-pressed','true');
    })
    .catch(function(){setStatus('The preview could not be rendered.',false);});
}
function buildExplorer(){
  body.replaceChildren();
  buildEditor();
}
function showFindings(findings){
  if(findingsPanel===null||findingsList===null)return;
  findingsList.replaceChildren();
  if(findings.length===0){
    findingsPanel.hidden=true;
    return;
  }
  findingsPanel.hidden=false;
  for(var i=0;i<findings.length;i++){
    var f=findings[i];
    var li=document.createElement('li');
    li.className='board-explorer-finding';
    var rule=document.createElement('code');
    rule.className='board-explorer-finding-rule';
    rule.textContent=(f.ruleId||'');
    var msg=document.createElement('span');
    msg.className='board-explorer-finding-message';
    msg.textContent=(f.message||'');
    li.appendChild(rule);
    li.appendChild(document.createTextNode(': '));
    li.appendChild(msg);
    if(typeof f.line==='number'){
      var line=document.createElement('span');
      line.className='board-explorer-finding-line';
      line.textContent=' line '+f.line;
      li.appendChild(line);
    }
    findingsList.appendChild(li);
  }
}
function save(){
  if(selectedPath===null||editorText===null)return;
  saveBtn.disabled=true;
  setStatus('Saving…');
  fetch(projectQuery('${BOARD_EXPLORER_WRITE_PATH}'),{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({file:selectedPath,content:editorText.value,holder:holder})
  })
  .then(function(res){return res.text().then(function(text){return {ok:res.ok,status:res.status,body:text};});})
  .then(function(r){
    saveBtn.disabled=false;
    if(!r.ok){setStatus(errorText(r),false);return;}
    var parsed=null;
    try{parsed=JSON.parse(r.body);}catch(failed){parsed=null;}
    if(parsed===null||typeof parsed!=='object'){setStatus('Save returned an unreadable response.',false);return;}
    if(parsed.findings!==undefined){
      showFindings(Array.isArray(parsed.findings)?parsed.findings:[]);
    }
    if(parsed.ok===true){
      setStatus('Saved.',true);
    }else{
      setStatus('Saved, but the file did not pass cyv check.',false);
    }
    refreshTree();
  })
  .catch(function(err){
    saveBtn.disabled=false;
    setStatus('Save failed: the request did not reach the server.',false);
  });
}
function refreshTree(){
  fetch(projectQuery('${BOARD_EXPLORER_TREE_PATH}'))
    .then(function(res){return res.text().then(function(text){return {ok:res.ok,status:res.status,body:text};});})
    .then(function(r){
      if(!r.ok){body.replaceChildren(empty('Could not load file tree: '+errorText(r)));return;}
      var parsed=null;
      try{parsed=JSON.parse(r.body);}catch(failed){parsed=null;}
      if(parsed===null||typeof parsed!=='object'||parsed.tree===null||typeof parsed.tree!=='object'){
        body.replaceChildren(empty('The server returned an empty tree.'));return;
      }
      if(editorPane===null)buildExplorer();
      if(treeRoot!==null&&treeRoot.parentNode===body)treeRoot.remove();
      renderTree(parsed.tree);
    })
    .catch(function(err){body.replaceChildren(empty('The file tree could not be loaded: '+(err&&err.message?err.message:String(err))));});
}
function renderTree(tree){
  var wrap=document.createElement('div');
  wrap.className='board-explorer-tree';
  wrap.setAttribute('role','tree');
  wrap.setAttribute('aria-label','Repository files');
  var rootDetails=document.createElement('details');
  rootDetails.className='board-explorer-dir';
  rootDetails.open=true;
  var summary=document.createElement('summary');
  summary.className='board-explorer-dir-name';
  summary.textContent=tree.name||'Files';
  rootDetails.appendChild(summary);
  var kids=document.createElement('div');
  kids.className='board-explorer-children';
  renderChildren(kids,tree.children||[]);
  rootDetails.appendChild(kids);
  wrap.appendChild(rootDetails);
  // The editor moved into a centred dialog on document.body, so it is no
  // longer a sibling to insert before. The rail holds the tree alone.
  body.appendChild(wrap);
  treeRoot=wrap;
  updateSelection();
}
function renderChildren(into,children){
  if(!Array.isArray(children))return;
  for(var i=0;i<children.length;i++){
    var node=children[i];
    if(node===null||typeof node!=='object')continue;
    if(node.kind==='dir'){
      var details=document.createElement('details');
      details.className='board-explorer-dir';
      var summary=document.createElement('summary');
      summary.className='board-explorer-dir-name';
      summary.textContent=node.name||'';
      details.appendChild(summary);
      var inner=document.createElement('div');
      inner.className='board-explorer-children';
      renderChildren(inner,node.children||[]);
      details.appendChild(inner);
      into.appendChild(details);
    }else if(node.kind==='file'){
      var btn=document.createElement('button');
      btn.className='board-explorer-file';
      btn.type='button';
      btn.setAttribute('data-path',node.path||'');
      btn.textContent=node.name||'';
      into.appendChild(btn);
    }
  }
}
function updateSelection(){
  if(treeRoot===null||selectedPath===null)return;
  var prev=treeRoot.querySelector('.board-explorer-file-selected');
  if(prev!==null)prev.classList.remove('board-explorer-file-selected');
  var next=treeRoot.querySelector('[data-path="'+selectedPath+'"]');
  if(next!==null)next.classList.add('board-explorer-file-selected');
}
function selectFile(path,shouldFetch){
  if(editorText===null||fileBar===null)return;
  if(shouldFetch!==false){
    loadTicket++;
    var ticket=loadTicket;
    var pathEl=fileBar.querySelector('.board-explorer-file-path');
    if(pathEl!==null)pathEl.textContent=path;
    editorText.value='';
    setStatus('Loading…');
    if(findingsPanel!==null)findingsPanel.hidden=true;
    if(findingsList!==null)findingsList.replaceChildren();
    fetch(projectQuery('${BOARD_EXPLORER_READ_PATH}'+'?f='+encodeURIComponent(path)))
      .then(function(res){return res.text().then(function(text){return {ok:res.ok,status:res.status,body:text};});})
      .then(function(r){
        if(ticket!==loadTicket)return;
        if(!r.ok){setStatus(errorText(r),false);return;}
        var parsed=null;
        try{parsed=JSON.parse(r.body);}catch(failed){parsed=null;}
        if(parsed===null||typeof parsed!=='object'||typeof parsed.content!=='string'){
          setStatus('The file could not be read.',false);return;
        }
        editorText.value=parsed.content;
        mountEditor(path,parsed.content);
        setStatus('');
      })
      .catch(function(){setStatus('The file could not be loaded.',false);});
  }
  selectedPath=path;
  updateSelection();
  if(previewBtn!==null){ previewBtn.hidden=!isMarkdown(path); }
  showEditorSource();
  openEditor();
}
document.addEventListener('click',function(e){
  var t=e.target;
  var actionEl=t.closest('[data-action]');
  if(actionEl!==null){
    var action=actionEl.getAttribute('data-action');
    if(action==='explorer'){e.preventDefault();toggleExplorer();return;}
    // A path in the review opens in the same editor the explorer opens, from
    // the same handler. Reading a review means reading what it names.
    if(action==='open-file'){
      var wanted=actionEl.getAttribute('data-path')||'';
      if(wanted!==''){e.preventDefault();openExplorer();selectFile(wanted);}
      return;
    }
    return;
  }
  var fileEl=t.closest('.board-explorer-file');
  if(fileEl!==null){
    var path=fileEl.getAttribute('data-path');
    if(path!==null&&path!==''){e.preventDefault();selectFile(path);}
    return;
  }
});
refreshTree();
})();`;
}

export function boardClientScript(): string {
  return drawerClientScript() + dispatchFormClientScript() + noteClientScript() + liveClientScript() + sessionClientScript() + explorerClientScript();
}
