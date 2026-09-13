import { Pool } from 'pg';
import { createApp } from './app.js';
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

const app = createApp({ db });
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend listening');
});
