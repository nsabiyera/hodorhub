import { migrateTestDb, closeTestDb } from './db';

/**
 * Vitest global setup for integration tests: apply migrations once before the
 * suite. Each test file resets rows via the per-test setup (setup.ts).
 */
export async function setup(): Promise<void> {
  await migrateTestDb();
  await closeTestDb(); // globalSetup runs in a separate process; close its pool.
}
