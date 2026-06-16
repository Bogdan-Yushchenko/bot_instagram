import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform((v) => parseInt(v, 10)),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  IG_USERNAME: z.string().min(1, 'IG_USERNAME is required'),
  IG_PASSWORD: z.string().min(1, 'IG_PASSWORD is required'),
  IG_WEB_COOKIES_FILE: z.string().optional(),

  MATERIAL_LINK: z.string().url().default('https://example.com/material'),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
