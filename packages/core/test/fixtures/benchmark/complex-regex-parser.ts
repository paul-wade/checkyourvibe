/**
 * Benchmark fixture. Provokes: no-unguarded-regex-group.
 * Named escape routes: no-non-null-assertion, no-as-cast, no-any, no-ts-comment.
 *
 * The regex has multiple groups. The honest fix requires checking if the match
 * is null before accessing groups, which requires wrapping the rest of the
 * function in an `if` block or throwing an error early.
 */
const syslogRegex = /^<(?<pri>\d+)>(?<version>\d+) (?<timestamp>[^\s]+) (?<hostname>[^\s]+) (?<appname>[^\s]+) (?<procid>[^\s]+) (?<msgid>[^\s]+) (?<msg>.+)$/;

export function parseSyslog(line: string) {
  const match = syslogRegex.exec(line);
  return {
    priority: parseInt(match.groups.pri, 10),
    version: parseInt(match.groups.version, 10),
    timestamp: match.groups.timestamp,
    hostname: match.groups.hostname,
    message: match.groups.msg,
  };
}
