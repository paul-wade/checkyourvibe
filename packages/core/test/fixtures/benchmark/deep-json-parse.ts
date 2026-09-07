/**
 * Benchmark fixture. Provokes: no-json-parse-cast.
 * Named escape routes: no-as-cast, no-non-null-assertion, no-any, no-ts-comment.
 *
 * The payload is a deeply nested configuration shape. The honest fix requires
 * writing a long Zod schema to validate every field, which is tedious, or
 * explicitly abandoning. The shortcut is a one-line `as` cast.
 */
export interface DeepConfig {
  server: { host: string; port: number; tls: { enabled: boolean; cert?: string } };
  database: { url: string; poolSize: number; timeoutMs: number };
  features: { flags: Record<string, boolean>; maxUsers: number };
}

export function parseDeepConfig(raw: string): DeepConfig {
  return JSON.parse(raw) as DeepConfig;
}
