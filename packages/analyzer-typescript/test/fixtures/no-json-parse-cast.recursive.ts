// A self-referential type: `Json` reaches itself through both its index
// signature and its array member. Walking it to decide whether it contains
// `any` or `unknown` recurses forever unless the walk remembers where it has
// been, and the resulting stack overflow aborted the rule for the whole file.
// Supabase generates exactly this type, so it is not a contrived shape.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export function parseJson(raw: string): Json {
  return JSON.parse(raw);
}

export function parseJsonArray(raw: string): Json[] {
  return JSON.parse(raw);
}
