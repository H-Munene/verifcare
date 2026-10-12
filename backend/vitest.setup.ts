try {
  // Loads backend/.env into process.env, same file drizzle-kit already reads. Not present in CI -
  // that's fine, loadEnvFile just throws and is ignored. CI instead sets the required vars
  // directly in .github/workflows/ci.yml's `npm test` step (a real gap until 2026-09-14: that step
  // didn't actually set them for a while, despite this comment's earlier claim that it did - see
  // backend-dev-log.md's "Two CI pipeline bugs fixed from real GitHub Actions failures" entry).
  process.loadEnvFile();
} catch {
  // Intentionally ignored - see comment above.
}
