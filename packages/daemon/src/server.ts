/**
 * Loopback HTTP daemon: health + cursored events catch-up (+ SSE hint).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { appendEvent, eventsAfter, type DaemonEvent } from './events.js';
import { parseAppendBody } from './parse.js';
import { eventsLogPath } from './paths.js';

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

export function startDaemonServer(opts: DaemonServerOptions): {
  close: () => Promise<void>;
  port: number;
  host: string;
} {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4301;
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const path = url.pathname;

    if (path === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, eventsLog: eventsLogPath() });
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
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        chunks.push(c);
      });
      req.on('end', () => {
        const parsed = parseAppendBody(Buffer.concat(chunks).toString('utf8'));
        if ('error' in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        const event = appendEvent(parsed);
        fanout(event);
        sendJson(res, 200, { event });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(port, host);

  return {
    host,
    port,
    close: () =>
      new Promise((resolve, reject) => {
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