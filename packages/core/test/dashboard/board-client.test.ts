import { describe, expect, it } from 'vitest';

import {
  BOARD_ACK_PATH,
  BOARD_DRAWER_PATH,
  BOARD_EXPLORER_READ_PATH,
  BOARD_EXPLORER_TREE_PATH,
  BOARD_EXPLORER_WRITE_PATH,
  boardClientScript,
} from '../../src/dashboard/board-client.js';
import type { BoardModel } from '../../src/dashboard/board-model.js';
import { boardCss, renderBoard } from '../../src/dashboard/board-render.js';
import { diffDrawerCss } from '../../src/dashboard/diff-drawer.js';

const EMPTY_MODEL: BoardModel = {
  todo: [],
  alerts: [],
  needsYou: [],
  inMotion: [],
  review: [],
  done: [],
  projects: [],
};

const TIMESTAMP = '2026-09-01T11:00:00.000Z';

function modelWithCard(dispatchId: string): BoardModel {
  return {
    todo: [],
    alerts: [],
    needsYou: [],
    inMotion: [
      {
        kind: 'card',
        dispatchId,
        description: 'do the thing',
        laneId: 'alpha',
        timestamp: TIMESTAMP,
        openNotes: 0,
      },
    ],
    review: [],
    done: [],
    projects: [],
  };
}

describe('boardClientScript', () => {
  const script = boardClientScript();

  it('parses as JavaScript and embeds inline without breaking the document', () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toContain('</script');
  });

  // What this protects: the page pulls nothing off the internet and depends on
  // no framework to render. The one exception is the code editor, served from
  // the dashboard's own origin under /vendor/monaco and loaded through its AMD
  // loader, so `require` appears naming only that path. The editor is optional:
  // without it the textarea it would replace still works and still saves.
  it('has no framework, import, or remote URL', () => {
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toMatch(/\bimport\s*[\('"]/);
    expect(script).not.toMatch(/<(script|link)\b/i);

    const requires = [...script.matchAll(/\brequire\s*\(([^)]*)/g)].map((match) => match[1] ?? '');
    for (const argument of requires) {
      expect(argument).toContain('vs/editor');
    }
    expect(script).toContain("paths:{vs:'/vendor/monaco'}");
  });

  it('binds a delegated click handler that reads the dispatch id off the card', () => {
    expect(script).toContain("addEventListener('click'");
    expect(script).toContain("closest('.board-card')");
    expect(script).toContain("getAttribute('data-dispatch')");
  });

  // Every panel the client drives has to exist in the page the renderer emits.
  // A client naming an element the renderer stopped emitting is a whole block
  // that returns at its first line and disables itself in silence.
  it('targets the panel regions the renderer emits', () => {
    const html = renderBoard({ model: EMPTY_MODEL, lanes: [] });

    for (const id of ['board-drawer', 'board-drawer-body', 'board-drawer-diff', 'board-explorer', 'board-explorer-body']) {
      expect(html).toContain(`id="${id}"`);
      expect(script).toContain(id);
    }
  });

  it('relies only on hooks the renderer already emits', () => {
    const html = renderBoard({ model: modelWithCard('d-1'), lanes: [] });

    for (const hook of ['board-card', 'data-dispatch', 'board-drawer']) {
      expect(html).toContain(hook);
      expect(script).toContain(hook);
    }
    expect(html).not.toContain('<script');
  });

  it('fetches the selected dispatch over the declared same-origin route', () => {
    expect(BOARD_DRAWER_PATH).toMatch(/^\//);
    expect(script).toContain('fetch(');
    expect(script).toContain(BOARD_DRAWER_PATH);
    expect(script).toContain('dispatch=');
    expect(script).toContain('encodeURIComponent');
  });

  it('posts acknowledgements through one handler and disables the button while the post is in flight', () => {
    // The same handler serves the needs-you decision cards and the review
    // column's accept action: it sends itemId to the acknowledge route and
    // refuses a second click before the first has resolved.
    expect(script).toContain("action==='ack'");
    expect(script).toContain("getAttribute('data-item-id')");
    expect(script).toContain(BOARD_ACK_PATH);
    expect(script).toContain('button.disabled=true');
    expect(script).toContain('button.disabled=false');
  });

  it('replaces content in place and shows the panel, tracking selection and busy state', () => {
    expect(script).toContain('replaceChildren');
    expect(script).toContain('data-selected');
    expect(script).toContain('aria-busy');
    // Opening the review is setting the <details> open, which the browser
    // owns, rather than a class or an attribute the board keeps in step.
    expect(script).toContain('drawer.open=true');
    expect(script).not.toContain('board-drawer-open');
    expect(script).not.toContain('board-drawer-close');
  });

  it('has no polling loop: the one interval repaints the badge and fetches nothing', () => {
    const intervals = script.match(/setInterval\((\w+)/g) ?? [];
    expect(intervals).toEqual(['setInterval(syncLive']);
    // The tick updates text only; data still arrives exclusively over the
    // stream. One timer is allowed and it is not a poll: it coalesces the
    // refreshes a burst of stream events asks for, and is armed only from an
    // event path. Nothing here asks the server for data on a schedule.
    const timeouts = script.match(/setTimeout\((\w+)/g) ?? [];
    expect(timeouts).toEqual(['setTimeout(flushRegions', 'setTimeout(flushRegions']);
    expect(script).not.toMatch(/setImmediate/);
    expect(script).not.toMatch(/request(AnimationFrame|IdleCallback)/);
    expect(script).not.toContain('data-poll');
    expect(script).toContain('function syncLive()');
    const syncBody = script.slice(script.indexOf('function syncLive()'), script.indexOf('function noteEvent()'));
    expect(syncBody).not.toContain('fetch(');
  });

  it('drives the live badge from the real EventSource states', () => {
    // Each state the stream can be in has a label and a distinct dot.
    for (const state of ['connected', 'reconnecting', 'disconnected']) {
      expect(script).toContain(`${state}:`);
    }
    expect(script).toContain('es.onopen');
    expect(script).toContain('es.onerror');
    expect(script).toContain('es.readyState === EventSource.CLOSED');
    // A dropped stream is never dressed up as a live one.
    expect(script).toContain("'not live'");
    expect(script).toContain("'reconnecting…'");
    expect(script).toContain("'live'");
    expect(script).toContain("setAttribute('data-live', connection)");
  });

  it('derives the freshness line from the last event received, not from assumed success', () => {
    // The clock only moves in noteEvent — the handlers attached to real events —
    // and in seedEpoch, which reads the epoch the server rendered into the page.
    expect(script).toContain('lastEventAt = Date.now()');
    expect(script).toContain("addEventListener('dispatch', function(e) { noteEvent(); applyEvent(e.data); })");
    expect(script).toContain('data-epoch');
    expect(script).toContain('ageText(lastEventAt, Date.now())');
    // The display tick must not touch the clock: only syncLive runs on it.
    expect(script.match(/lastEventAt = Date\.now\(\)/g)).toHaveLength(1);
  });

  it('says plainly when the page is stale, and how old the data is', () => {
    expect(script).toContain("'showing data from ' + when");
    expect(script).toContain("'an unknown age'");
    // Reconnecting refreshes the regions instead of trusting what is on screen.
    expect(script).toContain('function refreshAll()');
    expect(script).toContain('if (dropped) refreshAll();');
  });

  it('renders the badge it drives with a seeded epoch and a pessimistic label', () => {
    const html = renderBoard({ model: EMPTY_MODEL, lanes: [], now: Date.parse('2026-09-01T12:00:00.000Z') });

    expect(html).toContain('id="board-live-badge"');
    expect(html).toContain('data-live="connecting"');
    expect(html).toContain('not connected yet');
    expect(html).toContain('board-live-dot');
    expect(html).toContain('board-live-label');
    expect(html).toContain('board-live-age');
    const badgeAt = html.indexOf('id="board-live-badge"');
    const badge = html.slice(badgeAt, badgeAt + 600);
    expect(badge).toContain(`data-epoch="${Date.parse('2026-09-01T12:00:00.000Z')}"`);
    // A server render never claims the stream is up.
    expect(badge).not.toContain('live — updated');
    expect(script).toContain("getElementById('board-live-badge')");
  });

  // The script is built from a template literal, so a stray backtick in a
  // comment closes it and the page ships broken JavaScript. tsc catches that
  // one; a plain syntax error in the emitted script it does not.
  it('emits a script that parses', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('never inserts fetched markup by assignment', () => {
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('outerHTML');
    expect(script).not.toContain('insertAdjacentHTML');
    expect(script).not.toContain('createContextualFragment');
    expect(script).not.toContain('document.write');
    expect(script).not.toContain('eval(');

    expect(script).toContain('DOMParser');
    expect(script).toContain('parseFromString');
    expect(script).toContain('createElement');
    expect(script).toContain('createTextNode');
    expect(script).toContain('textContent');
  });

  it('rebuilds the fragment against a fixed element and attribute list', () => {
    // Elements that can carry code or outside content are dropped outright.
    expect(script).toContain('SCRIPT');
    expect(script).toContain('IFRAME');
    // Event-handler attributes and every attribute outside the allowlist go.
    expect(script).toContain("indexOf('on')");
    expect(script).toContain("indexOf('data-')");
    expect(script).toContain("indexOf('aria-')");
    expect(script).toContain('setAttribute');
  });

  it('renders an honest refusal or failure instead of an empty drawer', () => {
    expect(script).toContain('res.ok');
    expect(script).toContain('.catch(');
    expect(script).toContain('drawer-refused');
    expect(script).toContain('role');
    expect(script).toContain('aria-busy');
  });

  it('uses only classes the dashboard stylesheets already define', () => {
    const css = boardCss();
    const drawerCss = diffDrawerCss();
    expect(drawerCss).toContain('.drawer{');
    expect(drawerCss).toContain('.drawer-refused');
    expect(drawerCss).toContain('.drawer-empty');
    expect(css).toContain('.board-drawer');
    expect(css).toContain('.board-modal[open]');
    expect(css).toContain('.board-modal::backdrop');
    // The docked drawer is a <details>; open state is the open attribute, not a class or hidden.
    expect(css).not.toContain('.board-drawer[hidden]');
  });

  it('writes no style of its own; sizing lives in the stylesheet', () => {
    // The client toggles classes and the open attribute; every dimension on
    // this page is a rule in the stylesheet, so the layout can be read without
    // running the script.
    const styleWrites = [...script.matchAll(/\.style\.(\w+)/g)].map((match) => match[1] ?? '');
    expect(styleWrites).toEqual([]);

    expect(script).not.toContain("setAttribute('style'");
    expect(script).not.toMatch(/<style/i);

    const css = boardCss();
    expect(css).toContain('.board-explorer[open]');
    expect(css).toContain('max-height: 60vh');
  });

  it('fetches the explorer tree, reads files, and saves through the declared same-origin routes', () => {
    expect(script).toContain(BOARD_EXPLORER_TREE_PATH);
    expect(script).toContain(BOARD_EXPLORER_READ_PATH);
    expect(script).toContain(BOARD_EXPLORER_WRITE_PATH);
    expect(script).toContain('board-explorer');
    expect(script).toContain('board-explorer-file');
  });

  it('renders the editor as a native <dialog> that starts closed', () => {
    expect(script).toContain("createElement('dialog')");
    expect(script).toContain('.showModal()');
    expect(script).toContain('.close()');
    // The dialog is not open on first render; the script never sets editorModal.open = true.
    expect(script).not.toContain('editorModal.open=true');
    expect(script).not.toContain('editorModal.hidden');
  });

  it('lets the browser close the editor on Escape', () => {
    // A real <dialog> with showModal handles Escape itself; no manual listener.
    expect(script).toContain("createElement('dialog')");
    expect(script).toContain('.showModal()');
    expect(script).not.toContain("e.key==='Escape'");
  });

  // A layout manager's tab can be closed with no control left anywhere to
  // reopen it. A `<details>` cannot: its summary is on screen either way.
  it('docks the review and the explorer as <details> with a handle that never leaves', () => {
    const html = renderBoard({ model: EMPTY_MODEL, lanes: [], projectRoot: '/home/user/project' });
    expect(html).toContain('<details class="board-drawer" id="board-drawer"');
    expect(html).toContain('<details class="board-explorer" id="board-explorer"');
    expect(html).toContain('class="board-drawer-head"');
    expect(html).toContain('class="board-explorer-head"');
    expect(html).not.toContain('id="dockview-root"');
  });

  it('fills the review panel summary with the dispatch id and opens it when a card is selected', () => {
    const selectStart = script.indexOf('function select(');
    expect(selectStart).toBeGreaterThanOrEqual(0);
    const selectEnd = script.indexOf('\nfunction ', selectStart + 1);
    const selectFn = selectEnd === -1 ? script.slice(selectStart) : script.slice(selectStart, selectEnd);
    expect(selectFn).toContain('setDrawerSubject(id)');
    expect(selectFn).toContain('openDrawer()');
    expect(script).toContain('function openDrawer(){');
    expect(script).toContain('drawer.open=true');
    expect(script).toContain("getElementById('board-drawer-subject')");
  });
});
