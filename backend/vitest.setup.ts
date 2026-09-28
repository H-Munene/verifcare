try {
  // Loads backend/.env into process.env, same file drizzle-kit already reads. Not present in CI,
  // which sets real environment variables directly - that's fine, loadEnvFile just throws and is
  // ignored.
  process.loadEnvFile();
} catch {
  // Intentionally ignored - see comment above.
}
