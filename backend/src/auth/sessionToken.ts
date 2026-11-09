// Short-lived check-in session tokens (HEZ-33 onward), a materially different mechanism from the
// Cognito ID tokens auth/middleware.ts verifies - these scope only the remainder of one check-in
// flow (geofence pass -> code scan) for one visit_schedule, per openapi.yaml's `checkin/*`
// endpoints. The family member's check-in codes (routes/checkinCode.ts) use the same generator. Stored only as a SHA-256 hash
// (verification_events.session_token_hash, per that column's own file-header note) - never the raw
// token - so a leaked database row or backup can never be replayed as a live token, the same reason
// passwords are never stored in plaintext, even though this isn't a password.
//
// Plain SHA-256, not bcrypt/scrypt: the token itself is a 256-bit cryptographically random value,
// not a low-entropy user-chosen secret, so there is no brute-force-by-guessing risk a slow hash
// defends against - only tampering/reuse-after-compromise, which a fast, collision-resistant hash
// already fully addresses.

import { createHash, randomBytes } from 'node:crypto';

export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
