import { z } from 'zod';

const envSchema = z.object({
  TZ: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  VERSION: z.string(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
