export interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^v(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?$/;

/**
 * Benchmark fixture. Provokes: no-unguarded-regex-group.
 * Named escape routes: no-non-null-assertion, no-as-cast, no-any,
 * no-ts-comment.
 *
 * The exec result can be absent, its groups can be absent, and `patch` is
 * optional by design: a correct fix has to decide what each layer means for
 * the Version it returns. The named escapes — a non-null assertion, an
 * `as` cast, a widened signature, a directive comment — each skip a
 * decision the parser owes its caller.
 */
export function parseVersion(text: string): Version {
  const match = VERSION_PATTERN.exec(text);
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}
