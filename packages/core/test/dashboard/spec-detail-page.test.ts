import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isValidSpecId,
  renderSpecDetailPage,
  toSpecTab,
  type SpecTab,
} from '../../src/dashboard/spec-detail-page.js';
import { renderLanesPage } from '../../src/dashboard/lanes-page.js';
import { renderTasksPage, type TasksPageInput } from '../../src/dashboard/tasks-page.js';
import { topNavHtml } from '../../src/dashboard/nav.js';
import { findSpecs } from '../../src/dashboard/review/specs.js';
import { safeResolve } from '../../src/dashboard/review/documents.js';
import type { ParsedSpec, SpecTask } from '../../src/dashboard/review/specs.js';
import type { LaneDeclaration } from '../../src/executor/lane.js';

const PROJECT = '/repo';
const PROJECT_NAME = 'repo';
const SPEC_ID = '0051-kanban-diff-drawer';

describe('isValidSpecId', () => {
  it('rejects empty, dot, dot-dot, and any path separator', () => {
    expect(isValidSpecId('')).toBe(false);
    expect(isValidSpecId('.')).toBe(false);
    expect(isValidSpecId('..')).toBe(false);
    expect(isValidSpecId('../../etc')).toBe(false);
    expect(isValidSpecId('foo/bar')).toBe(false);
    expect(isValidSpecId('foo\\bar')).toBe(false);
  });

  it('accepts ordinary spec directory names', () => {
    expect(isValidSpecId('0051-kanban-diff-drawer')).toBe(true);
    expect(isValidSpecId('0001-core-vertical-slice')).toBe(true);
  });
});

describe('toSpecTab', () => {
  it('recognises the three tab values', () => {
    expect(toSpecTab('requirements')).toBe('requirements');
    expect(toSpecTab('design')).toBe('design');
    expect(toSpecTab('tasks')).toBe('tasks');
  });

  it('falls back to requirements for an unknown or absent value', () => {
    expect(toSpecTab('intro')).toBe('requirements');
    expect(toSpecTab(null)).toBe('requirements');
    expect(toSpecTab(undefined)).toBe('requirements');
  });
});

describe('renderSpecDetailPage', () => {
  it('renders all three tabs and marks the active one', () => {
    const page = renderSpecDetailPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      tab: 'requirements',
      files: {
        requirements: '# Requirements',
        design: '## Design',
        tasks: '- one\n- two',
      },
    });

    expect(page).toContain('<title>repo · 0051 · kanban diff drawer</title>');
    expect(page).toMatch(/class="sp-tab active"[^>]*href="[^"]*tab=requirements"/);
    expect(page).toContain('Requirements</a>');
    expect(page).toContain('Design</a>');
    expect(page).toContain('Tasks</a>');
    expect(page).toContain('tab=design');
    expect(page).toContain('tab=tasks');
    expect(page).toContain('<h1>Requirements</h1>');
    expect(page).not.toContain('This spec has no');
  });

  it('switches to the selected tab and renders its markdown', () => {
    const page = renderSpecDetailPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      tab: 'design',
      files: {
        requirements: '# Requirements',
        design: '## Design body',
        tasks: '- one',
      },
    });

    expect(page).toContain('<h2>Design body</h2>');
    expect(page).toMatch(/class="sp-tab active"[^>]*href="[^"]*tab=design"/);
  });

  it('says a missing file is missing and names the path it would use', () => {
    const page = renderSpecDetailPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      tab: 'design',
      files: {
        requirements: '# Requirements',
      },
    });

    expect(page).toContain('This spec has no Design file');
    expect(page).toContain('docs/specs/0051-kanban-diff-drawer/design.md');
    expect(page).not.toContain('<h2>');
  });

  it('renders an unknown or malformed spec as an error page with no tabs', () => {
    const page = renderSpecDetailPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      specId: 'unknown',
      tab: 'requirements',
      error: 'No spec "unknown" exists in this project.',
    });

    expect(page).toContain('No spec &quot;unknown&quot; exists in this project.');
    expect(page).not.toContain('sp-tab active');
    expect(page).not.toContain('tab=requirements');
    expect(page).toContain('rendered on request — not updated automatically');
  });

  it('uses the same header markup as the /lanes page', () => {
    const specPage = renderSpecDetailPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      tab: 'requirements',
    });
    const lanesPage = renderLanesPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      lanes: [],
      undeclared: [],
      none: true,
      now: 0,
    });

    const specHeader = specPage.match(/<header class="cyv-header">[\s\S]*?<\/header>/)?.[0] ?? '';
    const lanesHeader = lanesPage.match(/<header class="cyv-header">[\s\S]*?<\/header>/)?.[0] ?? '';

    expect(specHeader).toBe(topNavHtml(PROJECT_NAME, PROJECT, '/specs'));
    expect(lanesHeader).toBe(topNavHtml(PROJECT_NAME, PROJECT, '/lanes'));
  });

  it('does not claim to be live', () => {
    const page = renderSpecDetailPage({
      project: PROJECT,
      projectName: PROJECT_NAME,
      specId: SPEC_ID,
      tab: 'requirements',
      files: { requirements: '# Requirements' },
    });

    expect(page).toContain('rendered on request — not updated automatically');
    expect(page).not.toContain('polling');
    expect(page).not.toContain('updated just now');
  });
});

describe('renderSpecDetailPage from disk', () => {
  async function tempRepo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'cyv-spec-'));
    const base = join(dir, 'docs', 'specs', '0001-fixture');
    await mkdir(base, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(base, name), content, 'utf8');
    }
    return dir;
  }

  async function loadSpecFiles(repo: string, specId: string): Promise<Partial<Record<SpecTab, string>>> {
    const files: Partial<Record<SpecTab, string>> = {};
    for (const tab of ['requirements', 'design', 'tasks'] as const) {
      const rel = `docs/specs/${specId}/${tab}.md`;
      const full = await safeResolve(repo, rel);
      if (full !== null) {
        files[tab] = await readFile(full, 'utf8');
      }
    }
    return files;
  }

  it('reads a spec with all three files and renders each tab', async () => {
    const repo = await tempRepo({
      'requirements.md': '# Fixture requirements',
      'design.md': '## Fixture design',
      'tasks.md': '- [ ] T1001 do the thing',
    });
    const specs = await findSpecs(repo);
    expect(specs.some((candidate) => candidate.id === '0001-fixture')).toBe(true);

    const files = await loadSpecFiles(repo, '0001-fixture');
    const tasksPage = renderSpecDetailPage({
      project: repo,
      projectName: 'fixture',
      specId: '0001-fixture',
      tab: 'tasks',
      files,
    });
    expect(tasksPage).toContain('<li>[ ] T1001 do the thing</li>');

    const designPage = renderSpecDetailPage({
      project: repo,
      projectName: 'fixture',
      specId: '0001-fixture',
      tab: 'design',
      files,
    });
    expect(designPage).toContain('<h2>Fixture design</h2>');
  });

  it('reads a spec with only requirements and marks the others as missing', async () => {
    const repo = await tempRepo({
      'requirements.md': '# Only requirements',
    });
    const files = await loadSpecFiles(repo, '0001-fixture');
    const page = renderSpecDetailPage({
      project: repo,
      projectName: 'fixture',
      specId: '0001-fixture',
      tab: 'design',
      files,
    });

    expect(page).toContain('This spec has no Design file');
    expect(page).toContain('docs/specs/0001-fixture/design.md');
  });
});

describe('/tasks still links each spec header to /spec', () => {
  function task(id: string, title: string, specId: string): SpecTask {
    return {
      id,
      title,
      done: false,
      executor: 'unknown',
      model: '',
      kind: '',
      gates: '',
      files: [],
      dependsOn: [],
      specId,
      line: 1,
    };
  }

  function spec(id: string, tasks: readonly SpecTask[]): ParsedSpec {
    return {
      id,
      tasksPath: `docs/specs/${id}/tasks.md`,
      sections: tasks.length > 0 ? [{ title: 'Open', tasks: [...tasks] }] : [],
      done: tasks.filter((entry) => entry.done).length,
      total: tasks.length,
    };
  }

  const LANE: LaneDeclaration = {
    id: 'devin-cli',
    agentId: 'devin',
    concurrencyCap: 1,
    billing: { kind: 'subscription', permitsBilledOverage: false },
    models: [{ kind: 'mechanical-transformation', ordering: ['m'] }],
    orchestrator: false,
    acceptsDispatch: true,
  };

  function input(over: Partial<TasksPageInput> = {}): TasksPageInput {
    return {
      project: PROJECT,
      projectName: PROJECT_NAME,
      specs: over.specs ?? [],
      records: over.records ?? [],
      lanes: over.lanes ?? [LANE],
      spec: over.spec ?? '',
      state: over.state ?? '',
      forTask: over.forTask ?? '',
      ...(over.now === undefined ? {} : { now: over.now }),
    };
  }

  it('keeps the filters and list and links each spec header to /spec', () => {
    const html = renderTasksPage(
      input({
        specs: [
          spec('0002-second', [task('T2001', 'newer', '0002-second')]),
          spec('0001-first', [task('T1001', 'older', '0001-first')]),
        ],
      }),
    );

    expect(html).toContain('id="tk-filter"');
    expect(html).toContain('T2001');
    expect(html).toContain('T1001');
    expect(html).toContain('0002 · second');
    expect(html).toContain('0001 · first');
    expect(html).toContain('href="/spec?p=%2Frepo&amp;spec=0002-second"');
    expect(html).toContain('href="/spec?p=%2Frepo&amp;spec=0001-first"');
  });
});
