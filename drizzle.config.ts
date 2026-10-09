import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Read at CLI time only; never bundled into the app.
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
