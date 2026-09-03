import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { text } from 'node:stream/consumers';

/**
 * Phone width at which difit's layout is compacted. Kept in one place so the
 * injected stylesheet and any dashboard breakpoint line up.
 */
export const DIFIT_PHONE_MAX_WIDTH = 720;

/**
 * The stylesheet injected into difit's page: phone-width only, desktop untouched.
 */
export function difitPhoneStyle(): string {
  return `@media (max-width: ${DIFIT_PHONE_MAX_WIDTH}px) {
  /* difit's own header: logo, sidebar/settings buttons, ignore-whitespace, viewed progress */
  #root > div > header { display: none !important; }
  main > div[id^="file-"] { margin-bottom: 8px !important; }
  /* the file header row */
  main > div[id^="file-"] > div > div:first-child { padding: 6px 10px !important; }
  /* the Viewed button */
  main > div[id^="file-"] > div > div:first-child > div:last-child > button { display: none !important; }
  /* the old-line-number column; the new number stays */
  table.font-mono tr > td:first-child { display: none !important; }
  :root { --line-number-width: 3.5ch !important; }
  table.font-mono { font-size: 12px !important; line-height: 1.35 !important; }
}`;
}

/**
 * Insert `<style>` before `</head>` (case-insensitive); if there is no head, prepend.
 */
export function injectStyle(html: string, css: string): string {
  const style = `<style>${css}</style>`;
  const headClose = /<\/head>/i;
  if (headClose.test(html)) {
    return html.replace(headClose, `${style}</head>`);
  }
  return `${style}${html}`;
}

/** Upstream difit location. */
export interface DifitProxyTarget {
  port: number;
  host?: string;
}

/**
 * Forward one request to difit and stream the answer back. Method, path with
 * query, request body and headers are passed through except `host`; the
 * response status and headers pass through except `content-length` when the
 * body is rewritten. An HTML response has `difitPhoneStyle()` injected. A
 * streaming response (content-type text/event-stream, or any non-HTML) is
 * piped without buffering so `/api/watch` keeps flowing. When difit does not
 * answer, respond 502 with a plain-text line naming the port and saying
 * difit is not running there.
 */
export async function proxyToDifit(
  req: IncomingMessage,
  res: ServerResponse,
  target: DifitProxyTarget,
): Promise<void> {
  const host = target.host ?? '127.0.0.1';
  const headers: NodeJS.Dict<string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === 'host') continue;
    headers[name] = value;
  }
  headers['accept-encoding'] = 'identity';

  const options = {
    host,
    port: target.port,
    method: req.method,
    path: req.url ?? '/',
    headers,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const upstream = request(options, (response) => {
        const contentType = String(response.headers['content-type'] ?? '');
        const isHtml = contentType.toLowerCase().startsWith('text/html');

        if (isHtml) {
          const outHeaders: NodeJS.Dict<string | string[]> = { ...response.headers };
          delete outHeaders['content-length'];
          delete outHeaders['content-encoding'];
          delete outHeaders['transfer-encoding'];
          outHeaders['cache-control'] = 'no-store';

          res.once('error', reject);
          res.writeHead(response.statusCode ?? 200, outHeaders);
          text(response)
            .then((body) => {
              res.end(injectStyle(body, difitPhoneStyle()));
              resolve();
            })
            .catch(reject);
          return;
        }

        res.once('error', reject);
        res.writeHead(response.statusCode ?? 200, response.headers);
        response.once('end', resolve);
        response.once('error', reject);
        response.pipe(res);
      });

      upstream.once('error', reject);
      req.once('error', reject);
      req.pipe(upstream);
    });
  } catch {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`difit is not running on port ${String(target.port)}`);
  }
}
