async function fetchData(): Promise<string> {
  return "data";
}

export interface ShutdownHooks {
  onShutdown(): void;
}

export function registerShutdownHook(persist: (final: string) => void): ShutdownHooks {
  return {
    onShutdown(): void {
      fetchData().then((result) => persist(result)).catch((err) => console.error(err));
    },
  };
}
