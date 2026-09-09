import { defineConfig } from 'drizzle-kit';

// `generate` only diffs schema.ts against the migrations already in `out` - it never opens a
// connection, so this default lets it run without any local setup. `push`/`migrate`/`studio` do
// connect, and will fail naturally against this placeholder if DATABASE_URL isn't set for real.
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://user:password@localhost:5432/mzazi_care';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Columns are written camelCase in schema.ts; this maps them to snake_case in generated SQL.
  // The runtime `drizzle()` client (HEZ-27) must be constructed with the same `casing: 'snake_case'`
  // option, or query-time column name resolution will mismatch what these migrations create.
  casing: 'snake_case',
  dbCredentials: {
    url: databaseUrl,
  },
});
