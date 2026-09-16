/**
 * Loopback HTTP daemon: health, dispatch proxy, status, cursored events (+ SSE).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { startDispatch, readDispatchStatus } from './dispatch.js';
import { appendEvent, eventsAfter, type DaemonEvent } from './events.js';
import { parseAppendBody, isUnknownArray, isRecord, readString } from './parse.js';
import { eventsLogPath } from './paths.js';
import { startDispatchWatchers } from './watch.js';

export interface DaemonServerOptions {
  host?: string;
  port?: number;
  token: string;
  projectCwds?: string[];
}

function readBearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m?.[1];
  return token !== undefined ? token.trim() : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: 'unauthorized' });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function startDaemonServer(opts: DaemonServerOptions): {
  close: () => Promise<void>;
  port: number;
  host: string;
} {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4301;
  const projectCwds = opts.projectCwds ?? [process.cwd()];
  const sseClients = new Set<ServerResponse>();

  const fanout = (event: DaemonEvent): void => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...sseClients]) {
      try {
        client.write(data);
      } catch (err) {
        process.stderr.write(
          `daemon: dropping SSE client after write failure: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        sseClients.delete(client);
      }
    }
  };

  const watchers = startDispatchWatchers(projectCwds, fanout);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      const path = url.pathname;

      if (path === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          eventsLog: eventsLogPath(),
          pid: process.pid,
          projects: projectCwds,
        });
        return;
      }

      const token = readBearer(req);
      if (token !== opts.token) {
        unauthorized(res);
        return;
      }

      if (path === '/events' && req.method === 'GET') {
        const after = url.searchParams.get('after') ?? undefined;
        const accept = req.headers.accept;
        const stream =
          url.searchParams.get('stream') === '1' ||
          (typeof accept === 'string' && accept.includes('text/event-stream'));

        const batch = eventsAfter(after);
        if (!stream) {
          sendJson(res, 200, { events: batch });
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        for (const event of batch) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      if (path === '/events/append' && req.method === 'POST') {
        const parsed = parseAppendBody(await readBody(req));
        if ('error' in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const event = appendEvent(parsed);
        fanout(event);
        sendJson(res, 200, { event });
        return;
      }

      if (path === '/dispatch' && req.method === 'POST') {
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req));
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (!isRecord(raw)) {
          sendJson(res, 400, { error: 'body must be an object' });
          return;
        }
        const cwd = readString(raw, 'cwd') ?? projectCwds[0];
        const task = readString(raw, 'task');
        if (cwd === undefined || task === undefined || task.length === 0) {
          sendJson(res, 400, { error: 'cwd and task required' });
          return;
        }
        const ownRaw = raw.own;
        const own: string[] = [];
        if (isUnknownArray(ownRaw)) {
          for (const item of ownRaw) {
            if (typeof item === 'string') own.push(item);
          }
        }
        const gateRaw = raw.gate;
        const gate: string[] = [];
        if (isUnknownArray(gateRaw)) {
          for (const item of gateRaw) {
            if (typeof item === 'string') gate.push(item);
          }
        }
        try {
          const req: import('./dispatch.js').DispatchRequest = { cwd, task };
          const lane = readString(raw, 'lane');
          if (lane !== undefined) req.lane = lane;
          const kind = readString(raw, 'kind');
          if (kind !== undefined) req.kind = kind;
          if (own.length > 0) req.own = own;
          if (gate.length > 0) req.gate = gate;
          if (raw.expectsNoFileChanges === true) req.expectsNoFileChanges = true;
          if (typeof raw.timeoutSeconds === 'number') req.timeoutSeconds = raw.timeoutSeconds;
          const workId = readString(raw, 'workId');
          if (workId !== undefined) req.workId = workId;
          const accepted = await startDispatch(req);
          sendJson(res, 202, accepted);
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      const statusMatch = /^\/dispatches\/([^/]+)$/.exec(path);
      if (statusMatch !== null && req.method === 'GET') {
        const workId = decodeURIComponent(statusMatch[1] ?? '');
        const cwd = url.searchParams.get('cwd') ?? projectCwds[0] ?? process.cwd();
        sendJson(res, 200, readDispatchStatus(cwd, workId));
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    })().catch((err: unknown) => {
      process.stderr.write(
        `daemon request error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });

  server.listen(port, host);

  return {
    host,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        watchers.stop();
        for (const c of [...sseClients]) {
          try {
            c.end();
          } catch (err) {
            process.stderr.write(
              `daemon: SSE end failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        sseClients.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}