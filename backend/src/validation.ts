// Shared request-body/query validation, built on zod (already a dependency for config.ts's env
// validation - reused here rather than introducing a second validation approach). The first route
// file to need this is routes/users.ts; every later route (HEZ-30 onward) should use the same
// helper instead of hand-rolling its own 400 response shape.

import type { Response } from 'express';
import type { z } from 'zod';
import { sendProblem } from './errors.js';

// Validates `data` against `schema`. On success returns the parsed (and, for zod, coerced/
// defaulted) value. On failure, sends an RFC 7807 400 response itself and returns undefined - the
// caller's route handler should check for undefined and return immediately, the same pattern
// auth/middleware.ts's verifyBearerToken already establishes for a failed precondition.
export function parseOrSendProblem<T>(
  schema: z.ZodType<T>,
  data: unknown,
  res: Response,
): T | undefined {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
    .join('; ');
  sendProblem(res, { type: 'about:blank', title: 'Bad Request', status: 400, detail });
  return undefined;
}
