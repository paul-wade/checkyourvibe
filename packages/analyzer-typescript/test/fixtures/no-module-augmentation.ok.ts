// Every `declare module` in this file is one of the three forms the rule must not
// report. Together they are the rule's specification: it fires on a relative
// specifier and on nothing else.

export interface LocalShape {
  readonly id: string;
}

// A bare specifier names a package, not a file in this project. Nobody can open
// the declaring file and add the member there, because it belongs to a
// dependency. Reporting this would also contradict `no-ts-comment`, which offers
// exactly this construct as an allowed fix in the same pack.
declare module 'node:net' {
  interface Socket {
    lastSeenAt?: number;
  }
}

// A wildcard declaration types a class of imports rather than one module. There
// is no single file that owns the shape, so there is no file a reader could be
// sent to instead.
declare module '*.svg' {
  const source: string;
  export default source;
}

// `declare global` carries no module specifier at all, so the question the rule
// asks — is this specifier relative? — has no subject.
declare global {
  interface Window {
    __cyvDiagnostics?: readonly string[];
  }
}
