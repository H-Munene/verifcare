import { defineConfig } from 'drizzle-kit';

// Placeholder lets `generate` run without a database; commands that connect need DATABASE_URL.
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://user:password@localhost:5432/mzazi_care';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Must match the `casing` option in db/client.ts or runtime column names won't line up.
  casing: 'snake_case',
  dbCredentials: {
    url: databaseUrl,
  },
});
