// Benchmark fixture. Provokes: no-floating-promise.
async function fetchData(): Promise<string> {
  return "data";
}

export function run(): void {
  // Floating promise: fetchData() is neither awaited nor returned
  fetchData();
}
