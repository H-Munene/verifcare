import { sql } from 'drizzle-orm';
import express, { type Express } from 'express';
import type { Db } from './db/client.js';

export interface AppDependencies {
  db?: Db;
}

// db is optional: app.test.ts and the DB-independent parts of lambda.ts construct the app with no
// db yet, and /health doesn't need one. Whichever caller has a db (server.ts, lambda.ts) attaches
// it to app.locals so any route can read req.app.locals.db - the seam for the first real
// DB-touching route.
export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  app.locals.db = dependencies.db;

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Temporary diagnostic route proving the Lambda-to-RDS connection actually works end-to-end
  // after a real cdk deploy (HEZ-27's DB-connection slice has no other route that touches the
  // database yet). Remove this once a real route exercises req.app.locals.db instead.
  app.get('/health/db', async (req, res) => {
    const db = req.app.locals.db as Db | undefined;
    if (!db) {
      res.status(503).json({ status: 'no db configured' });
      return;
    }
    await db.execute(sql`SELECT 1`);
    res.status(200).json({ status: 'ok' });
  });

  return app;
}
