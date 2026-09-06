import { describe, expect, it } from 'vitest';

import { pathsWrittenByOutsideSessions } from '../../src/dashboard/attribution.js';

const WINDOW = { openedAt: '2026-09-07T10:00:00.000Z', closedAt: '2026-09-07T10:30:00.000Z' };

describe('pathsWrittenByOutsideSessions', () => {
  it('names a path only an outliving session wrote', () => {
    const attributed = pathsWrittenByOutsideSessions({
      ...WINDOW,
      paths: ['packages/core/src/benchmark/harness.ts'],
      decisions: [
        // The orchestrator was writing before this dispatch opened.
        { at: '2026-09-07T09:40:00.000Z', target: 'R:\\repo\\README.md', session: 'orchestrator' },
        {
          at: '2026-09-07T10:12:00.000Z',
          target: 'R:\\repo\\packages\\core\\src\\benchmark\\harness.ts',
          session: 'orchestrator',
        },
      ],
    });

    expect(attributed).toEqual([
      { path: 'packages/core/src/benchmark/harness.ts', sessions: ['orchestrator'] },
    ]);
  });

  it('leaves a path the dispatch itself wrote attributed to the dispatch', () => {
    const attributed = pathsWrittenByOutsideSessions({
      ...WINDOW,
      paths: ['src/a.ts'],
      decisions: [
        { at: '2026-09-07T09:40:00.000Z', target: 'src/other.ts', session: 'orchestrator' },
        // Both wrote it; the dispatch's own write settles the attribution.
        { at: '2026-09-07T10:05:00.000Z', target: 'src/a.ts', session: 'orchestrator' },
        { at: '2026-09-07T10:06:00.000Z', target: 'src/a.ts', session: 'executor-in-window' },
      ],
    });

    expect(attributed).toEqual([]);
  });

  it('says nothing about a path no decision recorded', () => {
    const attributed = pathsWrittenByOutsideSessions({
      ...WINDOW,
      paths: ['src/never-seen.ts'],
      decisions: [
        { at: '2026-09-07T09:40:00.000Z', target: 'src/other.ts', session: 'orchestrator' },
        { at: '2026-09-07T10:05:00.000Z', target: 'src/other.ts', session: 'orchestrator' },
      ],
    });

    // Silence is not evidence of innocence any more than it is of guilt.
    expect(attributed).toEqual([]);
  });

  it('ignores writes outside the window', () => {
    const attributed = pathsWrittenByOutsideSessions({
      ...WINDOW,
      paths: ['src/a.ts'],
      decisions: [
        { at: '2026-09-07T09:00:00.000Z', target: 'src/a.ts', session: 'orchestrator' },
        { at: '2026-09-07T11:00:00.000Z', target: 'src/a.ts', session: 'orchestrator' },
      ],
    });

    expect(attributed).toEqual([]);
  });

  it('does not treat a session confined to the window as an outsider', () => {
    const attributed = pathsWrittenByOutsideSessions({
      ...WINDOW,
      paths: ['src/a.ts'],
      decisions: [
        { at: '2026-09-07T10:05:00.000Z', target: 'src/a.ts', session: 'executor-in-window' },
        { at: '2026-09-07T10:06:00.000Z', target: 'src/b.ts', session: 'executor-in-window' },
      ],
    });

    expect(attributed).toEqual([]);
  });
});
