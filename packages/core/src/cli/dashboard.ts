import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../config/load.js';
import { configuredLanes } from '../config/lanes.js';
import { resolveRules } from '../config/resolve.js';
import { allRules, loadAnalyzers } from '../registry/load.js';
import { repoRoot } from '../run/discover.js';
import { renderDashboard, renderVolatilePanels } from '../dashboard/render.js';
import { readHistory } from '../dashboard/history.js';
import { readLatestRun, type LatestRun } from '../dashboard/latest.js';
import { readExecutorView, type ExecutorView } from '../dashboard/executor-view.js';
import { loadSuppressions, readBaseline } from '../baseline/index.js';
import { buildHomePage } from '../dashboard/home-model.js';
import { renderHome } from '../dashboard/home.js';
import {
  renderDiffPage,
  renderDocsPage,
  renderEditPage,
  renderViewPage,
} from '../dashboard/pages.js';
import type { ShellOptions } from '../dashboard/shell.js';
import { normalizeProjectPath, readRegistry } from '../dashboard/projects.js';
import {
  addComment,
  commentsToExchange,
  loadComments,
  setCommentStatus,
} from '../dashboard/review/comments.js';
import {
  fileMtime,
  findMarkdown,
  safeResolve,
  splitSections,
} from '../dashboard/review/documents.js';
import {
  difitComments,
  difitInstanceStates,
  instanceById,
  startDifit,
} from '../dashboard/review/difit.js';
import { proxyToDifit } from '../dashboard/review/difit-proxy.js';
import { gitLog } from '../dashboard/review/progress.js';
import { parseAllSpecs } from '../dashboard/review/specs.js';
import { readStatusLog } from '../dashboard/review/status-log.js';
import { stopDispatch } from '../dashboard/stop.js';
import { acknowledgeItem, dispatchLogPath } from '../executor/store.js';
import { isUnknownArray } from '../guards.js';
import type { RuleManifest } from '../protocol/index.js';
import type { RunRecord } from '../dashboard/history.js';
import type { Baseline, Suppression } from '../baseline/index.js';
import type { LaneDeclaration } from '../executor/lane.js';
import type { Command, CommandContext } from './types.js';

const DEFAULT_PORT = 4300;

/** Names the difit port the diff frame is proxying for this browser. */
const DIFIT_COOKIE = 'cyv_difit';

/** The dashboard's own `/api/` routes; anything else under `/api/` belongs to difit. */
const OWN_API_PATHS = new Set([
  '/api/state',
  '/api/comment',
  '/api/comment/status',
  '/api/acknowledge',
  '/api/stop',
  '/api/save',
  '/api/difit/start',
]);

/** A path difit's page fetches: its bundle, its icons, and its API. */
function isDifitPath(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  if (pathname === '/favicon.svg' || pathname === '/favicon-white.svg') return true;
  return pathname.startsWith('/api/') && !OWN_API_PATHS.has(pathname);
}

function difitPortFrom(cookieHeader: string | undefined): number | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name !== DIFIT_COOKIE || value === undefined) continue;
    const port = Number.parseInt(value, 10);
    if (Number.isFinite(port) && port > 0 && port < 65536) return port;
  }
  return undefined;
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => n !== undefined)
    .filter((n) => n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

function hasErrorCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && hasErrorCode(err) && err.code === 'ENOENT';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Whether `checkyourvibe.json` declares a `suppressions` key at all, as
 * distinct from `loadSuppressions` returning an empty array — which happens
 * both when the key is absent and when it is present but empty. The rules page
 * keeps those two facts apart.
 */
async function suppressionsConfigured(root: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(root, CONFIG_FILENAME), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed.suppressions !== undefined;
}

/** The parsed, on-disk inputs the rules page renders from. Nothing here executes an analyzer. */
interface VolatileInputs {
  history: RunRecord[];
  baseline: Baseline | null;
  suppressions: Suppression[];
  configured: boolean;
  latest: LatestRun | null;
  executor: ExecutorView;
}

async function readVolatileInputs(
  root: string,
  lanes: readonly LaneDeclaration[],
): Promise<VolatileInputs> {
  const [history, baseline, suppressions, configured, latest, executor] = await Promise.all([
    readHistory(root),
    readBaseline(root),
    loadSuppressions(root),
    suppressionsConfigured(root),
    readLatestRun(root),
    readExecutorView(root, lanes),
  ]);
  return { history, baseline, suppressions, configured, latest, executor };
}

/** The static half of the rules page for one project, loaded once per root. */
interface RulesContext {
  lanes: readonly LaneDeclaration[];
  enabled: RuleManifest[];
  analyzerIds: string[];
  ruleAnalyzers: Record<string, string>;
}

async function loadRulesContext(root: string): Promise<RulesContext> {
  const config = await loadConfig(root);
  const lanes = configuredLanes(config);
  const manifests = await loadAnalyzers(config.analyzers, root);
  const available = allRules(manifests);
  const enabledIds = new Set(resolveRules(config, available).keys());
  const enabled = available.filter((rule) => enabledIds.has(rule.id));
  const ruleAnalyzers: Record<string, string> = {};
  for (const manifest of manifests) {
    for (const rule of manifest.rules) ruleAnalyzers[rule.id] = manifest.id;
  }
  return { lanes, enabled, analyzerIds: manifests.map((m) => m.id), ruleAnalyzers };
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf('--port');
  if (index === -1) return DEFAULT_PORT;
  const raw = argv[index + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readBody(req));
  if (!isRecord(parsed)) throw new Error('expected a JSON object');
  return parsed;
}

/**
 * A key that changes whenever anything the home page shows could have changed:
 * the dispatch log, the comment store, the last run, the working tree, and
 * every spec's task list. The page polls it and reloads on a change, so a
 * reader on a phone sees a dispatch open without pulling to refresh.
 */
async function stateKey(root: string): Promise<string> {
  const files = [
    dispatchLogPath(root),
    join(root, '.cyv-review', 'comments.json'),
    join(root, '.cyv-review', 'latest-run.json'),
    join(root, '.git', 'index'),
    join(root, '.git', 'HEAD'),
  ];
  const specs = await parseAllSpecs(root);
  for (const spec of specs.specs) {
    if (spec.tasksPath !== null) files.push(join(root, spec.tasksPath));
  }
  const stamps: string[] = [];
  for (const file of files) {
    try {
      stamps.push(String(Math.floor((await stat(file)).mtimeMs)));
    } catch {
      stamps.push('-');
    }
  }
  return stamps.join(':');
}

export interface DashboardServerOptions {
  /** The repository `cyv dashboard` was started in; served when nothing is registered. */
  root: string;
  /** Overrides the registry read from the home directory, for tests. */
  registry?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** A configured, not-yet-listening dashboard server. */
export interface DashboardServer {
  server: Server;
  /** The roots the server will serve. */
  projects: readonly string[];
}

type Send = (code: number, type: string, body: string) => void;

/**
 * Build the dashboard's HTTP server: one server, every registered project,
 * the home page first and the rules page one tab away (spec 0040 R1, R7, R8).
 *
 * Nothing served here runs an analyzer or an executor. The two writes the
 * server makes on request are a comment and a guarded document save; the one
 * process it ends is a running dispatch a person stopped.
 */
export async function createDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServer> {
  const env = options.env ?? process.env;
  const registry = options.registry ?? (await readRegistry());
  // With nothing registered the checkout the command ran in stands in, as one
  // project that happens to be there, not as the subject of every route.
  const projects = registry.length > 0 ? registry : [normalizeProjectPath(options.root)];
  const rulesContexts = new Map<string, Promise<RulesContext>>();

  const rulesFor = (root: string): Promise<RulesContext> => {
    const cached = rulesContexts.get(root);
    if (cached !== undefined) return cached;
    const loading = loadRulesContext(root);
    rulesContexts.set(root, loading);
    return loading;
  };

  /**
   * The project a request is about. `?p=` names it; an unregistered root is
   * refused rather than served, because the query string decides which
   * directory's files are read.
   */
  const resolveProject = (url: URL): string | null => {
    const asked = url.searchParams.get('p');
    if (asked === null || asked === '') return projects[0] ?? null;
    const normalized = normalizeProjectPath(asked);
    return projects.includes(normalized) ? normalized : null;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send: Send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code: number, value: unknown): void =>
      send(code, 'application/json; charset=utf-8', JSON.stringify(value));
    const html = (code: number, body: string): void =>
      send(code, 'text/html; charset=utf-8', body);

    if (url.pathname === '/vendor/marked.min.js') {
      const file = new URL('../../vendor/marked.min.js', import.meta.url);
      send(200, 'text/javascript; charset=utf-8', await readFile(file, 'utf-8'));
      return;
    }

    // The diff frame. difit is served through this origin so the page can
    // style it for a phone; which difit is meant travels in a cookie, because
    // difit's own page fetches absolute paths that carry no instance of their
    // own. The instance id is a configured one or `port-N` for one discovered.
    if (url.pathname === '/frame') {
      const entry = instanceById(url.searchParams.get('d') ?? '');
      if (entry === undefined) {
        send(404, 'text/plain; charset=utf-8', 'Unknown diff. Open the diff tab and pick one.');
        return;
      }
      res.setHeader('set-cookie', `${DIFIT_COOKIE}=${String(entry.port)}; Path=/; SameSite=Lax`);
      req.url = '/';
      await proxyToDifit(req, res, { port: entry.port });
      return;
    }

    if (isDifitPath(url.pathname)) {
      const port = difitPortFrom(req.headers.cookie);
      if (port === undefined) {
        send(404, 'text/plain; charset=utf-8', 'No diff is open. Open the diff tab first.');
        return;
      }
      await proxyToDifit(req, res, { port });
      return;
    }

    const root = resolveProject(url);
    if (root === null) {
      json(404, {
        error: 'unknown project',
        detail:
          'The ?p= root is not registered. Register it with `cyv projects --add <path>`; ' +
          'the server serves registered projects only.',
      });
      return;
    }

    const projectName = basename(root);
    const shellOpts: ShellOptions = {
      project: root,
      projectName,
      showProjects: projects.length > 1,
    };
    const body = req.method === 'POST' ? await readJsonBody(req) : {};

    // ------------------------------------------------------------- HOME
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = await buildHomePage({ root, registry: projects, env });
      html(200, renderHome(page));
      return;
    }

    if (url.pathname === '/api/state') {
      json(200, { key: await stateKey(root) });
      return;
    }

    // --------------------------------------------------------- EXCHANGE
    if (url.pathname === '/api/comment' && req.method === 'POST') {
      const text = stringField(body, 'body') ?? '';
      if (text.trim().length === 0) {
        json(400, { error: 'empty comment' });
        return;
      }
      const file = stringField(body, 'file');
      if (file !== undefined && file !== '' && (await safeResolve(root, file)) === null) {
        json(400, { error: 'bad file' });
        return;
      }
      const task = stringField(body, 'task');
      const replyTo = numberField(body, 'replyTo');
      const comment = await addComment(
        root,
        {
          body: text,
          ...(file === undefined ? {} : { file }),
          anchor: stringField(body, 'anchor') ?? '',
          refs: {
            ...(task === undefined || task === '' ? {} : { task }),
            ...(replyTo === undefined ? {} : { replyTo }),
          },
        },
        Date.now(),
      );
      json(200, comment);
      return;
    }

    if (url.pathname === '/api/comment/status' && req.method === 'POST') {
      const id = numberField(body, 'id');
      const status = stringField(body, 'status') ?? 'open';
      const updated = id === undefined ? undefined : await setCommentStatus(root, id, status);
      if (updated === undefined) {
        json(404, { error: 'no such comment' });
        return;
      }
      json(200, updated);
      return;
    }

    // ------------------------------------------------------------- STOP
    // A person saw a dispatch that needed them and it needs nothing more. The
    // record stays as it was; the acknowledgement is its own log entry.
    if (url.pathname === '/api/acknowledge' && req.method === 'POST') {
      const itemId = stringField(body, 'itemId') ?? stringField(body, 'dispatchId');
      if (itemId === undefined) {
        json(400, { error: 'itemId is required' });
        return;
      }
      const note = stringField(body, 'note');
      const entry = await acknowledgeItem(root, {
        itemId,
        acknowledgedAt: new Date().toISOString(),
        ...(note === undefined || note === '' ? {} : { note }),
      });
      json(200, entry);
      return;
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      const dispatchId = stringField(body, 'dispatchId');
      if (dispatchId === undefined) {
        json(400, { error: 'dispatchId is required' });
        return;
      }
      const result = await stopDispatch(root, dispatchId);
      json(result.stopped ? 200 : 409, result);
      return;
    }

    // ------------------------------------------------------------- DOCS
    if (url.pathname === '/files') {
      const [specs, commits, status, files] = await Promise.all([
        parseAllSpecs(root),
        gitLog(root, 20),
        readStatusLog(root),
        findMarkdown(root),
      ]);
      const query = (query: Record<string, string>): string =>
        `?${new URLSearchParams({ p: root, ...query }).toString()}`;
      const documents = await Promise.all(
        files.map(async (file) => {
          const info = await stat(join(root, file));
          const specId = /^docs\/specs\/([^/]+)\//.exec(file)?.[1];
          return {
            file,
            when: new Date(info.mtimeMs).toLocaleString(),
            kb: (info.size / 1024).toFixed(1),
            ...(specId === undefined ? {} : { specId }),
          };
        }),
      );
      html(
        200,
        renderDocsPage(
          {
            specs: specs.specs.map((spec) => ({
              id: spec.id,
              name: spec.id.replace(/^\d+-/, '').replace(/-/g, ' '),
              done: spec.done,
              total: spec.total,
              href: `/view${query({
                f: spec.tasksPath ?? `docs/specs/${spec.id}/requirements.md`,
              })}`,
            })),
            commits,
            status,
            documents,
          },
          shellOpts,
        ),
      );
      return;
    }

    if (url.pathname === '/view') {
      const rel = url.searchParams.get('f') ?? '';
      const full = await safeResolve(root, rel);
      if (full === null) {
        send(400, 'text/plain; charset=utf-8', 'bad path');
        return;
      }
      const [markdown, store] = await Promise.all([readFile(full, 'utf-8'), loadComments(root)]);
      const exchange = commentsToExchange(store, Number.MAX_SAFE_INTEGER);
      const sections = splitSections(markdown).map((section, index) => {
        const anchor = section.anchor === '' ? `s${index}` : section.anchor;
        return {
          title: section.title,
          anchor,
          source: section.source,
          comments: exchange.entries.filter((entry) => entry.file === rel && entry.anchor === anchor),
        };
      });
      const query = new URLSearchParams({ p: root, f: rel }).toString();
      html(
        200,
        renderViewPage(
          {
            file: rel,
            sections,
            editHref: `/edit?${query}`,
            vendorScriptHref: '/vendor/marked.min.js',
          },
          shellOpts,
        ),
      );
      return;
    }

    if (url.pathname === '/edit') {
      const rel = url.searchParams.get('f') ?? '';
      const full = await safeResolve(root, rel);
      if (full === null) {
        send(400, 'text/plain; charset=utf-8', 'bad path');
        return;
      }
      const [source, mtime] = await Promise.all([readFile(full, 'utf-8'), fileMtime(root, rel)]);
      const query = new URLSearchParams({ p: root, f: rel }).toString();
      html(200, renderEditPage({ file: rel, source, mtime, viewHref: `/view?${query}` }, shellOpts));
      return;
    }

    if (url.pathname === '/api/save' && req.method === 'POST') {
      const rel = stringField(body, 'file') ?? '';
      const full = await safeResolve(root, rel);
      if (full === null) {
        json(400, { error: 'bad file' });
        return;
      }
      const current = Math.floor((await stat(full)).mtimeMs);
      // An agent may be writing this file right now; a save from a stale copy
      // would silently discard its work.
      if (numberField(body, 'mtime') !== current) {
        json(409, { error: 'file changed on disk since you opened it — reload and reapply' });
        return;
      }
      await writeFile(full, stringField(body, 'content') ?? '', 'utf-8');
      json(200, { ok: true, mtime: Math.floor((await stat(full)).mtimeMs) });
      return;
    }

    // ------------------------------------------------------------- DIFF
    if (url.pathname === '/diff') {
      const instances = await difitInstanceStates();
      const wanted = url.searchParams.get('d');
      const current =
        instances.find((entry) => entry.id === wanted) ??
        instances.find((entry) => entry.up) ??
        instances[0];
      if (current === undefined) {
        html(200, renderDiffPage({ instances: [], currentId: '', comments: [] }, shellOpts));
        return;
      }
      const comments = current.up ? await difitComments(root, current.port) : [];
      html(200, renderDiffPage({ instances, currentId: current.id, comments }, shellOpts));
      return;
    }

    if (url.pathname === '/api/difit/start' && req.method === 'POST') {
      const entry = instanceById(stringField(body, 'id') ?? '');
      if (entry === undefined) {
        json(400, { error: 'Unknown diff id.' });
        return;
      }
      const result = await startDifit({ cwd: root, port: entry.port, target: entry.target });
      const ok = result.started || result.alreadyRunning;
      json(ok ? 200 : 500, {
        started: result.started,
        alreadyRunning: result.alreadyRunning,
        ...(ok ? {} : { error: `difit did not start on port ${entry.port}.` }),
      });
      return;
    }

    // ------------------------------------------------------------ RULES
    if (url.pathname === '/rules') {
      const context = await rulesFor(root);
      const inputs = await readVolatileInputs(root, context.lanes);
      html(
        200,
        renderDashboard(
          context.enabled,
          context.analyzerIds,
          inputs.history,
          context.ruleAnalyzers,
          {
            baseline: inputs.baseline,
            suppressionsConfigured: inputs.configured,
            suppressions: inputs.suppressions,
            repoRoot: root,
          },
          inputs.latest,
          inputs.executor,
          {
            homeHref: `/?${new URLSearchParams({ p: root }).toString()}`,
            volatileHref: `/volatile.html?${new URLSearchParams({ p: root }).toString()}`,
          },
        ),
      );
      return;
    }

    if (url.pathname === '/volatile.html') {
      const context = await rulesFor(root);
      const inputs = await readVolatileInputs(root, context.lanes);
      html(
        200,
        renderVolatilePanels(
          context.enabled,
          inputs.history,
          {
            baseline: inputs.baseline,
            suppressionsConfigured: inputs.configured,
            suppressions: inputs.suppressions,
            repoRoot: root,
          },
          inputs.latest,
          Date.now(),
          inputs.executor,
        ),
      );
      return;
    }

    send(404, 'text/plain; charset=utf-8', 'not found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`The dashboard could not answer this request: ${messageOf(err)}`);
    });
  });

  return { server, projects };
}

/**
 * `cyv dashboard` — what needs you, what is in motion, and the lanes, for
 * every registered project.
 *
 * Binds to localhost unless `--host` is passed. A tool that exposes a
 * repository's contents to the local network by default is a hazard, not a
 * convenience.
 */
async function run(ctx: CommandContext): Promise<number> {
  const port = parsePort(ctx.argv);
  const exposeToLan = ctx.argv.includes('--host');
  const host = exposeToLan ? '0.0.0.0' : '127.0.0.1';

  const root = await repoRoot(ctx.cwd);
  const { server, projects } = await createDashboardServer({ root, env: ctx.env });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });

  process.stdout.write(`\n  checkyourvibe dashboard\n\n`);
  process.stdout.write(`  http://localhost:${port}\n`);
  if (exposeToLan) {
    for (const ip of lanAddresses()) process.stdout.write(`  http://${ip}:${port}\n`);
  } else {
    process.stdout.write(`  (localhost only — pass --host to reach it from a phone)\n`);
  }
  process.stdout.write(`\n  projects (${projects.length}):\n`);
  for (const project of projects) process.stdout.write(`    ${project}\n`);
  process.stdout.write(`\n  Ctrl+C to stop\n\n`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => {
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return 0;
}

export const command: Command = { run };
