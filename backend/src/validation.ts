// Shared zod validation for request bodies and query strings.

import type { Response } from 'express';
import type { z } from 'zod';
import { sendProblem } from './errors.js';

// E.164, the only phone format Cognito's phone_number accepts (a local "0712..." is rejected).
export const E164_PHONE_NUMBER = /^\+[1-9]\d{6,14}$/;
export const E164_MESSAGE = 'phoneNumber must be in E.164 format, e.g. +254712345678.';

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
