import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '@/db/schema';

/**
 * Integration-test database helpers. Uses TEST_DATABASE_URL (falls back to
 * DATABASE_URL). NEVER point this at a database with real data — resetDb()
 * truncates every table. In CI it targets the ephemeral Postgres service.
 */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL (or DATABASE_URL) must be set for integration tests');

export const pool = new pg.Pool({ connectionString: url });
export const testDb = drizzle(pool, { schema });

export async function migrateTestDb(): Promise<void> {
  await migrate(testDb, { migrationsFolder: './drizzle' });
}

/** Truncate all app tables between tests, resetting identities and cascading FKs. */
export async function resetDb(): Promise<void> {
  const rows = await testDb.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE 'drizzle%' AND tablename NOT LIKE 'pgboss%'
  `);
  const tables = rows.rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length === 0) return;
  await testDb.execute(sql.raw(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`));
}

export async function closeTestDb(): Promise<void> {
  await pool.end();
}
