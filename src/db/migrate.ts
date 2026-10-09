import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Standalone migration runner for production (ADR 0001). Bundled by esbuild into
 * dist/migrate.cjs and run as a one-shot `migrate` service the app depends on.
 * drizzle-kit is a devDependency and is NOT present in the runtime image, so we
 * use drizzle-orm's own migrator against the committed ./drizzle folder.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
  await pool.end();
  console.warn('[migrate] applied migrations from ./drizzle');
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
