/**
 * Built-in `Array.isArray` narrows `unknown` to an array whose elements are
 * not checked: every later read is unchecked. Returning `value is unknown[]`
 * keeps the element type honest, so callers still have to validate each one.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
