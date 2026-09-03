import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { relative, resolve as resolvePath, sep } from 'node:path';
import picomatch from 'picomatch';
import { loadConfig } from '../config/load.js';
import type { CheckYourVibeConfig } from '../config/types.js';
import { resolveRules } from '../config/resolve.js';
import { loadAnalyzers, allRules } from '../registry/load.js';
import { validateRules } from '../guidance/validate.js';
import { routeFiles } from './route.js';
import { runAnalyzer } from './execute.js';
import {
  PROTOCOL_VERSION,
  type AnalyzeRequest,
  type AnalyzerManifest,
  type Diagnostic,
  type RuleGuidance,
  type RuleManifest,
  type RuleSettings,
  type SkippedFile,
  type Violation,
} from '../protocol/index.js';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

export interface WatchOptions {
  repoRoot: string;
  /** Files or directories to watch, absolute or repo-relative. */
  paths: string[];
  onRun(result: WatchRunResult): void;
  /**
   * Called when a debounced run fails.
   *
   * A watch run is fired from a timer, so there is no caller left to await it
   * and nothing to propagate a rejection to. Without this the failure becomes
   * an unhandled rejection: the process either dies mid-session or, worse,
   * carries on watching while silently having stopped reporting.
   */
  onError?(error: unknown): void;
  debounceMs?: number;
}

export interface WatchRunResult {
  changedFiles: string[];
  violations: Violation[];
  skipped: SkippedFile[];
  diagnostics: Diagnostic[];
  durationMs: number;
}

export interface WatchHandle {
  close(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Directory names never worth reacting to. This is a fast, cheap filter
 * applied before the (comparatively expensive) config-`exclude` glob check —
 * most noise in a real repository is a package manager or build tool writing
 * inside one of these, and matching on path segments avoids compiling a glob
 * matcher against every single filesystem event.
 */
const IGNORED_SEGMENTS = new Set(['node_modules', 'dist', '.git']);

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function isIgnoredRelativePath(relPath: string): boolean {
  for (const segment of relPath.split(/[\\/]/)) {
    if (IGNORED_SEGMENTS.has(segment)) {
      return true;
    }
  }
  return false;
}

function guidanceFor(rule: RuleManifest): RuleGuidance {
  return {
    summary: rule.summary,
    why: rule.why,
    allowedFixes: rule.allowedFixes,
    notFixes: rule.notFixes,
    examples: rule.examples,
  };
}

/**
 * `file`-mode rules only: watch mode always analyses a partial, just-changed
 * file set, never the whole tree, so a project-scope rule (which needs the
 * whole tree to mean anything) would either be misleading or require a full
 * re-scan on every keystroke — the exact cost this module exists to avoid.
 */
function rulesForWatch(
  manifest: AnalyzerManifest,
  resolved: Map<string, RuleSettings>,
): Record<string, RuleSettings> {
  const rules: Record<string, RuleSettings> = {};
  for (const rule of manifest.rules) {
    if (rule.scope === 'project') {
      continue;
    }
    const settings = resolved.get(rule.id);
    if (settings !== undefined) {
      rules[rule.id] = settings;
    }
  }
  return rules;
}

function optionsFor(config: CheckYourVibeConfig, analyzerId: string): Record<string, unknown> | undefined {
  return config.analyzers.find((entry) => entry.id === analyzerId)?.options;
}

/**
 * `exec.type: 'process'` analyzers cannot hold a warm state between runs —
 * every invocation is a fresh subprocess, which is strictly worse for watch
 * mode than the in-process cold start it's trying to avoid (Requirement
 * 4.10). Rather than dropping them from the run silently, which would mean a
 * whole language quietly stops being checked while the watcher still looks
 * healthy, every run carries a diagnostic naming the analyzer and why.
 */
function processSkipDiagnostic(manifest: AnalyzerManifest): Diagnostic {
  return {
    level: 'warn',
    message:
      `Analyzer "${manifest.id}" is skipped in watch mode: it runs as a subprocess ` +
      `(exec.type: 'process'), which cannot hold a warm analyzer instance across runs. ` +
      `Watch mode only supports in-process ('node') analyzers. Run "cyv check" to include it.`,
  };
}

interface WatchState {
  config: CheckYourVibeConfig;
  nodeManifests: AnalyzerManifest[];
  resolved: Map<string, RuleSettings>;
  ruleById: Map<string, RuleManifest>;
  processSkipDiagnostics: Diagnostic[];
  isExcluded: (relPosixPath: string) => boolean;
}

/**
 * Load configuration, manifests, and resolved rules exactly once, before the
 * first filesystem event. Loading is what's expensive (spinning up a real
 * compiler project is the whole reason a keystroke-per-rebuild is
 * unusable) — doing it once and reusing the same `AnalyzerManifest` objects
 * for every subsequent run is what lets `runAnalyzer`'s `import()` of a node
 * analyzer's module resolve from Node's module cache instead of re-executing
 * the module (and losing whatever warm state it holds) on every change.
 */
async function loadWatchState(repoRoot: string): Promise<WatchState> {
  const config = await loadConfig(repoRoot);
  const manifests = await loadAnalyzers(config.analyzers, repoRoot);
  const catalog = allRules(manifests);
  validateRules(catalog);

  const resolved = resolveRules(config, catalog);
  const ruleById = new Map(catalog.map((rule) => [rule.id, rule]));

  const nodeManifests = manifests.filter((manifest) => manifest.exec.type === 'node');
  const processSkipDiagnostics = manifests
    .filter((manifest) => manifest.exec.type === 'process')
    .map(processSkipDiagnostic);

  const isExcluded =
    config.exclude.length > 0 ? picomatch(config.exclude, { dot: true }) : (): boolean => false;

  return { config, nodeManifests, resolved, ruleById, processSkipDiagnostics, isExcluded };
}

async function runOnce(
  state: WatchState,
  repoRoot: string,
  changedFiles: string[],
): Promise<WatchRunResult> {
  const start = Date.now();
  const violations: Violation[] = [];
  const skipped: SkippedFile[] = [];
  const diagnostics: Diagnostic[] = [...state.processSkipDiagnostics];

  const { routed } = routeFiles(changedFiles, state.nodeManifests, repoRoot, state.config.exclude);

  for (const manifest of state.nodeManifests) {
    const files = routed.get(manifest.id);
    if (files === undefined || files.length === 0) {
      continue;
    }

    const rules = rulesForWatch(manifest, state.resolved);
    const options = optionsFor(state.config, manifest.id);
    const request: AnalyzeRequest = {
      protocol: PROTOCOL_VERSION,
      repoRoot,
      mode: 'file',
      files,
      rules,
      ...(options !== undefined ? { options } : {}),
    };

    // Same `manifest` object, same `manifest.exec.module` string, every run:
    // this is the reuse that keeps a node analyzer's project warm.
    const response = await runAnalyzer(manifest, request, repoRoot);

    for (const violation of response.violations) {
      const rule = state.ruleById.get(violation.ruleId);
      violations.push(rule !== undefined ? { ...violation, guidance: guidanceFor(rule) } : violation);
    }
    skipped.push(...response.skipped);
    diagnostics.push(...response.diagnostics);
  }

  return { changedFiles, violations, skipped, diagnostics, durationMs: Date.now() - start };
}

/**
 * Watch `paths` for changes and re-run the configured node-shaped analyzers
 * against exactly the files that changed, in `file` mode, reusing the same
 * loaded manifests across every run so an analyzer's in-process state (a warm
 * ts-morph `Project`, for example) survives from one keystroke to the next.
 *
 * `node:fs`'s own recursive watch is used deliberately — chokidar is not a
 * dependency of this project, and the recursive option is available on the
 * platforms this tool targets.
 */
export async function watch(options: WatchOptions): Promise<WatchHandle> {
  const { repoRoot, paths, onRun } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const onError = options.onError;

  const state = await loadWatchState(repoRoot);

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();

  function scheduleFlush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      // `void flush()` was here, and `no-floating-promise` was right about it
      // on the first run of the rule against this repository. `flush` awaits
      // `runOnce`, which throws when an analyzer fails — a subprocess analyzer
      // that is not installed is enough. `void` silences the compiler, not the
      // rejection, so the failure surfaced as an unhandled rejection from a
      // timer with no caller: the session either died or kept watching while
      // having quietly stopped checking anything.
      flush().catch((error: unknown) => {
        if (onError !== undefined) {
          onError(error);
          return;
        }
        // Better to end loudly than to keep a watch session that no longer
        // reports. A caller that wants to survive a failed run passes onError.
        throw error;
      });
    }, debounceMs);
  }

  function schedule(absPath: string): void {
    if (closed) {
      return;
    }

    const rel = relative(repoRoot, absPath);
    if (rel.startsWith('..')) {
      // Outside the repository root entirely — not something this run can
      // meaningfully attribute a rule violation to.
      return;
    }
    if (isIgnoredRelativePath(rel) || state.isExcluded(toPosix(rel))) {
      return;
    }

    pending.add(absPath);
    scheduleFlush();
  }

  async function flush(): Promise<void> {
    if (closed || pending.size === 0) {
      return;
    }

    const batch = [...pending];
    pending.clear();

    const existing: string[] = [];
    for (const file of batch) {
      if (await fileExists(file)) {
        existing.push(file);
      }
    }

    if (closed || existing.length === 0) {
      return;
    }

    const result = await runOnce(state, repoRoot, existing);
    if (!closed) {
      onRun(result);
    }
  }

  const watchers: FSWatcher[] = [];
  for (const target of paths) {
    const absTarget = resolvePath(repoRoot, target);
    const watcher = fsWatch(absTarget, { recursive: true }, (_eventType, filename) => {
      if (filename === null) {
        return;
      }
      schedule(resolvePath(absTarget, filename));
    });
    // A watched path disappearing (e.g. a directory removed mid-session)
    // must not crash the process; the remaining watchers keep working, and
    // the next run simply won't see changes under the removed path.
    watcher.on('error', () => undefined);
    watchers.push(watcher);
  }

  return {
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending.clear();
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}
