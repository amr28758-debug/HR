import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env from the repo root (or cwd) without overriding real environment variables.
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, override: false });
    break;
  }
}

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_URL_TEST: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  AUTH_MODE: z.enum(['local', 'entra']).default('local'),
  AUTH_LOCAL_JWT_SECRET: z.string().min(32).optional(),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(28800),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_API_AUDIENCE: z.string().optional(),
  API_KEY_PEPPER: z.string().min(8).default('dev-pepper-change-me'),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('burtplace-documents'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: boolish.default('true'),

  BIOMETRIC_PROVIDER: z.enum(['webhook', 'vyom', 'none']).default('webhook'),
  VYOM_BASE_URL: z.string().optional(),
  VYOM_USERNAME: z.string().optional(),
  VYOM_PASSWORD: z.string().optional(),
  VYOM_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  // Notification channels (optional). Email needs an SMTP relay from IT; Teams needs an incoming-webhook URL created by the Teams admin.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: boolish.default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Burtplace Workforce <hr-noreply@burtplace.ae>'),
  TEAMS_WEBHOOK_URL: z.string().url().optional(),

  COMPANY_NAME: z.string().default('Burtplace General Contracting'),
  COMPANY_TIMEZONE: z.string().default('Asia/Dubai'),
  DEFAULT_LOCALE: z.enum(['en', 'ar']).default('en'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parse and validate process.env once. Throws a readable error listing every invalid variable. */
export function getEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.AUTH_MODE === 'local' && !env.AUTH_LOCAL_JWT_SECRET) {
    throw new Error('AUTH_LOCAL_JWT_SECRET is required when AUTH_MODE=local');
  }
  if (env.AUTH_MODE === 'entra' && (!env.ENTRA_TENANT_ID || !env.ENTRA_CLIENT_ID || !env.ENTRA_API_AUDIENCE)) {
    throw new Error('ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_API_AUDIENCE are required when AUTH_MODE=entra');
  }
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'local') {
    throw new Error('AUTH_MODE=local is not allowed in production. Use AUTH_MODE=entra.');
  }
  if (Object.keys(overrides).length === 0) cached = env;
  return env;
}

export function resetEnvCache(): void {
  cached = undefined;
}
