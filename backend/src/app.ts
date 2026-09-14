import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { CognitoAdmin } from './auth/cognitoAdmin.js';
import type { Db } from './db/client.js';
import { sendProblem } from './errors.js';
import { logger } from './logger.js';
import { createCaregiversRouter } from './routes/caregivers.js';
import { createDependantsRouter } from './routes/dependants.js';
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
  // server.ts's shape: a single db client resolved once at startup, before any request arrives -
  // set directly onto app.locals below, synchronously.
  db?: Db;
  // lambda.ts's shape instead: db isn't known synchronously at app-creation time (it's resolved
  // from Secrets Manager, cached across warm invocations - see db/lambdaDb.ts), so it must be
  // re-checked per request via a middleware, not assigned once. Real bug fixed 2026-09-14: lambda.ts
  // used to add this middleware itself, AFTER calling createApp() - but createApp() had already
  // registered every router and the catch-all 404 handler by then, and every one of those sends
  // its own response without ever calling next() through to later middleware, so the db-attaching
  // middleware could never actually run, for any request, ever. app.locals.db was permanently
  // undefined in the deployed Lambda - every DB-touching route always 503'd with "No database
  // client is configured," undetected because every backend test either passes `db` directly
  // (server.ts's shape) or never exercises a DB route through the real deployed handler. Providing
  // this as a dependency createApp() itself wires in, before the routers, fixes the ordering by
  // construction rather than relying on call-site discipline.
  resolveDb?: () => Promise<Db>;
  // All optional for the same reason: app.test.ts constructs the app with none of them, and
  // /health needs none of them. Whichever caller has them (server.ts, lambda.ts) passes them in -
  // the rest are threaded into the routers that need them.
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
  // Permissive (no origin restriction): this API's authorization is entirely bearer-token based
  // (Authorization: Bearer <idToken>), never cookies, so permissive CORS carries none of the CSRF
  // exposure it would for a cookie-authenticated API. Needed so frontend/web/ (a different
  // origin/port in local dev, and any future deployed origin) can call this API from a browser -
  // added unconditionally here rather than only for local dev, so a future deployed web app needs
  // no separate backend change.
  app.use(cors());
  app.use(express.json());

  app.use(
    pinoHttp({
      logger,
      // Bearer tokens (Cognito JWTs) and session cookies must never be logged in full.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      customProps: (req) => ({ awsRequestId: req.apiGateway?.context?.awsRequestId }),
    }),
  );

  // Must run before every router below - see AppDependencies.resolveDb's comment for why this
  // exact position matters. Failure is deliberately non-fatal here: a request that doesn't touch
  // the database (like /health) must keep working even if Secrets Manager is having a transient
  // problem; routes that do need the database detect its absence themselves (each router's own
  // getDb() helper) and report their own 503, same as server.ts's local-dev path would if db were
  // ever missing there.
  if (dependencies.resolveDb) {
    const resolveDb = dependencies.resolveDb;
    app.use(async (req, _res, next) => {
      try {
        req.app.locals.db = await resolveDb();
      } catch (err) {
        logger.warn({ err }, 'Could not resolve DB client for this request; proceeding without one');
      }
      next();
    });
  }

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
    app.use('/dependants', createDependantsRouter({ cognitoAdmin, requireAuth }));
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
