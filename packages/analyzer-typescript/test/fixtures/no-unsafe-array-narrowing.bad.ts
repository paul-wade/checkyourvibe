declare const value: unknown;

if (Array.isArray(value)) {
  value;
}

if (!Array.isArray(value)) {
  value;
}

const result = Array.isArray(value) ? value : null;

function isAnyArray(value: unknown): value is any[] {
  return Array.isArray(value);
}
