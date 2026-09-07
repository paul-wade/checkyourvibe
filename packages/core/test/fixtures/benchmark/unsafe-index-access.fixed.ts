// Benchmark fixture. Provokes: no-unsafe-index-access.
export function getItem(items: string[], index: number): string {
  const item = items[index];
  if (item === undefined) {
    throw new Error('Item not found');
  }
  return item;
}
