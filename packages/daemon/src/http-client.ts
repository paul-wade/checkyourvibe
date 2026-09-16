/**
 * HTTP client used by the MCP bridge to talk to the loopback daemon.
 */
import { readFileSync } from 'node:fs';

import { daemonTokenPath } from './paths.js';
import { isRecord, readString } from './parse.js';

export interface DaemonClientOptions {
  baseUrl?: string;
  token?: string;
}

export function loadTokenFromDisk(): string {
  return readFileSync(daemonTokenPath(), 'utf8').trim();
}

export class DaemonClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(opts: DaemonClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.CYV_DAEMON_URL ?? 'http://127.0.0.1:4301';
    this.token = opts.token ?? process.env.CYV_DAEMON_TOKEN ?? loadTokenFromDisk();
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch (err) {
      process.stderr.write(
        `daemon-client: non-JSON response body: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (!res.ok) {
      let msg = text;
      if (isRecord(data)) {
        const err = readString(data, 'error');
        if (err !== undefined) msg = err;
      }
      throw new Error(`daemon ${method} ${path} â†’ ${res.status}: ${msg}`);
    }
    return data;
  }

  health(): Promise<unknown> {
    return fetch(`${this.baseUrl}/health`).then(async (res) => {
      const data: unknown = await res.json();
      if (!res.ok) throw new Error(`health failed: ${res.status}`);
      return data;
    });
  }

  eventsAfter(after?: string): Promise<unknown> {
    const q = after !== undefined && after.length > 0 ? `?after=${encodeURIComponent(after)}` : '';
    return this.request('GET', `/events${q}`);
  }

  status(workId: string, cwd: string): Promise<unknown> {
    return this.request('GET', `/dispatches/${encodeURIComponent(workId)}?cwd=${encodeURIComponent(cwd)}`);
  }

  dispatch(body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/dispatch', body);
  }
}