/**
 * @file packages/core/src/dashboard/nav.ts
 * The one navigation bar every dashboard page renders.
 *
 * Each page used to build its own. The glance page listed five surfaces, the
 * tasks page three, the specs page two, and the rules page a single link back —
 * so from Specs there was no way to Tasks, and from Tasks no way to Glance or
 * Lanes. A dashboard meant to replace an IDE has to let a person get from any
 * page to any other.
 */
import { esc } from './render.js';

/** The surfaces the dashboard serves, in the order they are shown. */
export const NAV_PAGES = [
  { path: '/', label: 'Glance' },
  { path: '/board', label: 'Workbench' },
  { path: '/tasks', label: 'Waves & Tasks' },
  { path: '/lanes', label: 'Lanes' },
  { path: '/specs', label: 'Specs' },
  { path: '/rules', label: 'Rules' },
  { path: '/live', label: 'Live' },
] as const;

/** The path of the page being rendered, so it can mark itself. */
export type NavPath = (typeof NAV_PAGES)[number]['path'];

function navHref(project: string, path: string): string {
  if (project === '') return path;
  return `${path}?${new URLSearchParams({ p: project }).toString()}`;
}

/**
 * The freshness line for a page that renders on request and then never
 * updates — the words the spec detail page already carries. The render time
 * rides on `data-epoch` so `FRESHNESS_CLIENT` can rewrite the line with the
 * page's real age in the reader's browser: a "just now" baked into the HTML
 * keeps claiming to be current in a tab left open overnight, which is the
 * lie the badge's own `data-epoch` seed was added to prevent.
 */
export function freshnessHtml(now: number): string {
  return `<p class="cyv-freshness font-mono-sm text-on-surface-variant" role="status" data-epoch="${now}">rendered on request — not updated automatically</p>`;
}

/**
 * Rewrites the freshness line from the render time it carries, so the age is
 * computed where the page is read rather than frozen at render. The only
 * thing that moves on these pages is the clock, so a timer is the whole
 * mechanism; the age buckets match `relativeTime`'s.
 */
export const FRESHNESS_CLIENT = String.raw`(function(){
var el=document.querySelector('.cyv-freshness[data-epoch]');
if(el===null)return;
var epoch=Number.parseInt(el.getAttribute('data-epoch')||'',10);
if(Number.isNaN(epoch))return;
function ago(){
var s=Math.max(0,Math.round((Date.now()-epoch)/1000));
var when;
if(s<45)when='just now';
else if(s<90)when=s+'s ago';
else{var m=Math.round(s/60);if(m<90)when=m+'m ago';else{var h=Math.round(m/60);when=h<36?h+'h ago':Math.round(h/24)+'d ago';}}
el.textContent='rendered on request '+when+' — not updated automatically';
}
ago();
setInterval(ago,1000);
})();`;

/**
 * The header and tab strip. `current` marks one tab as the page being read;
 * a path not in `NAV_PAGES` marks none, which is what a page outside the set
 * should do rather than claiming to be one of them.
 */
export function topNavHtml(projectName: string, project: string, current: string): string {
  const tabs = NAV_PAGES.map((page) => {
    const active = page.path === current;
    return `<a class="cyv-tab${active ? ' active' : ''}" href="${esc(navHref(project, page.path))}"${
      active ? ' aria-current="page"' : ''
    }>${esc(page.label)}</a>`;
  }).join('\n    ');

  return `<header class="cyv-header">
  <div class="cyv-brand"><span>${esc(projectName)}</span></div>
  <nav class="cyv-nav-tabs">
    ${tabs}
  </nav>
</header>`;
}
