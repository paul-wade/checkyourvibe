declare const maybe: string | undefined;
declare const config: { value?: string } | undefined;

function toggle(x: boolean): boolean {
  return !x;
}

function compare(a: unknown, b: unknown): boolean {
  return a !== b;
}

class Container {
  public value: string;

  constructor() {
    this.value = 'default';
  }
}

interface Item {
  label?: string;
}

function useItem(item: Item): string {
  if (item.label !== undefined) {
    return item.label;
  }
  return 'unknown';
}

function withFallback(value: string | undefined): string {
  return value ?? 'default';
}
