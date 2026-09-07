import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyAnalyzer } from '../../src/conformance/suite.js';
import type { ConformanceCheck, ConformanceResult } from '../../src/conformance/suite.js';

/**
 * A compliant reference analyzer, hand-written in plain JS so the fixture has
 * no build step. It flags the literal token `BAD_MARKER`, correctly reports a
 * nonexistent file as skipped instead of throwing, and never populates
 * `guidance` — the three behaviours the suite exists to verify.
 */
const COMPLIANT_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const violations = [];
  const skipped = [];

  for (const file of request.files) {
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (err) {
      skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const settings = request.rules['no-bad-marker'];
    if (settings !== undefined && content.includes('BAD_MARKER')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'no-bad-marker',
        message: 'Found BAD_MARKER.',
        snippet: 'BAD_MARKER',
        severity: settings.severity,
      });
    }
  }

  return { protocol: 1, violations, skipped, diagnostics: [] };
}
`;

/** Throws on a missing file instead of reporting it skipped — the check that matters most. */
const THROWS_ON_MISSING_FILE_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const violations = [];

  for (const file of request.files) {
    // No try/catch: a missing file crashes the whole analysis run.
    const content = readFileSync(file, 'utf-8');
    const settings = request.rules['no-bad-marker'];
    if (settings !== undefined && content.includes('BAD_MARKER')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'no-bad-marker',
        message: 'Found BAD_MARKER.',
        snippet: 'BAD_MARKER',
        severity: settings.severity,
      });
    }
  }

  return { protocol: 1, violations, skipped: [], diagnostics: [] };
}
`;

/** Populates `violations[].guidance` itself, which is the core's job alone. */
const POPULATES_GUIDANCE_MODULE = `
import { readFileSync } from 'node:fs';

export default async function analyze(request) {
  const violations = [];
  const skipped = [];

  for (const file of request.files) {
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (err) {
      skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const settings = request.rules['no-bad-marker'];
    if (settings !== undefined && content.includes('BAD_MARKER')) {
      violations.push({
        file,
        line: 1,
        column: 1,
        ruleId: 'no-bad-marker',
        message: 'Found BAD_MARKER.',
        snippet: 'BAD_MARKER',
        severity: settings.severity,
        guidance: {
          summary: 'invented by the analyzer',
          why: 'invented by the analyzer',
          allowedFixes: ['do something'],
          notFixes: [],
          examples: { bad: 'bad', good: 'good' },
        },
      });
    }
  }

  return { protocol: 1, violations, skipped, diagnostics: [] };
}
`;

/**
 * Mirrors what a real analyzer does: ts-morph's `getFilePath()` can return a
 * path that is equivalent to, but not string-identical with, the one the
 * request's `files` entry used to reach it (forward slashes on Windows where
 * `path.join` produced backslashes, for example). `COMPLIANT_MODULE` echoes
 * the path it was handed unchanged, which cannot expose a file-path-comparison
 * bug on any platform.
 *
 * Inserting a redundant `/./` segment, rather than swapping slash direction,
 * makes this platform-independent: `path.resolve` collapses `/./` on every
 * platform (Windows included, where it accepts `/` as well as `\`), so a
 * normalized comparison still matches, while a raw string comparison never
 * can, on Windows or on Linux.
 */
const DIFFERENTLY_FORMATTED_PATH_MODULE = `
import { readFileSync } from 'node:fs';
import path from 'node:path';

export default async function analyze(request) {
  const violations = [];
  const skipped = [];

  for (const file of request.files) {
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch (err) {
      skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const differentlyFormattedFile = path.dirname(file) + '/./' + path.basename(file);

    const settings = request.rules['no-bad-marker'];
    if (settings !== undefined && content.includes('BAD_MARKER')) {
      violations.push({
        file: differentlyFormattedFile,
        line: 1,
        column: 1,
        ruleId: 'no-bad-marker',
        message: 'Found BAD_MARKER.',
        snippet: 'BAD_MARKER',
        severity: settings.severity,
      });
    }
  }

  return { protocol: 1, violations, skipped, diagnostics: [] };
}
`;

function baseRule(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'no-bad-marker',
    category: 'test',
    scope: 'file',
    severity: 'error',
    summary: 'Flags the literal BAD_MARKER token.',
    why: 'A deterministic fixture rule for conformance testing.',
    allowedFixes: ['Remove the BAD_MARKER token from the file.'],
    notFixes: [],
    examples: { bad: 'const x = 1; // BAD_MARKER', good: 'const x = 1;' },
    ...overrides,
  };
}

function baseManifest(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    protocol: 1,
    id: 'fixture-analyzer',
    match: ['**/*.sample'],
    rules: [baseRule()],
    exec: { type: 'node', module: './analyzer.mjs' },
    ...overrides,
  };
}

async function writeFixture(
  manifest: Record<string, unknown>,
  moduleSource: string,
): Promise<{ dir: string; manifestPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cyv-conformance-'));
  const manifestPath = join(dir, 'analyzer.manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await writeFile(join(dir, 'analyzer.mjs'), moduleSource, 'utf-8');
  return { dir, manifestPath };
}

function findCheck(result: ConformanceResult, substring: string): ConformanceCheck {
  const check = result.checks.find((candidate) => candidate.name.includes(substring));
  if (check === undefined) {
    throw new Error(`No check named like "${substring}" among: ${result.checks.map((c) => c.name).join(', ')}`);
  }
  return check;
}

describe('verifyAnalyzer — a compliant analyzer', () => {
  it('passes every check', async () => {
    const { dir, manifestPath } = await writeFixture(baseManifest(), COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);

      const details = result.checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`);
      expect(details).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.analyzerId).toBe('fixture-analyzer');

      // The scripted request against the rule's own bad example must have
      // actually caught something, not merely returned a permissive zero.
      const catches = findCheck(result, "catches a violation");
      expect(catches.detail).not.toMatch(/^WARNING/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyAnalyzer — broken analyzers name the exact failing check', () => {
  it('fails the protocol version check when protocol is not 1', async () => {
    const { dir, manifestPath } = await writeFixture(baseManifest({ protocol: 2 }), COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      expect(result.passed).toBe(false);
      expect(findCheck(result, 'protocol version is 1').passed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails the rule id uniqueness check on duplicate rule ids', async () => {
    const manifest = baseManifest({ rules: [baseRule(), baseRule()] });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      expect(result.passed).toBe(false);
      const check = findCheck(result, 'rule ids are unique');
      expect(check.passed).toBe(false);
      expect(check.detail).toContain('no-bad-marker');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails the notFix reference check on a dangling rule reference', async () => {
    const manifest = baseManifest({
      rules: [
        baseRule({
          notFixes: [{ pattern: 'do the wrong thing', because: 'it is wrong', rule: 'no-such-rule' }],
        }),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      expect(result.passed).toBe(false);
      const check = findCheck(result, "notFix's rule reference");
      expect(check.passed).toBe(false);
      expect(check.detail).toContain('no-such-rule');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails the nonexistent-file check when the analyzer throws instead of skipping', async () => {
    const { dir, manifestPath } = await writeFixture(baseManifest(), THROWS_ON_MISSING_FILE_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      expect(result.passed).toBe(false);
      const check = findCheck(result, 'reported in skipped');
      expect(check.passed).toBe(false);
      expect(check.detail).toMatch(/threw/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails the no-populated-guidance check when the analyzer fills in guidance itself', async () => {
    const { dir, manifestPath } = await writeFixture(baseManifest(), POPULATES_GUIDANCE_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      expect(result.passed).toBe(false);
      const check = findCheck(result, 'do not populate guidance');
      expect(check.passed).toBe(false);
      expect(check.detail).toContain('no-bad-marker');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a rule that fails rule-manifest.schema.json (missing summary)', async () => {
    const badRule = baseRule();
    delete badRule.summary;
    const manifest = baseManifest({ rules: [badRule] });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      expect(result.passed).toBe(false);
      expect(findCheck(result, 'validates against rule-manifest.schema.json').passed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyAnalyzer — notFix closure check', () => {
  it('passes when a rule-bearing notFix carries an example the named rule reports on', async () => {
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'reach for the wrong fix',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const x = 1; // BAD_MARKER',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(true);
      // The pass detail states the edge count plus the informational count of
      // examples the source rule itself still reports on; this is one edge,
      // and its own rule ("rule-a") never runs against the marker, so 0.
      expect(check.detail).toContain('1 notFix edge');
      expect(check.detail).toContain('0 of them are still reported');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when a rule-bearing notFix carries no example', async () => {
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'reach for the wrong fix',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(false);
      expect(check.detail).toContain('no example');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when the named rule does not report on the example, and names the edge', async () => {
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'reach for the wrong fix',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const x = 1; // nothing suspicious here',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(false);
      expect(check.detail).toContain('did not report');
      expect(check.detail).toContain('rule-a');
      expect(check.detail).toContain('no-bad-marker');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips a notFix with no rule while a real edge is verified', async () => {
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'a dead end that trips no rule',
              because: 'it is just a bad idea',
            },
            {
              pattern: 'a real shortcut',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const x = 1; // BAD_MARKER',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(true);
      expect(check.detail).toContain('1 notFix edge');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes with the zero-edge wording when no notFix names a rule', async () => {
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'a dead end that trips no rule',
              because: 'it is just a bad idea',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(true);
      expect(check.detail).toBe('No notFix names a rule; nothing to close.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives two edges whose examples declare the same top-level name their own independent verdict', async () => {
    // All examples are analyzed in a single request (see checkNotFixClosure). This
    // guards against a violation from one edge's file bleeding into another edge's
    // verdict — e.g. from a naive "does this rule appear anywhere in the response"
    // check instead of one scoped to the file that produced it.
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'reach for the wrong fix (a)',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const shared = 1; // BAD_MARKER',
            },
          ],
        }),
        baseRule({
          id: 'rule-b',
          notFixes: [
            {
              pattern: 'reach for the wrong fix (b)',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const shared = 2;',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, COMPLIANT_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(false);
      // rule-a's example does carry BAD_MARKER: its edge must not be reported as failing.
      expect(check.detail).not.toContain('rule-a -> notFix');
      // rule-b's example does not: its edge, and only its edge, must fail.
      expect(check.detail).toContain('rule-b -> notFix "reach for the wrong fix (b)" (rule "no-bad-marker"): did not report');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives each edge its correct verdict when the analyzer reports an equivalent but differently-formatted file path', async () => {
    // A real analyzer (e.g. ts-morph's getFilePath()) can report a path that
    // resolves to the same file as the sample path `path.join` built, without
    // being string-identical to it. DIFFERENTLY_FORMATTED_PATH_MODULE mirrors
    // that on every platform (see its own doc comment for why `/./` rather
    // than a slash swap). Without normalizing both sides of the file-path
    // comparison, this mismatches and every edge is reported as "did not
    // report" no matter what actually happened — including rule-a's, whose
    // example does carry BAD_MARKER.
    const manifest = baseManifest({
      rules: [
        baseRule({
          id: 'rule-a',
          notFixes: [
            {
              pattern: 'reach for the wrong fix (a)',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const shared = 1; // BAD_MARKER',
            },
          ],
        }),
        baseRule({
          id: 'rule-b',
          notFixes: [
            {
              pattern: 'reach for the wrong fix (b)',
              because: 'it trips the marker rule instead',
              rule: 'no-bad-marker',
              example: 'export const shared = 2;',
            },
          ],
        }),
        baseRule(),
      ],
    });
    const { dir, manifestPath } = await writeFixture(manifest, DIFFERENTLY_FORMATTED_PATH_MODULE);
    try {
      const result = await verifyAnalyzer(manifestPath);
      const check = findCheck(result, 'carries an example');
      expect(check.passed).toBe(false);
      // rule-a's example does carry BAD_MARKER: its edge must not be reported as failing,
      // even though the violation came back with a differently-formatted, but
      // equivalently-resolving, file path than the sample file was written with.
      expect(check.detail).not.toContain('rule-a -> notFix');
      // rule-b's example does not: its edge, and only its edge, must fail.
      expect(check.detail).toContain('rule-b -> notFix "reach for the wrong fix (b)" (rule "no-bad-marker"): did not report');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyAnalyzer — manifest cannot be read at all', () => {
  it('throws rather than returning a result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cyv-conformance-'));
    try {
      await expect(verifyAnalyzer(join(dir, 'does-not-exist.json'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyAnalyzer — this repo's own analyzer", () => {
  it('reports every check individually, naming exactly what is wrong rather than a single pass/fail bit', async () => {
    const manifestPath = join(process.cwd(), 'packages', 'analyzer-typescript', 'analyzer.manifest.json');
    const result = await verifyAnalyzer(manifestPath);
    expect(result.analyzerId).toBe('typescript');

    // The reference analyzer must satisfy the published contract completely.
    // It did not when this suite was first written: rules carry a `pack` field
    // that RuleManifest declares and pack-based configuration depends on, but
    // the published schema never declared it, so `additionalProperties: false`
    // rejected it. The suite named those two checks rather than loosening them,
    // the schema was corrected, and this assertion now pins the fixed state.
    //
    // If this test fails, the published schema and the reference implementation
    // have drifted apart again — fix whichever is wrong, do not relax the check.
    const failing = result.checks.filter((check) => !check.passed);
    expect(
      failing.map((check) => `${check.name}: ${check.detail}`),
      'the reference analyzer must fully satisfy the published schemas',
    ).toEqual([]);
    expect(result.passed).toBe(true);

    // Everything the schema drift does not touch — protocol version, rule id
    // uniqueness, notFix references, guidance completeness, and the analyzer's
    // actual runtime behaviour on the four scripted requests — is fully
    // conformant.
    const passingNames = result.checks.filter((check) => check.passed).map((check) => check.name);
    expect(passingNames).toEqual(
      expect.arrayContaining([
        'protocol version is 1',
        'rule ids are unique within the analyzer',
        "every notFix's rule reference resolves to a rule in this analyzer",
        'every rule has a non-empty summary, why, allowedFixes, and both examples',
        'an empty files array returns a well-formed response with zero violations',
        "the analyzer catches a violation of one of its own rule's bad examples",
        'a nonexistent file is reported in skipped, not silently dropped',
        'a request naming an unknown rule id does not crash the analyzer',
        'violations returned by the analyzer do not populate guidance',
      ]),
    );
  });
});
