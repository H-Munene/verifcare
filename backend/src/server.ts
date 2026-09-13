import { Pool } from 'pg';
import { createApp } from './app.js';
import { createRequireAuth } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file present - fine, DATABASE_URL is presumably set some other way.
}

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set - see backend/.env.example.');
}

const pool = new Pool({ connectionString: config.databaseUrl });
const db = createDb(pool);

// No local Cognito emulator in this project's stack - local dev verifies against the same real,
// deployed User Pool the Lambda uses (see .env.example).
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientId);
const requireAuth = createRequireAuth(verifier);

const app = createApp({ db, requireAuth });
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend listening');
});
