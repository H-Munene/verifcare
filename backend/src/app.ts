import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { CognitoAdmin } from './auth/cognitoAdmin.js';
import type { CheckinFrameStorage } from './db/checkinFrameStorage.js';
import type { CheckinPhotoValidator } from './db/checkinLiveness.js';
import type { BiometricFaceCollection } from './db/biometricFaceCollection.js';
import type { BiometricStorage } from './db/biometricStorage.js';
import type { Db } from './db/client.js';
import type { FaceMatcher } from './db/faceMatch.js';
import { sendProblem } from './errors.js';
import { logger } from './logger.js';
import { createBiometricEnrollmentsRouter } from './routes/biometricEnrollments.js';
import { createCaregiversRouter } from './routes/caregivers.js';
import { createCheckinRouter } from './routes/checkin.js';
import { createDependantsRouter } from './routes/dependants.js';
import { createUsersRouter } from './routes/users.js';
import { createVisitSchedulesRouter } from './routes/visitSchedules.js';

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
  // HEZ-31's biometric-enrollment upload/confirm/list routes - only needs requireAuth, not
  // requireVerifiedIdentity/cognitoAdmin (nothing in that router touches Cognito).
  biometricStorage?: BiometricStorage;
  // HEZ-85's enrollment-uniqueness check (Rekognition Collection search/index), threaded through
  // the same router.
  biometricFaceCollection?: BiometricFaceCollection;
  // HEZ-33's geofence check-in endpoint (config.ts's own configurable defaults - 20m/600s - apply
  // when omitted, so app.test.ts/most callers don't need to pass these explicitly).
  geofenceAccuracyThresholdMeters?: number;
  checkinSessionTokenTtlSeconds?: number;
  // HEZ-34's caregiver check-in upload-url/submit endpoints - all optional together (see
  // routes/checkin.ts's CheckinRouterDependencies comment); the numeric one defaults the same way
  // the geofence pair above does when omitted.
  checkinLivenessFramesBucketName?: string;
  // Raw bucket name, not the already-constructed `biometricStorage` object above - db/faceMatch.ts
  // needs to build {bucket, s3Key} pairs for CompareFaces' TargetImage, not presign/DetectFaces
  // calls, so it has no use for biometricStorage's own createUploadUrl/assessFaceQuality methods.
  biometricEnrollmentsBucketName?: string;
  checkinLivenessMatchThresholdPercent?: number;
  checkinPhotoValidator?: CheckinPhotoValidator;
  checkinFaceMatcher?: FaceMatcher;
  checkinFrameStorage?: CheckinFrameStorage;
  // HEZ-35's dependant check-in step: how long after the caregiver step passes the dependant step
  // must be submitted (config.ts's own default - 120s/2min - applies when omitted).
  checkinCoPresenceWindowSeconds?: number;
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

  // HEZ-29's users/caregivers endpoints are the first real routes - the temporary /health/db and
  // /auth/whoami diagnostic routes from the two prior issues are now superseded and removed
  // (both were explicitly documented as temporary, pending exactly this).
  const {
    requireAuth,
    requireVerifiedIdentity,
    cognitoAdmin,
    biometricStorage,
    biometricFaceCollection,
  } = dependencies;
  if (requireAuth && requireVerifiedIdentity && cognitoAdmin) {
    app.use('/users', createUsersRouter({ cognitoAdmin, requireAuth, requireVerifiedIdentity }));
    app.use(
      '/caregivers',
      createCaregiversRouter({
        cognitoAdmin,
        requireAuth,
        faceCollection: biometricFaceCollection,
      }),
    );
    app.use(
      '/dependants',
      createDependantsRouter({
        cognitoAdmin,
        requireAuth,
        faceCollection: biometricFaceCollection,
      }),
    );
  }
  if (requireAuth && biometricStorage && biometricFaceCollection) {
    app.use(
      '/biometric-enrollments',
      createBiometricEnrollmentsRouter({
        requireAuth,
        storage: biometricStorage,
        faceCollection: biometricFaceCollection,
      }),
    );
  }
  // HEZ-32's visit-scheduling endpoints - unlike the routers above, this needs only requireAuth
  // (no cognitoAdmin/requireVerifiedIdentity - nothing here touches Cognito), so it's wired
  // independently rather than nested inside the users/caregivers/dependants condition.
  if (requireAuth) {
    app.use('/visit-schedules', createVisitSchedulesRouter({ requireAuth }));
    // HEZ-33's check-in flow - mounted at the same '/visit-schedules' prefix as a separate router
    // (see routes/checkin.ts's header comment for why), only needs requireAuth too.
    app.use(
      '/visit-schedules',
      createCheckinRouter({
        requireAuth,
        geofenceAccuracyThresholdMeters: dependencies.geofenceAccuracyThresholdMeters ?? 20,
        sessionTokenTtlSeconds: dependencies.checkinSessionTokenTtlSeconds ?? 600,
        // HEZ-34's caregiver check-in routes - createCheckinRouter() itself only registers them
        // once every one of these is actually present (see its own dependencies comment), so
        // passing possibly-undefined values through here is safe.
        livenessFramesBucketName: dependencies.checkinLivenessFramesBucketName,
        biometricEnrollmentsBucketName: dependencies.biometricEnrollmentsBucketName,
        livenessMatchThresholdPercent: dependencies.checkinLivenessMatchThresholdPercent ?? 80,
        photoValidator: dependencies.checkinPhotoValidator,
        faceMatcher: dependencies.checkinFaceMatcher,
        frameStorage: dependencies.checkinFrameStorage,
        coPresenceWindowSeconds: dependencies.checkinCoPresenceWindowSeconds ?? 120,
      }),
    );
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
