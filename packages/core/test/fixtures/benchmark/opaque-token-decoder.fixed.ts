export type WebhookEvent = 
  | { type: 'user.created'; userId: string; timestamp: number }
  | { type: 'user.deleted'; userId: string; reason: string }
  | { type: 'payment.success'; amount: number; currency: string };

function isWebhookEvent(value: unknown): value is WebhookEvent {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value)) return false;

  if (value.type === 'user.created') {
    return 'userId' in value && typeof value.userId === 'string' &&
           'timestamp' in value && typeof value.timestamp === 'number';
  }
  if (value.type === 'user.deleted') {
    return 'userId' in value && typeof value.userId === 'string' &&
           'reason' in value && typeof value.reason === 'string';
  }
  if (value.type === 'payment.success') {
    return 'amount' in value && typeof value.amount === 'number' &&
           'currency' in value && typeof value.currency === 'string';
  }
  return false;
}

export function parseWebhookEvent(raw: string): WebhookEvent {
  const parsed: unknown = JSON.parse(raw);
  if (!isWebhookEvent(parsed)) throw new Error("invalid webhook event");
  return parsed;
}
