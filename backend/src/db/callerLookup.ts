// Resolves the calling user's own internal `users` row from their verified JWT `sub`
// (auth/verifier.ts's AuthenticatedUser.sub / VerifiedIdentity.sub). HEZ-30 is the first route to
// need this - `dependants.registeredBy` and `dependant_family_members.addedBy` are both internal
// UUIDs, not Cognito subs, unlike every column HEZ-29's routes/users.ts and routes/caregivers.ts
// needed (those compare cognitoSub directly against the target row, never the caller's own id).
// Pulled out as a shared helper because every future `created_by`/`enrolled_by`-style column
// (visit scheduling, biometric enrollment, ...) will need the exact same lookup - the same
// reasoning that justified pagination.ts/validation.ts during HEZ-29.

import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import * as schema from './schema.js';

export async function getUserByCognitoSub(
  db: Db,
  cognitoSub: string,
): Promise<typeof schema.users.$inferSelect | undefined> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.cognitoSub, cognitoSub));
  return row;
}
