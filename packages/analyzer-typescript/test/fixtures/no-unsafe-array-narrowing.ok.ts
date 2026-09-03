declare const maybeArray: string[] | string;

// Already typed as an array or non-array: a refinement, not a trap.
if (Array.isArray(maybeArray)) {
  maybeArray;
}

// The result is used as a boolean, not for narrowing.
const isArr = Array.isArray(maybeArray);

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A guard-and-iterate pattern where the element is checked before use.
function parseStoredLines(raw: string): { id: string }[] {
  const data: unknown = JSON.parse(raw);

  if (!Array.isArray(data)) {
    return [];
  }

  const lines: { id: string }[] = [];
  for (const item of data) {
    if (
      item &&
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      (item as Record<string, unknown>).quantity > 0
    ) {
      lines.push({ id: (item as Record<string, unknown>).id as string });
    }
  }

  return lines;
}

// A positive guard that contains the loop directly.
function positiveGuard(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        item.toUpperCase();
      }
    }
  }
}
