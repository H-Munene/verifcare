import { Pool } from 'pg';
import { createApp } from './app.js';
import { createDb } from './db/client.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file present - fine, DATABASE_URL is presumably set some other way.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set - see backend/.env.example.');
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createDb(pool);

const port = Number(process.env.PORT ?? 3000);

createApp({ db }).listen(port, () => {
  console.log(`backend listening on port ${port}`);
});
