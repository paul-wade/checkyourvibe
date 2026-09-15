/**
 * User-local paths for the dispatch daemon (spec 0066).
 * Windows: %LOCALAPPDATA%\checkyourvibe\
 * POSIX: ~/.local/share/checkyourvibe/
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function checkyourvibeDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'checkyourvibe');
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdg, 'checkyourvibe');
}

export function eventsLogPath(): string {
  return join(checkyourvibeDataDir(), 'events.ndjson');
}

export function daemonTokenPath(): string {
  return join(checkyourvibeDataDir(), 'daemon.token');
}
