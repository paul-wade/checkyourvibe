// Benchmark fixture. Provokes: no-json-parse-cast.
import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

export type UserData = z.infer<typeof UserSchema>;

export function parseUserData(rawJson: string): UserData {
  return UserSchema.parse(JSON.parse(rawJson));
}
