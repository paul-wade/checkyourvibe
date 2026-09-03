function identity<T>(input: T): T {
  return input;
}

type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; side: number };

function classify(shape: Shape): string {
  switch (shape.kind) {
    case 'circle':
      return 'round';
    case 'square':
      return 'angular';
  }
}

function emit(event: string): void {
  console.log(event);
}
