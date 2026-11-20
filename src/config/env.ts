import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** How long to wait for in-flight requests to finish on shutdown. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast with a readable message instead of crashing later at runtime.
  console.error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  isProduction: parsed.data.NODE_ENV === 'production',
  port: parsed.data.PORT,
  mongodbUri: parsed.data.MONGODB_URI,
  corsOrigins: parsed.data.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  shutdownTimeoutMs: parsed.data.SHUTDOWN_TIMEOUT_MS,
};
