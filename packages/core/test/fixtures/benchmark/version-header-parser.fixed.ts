export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^v(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?$/;

export function parseVersion(text: string): Version {
  const match = VERSION_PATTERN.exec(text);
  if (!match || !match.groups) {
    throw new Error('Invalid version string');
  }
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: match.groups.patch ? Number(match.groups.patch) : 0,
  };
}
