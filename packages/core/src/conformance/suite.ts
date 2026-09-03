import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, Schema, ValidateFunction } from 'ajv/dist/types/index.js';
import { loadAnalyzerManifest } from '../registry/load.js';
import { runAnalyzer } from '../run/execute.js';
import {
  PROTOCOL_VERSION,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type AnalyzerManifest,
  type RuleManifest,
  type RuleSettings,
  type Violation,
} from '../protocol/index.js';
import { isUnknownArray } from '../guards.js';
import { readProtocolSchema } from '../protocol/schema-path.js';

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceResult {
  analyzerId: string;
  checks: ConformanceCheck[];
  passed: boolean;
}

/**
 * Every check this suite performs, named once so the CLI, the pass/fail
 * builders, and the "manifest could not be executed" fallback path all report
 * the exact same string for the exact same check.
 */
const CHECK_NAMES = {
  manifestSchema: 'manifest is readable and validates against analyzer-manifest.schema.json',
  protocolVersion: 'protocol version is 1',
  ruleSchemas: 'every rule validates against rule-manifest.schema.json',
  ruleIdUniqueness: 'rule ids are unique within the analyzer',
  notFixReferences: "every notFix's rule reference resolves to a rule in this analyzer",
  guidanceCompleteness: 'every rule has a non-empty summary, why, allowedFixes, and both examples',
  emptyFiles: 'an empty files array returns a well-formed response with zero violations',
  catchesOwnConstruct: "the analyzer catches a violation of one of its own rule's bad examples",
  nonexistentFileSkipped: 'a nonexistent file is reported in skipped, not silently dropped',
  unknownRuleId: 'a request naming an unknown rule id does not crash the analyzer',
  noGuidancePopulated: 'violations returned by the analyzer do not populate guidance',
} as const;

function pass(name: string, detail: string): ConformanceCheck {
  return { name, passed: true, detail };
}

function fail(name: string, detail: string): ConformanceCheck {
  return { name, passed: false, detail };
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractRulesArray(raw: unknown): unknown[] {
  if (!isRecord(raw)) {
    return [];
  }
  return isUnknownArray(raw.rules) ? raw.rules : [];
}

/**
 * Calling a compiled ajv validator directly as an `if` condition makes
 * TypeScript apply the validator's `data is T` predicate to narrow the
 * argument — which, for these schemas, narrows the failure branch to `never`
 * and makes the checked value unusable in its own error report. Routing the
 * call through a plain boolean-returning wrapper keeps the checked value's
 * original type intact on both branches.
 */
function isValid(validate: ValidateFunction, data: unknown): boolean {
  return validate(data) === true;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return 'failed validation for an unspecified reason';
  }
  return errors
    .map((error) => `${error.instancePath === '' ? '<root>' : error.instancePath} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

interface Validators {
  manifest: ValidateFunction;
  rule: ValidateFunction;
  response: ValidateFunction;
}

// `Schema` (from ajv) is `SchemaObject | boolean` — a JSON Schema document is either
// an object of (all-optional) keywords or one of the two boolean schemas. That is
// the actual shape being claimed here, so checking for it is a faithful guard
// rather than a stand-in for validating this specific config's fields.
function isSchemaValue(value: unknown): value is Schema {
  return typeof value === 'boolean' || (typeof value === 'object' && value !== null);
}

async function loadSchema(name: string): Promise<Schema> {
  const raw = await readProtocolSchema(name, import.meta.url);
  const parsed: unknown = JSON.parse(raw);
  if (!isSchemaValue(parsed)) {
    throw new Error(`Schema ${name} must contain a JSON Schema object or boolean`);
  }
  return parsed;
}

let cachedValidators: Promise<Validators> | undefined;

function getValidators(): Promise<Validators> {
  if (cachedValidators === undefined) {
    cachedValidators = buildValidators();
  }
  return cachedValidators;
}

async function buildValidators(): Promise<Validators> {
  const [violationSchema, ruleSchema, manifestSchema, responseSchema] = await Promise.all([
    loadSchema('violation.schema.json'),
    loadSchema('rule-manifest.schema.json'),
    loadSchema('analyzer-manifest.schema.json'),
    loadSchema('analyze-response.schema.json'),
  ]);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(violationSchema);
  ajv.addSchema(ruleSchema);

  const manifest = ajv.compile(manifestSchema);
  const response = ajv.compile(responseSchema);
  const rule = ajv.getSchema('https://checkyourvibe.dev/schema/rule-manifest.json');
  if (rule === undefined) {
    throw new Error('Internal error: rule-manifest.schema.json did not register under its own $id.');
  }

  return { manifest, rule, response };
}

// --- Checks 1-6: static manifest structure, no execution involved. -------

function checkManifestSchema(
  raw: unknown,
  jsonError: string | undefined,
  validate: ValidateFunction,
): ConformanceCheck {
  if (jsonError !== undefined) {
    return fail(CHECK_NAMES.manifestSchema, `Manifest is not valid JSON: ${jsonError}`);
  }
  if (isValid(validate, raw)) {
    return pass(
      CHECK_NAMES.manifestSchema,
      'Manifest was read and parsed without executing the analyzer, and matches analyzer-manifest.schema.json.',
    );
  }
  return fail(CHECK_NAMES.manifestSchema, formatAjvErrors(validate.errors));
}

function checkProtocolVersion(raw: unknown): ConformanceCheck {
  const protocol = isRecord(raw) ? raw.protocol : undefined;
  if (protocol === PROTOCOL_VERSION) {
    return pass(CHECK_NAMES.protocolVersion, `protocol: ${String(protocol)}`);
  }
  return fail(
    CHECK_NAMES.protocolVersion,
    `Expected "protocol" === ${PROTOCOL_VERSION}, got ${JSON.stringify(protocol)}.`,
  );
}

function checkRuleSchemas(rules: unknown[], validateRule: ValidateFunction): ConformanceCheck {
  const problems: string[] = [];
  rules.forEach((rule, index) => {
    if (isValid(validateRule, rule)) {
      return;
    }
    const id = isRecord(rule) && typeof rule.id === 'string' ? rule.id : `#${index}`;
    problems.push(`rule "${id}": ${formatAjvErrors(validateRule.errors)}`);
  });

  if (problems.length === 0) {
    return pass(CHECK_NAMES.ruleSchemas, `${rules.length} rule(s) checked against rule-manifest.schema.json.`);
  }
  return fail(CHECK_NAMES.ruleSchemas, problems.join(' | '));
}

function checkRuleIdUniqueness(rules: unknown[]): ConformanceCheck {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    if (isRecord(rule) && typeof rule.id === 'string') {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    }
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  if (duplicates.length === 0) {
    return pass(CHECK_NAMES.ruleIdUniqueness, `${counts.size} distinct rule id(s).`);
  }
  return fail(CHECK_NAMES.ruleIdUniqueness, `Duplicate rule id(s): ${duplicates.join(', ')}.`);
}

function checkNotFixReferences(rules: unknown[]): ConformanceCheck {
  const knownIds = new Set<string>();
  for (const rule of rules) {
    if (isRecord(rule) && typeof rule.id === 'string') {
      knownIds.add(rule.id);
    }
  }

  const dangling: string[] = [];
  for (const rule of rules) {
    if (!isRecord(rule)) {
      continue;
    }
    const ruleId = typeof rule.id === 'string' ? rule.id : '<unknown>';
    if (isUnknownArray(rule.notFixes)) {
      for (let i = 0; i < rule.notFixes.length; i++) {
        const notFix: unknown = rule.notFixes[i];
        if (isRecord(notFix) && typeof notFix.rule === 'string' && !knownIds.has(notFix.rule)) {
          dangling.push(`${ruleId} -> notFix.rule "${notFix.rule}"`);
        }
      }
    }
  }

  if (dangling.length === 0) {
    return pass(CHECK_NAMES.notFixReferences, "Every notFix's rule field names a rule in this analyzer.");
  }
  return fail(
    CHECK_NAMES.notFixReferences,
    `Dangling notFix rule reference(s), pointing nowhere: ${dangling.join(', ')}.`,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function checkGuidanceCompleteness(rules: unknown[]): ConformanceCheck {
  const problems: string[] = [];

  rules.forEach((rule, index) => {
    if (!isRecord(rule)) {
      problems.push(`rule #${index}: not an object`);
      return;
    }
    const id = typeof rule.id === 'string' ? rule.id : `#${index}`;

    if (!isNonEmptyString(rule.summary)) problems.push(`${id}: summary is empty`);
    if (!isNonEmptyString(rule.why)) problems.push(`${id}: why is empty`);
    if (!isUnknownArray(rule.allowedFixes) || rule.allowedFixes.length === 0) {
      problems.push(`${id}: allowedFixes is empty`);
    }

    const examples = rule.examples;
    if (!isRecord(examples) || !isNonEmptyString(examples.bad)) {
      problems.push(`${id}: examples.bad is empty`);
    }
    if (!isRecord(examples) || !isNonEmptyString(examples.good)) {
      problems.push(`${id}: examples.good is empty`);
    }
  });

  if (problems.length === 0) {
    return pass(CHECK_NAMES.guidanceCompleteness, `${rules.length} rule(s) have complete guidance.`);
  }
  return fail(CHECK_NAMES.guidanceCompleteness, problems.join(' | '));
}

// --- Checks 7-8: drive the analyzer through scripted requests. ----------

async function tryLoadManifest(
  manifestPath: string,
): Promise<{ manifest?: AnalyzerManifest; error?: string }> {
  try {
    const manifest = await loadAnalyzerManifest(manifestPath, path.dirname(manifestPath));
    return { manifest };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

function fullRuleSettings(manifest: AnalyzerManifest): Record<string, RuleSettings> {
  const settings: Record<string, RuleSettings> = {};
  for (const rule of manifest.rules) {
    settings[rule.id] = { severity: rule.severity };
  }
  return settings;
}

function extensionFromMatch(match: string[]): string {
  for (const pattern of match) {
    const found = /\.[A-Za-z0-9]+$/.exec(pattern)?.[0];
    if (found !== undefined) {
      return found;
    }
  }
  return '.txt';
}

/** Prefer a rule whose bad example is actually usable to drive a live request. */
function pickSampleRule(manifest: AnalyzerManifest): RuleManifest | undefined {
  if (manifest.rules.length === 0) {
    return undefined;
  }
  return manifest.rules.find((rule) => isNonEmptyString(rule.examples.bad)) ?? manifest.rules[0];
}

async function runSafely(
  manifest: AnalyzerManifest,
  request: AnalyzeRequest,
  repoRootForRun: string,
): Promise<{ response?: AnalyzeResponse; error?: string }> {
  try {
    const response = await runAnalyzer(manifest, request, repoRootForRun);
    return { response };
  } catch (err) {
    return { error: messageFor(err) };
  }
}

interface ScriptedCheckResult {
  check: ConformanceCheck;
  violations: Violation[];
}

async function checkEmptyFiles(
  manifest: AnalyzerManifest,
  tempDir: string,
  validateResponse: ValidateFunction,
): Promise<ScriptedCheckResult> {
  const request: AnalyzeRequest = {
    protocol: PROTOCOL_VERSION,
    repoRoot: tempDir,
    mode: 'file',
    files: [],
    rules: fullRuleSettings(manifest),
  };

  const { response, error } = await runSafely(manifest, request, tempDir);
  if (response === undefined) {
    return { check: fail(CHECK_NAMES.emptyFiles, `Analyzer threw on an empty files array: ${error}`), violations: [] };
  }
  if (!isValid(validateResponse, response)) {
    return {
      check: fail(
        CHECK_NAMES.emptyFiles,
        `Response does not match analyze-response.schema.json: ${formatAjvErrors(validateResponse.errors)}`,
      ),
      violations: response.violations,
    };
  }
  if (response.violations.length !== 0) {
    return {
      check: fail(CHECK_NAMES.emptyFiles, `Expected zero violations, got ${response.violations.length}.`),
      violations: response.violations,
    };
  }
  return {
    check: pass(CHECK_NAMES.emptyFiles, 'Empty files array returned a well-formed response with zero violations.'),
    violations: response.violations,
  };
}

async function checkCatchesOwnConstruct(
  manifest: AnalyzerManifest,
  tempDir: string,
  validateResponse: ValidateFunction,
): Promise<ScriptedCheckResult> {
  if (manifest.rules.length === 0) {
    return {
      check: pass(CHECK_NAMES.catchesOwnConstruct, 'Analyzer declares no rules; nothing to catch.'),
      violations: [],
    };
  }

  const sampleRule = pickSampleRule(manifest);
  if (sampleRule === undefined || !isNonEmptyString(sampleRule.examples.bad)) {
    return {
      check: pass(
        CHECK_NAMES.catchesOwnConstruct,
        'No rule has a non-empty "examples.bad" to drive this check; skipped.',
      ),
      violations: [],
    };
  }

  const samplePath = path.join(tempDir, `conformance-sample${extensionFromMatch(manifest.match)}`);
  await writeFile(samplePath, sampleRule.examples.bad, 'utf-8');

  const request: AnalyzeRequest = {
    protocol: PROTOCOL_VERSION,
    repoRoot: tempDir,
    mode: 'file',
    files: [samplePath],
    rules: fullRuleSettings(manifest),
  };

  const { response, error } = await runSafely(manifest, request, tempDir);
  if (response === undefined) {
    return {
      check: fail(
        CHECK_NAMES.catchesOwnConstruct,
        `Analyzer threw while analyzing rule "${sampleRule.id}"'s own bad example: ${error}`,
      ),
      violations: [],
    };
  }
  if (!isValid(validateResponse, response)) {
    return {
      check: fail(
        CHECK_NAMES.catchesOwnConstruct,
        `Response does not match analyze-response.schema.json: ${formatAjvErrors(validateResponse.errors)}`,
      ),
      violations: response.violations,
    };
  }
  if (response.violations.length === 0) {
    return {
      check: pass(
        CHECK_NAMES.catchesOwnConstruct,
        `WARNING: 0 violations reported for rule "${sampleRule.id}"'s own bad example. A permissive ` +
          'analyzer is legal, but this means nothing was actually flagged.',
      ),
      violations: response.violations,
    };
  }
  return {
    check: pass(
      CHECK_NAMES.catchesOwnConstruct,
      `${response.violations.length} violation(s) reported for rule "${sampleRule.id}"'s bad example.`,
    ),
    violations: response.violations,
  };
}

async function checkNonexistentFileSkipped(
  manifest: AnalyzerManifest,
  tempDir: string,
  validateResponse: ValidateFunction,
): Promise<ScriptedCheckResult> {
  const missingPath = path.join(tempDir, `conformance-missing${extensionFromMatch(manifest.match)}`);

  const request: AnalyzeRequest = {
    protocol: PROTOCOL_VERSION,
    repoRoot: tempDir,
    mode: 'file',
    files: [missingPath],
    rules: fullRuleSettings(manifest),
  };

  const { response, error } = await runSafely(manifest, request, tempDir);
  if (response === undefined) {
    return {
      check: fail(
        CHECK_NAMES.nonexistentFileSkipped,
        `Analyzer threw instead of reporting the nonexistent file as skipped: ${error}`,
      ),
      violations: [],
    };
  }
  if (!isValid(validateResponse, response)) {
    return {
      check: fail(
        CHECK_NAMES.nonexistentFileSkipped,
        `Response does not match analyze-response.schema.json: ${formatAjvErrors(validateResponse.errors)}`,
      ),
      violations: response.violations,
    };
  }

  const skippedEntry = response.skipped.find((entry) => entry.file === missingPath);
  if (skippedEntry === undefined) {
    return {
      check: fail(
        CHECK_NAMES.nonexistentFileSkipped,
        `The nonexistent file "${missingPath}" did not throw, but is also absent from "skipped" ` +
          `(${response.violations.length} violation(s), ${response.skipped.length} skipped entr(y/ies) returned ` +
          'instead). Silently omitting an unreadable file is how a tool reports success over code nobody analysed.',
      ),
      violations: response.violations,
    };
  }
  return {
    check: pass(CHECK_NAMES.nonexistentFileSkipped, `Reported as skipped: ${skippedEntry.reason}`),
    violations: response.violations,
  };
}

async function checkUnknownRuleId(
  manifest: AnalyzerManifest,
  tempDir: string,
  validateResponse: ValidateFunction,
): Promise<ScriptedCheckResult> {
  const sampleRule = pickSampleRule(manifest);
  const samplePath = path.join(tempDir, `conformance-unknown-rule${extensionFromMatch(manifest.match)}`);
  await writeFile(samplePath, sampleRule?.examples.bad ?? '', 'utf-8');

  const request: AnalyzeRequest = {
    protocol: PROTOCOL_VERSION,
    repoRoot: tempDir,
    mode: 'file',
    files: [samplePath],
    rules: { __cyv_conformance_unknown_rule__: { severity: 'error' } },
  };

  const { response, error } = await runSafely(manifest, request, tempDir);
  if (response === undefined) {
    return {
      check: fail(CHECK_NAMES.unknownRuleId, `Analyzer threw when asked for an unknown rule id: ${error}`),
      violations: [],
    };
  }
  if (!isValid(validateResponse, response)) {
    return {
      check: fail(
        CHECK_NAMES.unknownRuleId,
        `Response does not match analyze-response.schema.json: ${formatAjvErrors(validateResponse.errors)}`,
      ),
      violations: response.violations,
    };
  }
  return {
    check: pass(CHECK_NAMES.unknownRuleId, 'Analyzer returned a well-formed response for an unrecognized rule id.'),
    violations: response.violations,
  };
}

function checkNoGuidancePopulated(allViolations: Violation[]): ConformanceCheck {
  const offending = allViolations.filter((violation) => violation.guidance !== undefined);
  if (offending.length === 0) {
    return pass(
      CHECK_NAMES.noGuidancePopulated,
      `Checked ${allViolations.length} violation(s) returned across the scripted requests; none carried guidance.`,
    );
  }
  const detail = offending.map((v) => `${v.ruleId} at ${v.file}:${v.line}`).join(', ');
  return fail(
    CHECK_NAMES.noGuidancePopulated,
    `Analyzer populated "guidance" on: ${detail}. Guidance is the core's job — an analyzer filling it in ` +
      'would let guidance drift per-analyzer.',
  );
}

/**
 * Conformance-test an analyzer against the request/response schemas and the
 * behavioural guarantees third-party analyzers must uphold, without needing
 * to read this project's source or be registered in anyone's configuration.
 *
 * Only a failure to read the manifest file from disk throws. Every other
 * defect — a bad schema, a crash on a scripted request, populated guidance —
 * is reported as a named, individually-inspectable `ConformanceCheck` so a
 * caller can see exactly what is wrong instead of a single pass/fail bit.
 */
export async function verifyAnalyzer(manifestPath: string): Promise<ConformanceResult> {
  const resolvedPath = path.resolve(manifestPath);

  let manifestText: string;
  try {
    manifestText = await readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read analyzer manifest at "${resolvedPath}": ${messageFor(err)}`);
  }

  let raw: unknown;
  let jsonError: string | undefined;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    jsonError = messageFor(err);
  }

  const fallbackId = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '<unknown>';
  const { manifest: manifestValidator, rule: ruleValidator, response: responseValidator } = await getValidators();

  const checks: ConformanceCheck[] = [];
  checks.push(checkManifestSchema(raw, jsonError, manifestValidator));
  checks.push(checkProtocolVersion(raw));

  const rawRules = extractRulesArray(raw);
  checks.push(checkRuleSchemas(rawRules, ruleValidator));
  checks.push(checkRuleIdUniqueness(rawRules));
  checks.push(checkNotFixReferences(rawRules));
  checks.push(checkGuidanceCompleteness(rawRules));

  const loaded = await tryLoadManifest(resolvedPath);

  if (loaded.manifest === undefined) {
    const detail =
      'The analyzer could not be executed for this check because its manifest failed to load: ' +
      `${loaded.error ?? 'unknown error'}`;
    checks.push(fail(CHECK_NAMES.emptyFiles, detail));
    checks.push(fail(CHECK_NAMES.catchesOwnConstruct, detail));
    checks.push(fail(CHECK_NAMES.nonexistentFileSkipped, detail));
    checks.push(fail(CHECK_NAMES.unknownRuleId, detail));
    checks.push(fail(CHECK_NAMES.noGuidancePopulated, detail));
  } else {
    const manifest = loaded.manifest;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'cyv-verify-analyzer-'));
    try {
      const allViolations: Violation[] = [];

      const emptyResult = await checkEmptyFiles(manifest, tempDir, responseValidator);
      checks.push(emptyResult.check);
      allViolations.push(...emptyResult.violations);

      const catchesResult = await checkCatchesOwnConstruct(manifest, tempDir, responseValidator);
      checks.push(catchesResult.check);
      allViolations.push(...catchesResult.violations);

      const skippedResult = await checkNonexistentFileSkipped(manifest, tempDir, responseValidator);
      checks.push(skippedResult.check);
      allViolations.push(...skippedResult.violations);

      const unknownRuleResult = await checkUnknownRuleId(manifest, tempDir, responseValidator);
      checks.push(unknownRuleResult.check);
      allViolations.push(...unknownRuleResult.violations);

      checks.push(checkNoGuidancePopulated(allViolations));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  return {
    analyzerId: loaded.manifest?.id ?? fallbackId,
    checks,
    passed: checks.every((check) => check.passed),
  };
}
