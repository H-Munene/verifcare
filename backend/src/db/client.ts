// Single place that knows the `casing: 'snake_case'` rule shared by every runtime Drizzle client
// in this project (local dev, tests, and the Lambda-deployed api). See schema.ts's and
// drizzle.config.ts's header comments for why this must match the migrations exactly.

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema, casing: 'snake_case' });
}
