// Shared zod validation for request bodies and query strings.

import type { Response } from 'express';
import type { z } from 'zod';
import { sendProblem } from './errors.js';

// Returns the parsed value, or sends a 400 problem response and returns undefined.
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
