import { z } from 'zod';

/**
 * Environment schema. Kept as a pure, exported parser so it is unit-testable
 * (QA) and so it does NOT throw during `next build`, when runtime secrets are
 * absent (DevOps). Strict validation still runs at real runtime boot.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  // 32 bytes, base64-encoded → AES-256 key.
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes base64-encoded'),
  SESSION_SECRET: z.string().min(32),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('HodorHub <no-reply@hodorhub.local>'),
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  TWITTER_CLIENT_ID: z.string().optional(),
  TWITTER_CLIENT_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_DELIVERY_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
  E2B_API_KEY: z.string().optional(),
  AGENT_DELIVERY_SANDBOX: z.enum(['fake', 'e2b']).default('fake'),
  AGENT_DELIVERY_DEPLOYER: z.enum(['fake', 'cloudrun']).default('fake'),
  // US-10.6 — 'stripe' throws until real keys are wired; default stays offline.
  STRIPE_SECRET_KEY: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
});

export type Env = z.infer<typeof schema>;

/** Pure, throwing validator — feed it any source object in tests. */
export function parseEnv(source: Record<string, unknown>): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Print only which keys failed, never their values.
    console.error('❌ Invalid environment:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed. See .env.example.');
  }
  return parsed.data;
}

// Skip fail-fast validation where runtime secrets legitimately don't exist:
// during the production build and under the test runner.
const skipEager =
  process.env.NEXT_PHASE === 'phase-production-build' || process.env.NODE_ENV === 'test';

export const env: Env = skipEager
  ? (schema.partial().parse(process.env) as Env)
  : parseEnv(process.env);

export const isProd = env.NODE_ENV === 'production';
