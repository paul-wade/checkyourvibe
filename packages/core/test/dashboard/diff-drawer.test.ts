import { describe, expect, it } from 'vitest';

import { diffDrawerCss, renderDiffDrawer } from '../../src/dashboard/diff-drawer.js';
import { dashboardCss } from '../../src/dashboard/styles.js';
import type { DispatchAssignment, DispatchRecord } from '../../src/executor/dispatch.js';
import type { DispatchOutcome, GateResult } from '../../src/executor/outcome.js';

const OPENED_AT = '2026-09-01T11:00:00.000Z';
const CLOSED_AT = '2026-09-01T11:30:00.000Z';

function assignmentOn(laneId: string): DispatchAssignment {
  return {
    laneId,
    agentId: `${laneId}-agent`,
    model: 'weak',
    billing: 'subscription',
    permitsBilledOverage: false,
    orchestrator: false,
    declaredHeadroomAtSchedule: 1,
  };
}

function outcome(overrides: Partial<DispatchOutcome> = {}): DispatchOutcome {
  return {
    kind: 'succeeded',
    summary: 'changed 1 declared file(s) and every gate passed',
    changedPaths: ['src/a.ts'],
    outOfScopePaths: [],
    failedGates: [],
    ...overrides,
  };
}

interface RecordOverrides {
  task?: string;
  laneId?: string;
  ownedPaths?: string[];
  outcome?: DispatchOutcome;
  gateResults?: GateResult[];
  /** Present to leave the record in flight: no close entry. */
  open?: boolean;
}

function record(dispatchId: string, overrides: RecordOverrides = {}): DispatchRecord {
  const open = overrides.open ?? false;
  return {
    dispatchId,
    workId: dispatchId,
    attempt: 1,
    openedAt: OPENED_AT,
    declaration: {
      task: overrides.task ?? 'T51004 build the diff drawer',
      taskKind: 'mechanical-transformation',
      ownedPaths: overrides.ownedPaths ?? ['src/a.ts', 'src/b.ts'],
      expectsFileChanges: true,
      gates: (overrides.gateResults ?? []).map((gate) => gate.gate),
    },
    assignment: assignmentOn(overrides.laneId ?? 'alpha'),
    ...(open
      ? {}
      : {
          closed: {
            closedAt: CLOSED_AT,
            report: { status: 'success', rateLimited: false },
            gateResults: overrides.gateResults ?? [],
            outcome: overrides.outcome ?? outcome(),
          },
        }),
  };
}

/**
 * The markup between one section's `data-section` marker and the next one (or
 * the end of the drawer), so an assertion can say a path is *in* a section
 * rather than merely in the drawer.
 */
function sectionSlice(html: string, key: string): string {
  const marker = `data-section="${key}"`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`section ${key} was not rendered`);
  const rest = html.slice(start);
  const next = rest.indexOf('data-section="', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('renderDiffDrawer', () => {
  it('renders a path in each of the three scope sections, in spec order', () => {
    const html = renderDiffDrawer({
      record: record('d-1', {
        ownedPaths: ['src/a.ts', 'src/b.ts'],
        outcome: outcome({
          changedPaths: ['src/a.ts', 'tools/x.ts'],
          outOfScopePaths: ['tools/x.ts'],
        }),
      }),
    });

    const at = (key: string): number => html.indexOf(`data-section="${key}"`);
    expect(at('in-scope')).toBeGreaterThanOrEqual(0);
    expect(at('in-scope')).toBeLessThan(at('out-of-scope'));
    expect(at('out-of-scope')).toBeLessThan(at('declared-unchanged'));

    const inScope = sectionSlice(html, 'in-scope');
    expect(inScope).toContain('src/a.ts');
    expect(inScope).not.toContain('tools/x.ts');
    expect(inScope).not.toContain('src/b.ts');

    const outOfScope = sectionSlice(html, 'out-of-scope');
    expect(outOfScope).toContain('tools/x.ts');
    expect(outOfScope).not.toContain('src/a.ts');

    const unchanged = sectionSlice(html, 'declared-unchanged');
    expect(unchanged).toContain('src/b.ts');
    expect(unchanged).not.toContain('src/a.ts');
    expect(unchanged).not.toContain('tools/x.ts');
  });

  it('names the paths another session wrote inside this dispatch’s window', () => {
    const html = renderDiffDrawer({
      record: record('d-others', {
        ownedPaths: ['src/a.ts'],
        outcome: outcome({
          changedPaths: ['src/a.ts', 'tools/x.ts'],
          outOfScopePaths: ['tools/x.ts'],
        }),
      }),
      writtenByOthers: [{ path: 'tools/x.ts', sessions: ['orchestrator'] }],
    });

    // The out-of-scope section still lists it: the file did change here. The
    // drawer just stops presenting it as this dispatch's write.
    expect(sectionSlice(html, 'out-of-scope')).toContain('tools/x.ts');
    const others = sectionSlice(html, 'written-by-others');
    expect(others).toContain('tools/x.ts');
    expect(others).toContain('orchestrator');
  });

  it('renders no such section when nothing is attributed elsewhere', () => {
    const html = renderDiffDrawer({
      record: record('d-clean', {
        ownedPaths: ['src/a.ts'],
        outcome: outcome({ changedPaths: ['src/a.ts'] }),
      }),
    });

    expect(html).not.toContain('data-section="written-by-others"');
  });

  it('lists a declared directory as unchanged when nothing beneath it changed', () => {
    const html = renderDiffDrawer({
      record: record('d-2', {
        ownedPaths: ['src/a.ts', 'docs'],
        outcome: outcome({ changedPaths: ['src/a.ts'] }),
      }),
    });

    const unchanged = sectionSlice(html, 'declared-unchanged');
    expect(unchanged).toContain('docs');
    expect(unchanged).not.toContain('src/a.ts');
  });

  it('shows the outcome kind, its summary, and each gate verdict', () => {
    const html = renderDiffDrawer({
      record: record('d-3', {
        outcome: outcome({
          kind: 'gates-failed',
          summary: 'gates failed: vitest',
          failedGates: ['vitest'],
        }),
        gateResults: [
          { gate: 'tsc', passed: true },
          { gate: 'vitest', passed: false, detail: '3 test(s) failed' },
        ],
      }),
    });

    const outcomeSection = sectionSlice(html, 'outcome');
    expect(outcomeSection).toContain('gates-failed');
    expect(outcomeSection).toContain('gates failed: vitest');

    const gates = sectionSlice(html, 'gates');
    expect(gates).toContain('tsc');
    expect(gates).toContain('passed');
    expect(gates).toContain('vitest');
    expect(gates).toContain('failed');
    expect(gates).toContain('3 test(s) failed');
  });

  // A failed gate was a count and nothing else, so a reader could see that a
  // dispatch had been refused and never what for. Dispatch w60 failed on "2
  // error(s) across 5 file(s)" and there was no way to find out which two.
  it('names what a failed gate objected to, not only how many', () => {
    const html = renderDiffDrawer({
      record: record('d-4', {
        outcome: outcome({ kind: 'gates-failed', summary: 'gates failed: cyv-check', failedGates: ['cyv-check'] }),
        gateResults: [
          {
            gate: 'cyv-check',
            passed: false,
            detail: '2 error(s), 0 warning(s) across 5 file(s) the dispatch changed',
            findings: [
              {
                path: 'packages/core/src/a.ts',
                line: 12,
                column: 5,
                ruleId: 'no-any',
                message: 'This binding has an inferred `any` type.',
              },
            ],
          },
        ],
      }),
    });

    const gates = sectionSlice(html, 'gates');
    expect(gates).toContain('no-any');
    expect(gates).toContain('packages/core/src/a.ts:12:5');
    expect(gates).toContain('This binding has an inferred');
    // The count stays: it says how much is not listed.
    expect(gates).toContain('2 error(s)');
  });

  it('refuses a dispatch still in motion and says why', () => {
    const html = renderDiffDrawer({ record: record('d-open', { open: true }) });

    expect(html).toContain('data-reviewable="false"');
    expect(html).toContain('d-open');
    expect(html).toContain('still in motion');
    expect(html).toContain('Not reviewable');
    expect(html).not.toContain('data-section="in-scope"');
    expect(html).not.toContain('data-section="outcome"');
    expect(html).not.toContain('drawer-difit-link');
  });

  it('renders a designed empty state for a dispatch that changed nothing', () => {
    const html = renderDiffDrawer({
      record: record('d-4', {
        outcome: outcome({
          kind: 'produced-nothing',
          summary: 'the executor reported success and none of its declared files changed',
          changedPaths: [],
        }),
      }),
    });

    expect(html).toContain('changed no files');
    // Everything declared is declared-but-unchanged.
    const unchanged = sectionSlice(html, 'declared-unchanged');
    expect(unchanged).toContain('src/a.ts');
    expect(unchanged).toContain('src/b.ts');
    expect(sectionSlice(html, 'out-of-scope')).toContain('No write outside');
  });

  it('keeps the line-level diff in the Diff tab, not a link away', () => {
    const html = renderDiffDrawer({ record: record('d-5') });

    const diff = sectionSlice(html, 'diff');
    expect(diff).toContain('Diff tab');
    expect(diff).toContain('difit');
    expect(html).not.toContain('href="/diff"');
    expect(html).not.toContain('cyv-diff-add');
    expect(html).not.toContain('cyv-diff-remove');
  });

  it('ignores a caller-supplied diff href; the Diff tab starts difit', () => {
    const html = renderDiffDrawer({ record: record('d-6'), diffHref: '/diff?d=staged' });

    expect(html).not.toContain('href="/diff?d=staged"');
    expect(sectionSlice(html, 'diff')).toContain('Diff tab');
  });

  it('escapes markup that arrives in paths, gate names and task text', () => {
    const nasty = 'src/<img src=x onerror="alert(1)">.ts';
    const html = renderDiffDrawer({
      record: record('d-7', {
        task: 'T1 <b>bold</b>',
        ownedPaths: [nasty],
        outcome: outcome({ changedPaths: [nasty] }),
        gateResults: [{ gate: 'gate<script>', passed: true }],
      }),
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('gate<script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('gate&lt;script&gt;');
  });

  it('is a self-contained fragment: no script, no external resource, no second stylesheet', () => {
    const html = renderDiffDrawer({ record: record('d-8') });

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<style');
  });
});

describe('diffDrawerCss', () => {
  it('references only declared custom properties and no literal colours', () => {
    const css = diffDrawerCss();
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/i);

    const defined = new Set(dashboardCss().match(/--cyv-[a-z-]+(?=:)/g) ?? []);
    const used = css.match(/(?<=var\()--cyv-[a-z-]+(?=\))/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      expect(defined.has(token)).toBe(true);
    }
  });
});
