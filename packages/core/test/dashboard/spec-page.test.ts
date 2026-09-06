import { describe, expect, it } from 'vitest';
import { renderSpecMarkdown, renderSpecPage } from '../../src/dashboard/spec-page.js';

describe('spec-page', () => {
  describe('renderSpecMarkdown', () => {
    it('renders headings, lists, code blocks, links, bold, and italic', () => {
      const markdown = [
        '# Title',
        '',
        '- item one',
        '- item two',
        '',
        '1. first',
        '2. second',
        '',
        'A paragraph with **bold** and *italic* and [a link](https://example.com).',
        '',
        '```',
        'code block',
        'line two',
        '```',
      ].join('\n');
      const html = renderSpecMarkdown(markdown);
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<ul>');
      expect(html).toContain('<ol>');
      expect(html).toContain('<li>item one</li>');
      expect(html).toContain('<li>first</li>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
      expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">a link</a>');
      expect(html).toContain('<pre><code>');
      expect(html).toContain('code block');
    });

    it('escapes a script tag so it cannot execute', () => {
      const html = renderSpecMarkdown('evil: <script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('rejects unsafe link schemes', () => {
      const html = renderSpecMarkdown('[bad](javascript:alert(1))');
      expect(html).toContain('href="#');
      expect(html).not.toContain('javascript');
    });
  });

  describe('renderSpecPage', () => {
    it('lists specs grouped by directory', () => {
      const page = renderSpecPage({
        project: 'R:\\checkyourvibe',
        projectName: 'checkyourvibe',
        directories: [
          {
            name: '0099-fixture',
            files: [
              {
                name: 'requirements.md',
                repoRelativePath: 'docs/specs/0099-fixture/requirements.md',
              },
              {
                name: 'tasks.md',
                repoRelativePath: 'docs/specs/0099-fixture/tasks.md',
              },
            ],
          },
        ],
      });
      expect(page).toContain('0099-fixture');
      expect(page).toContain('requirements.md');
      expect(page).toContain('tasks.md');
      expect(page).toContain('data-file="docs/specs/0099-fixture/requirements.md"');
      expect(page).toContain('data-file="docs/specs/0099-fixture/tasks.md"');
    });

    it('renders an editable textarea for an open file', () => {
      const page = renderSpecPage({
        project: 'R:\\checkyourvibe',
        projectName: 'checkyourvibe',
        directories: [],
        open: {
          file: 'docs/specs/0099-fixture/requirements.md',
          content: '# hello',
          holder: 'u1',
          readOnly: false,
        },
      });
      expect(page).toContain('id="spec-source"');
      expect(page).toContain('data-holder="u1"');
      expect(page).toContain('docs/specs/0099-fixture/requirements.md');
      expect(page).not.toContain('read only');
    });

    it('renders a read-only preview when a file is locked by another holder', () => {
      const page = renderSpecPage({
        project: 'R:\\checkyourvibe',
        projectName: 'checkyourvibe',
        directories: [],
        open: {
          file: 'docs/specs/0099-fixture/requirements.md',
          content: '# hello',
          holder: 'u1',
          readOnly: true,
          lockedBy: 'u2',
        },
      });
      expect(page).toContain('u2');
      expect(page).toContain('read only');
      expect(page).toContain('<h1>hello</h1>');
      expect(page).not.toContain('id="spec-source"');
    });

    it('escapes a script tag in the editor content', () => {
      const page = renderSpecPage({
        project: 'R:\\checkyourvibe',
        projectName: 'checkyourvibe',
        directories: [],
        open: {
          file: 'docs/specs/0099-fixture/requirements.md',
          content: '<script>alert(1)</script>',
          holder: 'u1',
          readOnly: false,
        },
      });
      expect(page).toContain('&lt;script&gt;');
      expect(page).not.toContain('<script>alert(1)</script>');
    });
  });
});
