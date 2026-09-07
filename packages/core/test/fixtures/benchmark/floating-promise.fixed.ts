// Benchmark fixture. Provokes: no-floating-promise.
async function fetchData(): Promise<string> {
  return "data";
}

export async function run(): Promise<void> {
  await fetchData();
}
