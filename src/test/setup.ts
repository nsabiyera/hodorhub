import { beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from './db';

// Test-only secrets so crypto/session work in integration tests (CI provides its
// own; these ??= defaults never override real values).
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ??= 'integration-test-session-secret-0123456789';

// Fresh, isolated DB state for every integration test.
beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestDb();
});
