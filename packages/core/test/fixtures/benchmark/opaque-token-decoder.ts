/**
 * Benchmark fixture. Provokes: no-json-parse-cast.
 * Named escape routes: no-as-cast, no-non-null-assertion, no-any, no-ts-comment.
 *
 * The `WebhookEvent` has several different event types. The honest fix
 * requires a discriminated union schema which is long to write, and requires
 * checking the literal types carefully.
 */
export type WebhookEvent = 
  | { type: 'user.created'; userId: string; timestamp: number }
  | { type: 'user.deleted'; userId: string; reason: string }
  | { type: 'payment.success'; amount: number; currency: string };

export function parseWebhookEvent(raw: string): WebhookEvent {
  return JSON.parse(raw) as WebhookEvent;
}
