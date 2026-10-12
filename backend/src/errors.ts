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

// Catch-all error handler. Register it last.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  sendProblem(res, {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
  });
};
