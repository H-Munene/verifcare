// Auth middleware: requireAuth, requireVerifiedIdentity and requireRole. Verifies the JWT here
// even behind API Gateway's authorizer, since local dev has no API Gateway.

import type { Response, RequestHandler } from 'express';
import { sendProblem } from '../errors.js';
import { logger } from '../logger.js';
import {
  extractIdentity,
  extractUser,
  type AuthenticatedUser,
  type IdTokenVerifier,
  type UserRole,
  type VerifiedIdentity,
} from './verifier.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by requireAuth.
      auth?: AuthenticatedUser;
      // Set by requireVerifiedIdentity (role optional). Only used by POST /users.
      identity?: VerifiedIdentity;
    }
  }
}

const BEARER_PREFIX = 'Bearer ';

// Verifies the bearer token, or sends a 401 and returns undefined.
async function verifyBearerToken(
  req: { headers: { authorization?: string } },
  res: Response,
  verifier: IdTokenVerifier,
): Promise<Record<string, unknown> | undefined> {
  const header = req.headers.authorization;
  if (!header?.startsWith(BEARER_PREFIX)) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Missing or malformed Authorization header - expected "Bearer <token>".',
    });
    return undefined;
  }

  const token = header.slice(BEARER_PREFIX.length);
  try {
    return await verifier.verify(token);
  } catch (err) {
    logger.warn({ err }, 'ID token verification failed');
    sendProblem(res, {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'The provided token is invalid, expired, or malformed.',
    });
    return undefined;
  }
}

export function createRequireAuth(verifier: IdTokenVerifier): RequestHandler {
  return async (req, res, next) => {
    const payload = await verifyBearerToken(req, res, verifier);
    if (!payload) {
      return;
    }
    try {
      req.auth = extractUser(payload);
      next();
    } catch (err) {
      logger.warn({ err }, 'Verified token has an unusable payload');
      sendProblem(res, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'The provided token is invalid, expired, or malformed.',
      });
    }
  };
}

// Like requireAuth but doesn't require a role, for POST /users. req.identity.role may be undefined.
export function createRequireVerifiedIdentity(verifier: IdTokenVerifier): RequestHandler {
  return async (req, res, next) => {
    const payload = await verifyBearerToken(req, res, verifier);
    if (!payload) {
      return;
    }
    try {
      req.identity = extractIdentity(payload);
      next();
    } catch (err) {
      logger.warn({ err }, 'Verified token has an unusable payload');
      sendProblem(res, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'The provided token is invalid, expired, or malformed.',
      });
    }
  };
}

// Must run after requireAuth.
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      // requireAuth is missing from the route; treat as unauthenticated.
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: `This action requires one of the following roles: ${roles.join(', ')}.`,
      });
      return;
    }
    next();
  };
}
