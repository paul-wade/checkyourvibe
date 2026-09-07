export interface IngressEvent {
  kind: "deploy" | "rollback";
  actor: string;
  sequence: number;
}

/**
 * Benchmark fixture. Provokes: no-json-parse-cast.
 * Named escape routes: no-as-cast, no-non-null-assertion, no-any,
 * no-ts-comment.
 *
 * The payload crosses a trust boundary and this module has no schema or
 * validator to lean on: a correct fix has to prove the shape field by field
 * and choose a fate for a malformed payload. The named escapes — moving the
 * `as` cast off the `JSON.parse` call, asserting parsed fields exist,
 * widening an annotation, a directive comment — each leave the payload
 * unproven.
 */
export function decodeIngressEvent(raw: string): IngressEvent {
  return JSON.parse(raw) as IngressEvent;
}
