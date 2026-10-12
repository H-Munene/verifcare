import { Pool } from 'pg';
import { createApp } from './app.js';
import { createCognitoAdmin } from './auth/cognitoAdmin.js';
import { createRequireAuth, createRequireVerifiedIdentity } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file; DATABASE_URL may be set elsewhere.
}

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set - see backend/.env.example.');
}

const pool = new Pool({ connectionString: config.databaseUrl });
const db = createDb(pool);

// Local dev uses the deployed user pool, so Cognito admin calls need local AWS credentials.
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientIds);
const requireAuth = createRequireAuth(verifier);
const requireVerifiedIdentity = createRequireVerifiedIdentity(verifier);
const cognitoAdmin = createCognitoAdmin(config.userPoolId);

const app = createApp({ db, requireAuth, requireVerifiedIdentity, cognitoAdmin });
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend listening');
});
