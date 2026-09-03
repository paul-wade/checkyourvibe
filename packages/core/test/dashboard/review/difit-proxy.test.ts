import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { text } from 'node:stream/consumers';
import {
  DIFIT_PHONE_MAX_WIDTH,
  difitPhoneStyle,
  injectStyle,
  proxyToDifit,
} from '../../../src/dashboard/review/difit-proxy.js';

function getPort(server: Server): number {
  const address = server.address();
  if (address !== null && typeof address === 'object') return address.port;
  throw new Error('server is not bound to a port');
}

function listen(server: Server, hostname: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.listen(0, hostname, () => resolve());
    server.once('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('difitPhoneStyle', () => {
  it('wraps rules in a phone-width media query', () => {
    const css = difitPhoneStyle();
    expect(css).toContain(`@media (max-width: ${DIFIT_PHONE_MAX_WIDTH}px)`);
    expect(css).toContain('#root > div > header { display: none !important; }');
  });
});

describe('injectStyle', () => {
  it('inserts a style block before </head>', () => {
    const html = '<html><head><title>difit</title></head><body></body></html>';
    const css = '.x {}';
    const result = injectStyle(html, css);
    expect(result).toContain(`<style>${css}</style></head>`);
  });

  it('matches </head> case-insensitively', () => {
    const html = '<html><head></HEAD><body></body></html>';
    const css = '.x {}';
    const result = injectStyle(html, css);
    expect(result).toContain(`<style>${css}</style></head>`);
    expect(result).not.toContain('</HEAD>');
  });

  it('prepends the style when no head is present', () => {
    const html = '<div></div>';
    const css = '.x {}';
    const result = injectStyle(html, css);
    expect(result.startsWith(`<style>${css}</style>`)).toBe(true);
  });
});

describe('proxyToDifit', () => {
  it('injects the phone stylesheet into html responses', async () => {
    const stub = createServer(async (req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>difit</title></head><body></body></html>');
        return;
      }
      res.writeHead(404); res.end();
    });
    const proxy = createServer(async (req, res) => {
      await proxyToDifit(req, res, { port: getPort(stub), host: '127.0.0.1' });
    });
    try {
      await listen(stub, '127.0.0.1');
      await listen(proxy, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${getPort(proxy)}/`);
      const body = await response.text();
      expect(body).toContain('<style>');
      expect(body).toContain(`@media (max-width: ${DIFIT_PHONE_MAX_WIDTH}px)`);
      expect(body).toContain('#root > div > header { display: none !important; }');
    } finally {
      await closeServer(proxy);
      await closeServer(stub);
    }
  });

  it('forwards method, path with query and body to the upstream', async () => {
    const stub = createServer(async (req, res) => {
      if (req.url?.startsWith('/api/x')) {
        const body = await text(req);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
        return;
      }
      res.writeHead(404); res.end();
    });
    const proxy = createServer(async (req, res) => {
      await proxyToDifit(req, res, { port: getPort(stub), host: '127.0.0.1' });
    });
    try {
      await listen(stub, '127.0.0.1');
      await listen(proxy, '127.0.0.1');
      const payload = JSON.stringify({ key: 'value' });
      const response = await fetch(`http://127.0.0.1:${getPort(proxy)}/api/x?foo=bar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      const data: unknown = await response.json();
      expect(data).toMatchObject({ method: 'POST', url: '/api/x?foo=bar', body: payload });
    } finally {
      await closeServer(proxy);
      await closeServer(stub);
    }
  });

  it('pipes server-sent events without buffering', async () => {
    const stub = createServer(async (req, res) => {
      if (req.url === '/api/watch') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: one\n\n');
        res.write('data: two\n\n');
        res.end();
        return;
      }
      res.writeHead(404); res.end();
    });
    const proxy = createServer(async (req, res) => {
      await proxyToDifit(req, res, { port: getPort(stub), host: '127.0.0.1' });
    });
    try {
      await listen(stub, '127.0.0.1');
      await listen(proxy, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${getPort(proxy)}/api/watch`);
      const body = await response.text();
      expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(body).toContain('data: one');
      expect(body).toContain('data: two');
    } finally {
      await closeServer(proxy);
      await closeServer(stub);
    }
  });

  it('preserves content-type for non-html static assets', async () => {
    const stub = createServer(async (req, res) => {
      if (req.url === '/favicon.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        res.end('<svg/>');
        return;
      }
      res.writeHead(404); res.end();
    });
    const proxy = createServer(async (req, res) => {
      await proxyToDifit(req, res, { port: getPort(stub), host: '127.0.0.1' });
    });
    try {
      await listen(stub, '127.0.0.1');
      await listen(proxy, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${getPort(proxy)}/favicon.svg`);
      const body = await response.text();
      expect(response.headers.get('content-type')).toMatch(/image\/svg\+xml/);
      expect(body).toBe('<svg/>');
    } finally {
      await closeServer(proxy);
      await closeServer(stub);
    }
  });

  it('returns 502 when the target is not listening', async () => {
    const taker = createServer();
    await listen(taker, '127.0.0.1');
    const port = getPort(taker);
    await closeServer(taker);

    const proxy = createServer(async (req, res) => {
      await proxyToDifit(req, res, { port, host: '127.0.0.1' });
    });
    try {
      await listen(proxy, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${getPort(proxy)}/`);
      const body = await response.text();
      expect(response.status).toBe(502);
      expect(body).toContain(String(port));
      expect(body).toContain('difit is not running');
    } finally {
      await closeServer(proxy);
    }
  });
});
