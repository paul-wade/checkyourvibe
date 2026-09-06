/**
 * Who actually wrote the files a dispatch is being blamed for.
 *
 * A dispatch's outcome compares the working tree before it opened against the
 * tree after it closed. Anything that appeared in between is recorded as its
 * change, and a path outside its declaration is recorded as an out-of-scope
 * write. That comparison cannot tell two writers apart, so a person editing
 * the repository while a dispatch runs is charged to the dispatch. It happened
 * three times on 2026-09-07 and the board showed three sound dispatches as
 * having written files they did not declare.
 *
 * The gate's decision log knows better: it records every proposed write with a
 * timestamp, a target, and the session that proposed it. A session whose writes
 * begin before the dispatch opened, or continue after it closed, outlived the
 * dispatch and is therefore not it — a dispatch's executor session exists only
 * inside its own window.
 */

/** One proposed write, as the gate's decision log records it. */
export interface WriteRecord {
  at: string;
  target?: string | undefined;
  session?: string | undefined;
}

export interface AttributedPath {
  path: string;
  /** Sessions that wrote it during the window and existed outside the window. */
  sessions: string[];
}

export interface AttributionInput {
  openedAt: string;
  closedAt: string;
  paths: readonly string[];
  decisions: readonly WriteRecord[];
}

function time(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** Whether a decision's target names the same file as a repo-relative path. */
function namesSameFile(target: string, path: string): boolean {
  const left = normalize(target);
  const right = normalize(path);
  if (left === right) return true;
  return left.endsWith(`/${right}`);
}

/**
 * The paths among `paths` that only sessions outliving the window wrote.
 *
 * A path no decision covers is not returned: silence is not evidence, and
 * claiming a dispatch is innocent because nothing was recorded would be the
 * same mistake in the other direction.
 */
export function pathsWrittenByOutsideSessions(input: AttributionInput): AttributedPath[] {
  const opened = time(input.openedAt);
  const closed = time(input.closedAt);
  if (Number.isNaN(opened) || Number.isNaN(closed)) return [];

  const spans = new Map<string, { first: number; last: number }>();
  for (const decision of input.decisions) {
    const session = decision.session;
    if (session === undefined || session === '') continue;
    const at = time(decision.at);
    if (Number.isNaN(at)) continue;
    const span = spans.get(session);
    if (span === undefined) {
      spans.set(session, { first: at, last: at });
      continue;
    }
    if (at < span.first) span.first = at;
    if (at > span.last) span.last = at;
  }

  const outlives = (session: string): boolean => {
    const span = spans.get(session);
    if (span === undefined) return false;
    return span.first < opened || span.last > closed;
  };

  const attributed: AttributedPath[] = [];
  for (const path of input.paths) {
    const outside = new Set<string>();
    let inside = 0;
    for (const decision of input.decisions) {
      const target = decision.target;
      const session = decision.session;
      if (target === undefined || session === undefined || session === '') continue;
      const at = time(decision.at);
      if (Number.isNaN(at) || at < opened || at > closed) continue;
      if (!namesSameFile(target, path)) continue;
      if (outlives(session)) {
        outside.add(session);
      } else {
        inside += 1;
      }
    }
    // A path the dispatch itself was recorded writing stays the dispatch's,
    // whoever else touched it. Only a path every recorded writer of which
    // outlived the window is somebody else's.
    if (inside === 0 && outside.size > 0) {
      attributed.push({ path, sessions: [...outside].sort() });
    }
  }
  return attributed;
}
