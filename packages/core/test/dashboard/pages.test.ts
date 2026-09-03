import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import {
  renderDiffPage,
  renderDocsPage,
  renderEditPage,
  renderViewPage,
  type DiffPageInput,
  type DocsPageInput,
} from '../../src/dashboard/pages.js';
import { shell, type ShellOptions } from '../../src/dashboard/shell.js';

const OPTS: ShellOptions = { project: 'C:\\work\\one', projectName: 'one', showProjects: true };
const Q = encodeURIComponent('C:\\work\\one');

describe('shell', () => {
  it('carries the project on every tab and names the project in the top bar', () => {
    const html = shell('title', '<p>body</p>', { ...OPTS, active: 'docs', badge: 'b' });
    for (const path of ['/', '/diff', '/files', '/rules']) {
      expect(html).toContain(`href="${path}?p=${Q}"`);
    }
    expect(html).toContain('class="tab on" href="/files');
    expect(html).toContain(`data-project="C:\\work\\one"`);
    expect(html).toContain('>one</a>');
    expect(html).toContain('<p>body</p>');
    expect(html).toContain('<title>title</title>');
  });

  it('escapes the title and never writes an inline handler', () => {
    const html = shell('<b>', '', OPTS);
    expect(html).toContain('<title>&lt;b&gt;</title>');
    expect(html).not.toContain('onclick=');
  });
});

describe('renderDocsPage', () => {
  const input: DocsPageInput = {
    specs: [
      { id: '0040-a-dashboard-that-makes-sense', name: 'a dashboard that makes sense', done: 2, total: 8, href: '/view?f=x' },
      { id: '0011-executor', name: 'executor', done: 5, total: 5, href: '/view?f=y' },
      { id: '0099-idea', name: 'idea', done: 0, total: 0, href: '/view?f=z' },
    ],
    commits: [{ hash: 'abc1234', when: '2 hours ago', subject: 'T40003: the shell <b>' }],
    status: [{ titleHtml: '<b>Looked at it</b>', bodyHtml: '<p>seen</p>' }],
    documents: [
      { file: 'docs/specs/0040-a-dashboard-that-makes-sense/tasks.md', when: 'today', kb: '3.1', specId: '0040-a-dashboard-that-makes-sense' },
      { file: 'README.md', when: 'yesterday', kb: '1.0' },
    ],
  };
  const html = renderDocsPage(input, OPTS);

  it('ranks active specs first and draws each with a thin track', () => {
    expect(html.indexOf('a dashboard that makes sense')).toBeLessThan(html.indexOf('>executor<'));
    expect(html.indexOf('>executor<')).toBeLessThan(html.indexOf('>idea<'));
    expect(html).toContain('class="spec done"');
    expect(html).toContain('class="spec empty"');
    expect(html).toContain('<span class="ct">2/8</span>');
    expect(html).toContain('class="track"');
  });

  it('lists commits escaped, the status log as details, and documents grouped by spec then everything else', () => {
    expect(html).toContain('T40003: the shell &lt;b&gt;');
    expect(html).toContain('<details class="happen" open>');
    expect(html).toContain('<b>Looked at it</b>');
    expect(html).toContain('0040 a dashboard that makes sense');
    expect(html).toContain(`/view?f=docs%2Fspecs%2F0040-a-dashboard-that-makes-sense%2Ftasks.md&amp;p=${Q}`);
    expect(html).toContain('Everything else (1)');
    expect(html).toContain(`/edit?f=README.md&amp;p=${Q}`);
  });

  it('has an empty state for a project with no spec', () => {
    const empty = renderDocsPage({ specs: [], commits: [], status: [], documents: [] }, OPTS);
    expect(empty).toContain('No spec yet.');
    expect(empty).toContain('No commits read.');
    expect(empty).toContain('Everything else (0)');
  });

  it('renders the title row (non-compact layout)', () => {
    // The docs page is not compact: it must have the two-row nav with a .who div.
    expect(html).toContain('class="who"');
    expect(html).not.toContain('class="nav compact"');
  });
});

describe('renderViewPage', () => {
  const source = '## Heading\n\nText with <b>markup</b> & an ampersand.';
  const html = renderViewPage(
    {
      file: 'docs/a.md',
      sections: [
        {
          title: 'Heading',
          anchor: 'heading',
          source,
          comments: [
            { id: 3, author: 'owner', isAgent: false, kind: 'note', body: 'hm', created: 0, status: 'open', file: 'docs/a.md', anchor: 'heading' },
          ],
        },
        { title: '', anchor: '', source: 'preamble', comments: [] },
      ],
      editHref: `/edit?f=docs%2Fa.md&p=${Q}`,
      vendorScriptHref: '/vendor/marked.min.js',
    },
    OPTS,
  );

  it('carries the escaped source as visible text so the page reads without script', () => {
    expect(html).toContain('Text with &lt;b&gt;markup&lt;/b&gt; &amp; an ampersand.');
    expect(html).not.toContain('<b>markup</b>');
    expect(html).toContain(`data-src="${encodeURIComponent(source).replace(/'/g, '&#39;')}"`);
    expect(html).toContain('>preamble</div>');
  });

  it('gives each section an anchor, a comment control with data attributes, and its comments', () => {
    expect(html).toContain('<div class="sec" data-anchor="heading">');
    expect(html).toContain('<div class="sec" data-anchor="s1">');
    expect(html).toContain('class="anchor-btn cbtn" data-file="docs/a.md" data-anchor="heading" data-title="Heading"');
    expect(html).toContain('data-title="this section"');
    expect(html).toContain('class="cm" data-id="3"');
    expect(html).toContain('src="/vendor/marked.min.js"');
  });

  it('keeps the renderer hardening: raw html escaped, safe schemes only, no opener', () => {
    expect(html).toContain('r.html=function');
    expect(html).toContain('https?:\\/\\/');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('onclick=');
  });
});

describe('renderEditPage', () => {
  const html = renderEditPage(
    { file: 'docs/a.md', source: 'a & b', mtime: 1756728000000, viewHref: `/view?f=docs%2Fa.md&p=${Q}` },
    OPTS,
  );

  it('carries the mtime and file on the editor for the guarded save', () => {
    expect(html).toContain('id="editor" rows="26" data-file="docs/a.md" data-mtime="1756728000000"');
    expect(html).toContain('>a &amp; b</textarea>');
    expect(html).toContain(`class="savebtn primary" data-view="/view?f=docs%2Fa.md&amp;p=${Q}"`);
    expect(html).toContain('id="savebar" hidden');
    expect(html).toContain('id="saveerr"');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('oninput=');
  });
});

describe('renderDiffPage', () => {
  const instances: DiffPageInput['instances'] = [
    { id: 'working', label: 'working', port: 4301, up: false, description: 'Uncommitted changes in the working tree.' },
    { id: 'staged', label: 'staged', port: 4302, up: true, description: 'Changes staged for commit.' },
  ];

  it('renders exactly one nav row with .difit-select inside it and no separate instance tab row', () => {
    const html = renderDiffPage({ instances, currentId: 'working', comments: [] }, OPTS);
    // The compact nav must be present.
    expect(html).toContain('class="nav compact"');
    // The select must be inside the nav.
    expect(html).toContain('class="difit-select"');
    // There must be no separate .tabs div outside the nav for instance links.
    // The old pattern was <div class="tabs"> rendered in the body; it should not appear.
    expect(html).not.toContain('<div class="tabs">');
  });

  it('marks the current instance selected in the select', () => {
    const html = renderDiffPage({ instances, currentId: 'working', comments: [] }, OPTS);
    expect(html).toContain('value="working" selected');
    expect(html).not.toContain('value="staged" selected');
  });

  it('offers a start button when the chosen instance is down', () => {
    const html = renderDiffPage({ instances, currentId: 'working', comments: [] }, OPTS);
    expect(html).toContain('<button class="difit-start" data-id="working">start it</button>');
    expect(html).toContain('Not running.');
    expect(html).not.toContain('<iframe');
  });

  it('frames the instance from the same-origin /frame route when it is up, and reads comments back', () => {
    const html = renderDiffPage(
      {
        instances,
        currentId: 'staged',
        comments: [{ file: 'src/a.ts', line: 12, body: 'why <this>' }, { file: 'src/b.ts', line: null, body: 'whole file' }],
      },
      OPTS,
    );
    expect(html).toContain(`<iframe class="difit" src="/frame?d=staged&amp;p=${Q}"`);
    expect(html).not.toContain('class="difit-start"');
    expect(html).toContain('2 review comment(s)');
    expect(html).toContain('src/a.ts:12');
    expect(html).toContain('why &lt;this&gt;');
    expect(html).toContain('>src/b.ts</div>');
  });

  it('falls back to the first running instance for an unknown id, and has an empty state with none', () => {
    const html = renderDiffPage({ instances, currentId: 'nope', comments: [] }, OPTS);
    expect(html).toContain(`src="/frame?d=staged&amp;p=${Q}"`);
    const none = renderDiffPage({ instances: [], currentId: 'working', comments: [] }, OPTS);
    expect(none).toContain('No diff instance is configured');
  });

  it('script content in the page parses without syntax errors', () => {
    const html = renderDiffPage({ instances, currentId: 'working', comments: [] }, OPTS);
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    expect(() => new Script(match?.[1] ?? '')).not.toThrow();
  });
});
