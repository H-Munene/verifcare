// Shared cursor-pagination helpers. openapi.yaml describes the cursor as opaque - this file is
// the one place that decides what's actually inside it, so every list endpoint (starting with
// HEZ-29's users/caregivers, and reused as-is by HEZ-30/HEZ-32's list endpoints) encodes and
// decodes it the same way instead of each route inventing its own.
//
// Keyset pagination on id alone, not OFFSET/LIMIT and not (createdAt, id): project-state.md
// already settled on cursor pagination specifically because list endpoints need to stay stable
// under concurrent writes, which OFFSET/LIMIT does not guarantee (a row inserted or deleted
// between two page requests shifts every subsequent offset).
//
// id alone, not a (createdAt, id) composite - a real bug caught by testing against a real
// Postgres database, not assumed: every id here is architecture.md's UUID v7 primary key, which
// is itself unique and roughly time-ordered, so it doesn't need createdAt as a tie-breaker at
// all. Including createdAt actively caused incorrect results: Postgres timestamptz has
// microsecond precision, but a JS Date (and therefore its toISOString() encoding in the cursor)
// only has millisecond precision. A row whose real created_at carried a sub-millisecond fraction
// beyond what its own cursor could represent would compare as "greater than itself" on the next
// page's query, re-including that row instead of excluding it. Sorting and comparing on id alone
// has no such precision mismatch, since id round-trips through the cursor exactly.
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export interface Cursor {
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ id: cursor.id })).toString('base64url');
}

// Throws on any malformed input - callers should treat this the same as any other bad request
// (400), not a 500. A cursor is only ever produced by encodeCursor above, so a decode failure
// means a client sent something else (stale/tampered/hand-edited), not a bug in this code.
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
      // Unreachable: this branch only runs when rowsFetched.length > limit >= 1, so items (a
      // limit-length slice) always has at least one element - guarded explicitly rather than
      // asserted, so a future change to this invariant fails loudly instead of silently.
      throw new Error('paginate() invariant violated: items should never be empty here.');
    }
    return { items, nextCursor: encodeCursor(cursorOf(last)) };
  }
  return { items: rowsFetched, nextCursor: null };
}
