declare const value: unknown;
declare const arr: string[];
declare const record: Record<string, string>;
declare const i: number;
declare const key: string;

arr[i]?.toUpperCase();
record[key]?.trim();

const withFallback = arr[i] ?? 'missing';

if (arr[i] !== undefined) {
  arr[i].toUpperCase();
}

if (typeof value === 'string') {
  value.length;
}

const found: string | undefined = arr[i];

function find(): string | undefined {
  return record[key];
}

record[key] = 'value';

interface ProcessEnv {
  [key: string]: string | undefined;
}
declare const env: ProcessEnv;
declare const k: string;
env[k] = 'x';

if (env[k] == null) {
  env[k] = 'fallback';
}

// Removing a slot never produces its value, so there is no possible
// `undefined` result for surrounding code to consume.
delete env[k];
delete record[key];
