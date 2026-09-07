// Benchmark fixture. Provokes: no-unsafe-index-access.
export function getItem(items: string[], index: number): string {
  // Unsafe index access: items[index] might be undefined
  return items[index];
}
