import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Integration tests have their own config (need a real Postgres).
    exclude: ['**/*.integration.test.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // Gate the pure logic that carries correctness/security weight. As modules
      // land, add them here and ratchet the thresholds up (see QA review §6).
      include: ['src/lib/**', 'src/config/**'],
      // Framework glue (Next request/response, cookies) — covered by the running
      // app + integration tests, not the unit gate.
      exclude: ['src/lib/auth.ts', 'src/lib/mailer.ts', '**/*.test.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
