import { sql } from 'drizzle-orm';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Db } from './db/client.js';
import { sendProblem } from './errors.js';
import { logger } from './logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set unconditionally by serverless-http's AWS provider (confirmed in its source,
      // lib/provider/aws/create-request.js) when running in Lambda; undefined for local dev and
      // tests. Used to correlate application logs with the Lambda invocation's own CloudWatch
      // START/END/REPORT lines.
      apiGateway?: { context?: { awsRequestId?: string } };
    }
  }
}

export interface AppDependencies {
  db?: Db;
}

// db is optional: app.test.ts and the DB-independent parts of lambda.ts construct the app with no
// db yet, and /health doesn't need one. Whichever caller has a db (server.ts, lambda.ts) attaches
// it to app.locals so any route can read req.app.locals.db - the seam for the first real
// DB-touching route.
//
// This does NOT install a terminal error handler - see errors.ts's errorHandler for why that must
// be attached last, by each entry point, after any of its own error-handling middleware
// (lambda.ts's Postgres-auth-rotation handler in particular).
export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  app.locals.db = dependencies.db;

  app.use(
    pinoHttp({
      logger,
      // Bearer tokens (Cognito JWTs, once HEZ-28 lands) and session cookies must never be logged
      // in full.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      customProps: (req) => ({ awsRequestId: req.apiGateway?.context?.awsRequestId }),
    }),
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Temporary diagnostic route proving the Lambda-to-RDS connection actually works end-to-end
  // after a real cdk deploy (HEZ-27's DB-connection slice has no other route that touches the
  // database yet). Remove this once a real route exercises req.app.locals.db instead.
  app.get('/health/db', async (req, res) => {
    const db = req.app.locals.db as Db | undefined;
    if (!db) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'No database client is configured.',
      });
      return;
    }
    await db.execute(sql`SELECT 1`);
    res.status(200).json({ status: 'ok' });
  });

  // No route matched. Must come after every real route, before any error-handling middleware.
  app.use((req, res) => {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: `No resource exists at ${req.path}.`,
    });
  });

  return app;
}
