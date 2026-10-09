import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests — run against a real Postgres (docker compose up -d db).
 * Separate from the unit config so unit tests stay fast and DB-free.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    setupFiles: ['src/test/setup.ts'],
    // argon2 hashing + DB round-trips are slower than unit tests.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests share one database; don't run files in parallel.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
