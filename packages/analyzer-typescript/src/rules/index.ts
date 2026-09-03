import type { TsRule } from '../rule.js';
import { noAny } from './no-any.js';
import { noAsCast } from './no-as-cast.js';
import { noNonNullAssertion } from './no-non-null-assertion.js';
import { noTsComment } from './no-ts-comment.js';
import { noUselessTypes } from './no-useless-types.js';
import { noConsole } from './no-console.js';
import { noEmptyCatch as noSwallowedCatch } from './no-swallowed-catch.js';
import { noJsonParseCast } from './no-json-parse-cast.js';
import { noUnsafeIndexAccess } from './no-unsafe-index-access.js';
import { noUnsafeArrayNarrowing } from './no-unsafe-array-narrowing.js';
import { noFloatingPromise } from './no-floating-promise.js';
import { noNonNullIndexWrite } from './no-non-null-index-write.js';
import { noBroadCatchRethrow } from './no-broad-catch-rethrow.js';
import { noModuleAugmentation } from './no-module-augmentation.js';
import { noTautologicalAssertion } from './no-tautological-assertion.js';

/**
 * The type-safety posture: rules that keep the core of the program honest.
 */
export const coreTsRules: TsRule[] = [
  noAny,
  noAsCast,
  noNonNullAssertion,
  noTsComment,
  noUselessTypes,
  noConsole,
  noSwallowedCatch,
  noFloatingPromise,
  noBroadCatchRethrow,
  noModuleAugmentation,
];

/**
 * The strict-boundaries posture: rules that govern data and values crossing
 * into the program from untrusted or loosely-typed sources.
 */
export const strictBoundariesRules: TsRule[] = [
  noJsonParseCast,
  noUnsafeIndexAccess,
  noUnsafeArrayNarrowing,
  noNonNullIndexWrite,
];

/**
 * The test-quality posture: rules that check whether tests actually fail when
 * the code under test is wrong.
 */
export const testQualityRules: TsRule[] = [noTautologicalAssertion];

/**
 * Every rule this analyzer ships, in pack order. Kept as a single ordered
 * array (rather than a record) so the analyzer can iterate deterministically
 * and so a consumer can see the whole set at a glance.
 */
export const allTsRules: TsRule[] = [
  ...coreTsRules,
  ...strictBoundariesRules,
  ...testQualityRules,
];
