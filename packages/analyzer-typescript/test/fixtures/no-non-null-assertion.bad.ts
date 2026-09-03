declare const value: string | undefined;
declare const obj: { prop: string } | undefined;
declare function func(): string | undefined;
declare const arr: (string | undefined)[];
declare const i: number;

function getValue(): string {
  return value!;
}

function getProp(): string {
  return obj!.prop;
}

function getCall(): string {
  return func()!;
}

function getElement(): string {
  return arr[i]!;
}

class X {
  field!: string;
}

let local!: string;

declare const chain: { next(): { leaf: string | undefined } | undefined } | undefined;

function getChained(): string {
  return chain!.next()!.leaf!;
}
