import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from './schema';

/**
 * Single shared connection pool. Row-level tenancy (organisation_id) is enforced
 * in application queries — this is the tenant isolation boundary (ARCHITECTURE.md §3/§10).
 *
 * Cloud Run runs one pool PER instance and autoscales, so the aggregate cap is
 * `max × maxInstances + worker + migrate` — keep `max` small and size Cloud SQL
 * `max_connections` (or a pooler) against it (TECH_DEBT A2). Override via env.
 */
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 5),
});

export const db = drizzle(pool, { schema });
export { schema };
