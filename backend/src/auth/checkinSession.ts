// Check-in session verification (HEZ-34) - required IN ADDITION to, not instead of, the normal
// Cognito requireAuth/requireRole('caregiver') + visit-ownership check every checkin/* route
// already performs. Confirmed with the user as the more robust of two designs (senior-engineer
// recommendation, not deferred to the user's own suggestion): a session-token-only design would
// mean a leaked/intercepted session token alone is enough to complete check-in as the
// caregiver, with no requirement to also be authenticated as that Cognito user on that device.
// Requiring both is defense-in-depth at negligible extra cost - the Cognito check this project
// already has on every other route, plus proof this specific visit's geofence step was passed
// recently. It also avoids overloading the `Authorization: Bearer` header with two structurally
// different token types depending on which endpoint is called (the session token travels in its
// own header, X-Checkin-Session-Token, instead) - openapi.yaml's `security: [{bearerAuth:
// [sessionToken]}]` annotation on the challenge endpoint was ambiguous scope-syntax borrowed from
// OAuth2 that doesn't actually apply to an `http`/`bearer` scheme, not a considered design; this
// file's actual design supersedes it, and openapi.yaml is updated to match (HEZ-34).
//
// Expiry is read directly from verification_events.session_token_issued_at (HEZ-34 added this
// column - HEZ-33's original plan to derive it from a verification_attempts row on every request
// was revisited here: this design needs it on every remaining check-in request,
// and a direct column avoids both the extra cross-table query and coupling this auth check to
// verification_attempts' own audit-log shape).

import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { hashSessionToken } from './sessionToken.js';

const SESSION_TOKEN_HEADER = 'x-checkin-session-token';

export async function resolveCheckinSession(
  db: Db,
  visitScheduleId: string,
  headerValue: string | string[] | undefined,
  sessionTokenTtlSeconds: number,
  res: Response,
): Promise<typeof schema.verificationEvents.$inferSelect | undefined> {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: `Missing ${SESSION_TOKEN_HEADER} header - pass the sessionToken returned by the geofence check.`,
    });
    return undefined;
  }

  const [event] = await db
    .select()
    .from(schema.verificationEvents)
    .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));

  if (
    !event ||
    !event.sessionTokenHash ||
    !event.sessionTokenIssuedAt ||
    event.sessionTokenHash !== hashSessionToken(headerValue)
  ) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid check-in session token - pass a fresh geofence check to get a new one.',
    });
    return undefined;
  }

  const expiresAt = event.sessionTokenIssuedAt.getTime() + sessionTokenTtlSeconds * 1000;
  if (Date.now() > expiresAt) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Check-in session has expired - pass a fresh geofence check to get a new one.',
    });
    return undefined;
  }

  return event;
}

export { SESSION_TOKEN_HEADER };
