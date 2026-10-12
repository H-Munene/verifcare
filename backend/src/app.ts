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
      // Set by serverless-http in Lambda; undefined locally. Used to correlate logs.
      apiGateway?: { context?: { awsRequestId?: string } };
    }
  }
}

export interface AppDependencies {
  // Local server: db is known at startup.
  db?: Db;
  // Lambda: db comes from Secrets Manager, so it's resolved per request. The middleware has to be
  // registered here, before the routers - adding it after createApp() means it never runs.
  resolveDb?: () => Promise<Db>;
  // Optional so tests and /health can run without them.
  requireAuth?: RequestHandler;
  requireVerifiedIdentity?: RequestHandler;
  cognitoAdmin?: CognitoAdmin;
}

// Doesn't install the final error handler; each entry point attaches errorHandler last.
export function createApp(dependencies: AppDependencies = {}): Express {
  const app = express();
  app.locals.db = dependencies.db;
  // Open CORS is fine: auth is bearer tokens only, no cookies.
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

  // Must run before the routers. Non-fatal so /health still works if Secrets Manager is down;
  // DB routes return 503 on their own.
  if (dependencies.resolveDb) {
    const resolveDb = dependencies.resolveDb;
    app.use(async (req, _res, next) => {
      try {
        req.app.locals.db = await resolveDb();
      } catch (err) {
        logger.warn(
          { err },
          'Could not resolve DB client for this request; proceeding without one',
        );
      }
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

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
