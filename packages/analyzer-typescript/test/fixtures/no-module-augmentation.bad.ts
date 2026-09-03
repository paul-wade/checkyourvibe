import type { DispatchLiveness } from './no-module-augmentation.dispatch.js';

// The shape that produced this rule. T36004 asked for three fields on
// DispatchOpened and was scoped to files that did not include the one declaring
// it, so the augmentation below was the only route left. It compiled, passed the
// analyzer and passed the suite, and left the declaring file describing a type
// that does not mention three of its own fields.
declare module './no-module-augmentation.dispatch.js' {
  interface DispatchOpened extends Partial<DispatchLiveness> {}
}

// The same defect reached through a parent directory. The prefix differs; what a
// reader of the declaring file sees does not.
declare module '../fixtures/no-module-augmentation.dispatch.js' {
  interface DispatchOpened {
    retriedAt?: number;
  }
}
