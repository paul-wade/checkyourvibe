#!/usr/bin/env node
/**
 * cyv-daemon start — loopback durable event daemon (spec 0066).
 */
import { backfillFromDispatches } from './backfill.js';
import { loadOrCreateToken } from './auth.js';
import { daemonTokenPath, eventsLogPath } from './paths.js';
import { startDaemonServer } from './server.js';

function usage(): never {
  process.stderr.write(`Usage: cyv-daemon start [--port 4301] [--project <cwd>]...\n`);
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== 'start') usage();

  let port = 4301;
  const projects: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      const raw = args[i + 1];
      i += 1;
      if (raw === undefined) usage();
      port = Number.parseInt(raw, 10);
      if (!Number.isFinite(port)) usage();
    } else if (a === '--project') {
      const p = args[i + 1];
      i += 1;
      if (p === undefined) usage();
      projects.push(p);
    } else {
      usage();
    }
  }

  if (projects.length === 0) {
    projects.push(process.cwd());
  }

  const token = loadOrCreateToken();
  let backfilled = 0;
  for (const cwd of projects) {
    backfilled += backfillFromDispatches(cwd);
  }

  const server = startDaemonServer({ token, port, projectCwds: projects });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      listen: `http://${server.host}:${server.port}`,
      eventsLog: eventsLogPath(),
      tokenPath: daemonTokenPath(),
      backfilled,
      projects,
    })}\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
}