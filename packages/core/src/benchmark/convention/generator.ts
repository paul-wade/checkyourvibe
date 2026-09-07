/**
 * @file packages/core/src/benchmark/convention/generator.ts
 *
 * Generates a service repository at a requested size and returns it as a map
 * of repo-relative path to file contents. Nothing is written to disk here: a
 * caller decides where the files go, which is what makes this testable.
 *
 * The shape of the generated repository -- its kernel, conventions, and three-
 * way check result -- was established empirically in fourteen probe trials and
 * is preserved here unchanged. Altering the kernel or the legacy test shape
 * would invalidate that record.
 *
 * No third-party dependency, deliberately. A trial that runs an install
 * measures the registry; the trap under test does not need one.
 */

/** How legacy-style tests are positioned relative to the rest. */
export type LegacyPlacement =
  /** Legacy modules appear first in the alphabetical listing (the condition that defeats the model). */
  | 'first'
  /** Legacy modules are distributed past the midpoint so the target appears before them. */
  | 'late'
  | 'scattered';

/** The result of a generator call: a map of relative path to file contents. */
export type GeneratedRepo = ReadonlyMap<string, string>;

const FEATURES: readonly string[] = [
  'account', 'invoice', 'shipment', 'catalog', 'pricing', 'refund', 'ledger',
  'webhook', 'tenant', 'session', 'coupon', 'inventory', 'payout', 'dispute',
  'subscription', 'address', 'tax', 'notification', 'audit', 'quota',
];

function featureName(index: number): string {
  const base = FEATURES[index % FEATURES.length];
  if (base === undefined) {
    throw new Error(`feature index ${index} out of range`);
  }
  const round = Math.floor(index / FEATURES.length);
  return round === 0 ? base : `${base}${round + 1}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Kernel -- the shared infrastructure every module is written against.
// ---------------------------------------------------------------------------

const KERNEL: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'src/kernel/container.ts',
    `/**
 * The container every service is resolved through. Nothing in this repository
 * constructs a service with \`new\`: a service declares its dependencies as
 * tokens and the container supplies them, so a test can substitute one.
 */
export type Token<T> = { readonly key: string; readonly _type?: T };

export function token<T>(key: string): Token<T> {
  return { key };
}

type Factory<T> = (c: Container) => T;

export class Container {
  private readonly factories = new Map<string, Factory<unknown>>();
  private readonly cache = new Map<string, unknown>();

  register<T>(t: Token<T>, factory: Factory<T>): void {
    this.factories.set(t.key, factory as Factory<unknown>);
  }

  resolve<T>(t: Token<T>): T {
    const cached = this.cache.get(t.key);
    if (cached !== undefined) return cached as T;
    const factory = this.factories.get(t.key);
    if (factory === undefined) throw new Error(\`nothing registered for \${t.key}\`);
    const made = factory(this);
    this.cache.set(t.key, made);
    return made as T;
  }
}
`,
  ],
  [
    'src/kernel/clock.ts',
    `/**
 * Time is injected. Nothing in this repository calls Date.now() directly:
 * a test that cannot control the clock cannot assert on what it stamped.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
`,
  ],
  [
    'src/kernel/result.ts',
    `/**
 * Expected failure is a value, not an exception. A handler that can fail
 * returns a Result and the router maps it; throwing skips the mapping and
 * surfaces a 500 for something the caller could have been told about.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
`,
  ],
  [
    'src/kernel/errors.ts',
    `/** The failures a handler may return, and the status each maps to. */
export type AppError =
  | { kind: 'not-found'; what: string }
  | { kind: 'conflict'; what: string }
  | { kind: 'invalid'; field: string; why: string }
  | { kind: 'upstream'; service: string };

export function statusFor(error: AppError): number {
  switch (error.kind) {
    case 'not-found':
      return 404;
    case 'conflict':
      return 409;
    case 'invalid':
      return 422;
    case 'upstream':
      return 502;
  }
}
`,
  ],
  [
    'src/kernel/config.ts',
    `/**
 * Configuration is read once, validated, and injected. Nothing reads
 * process.env outside this file: a flag read inline is a flag no test can set
 * and no deployment can see.
 */
export interface Config {
  readonly pricingBaseUrl: string;
  readonly pageSize: number;
  readonly features: Readonly<Record<string, boolean>>;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const pageSize = Number(env['PAGE_SIZE'] ?? '50');
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error('PAGE_SIZE must be a positive integer');
  }
  return {
    pricingBaseUrl: env['PRICING_BASE_URL'] ?? 'http://pricing.internal',
    pageSize,
    features: { betaLedger: env['FEATURE_BETA_LEDGER'] === '1' },
  };
}
`,
  ],
  [
    'src/kernel/http.ts',
    `/**
 * Every outbound call goes through this client: it carries a timeout, one
 * retry, and the caller's request id. A bare fetch has none of those, and an
 * upstream that hangs takes the handler with it.
 */
import { err, ok, type Result } from './result.js';
import type { AppError } from './errors.js';

export interface HttpClient {
  getJson<T>(url: string, requestId: string): Promise<Result<T, AppError>>;
}

export function createHttpClient(fetchImpl: typeof fetch, timeoutMs = 2000): HttpClient {
  return {
    async getJson<T>(url: string, requestId: string): Promise<Result<T, AppError>> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, {
            signal: controller.signal,
            headers: { 'x-request-id': requestId },
          });
          if (!res.ok) continue;
          return ok((await res.json()) as T);
        } catch {
          // fall through to the retry
        } finally {
          clearTimeout(timer);
        }
      }
      return err({ kind: 'upstream', service: url });
    },
  };
}
`,
  ],
  [
    'src/kernel/db.ts',
    `/**
 * The database handle, and the only way to write more than one row.
 *
 * \`transaction\` is not optional decoration: two awaited writes outside one
 * leave the second free to fail with the first already committed.
 */
export interface Row {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface Db {
  select(table: string, where: Readonly<Record<string, unknown>>): Promise<Row[]>;
  selectIn(table: string, column: string, values: readonly string[]): Promise<Row[]>;
  insert(table: string, row: Row): Promise<void>;
  transaction<T>(body: (tx: Db) => Promise<T>): Promise<T>;
}
`,
  ],
  [
    'src/kernel/page.ts',
    `/**
 * Every list endpoint pages by cursor. Offset paging skips or repeats rows
 * when the table is written to between pages, which every table here is.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function pageFrom<T extends { id: string }>(rows: readonly T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
}
`,
  ],
  [
    'test/support/factory.ts',
    `/**
 * How a test builds a service.
 *
 * It registers doubles in a real container and resolves the subject through
 * it. Constructing the service directly is not done anywhere in this suite:
 * it pins the test to today's constructor and skips the wiring the
 * application actually uses.
 */
import { Container, type Token } from '../../src/kernel/container.js';
import type { Clock } from '../../src/kernel/clock.js';
import type { Db, Row } from '../../src/kernel/db.js';
import { CLOCK, DB } from '../../src/kernel/tokens.js';

export interface Doubles {
  readonly clock?: Clock;
  readonly rows?: Readonly<Record<string, Row[]>>;
}

export function fakeClock(iso = '2026-01-01T00:00:00.000Z'): Clock {
  return { now: () => new Date(iso) };
}

export function fakeDb(rows: Readonly<Record<string, Row[]>> = {}): Db {
  const tables = new Map<string, Row[]>(Object.entries(rows).map(([k, v]) => [k, [...v]]));
  const db: Db = {
    async select(table, where) {
      const all = tables.get(table) ?? [];
      return all.filter((row) => Object.entries(where).every(([k, v]) => row[k] === v));
    },
    async selectIn(table, column, values) {
      const all = tables.get(table) ?? [];
      return all.filter((row) => values.includes(String(row[column])));
    },
    async insert(table, row) {
      tables.set(table, [...(tables.get(table) ?? []), row]);
    },
    async transaction(body) {
      return body(db);
    },
  };
  return db;
}

/** Builds a container with the kernel doubles registered, ready to resolve from. */
export function testContainer(doubles: Doubles = {}): Container {
  const container = new Container();
  container.register(CLOCK, () => doubles.clock ?? fakeClock());
  container.register(DB, () => fakeDb(doubles.rows ?? {}));
  return container;
}

export { CLOCK, DB } from '../../src/kernel/tokens.js';
export type { Token };
`,
  ],
  [
    'src/kernel/tokens.ts',
    `import { token } from './container.js';
import type { Clock } from './clock.js';
import type { Db } from './db.js';
import type { Config } from './config.js';
import type { HttpClient } from './http.js';

export const CLOCK = token<Clock>('kernel.clock');
export const DB = token<Db>('kernel.db');
export const CONFIG = token<Config>('kernel.config');
export const HTTP = token<HttpClient>('kernel.http');
`,
  ],
]);

// ---------------------------------------------------------------------------
// Per-module files
// ---------------------------------------------------------------------------

function moduleFiles(name: string): ReadonlyMap<string, string> {
  const C = capitalize(name);
  const NAME = name.toUpperCase();
  return new Map<string, string>([
    [
      `src/${name}/${name}.tokens.ts`,
      `import { token } from '../kernel/container.js';
import type { ${C}Service } from './${name}.service.js';
import type { ${C}Repository } from './${name}.repository.js';

export const ${NAME}_SERVICE = token<${C}Service>('${name}.service');
export const ${NAME}_REPOSITORY = token<${C}Repository>('${name}.repository');
`,
    ],
    [
      `src/${name}/${name}.repository.ts`,
      `import type { Db, Row } from '../kernel/db.js';

/** Every read for ${name} goes through here. */
export class ${C}Repository {
  constructor(private readonly db: Db) {}

  async byId(id: string): Promise<Row | undefined> {
    const rows = await this.db.select('${name}', { id });
    return rows.at(0);
  }

  /** One query for many ids. Callers must not loop byId. */
  async byIds(ids: readonly string[]): Promise<Row[]> {
    return this.db.selectIn('${name}', 'id', ids);
  }

  async add(row: Row): Promise<void> {
    await this.db.insert('${name}', row);
  }
}
`,
    ],
    [
      `src/${name}/${name}.service.ts`,
      `import type { Clock } from '../kernel/clock.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { AppError } from '../kernel/errors.js';
import type { Row } from '../kernel/db.js';
import type { ${C}Repository } from './${name}.repository.js';

export class ${C}Service {
  constructor(
    private readonly repository: ${C}Repository,
    private readonly clock: Clock,
  ) {}

  async find(id: string): Promise<Result<Row, AppError>> {
    const found = await this.repository.byId(id);
    if (found === undefined) return err({ kind: 'not-found', what: '${name}' });
    return ok(found);
  }

  async create(id: string, label: string): Promise<Result<Row, AppError>> {
    if (label.trim() === '') return err({ kind: 'invalid', field: 'label', why: 'required' });
    const row: Row = { id, label, createdAt: this.clock.now().toISOString() };
    await this.repository.add(row);
    return ok(row);
  }
}
`,
    ],
    [
      `src/${name}/${name}.module.ts`,
      `import type { Container } from '../kernel/container.js';
import { CLOCK, DB } from '../kernel/tokens.js';
import { ${NAME}_REPOSITORY, ${NAME}_SERVICE } from './${name}.tokens.js';
import { ${C}Repository } from './${name}.repository.js';
import { ${C}Service } from './${name}.service.js';

export function register${C}(container: Container): void {
  container.register(${NAME}_REPOSITORY, (c) => new ${C}Repository(c.resolve(DB)));
  container.register(
    ${NAME}_SERVICE,
    (c) => new ${C}Service(c.resolve(${NAME}_REPOSITORY), c.resolve(CLOCK)),
  );
}
`,
    ],
    [
      `test/${name}.service.test.ts`,
      `import { describe, expect, it } from 'vitest';

import { testContainer } from './support/factory.js';
import { register${C} } from '../src/${name}/${name}.module.js';
import { ${NAME}_SERVICE } from '../src/${name}/${name}.tokens.js';

describe('${C}Service', () => {
  it('returns not-found for an id that is not there', async () => {
    const container = testContainer();
    register${C}(container);
    const service = container.resolve(${NAME}_SERVICE);

    const result = await service.find('missing');

    expect(result.ok).toBe(false);
  });

  it('stamps a created row with the injected clock', async () => {
    const container = testContainer();
    register${C}(container);
    const service = container.resolve(${NAME}_SERVICE);

    const result = await service.create('a-1', 'a label');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value['createdAt']).toBe('2026-01-01T00:00:00.000Z');
  });
});
`,
    ],
  ]);
}

/**
 * The way this repository used to write a test, before the container existed.
 *
 * A codebase that grew has both: the current way in most modules and the old
 * way in the ones nobody has revisited. That mixture is the condition the
 * product exists for -- a uniform repository makes its own convention obvious.
 */
function legacyTestFile(name: string): string {
  const C = capitalize(name);
  return `import { describe, expect, it } from 'vitest';

import { ${C}Service } from '../src/${name}/${name}.service.js';
import { ${C}Repository } from '../src/${name}/${name}.repository.js';
import type { Db } from '../src/kernel/db.js';

const emptyDb: Db = {
  select: async () => [],
  selectIn: async () => [],
  insert: async () => {},
  transaction: async (body) => body(emptyDb),
};

describe('${C}Service', () => {
  it('returns not-found for an id that is not there', async () => {
    const service = new ${C}Service(new ${C}Repository(emptyDb), { now: () => new Date() });

    const result = await service.find('missing');

    expect(result.ok).toBe(false);
  });
});
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options accepted by the generator. */
export interface GeneratorOptions {
  /** Total number of feature modules to generate. Must be >= 1. */
  readonly moduleCount: number;
  /**
   * How many modules are written in the superseded (direct-construction) style.
   * Must be >= 0 and <= moduleCount.
   */
  readonly legacyCount: number;
  /**
   * Where the legacy modules appear in the listing relative to the target.
   *
   * 'first' puts them at indices 0...legacyCount-1, so the first file a
   * listing shows is stale. 'late' puts them past the target, so it is not.
   * 'scattered' spreads them evenly and keeps index 0 current, which is the
   * condition that separates position from proportion: stale files sit second,
   * third and fourth, and only the first is current.
   *
   * These are three different experiments and were measured as three. 'late'
   * and 'scattered' agreed here, but they cannot be assumed to: 'late' also
   * marks its stale modules by name, and 'scattered' does not.
   */
  readonly placement: LegacyPlacement;
}

/**
 * Generates a service repository and returns the files as a map of repo-
 * relative path to file contents. Nothing is written to disk.
 *
 * The caller decides where the files go, which is what makes this testable.
 */
export function generateRepo(options: GeneratorOptions): GeneratedRepo {
  const { moduleCount, legacyCount, placement } = options;
  if (!Number.isInteger(moduleCount) || moduleCount < 1) {
    throw new Error(`moduleCount must be a positive integer, got ${moduleCount}`);
  }
  if (!Number.isInteger(legacyCount) || legacyCount < 0 || legacyCount > moduleCount) {
    throw new Error(
      `legacyCount must be an integer in [0, moduleCount], got ${legacyCount}`,
    );
  }

  const files = new Map<string, string>(KERNEL);

  // Which module indices get the legacy test. Index 0 is the file a listing
  // shows first, and the transcripts show that is the only neighbour the model
  // opens — so whether index 0 is stale is what each placement decides.
  const legacyIndices = new Set<number>();
  if (placement === 'first') {
    for (let i = 0; i < legacyCount; i += 1) {
      legacyIndices.add(i);
    }
  } else if (placement === 'late') {
    const startAt = Math.max(moduleCount - legacyCount, 0);
    for (let i = startAt; i < moduleCount; i += 1) {
      legacyIndices.add(i);
    }
  } else {
    // Evenly spread, index 0 left current. With ten modules and three legacy
    // that is indices 3, 6 and 9 — ordinary names, none of them first.
    const spacing = legacyCount === 0 ? 0 : Math.floor(moduleCount / legacyCount);
    for (let n = 1; n <= legacyCount && spacing > 0; n += 1) {
      const index = n * spacing;
      legacyIndices.add(index < moduleCount ? index : moduleCount - n);
    }
  }

  const names: string[] = [];
  for (let i = 0; i < moduleCount; i += 1) {
    const name = featureName(i);
    names.push(name);
    for (const [path, content] of moduleFiles(name)) {
      files.set(path, content);
    }
    if (legacyIndices.has(i)) {
      // Override the modern test with the legacy one.
      files.set(`test/${name}.service.test.ts`, legacyTestFile(name));
    }
  }

  const moduleRegistrations = names
    .map((n) => `import { register${capitalize(n)} } from './${n}/${n}.module.js';`)
    .join('\n');
  const registerCalls = names
    .map((n) => `  register${capitalize(n)}(container);`)
    .join('\n');

  files.set(
    'src/app.ts',
    `import { Container } from './kernel/container.js';
import { CLOCK, CONFIG, DB, HTTP } from './kernel/tokens.js';
import { systemClock } from './kernel/clock.js';
import { loadConfig } from './kernel/config.js';
import { createHttpClient } from './kernel/http.js';
import type { Db } from './kernel/db.js';
${moduleRegistrations}

export function buildApp(db: Db, env: Readonly<Record<string, string | undefined>>): Container {
  const container = new Container();
  container.register(DB, () => db);
  container.register(CLOCK, () => systemClock);
  container.register(CONFIG, () => loadConfig(env));
  container.register(HTTP, () => createHttpClient(fetch));
  // The environment is handed in rather than read here: kernel/config.ts is
  // the only place that knows what a variable is called.
${registerCalls}
  return container;
}
`,
  );

  files.set(
    'README.md',
    `# service

${moduleCount} feature module(s) over a shared kernel.

Conventions, followed by every module without exception:

- services are resolved from the container, never constructed with \`new\`
- tests build their subject through \`test/support/factory.ts\`
- time comes from the injected \`Clock\`
- expected failure is a \`Result\`, not a thrown error
- outbound calls go through the kernel's HTTP client
- more than one write goes inside \`db.transaction\`
- lists page by cursor through \`pageFrom\`
- configuration is read in \`kernel/config.ts\` and nowhere else
`,
  );

  return files;
}
