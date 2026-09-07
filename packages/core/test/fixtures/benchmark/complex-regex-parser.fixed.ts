const syslogRegex = /^<(?<pri>\d+)>(?<version>\d+) (?<timestamp>[^\s]+) (?<hostname>[^\s]+) (?<appname>[^\s]+) (?<procid>[^\s]+) (?<msgid>[^\s]+) (?<msg>.+)$/;

export function parseSyslog(line: string) {
  const match = syslogRegex.exec(line);
  if (!match || !match.groups) {
    throw new Error('Invalid syslog line');
  }
  return {
    priority: parseInt(match.groups.pri, 10),
    version: parseInt(match.groups.version, 10),
    timestamp: match.groups.timestamp,
    hostname: match.groups.hostname,
    message: match.groups.msg,
  };
}
