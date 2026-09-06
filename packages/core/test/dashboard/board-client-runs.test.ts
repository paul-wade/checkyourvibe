import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { boardClientScript } from '../../src/dashboard/board-client.js';
import { renderBoard } from '../../src/dashboard/board-render.js';
import type { BoardModel } from '../../src/dashboard/board-model.js';

/**
 * The board's client script, actually executed.
 *
 * Everything else known about this script is read off its source text, because
 * until now nothing here could run it. Three bugs reached the page that way:
 * a helper called across an IIFE boundary, a click handler that threw and
 * silently disabled the file tree, and a global read under the wrong name that
 * would have rendered a blank page with no error at all.
 */
const EMPTY_MODEL: BoardModel = {
  todo: [],
  alerts: [],
  needsYou: [],
  inMotion: [],
  review: [],
  done: [],
  projects: [],
};

interface RunResult {
  dom: JSDOM;
  errors: string[];
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Renders the board, evaluates the client in it, and collects anything it threw. */
function runClient(model: BoardModel = EMPTY_MODEL): RunResult {
  const html = renderBoard({ model, lanes: [], projectRoot: 'R:/repo' });
  const dom = new JSDOM(html, {
    url: 'http://localhost:4300/board',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const errors: string[] = [];

  // jsdom implements neither fetch nor EventSource, and the client needs both.
  // A browser has them, so these keep the test about the client rather than
  // about what jsdom happens to ship. `fetch` records what was asked for,
  // which is how a block proves it started.
  dom.window.eval(
    [
      'window.__fetched = [];',
      'window.fetch = function(url){',
      '  window.__fetched.push(String(url));',
      '  return new Promise(function(){});',
      '};',
      // The stub records its listeners so a test can push a real event down
      // the path the client actually uses, rather than through a hook the
      // production script would have to carry for the test's sake.
      'window.__es = null;',
      'window.EventSource = function EventSource(url){',
      '  this.url = String(url); this.readyState = 1;',
      '  this.handlers = {};',
      '  var self = this;',
      '  this.addEventListener = function(name, fn){',
      '    if (self.handlers[name] === undefined) self.handlers[name] = [];',
      '    self.handlers[name].push(fn);',
      '  };',
      '  this.close = function(){};',
      '  window.__es = this;',
      '};',
      'window.EventSource.CLOSED = 2;',
      'window.EventSource.OPEN = 1;',
      'window.__emit = function(name, data){',
      '  var listeners = window.__es === null ? [] : (window.__es.handlers[name] || []);',
      '  for (var i = 0; i < listeners.length; i++) listeners[i]({ data: data });',
      '};',
    ].join('\n'),
  );

  try {
    dom.window.eval(boardClientScript());
  } catch (clientFailed) {
    errors.push(messageFor(clientFailed));
  }

  return { dom, errors };
}

function click(dom: JSDOM, selector: string): void {
  const el = dom.window.document.querySelector(selector);
  if (el === null) throw new Error(`no element matched ${selector}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

describe('the board client, executed', () => {
  it('runs to completion without throwing', () => {
    const { errors } = runClient();

    expect(errors).toEqual([]);
  });

  // The reason the board is on drawers rather than a layout manager: a dock
  // tab closed by accident had no control anywhere to bring it back. A
  // `<details>` summary stays on screen whether the drawer is open or shut,
  // so every panel on this page can always be reopened.
  it('leaves a visible handle for every panel, open or shut', () => {
    const { dom } = runClient();
    const doc = dom.window.document;

    for (const id of ['board-drawer', 'board-explorer']) {
      const panel = doc.getElementById(id);
      expect(panel).not.toBeNull();
      if (panel === null) continue;
      expect(panel.tagName.toLowerCase()).toBe('details');
      expect(panel.querySelector('summary')).not.toBeNull();
      expect(panel.hasAttribute('open')).toBe(false);
    }
  });

  it('opens and closes the explorer from the button in the chrome', () => {
    const { dom } = runClient();
    const explorer = dom.window.document.getElementById('board-explorer');
    const main = dom.window.document.querySelector('.board-main');
    expect(explorer).not.toBeNull();
    expect(main).not.toBeNull();
    if (explorer === null || main === null) return;

    click(dom, '.board-explorer-toggle');
    expect(explorer.hasAttribute('open')).toBe(true);
    // The board gives up the width the open rail takes, rather than running
    // underneath it.
    expect(main.classList.contains('board-main--explorer')).toBe(true);

    click(dom, '.board-explorer-toggle');
    expect(explorer.hasAttribute('open')).toBe(false);
    expect(main.classList.contains('board-main--explorer')).toBe(false);
  });

  it('switches the review drawer between its info and diff tabs', () => {
    const { dom } = runClient();
    const doc = dom.window.document;

    click(dom, '[data-action="drawer-tab"][data-tab="diff"]');
    const body = doc.getElementById('board-drawer-body');
    const diff = doc.getElementById('board-drawer-diff');
    expect(body === null ? true : body.hidden).toBe(true);
    expect(diff === null ? true : diff.hidden).toBe(false);

    click(dom, '[data-action="drawer-tab"][data-tab="info"]');
    expect(body === null ? true : body.hidden).toBe(false);
    expect(diff === null ? true : diff.hidden).toBe(true);
  });

  // A burst of stream events used to mean a fetch and a full DOM rebuild per
  // event, on the main thread, with nothing between them — which is what an
  // ordinary dispatch closing produces, and the page stopped answering.
  it('coalesces a burst of stream events into one refresh per region', async () => {
    const { dom } = runClient();

    // Thirty events naming the same two regions, back to back.
    dom.window.eval(
      [
        'window.__fetched.length = 0;',
        'var payload = JSON.stringify({ fragments: ["todo", "in-progress", "todo"] });',
        'for (var i = 0; i < 30; i++) window.__emit("dispatch", payload);',
      ].join('\n'),
    );

    // Nothing goes out on the events themselves.
    expect(dom.window.eval('window.__fetched.length')).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 400));

    const requested: unknown = dom.window.eval('window.__fetched.join(" ")');
    const text = typeof requested === 'string' ? requested : '';
    const fragmentCalls = text.split(' ').filter((url) => url.includes('/api/fragment'));

    // Two regions were named, ninety times between them. Two requests.
    expect(fragmentCalls.length).toBe(2);
    expect(text).toContain('region=todo');
    expect(text).toContain('region=in-progress');
  });

  // Two bugs have now reached the browser as a half-applied edit: one side of
  // a rename landed and the other did not, the script still parsed, and the
  // page asked the server for `/api/spec-diff?undefined=undefined`. Nothing in
  // the suite looked at the request the tab actually builds.
  it('asks for a diff by spec or by dispatch, and never for undefined', async () => {
    const card = {
      kind: 'card' as const,
      dispatchId: 'w44-attempt-1',
      description: 'do the thing',
      laneId: 'alpha',
      timestamp: new Date().toISOString(),
      openNotes: 0,
      outcome: 'succeeded' as const,
      changedPaths: ['src/a.ts'],
    };
    const { dom } = runClient({ ...EMPTY_MODEL, done: [card] });
    const doc = dom.window.document;

    const target = doc.querySelector('.board-card[data-dispatch]');
    expect(target).not.toBeNull();
    if (target === null) return;
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    click(dom, '[data-action="drawer-tab"][data-tab="diff"]');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const requested: unknown = dom.window.eval('window.__fetched.join(" ")');
    const text = typeof requested === 'string' ? requested : '';
    const diffCall = text.split(' ').find((url) => url.includes('/api/spec-diff')) ?? '';

    expect(diffCall).not.toBe('');
    expect(diffCall).not.toContain('undefined');
    expect(diffCall).toMatch(/\/api\/spec-diff\?(spec|dispatch)=[^&=]+/);
    expect(diffCall).toContain('dispatch=w44-attempt-1');
  });

  // Every block in this script guards on an element and returns if it is
  // missing. A guard naming an element the renderer no longer emits disables
  // its whole block in silence: removing the explorer's old <details> wrapper
  // left the file tree, the editor and the preview dead this way.
  it('starts every block, so none of them guarded on an element that is gone', () => {
    const { dom } = runClient();
    const doc = dom.window.document;

    expect(doc.getElementById('board-explorer-body')).not.toBeNull();

    // The explorer asks the server for its tree the moment it starts. Nothing
    // else requests that path, so seeing it is proof the block ran.
    const requested: unknown = dom.window.eval("window.__fetched.join(' ')");
    expect(typeof requested === 'string' ? requested : '').toContain('/api/explorer/tree');
  });

  it('keeps the trust signals in the chrome, outside any panel that can be shut', () => {
    const { dom } = runClient();
    const doc = dom.window.document;
    const chrome = doc.getElementById('board-chrome');

    expect(chrome).not.toBeNull();
    if (chrome === null) return;

    // The badge that says whether the page is live must not sit inside a
    // drawer somebody has closed.
    expect(chrome.querySelector('#board-live-badge')).not.toBeNull();
    const drawer = doc.getElementById('board-drawer');
    expect(drawer === null ? false : drawer.contains(chrome)).toBe(false);
  });

  // The lane cards, the sessions line and the agent picker were three hundred
  // pixels of chrome above a board that then started below the fold. They fold
  // away; the status line above them keeps the summary on screen.
  it('folds the lanes and sessions away, with the summary still on the status line', () => {
    const { dom } = runClient();
    const doc = dom.window.document;
    const more = doc.getElementById('board-status-more');

    expect(more).not.toBeNull();
    if (more === null) return;
    expect(more.tagName.toLowerCase()).toBe('details');
    expect(more.hasAttribute('open')).toBe(false);
    expect(more.querySelector('#board-lanes')).not.toBeNull();
    expect(more.querySelector('#board-sessions-panel')).not.toBeNull();
    const summary = more.querySelector('summary');
    expect(summary === null ? '' : summary.textContent).toContain('lane');
  });
});
