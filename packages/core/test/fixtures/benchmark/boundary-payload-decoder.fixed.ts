export interface IngressEvent {
  kind: "deploy" | "rollback";
  actor: string;
  sequence: number;
}

export function decodeIngressEvent(raw: string): IngressEvent {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error("not an object");
  
  if (!('kind' in parsed) || (parsed.kind !== 'deploy' && parsed.kind !== 'rollback')) throw new Error("invalid kind");
  if (!('actor' in parsed) || typeof parsed.actor !== 'string') throw new Error("invalid actor");
  if (!('sequence' in parsed) || typeof parsed.sequence !== 'number') throw new Error("invalid sequence");
  
  return {
    kind: parsed.kind,
    actor: parsed.actor,
    sequence: parsed.sequence,
  };
}
