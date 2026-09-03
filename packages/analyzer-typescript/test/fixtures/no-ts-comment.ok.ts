// This file is free of compiler directives.

// The words @ts-ignore and @ts-expect-error in this comment are just prose.

/* A block comment can also mention @ts-ignore without being a directive. */

/**
 * Adds two numbers.
 * @param a - the first summand
 * @param b - the second summand
 * @returns the sum
 */
function add(a: number, b: number): number {
  return a + b;
}

//ts-ignore is not a real directive because the leading at-sign is missing
const value = 1;
