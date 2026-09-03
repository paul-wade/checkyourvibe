interface Named {
  name: string;
}

const named: Named = { name: 'ok' };

function handle(event: string): number {
  return event.length;
}

function identity<T>(value: T): T {
  return value;
}

const object = 'value';

type Lookup = Record<string, unknown>;

interface Function {
  (input: string): number;
}

let runner: Function;
