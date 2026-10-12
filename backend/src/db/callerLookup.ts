// Looks up the caller's `users` row from their JWT `sub`, for columns like registeredBy/addedBy
// that store internal user ids rather than Cognito subs.

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
