// Cursor pagination shared by all list endpoints. The cursor is opaque to clients.
//
// Keyset on id alone: ids are UUID v7, so already time-ordered. Don't add createdAt to the key -
// timestamptz has microsecond precision but a JS Date only has milliseconds, so the boundary row
// would repeat on the next page.
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export interface Cursor {
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ id: cursor.id })).toString('base64url');
}

// Throws on malformed input; callers should return 400.
export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed pagination cursor.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Malformed pagination cursor.');
  }
  const { id } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') {
    throw new Error('Malformed pagination cursor.');
  }
  return { id };
}

export function cursorCondition(idColumn: PgColumn, cursor: Cursor): SQL {
  return sql`${idColumn} > ${cursor.id}`;
}

// Callers fetch `limit + 1` rows ordered by id ASC; this splits that result into the page actually
// returned and the next cursor (or null on the last page), without a separate COUNT query.
export function paginate<T>(
  rowsFetched: T[],
  limit: number,
  cursorOf: (row: T) => Cursor,
): { items: T[]; nextCursor: string | null } {
  if (rowsFetched.length > limit) {
    const items = rowsFetched.slice(0, limit);
    const last = items.at(-1);
    if (!last) {
      // Unreachable while limit >= 1.
      throw new Error('paginate() invariant violated: items should never be empty here.');
    }
    return { items, nextCursor: encodeCursor(cursorOf(last)) };
  }
  return { items: rowsFetched, nextCursor: null };
}
