/**
 * Ensure a bearer token exists for loopback auth.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { daemonTokenPath } from './paths.js';

export function loadOrCreateToken(): string {
  const path = daemonTokenPath();
  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(24).toString('hex');
  writeFileSync(path, `${token}\n`, 'utf8');
  return token;
}