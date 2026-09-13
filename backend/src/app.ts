import express, { type Express, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { CognitoAdmin } from './auth/cognitoAdmin.js';
import type { Db } from './db/client.js';
import { sendProblem } from './errors.js';
import { logger } from './logger.js';
import { createCaregiversRouter } from './routes/caregivers.js';
import { createUsersRouter } from './routes/users.js';

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
  // All optional for the same reason: app.test.ts constructs the app with none of them, and
  // /health needs none of them. Whichever caller has them (server.ts, lambda.ts) passes them in -
  // db is attached to app.locals for any route to read; the rest are threaded into the routers
  // that need them.
  requireAuth?: RequestHandler;
  requireVerifiedIdentity?: RequestHandler;
  cognitoAdmin?: CognitoAdmin;
}

// This does NOT install a terminal error handler - see errors.ts's errorHandler for why that must
// be attached last, by each entry point, after any of its own error-handling middleware
// (lambda.ts's Postgres-auth-rotation handler in particular).
export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  app.locals.db = dependencies.db;
  app.use(express.json());

  app.use(
    pinoHttp({
      logger,
      // Bearer tokens (Cognito JWTs) and session cookies must never be logged in full.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      customProps: (req) => ({ awsRequestId: req.apiGateway?.context?.awsRequestId }),
    }),
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // HEZ-29's users/caregivers endpoints are the first real routes - the temporary /health/db and
  // /auth/whoami diagnostic routes from the two prior issues are now superseded and removed
  // (both were explicitly documented as temporary, pending exactly this).
  const { requireAuth, requireVerifiedIdentity, cognitoAdmin } = dependencies;
  if (requireAuth && requireVerifiedIdentity && cognitoAdmin) {
    app.use('/users', createUsersRouter({ cognitoAdmin, requireAuth, requireVerifiedIdentity }));
    app.use('/caregivers', createCaregiversRouter({ cognitoAdmin, requireAuth }));
  }

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
