try {
  // Load backend/.env if present. CI sets env vars directly.
  process.loadEnvFile();
} catch {
  // No .env file.
}
