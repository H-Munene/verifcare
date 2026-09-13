// RFC 7807 Problem Details helpers, matching openapi.yaml's error convention
// (application/problem+json, { type, title, status, detail?, instance? }).

import type { ErrorRequestHandler, Response } from 'express';
import { logger } from './logger.js';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

export function sendProblem(res: Response, problem: Problem): void {
  res.status(problem.status).type('application/problem+json').json(problem);
}

// Terminal error handler - the last middleware in the chain. Any Lambda-specific error handling
// (lambda.ts's Postgres-auth-rotation handler) must be registered BEFORE this one: Express walks
// error-handling middleware in registration order and stops at the first one that doesn't call
// next(err), so this catch-all must always be attached last, never first.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  sendProblem(res, {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
  });
};
