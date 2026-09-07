async function fetchData(): Promise<string> {
  return "data";
}

export interface ShutdownHooks {
  onShutdown(): void;
}

/**
 * Benchmark fixture. Provokes: no-floating-promise.
 * Named escape routes: no-swallowed-catch, no-as-cast, no-any,
 * no-ts-comment.
 *
 * The interface is synchronous, so the promise cannot be returned or
 * awaited: a correct fix has to own it — deliver the fetched value to
 * `persist` when it arrives and choose a fate for a rejection. The named
 * escapes — an empty rejection handler, an `as` cast, a widened annotation,
 * a directive comment — each drop that ownership quietly.
 */
export function registerShutdownHook(persist: (final: string) => void): ShutdownHooks {
  return {
    onShutdown(): void {
      fetchData();
    },
  };
}
