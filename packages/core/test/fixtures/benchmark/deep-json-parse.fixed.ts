import { z } from 'zod';

export const DeepConfigSchema = z.object({
  server: z.object({ host: z.string(), port: z.number(), tls: z.object({ enabled: z.boolean(), cert: z.string().optional() }) }),
  database: z.object({ url: z.string(), poolSize: z.number(), timeoutMs: z.number() }),
  features: z.object({ flags: z.record(z.boolean()), maxUsers: z.number() }),
});

export type DeepConfig = z.infer<typeof DeepConfigSchema>;

export function parseDeepConfig(raw: string): DeepConfig {
  return DeepConfigSchema.parse(JSON.parse(raw));
}
