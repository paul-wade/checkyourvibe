interface Config {
  name: string;
}

declare const text: string;
declare const res: { json(): Promise<unknown> };

// `any` and `unknown` claims are handled by `no-any`; this rule only reports
// a claimed specific shape.
async function anyReturn(): Promise<any> {
  return res.json();
}

const anyArrow = async (): Promise<any> => res.json();

function unknownReturn(): unknown {
  return JSON.parse(text);
}

// Static JSON-constructor helpers build a response, they do not parse.
declare class JsonResponse {
  static json(body: unknown, init?: unknown): JsonResponse;
}

export function handler() {
  return JsonResponse.json({ ok: true });
}

declare class ResponseConstructor {
  static json(body: unknown, init?: unknown): ResponseConstructor;
}

function route() {
  return ResponseConstructor.json({ received: true });
}

const raw = JSON.parse(text);

function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null && 'name' in value;
}

function loadWithGuard(): Config {
  const parsed = JSON.parse(text);
  if (isConfig(parsed)) {
    return parsed;
  }
  throw new Error('invalid config');
}

async function useNarrowed(): Promise<void> {
  const parsed: unknown = await res.json();
  if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === 'string') {
      console.log(record.name);
    }
  }
}
