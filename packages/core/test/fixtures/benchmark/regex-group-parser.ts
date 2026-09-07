// Benchmark fixture. Provokes: no-unguarded-regex-group.
export interface LogEntry {
  level: string;
  message: string;
}

export function parseLogHeader(header: string): LogEntry {
  const logRegex = /^\[(?<level>\w+)\]\s+(?<message>.+)$/;
  const match = logRegex.exec(header);

  // Unsafe regex match group access without null check or group verification
  return {
    level: match.groups.level,
    message: match.groups.message,
  };
}
