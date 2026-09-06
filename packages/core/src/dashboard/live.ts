/**
 * Live update hub for the dashboard board.
 *
 * One shared watcher per project roots itself in the files that already hold
 * the board's state: the dispatch log, the comment store, and the session
 * registry. It tries `fs.watch` on each file and falls back to a server-side
 * stat check, so a browser connection never polls.
 */
import { watch, type FSWatcher } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatchLogPath } from '../executor/store.js';
import { stateStorePath } from './state-store.js';
import { lifecycleLogPath } from '../cli/hook.js';
import { REVIEW_DIR } from './review/comments.js';

const COMMENTS_FILE = 'comments.json';
const DEFAULT_STAT_INTERVAL_MS = 500;
const DEFAULT_DEBOUNCE_MS = 80;

export type LiveEventKind = 'dispatch' | 'comment' | 'session' | 'orchestrator';

export interface LiveEvent {
  kind: LiveEventKind;
  fragments: string[];
}

interface TrackedFile {
  path: string;
  exists: boolean;
  mtimeMs: number;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

/**
 * What the last non-empty line of the dispatch log says happened. Used to tell
 * an orchestrator self-report from a dispatch open/close/acknowledge/refusal.
 */
async function lastLogEventKind(path: string): Promise<'dispatch' | 'orchestrator' | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    // The file may not exist, be locked, or be unreadable; skip this round.
    return undefined;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return 'dispatch';
    }
    if (isRecord(parsed) && parsed.event === 'orchestrator') return 'orchestrator';
    return 'dispatch';
  }
  return undefined;
}

/**
 * Which regions each kind of change invalidates.
 *
 * These names must be regions the renderer serves. `liveFragmentRegions` is
 * exported so a test can hold this list against what it actually renders.
 *
 * A closed dispatch can land in any of the four columns depending on its
 * outcome and whether it carries an open note, so a dispatch event invalidates
 * all four rather than the two it named before.
 */
const FRAGMENTS_BY_KIND: Record<LiveEventKind, string[]> = {
  dispatch: ['status', 'todo', 'in-progress', 'done', 'decisions'],
  // An open note moves a card into Needs You, so a comment changes the columns
  // as well as the conversation.
  comment: ['conversation', 'drafts', 'decisions', 'in-progress', 'status'],
  // The status strip says whether a session is live.
  session: ['sessions', 'status'],
  orchestrator: ['status'],
};

/** Every region the live channel can ask a client to refresh. */
export function liveFragmentRegions(): string[] {
  return [...new Set(Object.values(FRAGMENTS_BY_KIND).flat())].sort();
}

class ProjectWatcher {
  private root: string;
  private intervalMs: number;
  private files: TrackedFile[];
  private listeners = new Set<(event: LiveEvent) => void>();
  private watchers: FSWatcher[] = [];
  private interval: ReturnType<typeof setInterval> | undefined;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  constructor(root: string, intervalMs: number) {
    this.root = root;
    this.intervalMs = intervalMs;
    this.files = [
      { path: dispatchLogPath(root), exists: false, mtimeMs: 0, size: 0 },
      { path: join(root, REVIEW_DIR, COMMENTS_FILE), exists: false, mtimeMs: 0, size: 0 },
      { path: stateStorePath(root), exists: false, mtimeMs: 0, size: 0 },
      // Session status is derived from hooks firing, so the log they append to
      // is the thing that changes when a session starts, takes a turn or ends.
      // Without it the most live thing on the board never pushed an update.
      { path: lifecycleLogPath(root), exists: false, mtimeMs: 0, size: 0 },
    ];
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;

    for (const file of this.files) {
      try {
        const watcher = watch(file.path, { persistent: false }, () => {
          this.onChange(file.path);
        });
        watcher.on('error', () => {
          // The stat interval will pick up the change if fs.watch misses it.
        });
        this.watchers.push(watcher);
      } catch (err) {
        if (isEnoent(err)) {
          // The file may not exist yet; the stat interval watches for creation.
          continue;
        }
        throw err;
      }
    }

    this.interval = setInterval(() => {
      void this.pollStats(); // Fire-and-forget: the stat loop keeps state in sync with the files.
    }, this.intervalMs);
    void this.pollStats(); // The first stat run is also fire-and-forget; it only updates watcher state.
  }

  private stop(): void {
    if (!this.started) return;
    this.started = false;

    for (const [path, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(path);
    }

    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private async pollStats(): Promise<void> {
    for (const file of this.files) {
      try {
        const current = await stat(file.path);
        if (!file.exists || current.mtimeMs !== file.mtimeMs || current.size !== file.size) {
          file.exists = true;
          file.mtimeMs = current.mtimeMs;
          file.size = current.size;
          this.onChange(file.path);
        }
      } catch (err) {
        if (isEnoent(err)) {
          if (file.exists) {
            file.exists = false;
            file.mtimeMs = 0;
            file.size = 0;
            this.onChange(file.path);
          }
        } else {
          throw err;
        }
      }
    }
  }

  private onChange(path: string): void {
    const existing = this.timers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.emitFor(path); // Fire-and-forget: classify and notify listeners asynchronously.
      }, DEFAULT_DEBOUNCE_MS),
    );
  }

  private async emitFor(path: string): Promise<void> {
    const kind = await this.classify(path);
    if (kind === undefined) return;
    const fragments = FRAGMENTS_BY_KIND[kind];
    const event: LiveEvent = { kind, fragments };
    for (const listener of this.listeners) listener(event);
  }

  private async classify(path: string): Promise<LiveEventKind | undefined> {
    if (path === dispatchLogPath(this.root)) {
      const last = await lastLogEventKind(path);
      if (last === undefined) return undefined;
      return last;
    }
    if (path === join(this.root, REVIEW_DIR, COMMENTS_FILE)) return 'comment';
    if (path === stateStorePath(this.root)) return 'session';
    if (path === lifecycleLogPath(this.root)) return 'session';
    return undefined;
  }
}

const hubs = new Map<string, ProjectWatcher>();

/**
 * Subscribe to live events for a project. The returned function stops the
 * subscription and tears down the file watchers when the last listener leaves.
 */
export function subscribeToProject(
  root: string,
  listener: (event: LiveEvent) => void,
  intervalMs = DEFAULT_STAT_INTERVAL_MS,
): () => void {
  let watcher = hubs.get(root);
  if (watcher === undefined) {
    watcher = new ProjectWatcher(root, intervalMs);
    hubs.set(root, watcher);
  }
  const unsubscribe = watcher.subscribe(listener);
  return () => {
    unsubscribe();
    if (watcher !== undefined && !watcher.hasListeners()) {
      hubs.delete(root);
    }
  };
}
