// Express middleware for authentication (requireAuth) and RBAC (requireRole), built on top of
// verifier.ts. Always independently verifies the JWT signature here, rather than trusting that
// API Gateway's Cognito authorizer already did so - a deliberate choice: local dev (server.ts) has
// no API Gateway in front of it at all, so this is the only way protected routes are testable
// there, and it also gives real defense-in-depth for the deployed Lambda rather than relying
// solely on network topology (only API Gateway can reach it) to keep an unverified decode safe.

import type { RequestHandler } from 'express';
import { sendProblem } from '../errors.js';
import { logger } from '../logger.js';
import {
  extractUser,
  type AuthenticatedUser,
  type IdTokenVerifier,
  type UserRole,
} from './verifier.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by requireAuth once the bearer token's signature and claims have been verified.
      // Undefined on any route not behind requireAuth.
      auth?: AuthenticatedUser;
    }
  }
}

const BEARER_PREFIX = 'Bearer ';

export function createRequireAuth(verifier: IdTokenVerifier): RequestHandler {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Missing or malformed Authorization header - expected "Bearer <token>".',
      });
      return;
    }

    const token = header.slice(BEARER_PREFIX.length);
    try {
      const payload = await verifier.verify(token);
      req.auth = extractUser(payload);
      next();
    } catch (err) {
      logger.warn({ err }, 'ID token verification failed');
      sendProblem(res, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'The provided token is invalid, expired, or malformed.',
      });
    }
  };
}

// Must run after requireAuth on the same route (requireAuth populates req.auth). Enforces that the
// authenticated user's single role is one of the roles this route allows - matches
// architecture.md's role model (a user has exactly one role; supervisor/administrator share full
// permissions).
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.auth) {
      // Programmer error (requireRole used on a route without requireAuth ahead of it), not a
      // client error - still surfaced as 401 rather than a 500, since from the client's point of
      // view it's indistinguishable from "you're not authenticated".
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
