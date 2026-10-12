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
//
// Sorting (2026-09-26, for the supervisor console's sortable tables): a list may be ordered by
// another column instead, with id as the tie-breaker, and then pages on the (sort value, id) pair
// - so the cursor also carries the last row's sort value and which sort it was made for. A cursor
// from one sort is rejected on another rather than silently skipping or repeating rows. Sort
// expressions must never be NULL (COALESCE a nullable column) and must round-trip exactly
// through the cursor's string (truncate timestamps to milliseconds, as above).
import { asc, desc, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export interface Cursor {
  id: string;
  /** The sort the cursor was made for (e.g. "-name"); absent for the default id order. */
  sort?: string;
  /** The last row's sort value, as text. */
  value?: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ id: cursor.id, sort: cursor.sort, value: cursor.value }),
  ).toString('base64url');
}

// Throws on any malformed input - callers should treat this the same as any other bad request
// (400), not a 500. A cursor is only ever produced by encodeCursor above, so a decode failure
// means a client sent something else (stale/tampered/hand-edited), not a bug in this code.
export function decodeCursor(raw: string, expectedSort?: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed pagination cursor.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Malformed pagination cursor.');
  }
  const { id, sort, value } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || id === '') {
    throw new Error('Malformed pagination cursor.');
  }
  if (sort !== expectedSort) {
    throw new Error('Pagination cursor belongs to a different sort.');
  }
  if (expectedSort !== undefined && typeof value !== 'string') {
    throw new Error('Malformed pagination cursor.');
  }
  return typeof sort === 'string' && typeof value === 'string' ? { id, sort, value } : { id };
}

export function cursorCondition(idColumn: PgColumn, cursor: Cursor): SQL {
  return sql`${idColumn} > ${cursor.id}`;
}

/** A column a list can be sorted by: the SQL to order on, and the type its cursor text casts to. */
export interface SortKey {
  expr: SQL | PgColumn;
  cast: 'text' | 'date' | 'timestamptz';
}

/** A requested sort ("name" ascending, "-name" descending) resolved against a list's keys. */
export interface Sort extends SortKey {
  /** The sort as requested, which the cursor records. */
  param: string;
  descending: boolean;
}

// [param] comes from the route's own z.enum of "key" / "-key" values, so it always names a key.
export function resolveSort<K extends string>(
  param: string | undefined,
  keys: Record<K, SortKey>,
): Sort | undefined {
  if (!param) {
    return undefined;
  }
  const descending = param.startsWith('-');
  const key = (descending ? param.slice(1) : param) as K;
  return { ...keys[key], param, descending };
}

/** WHERE condition for the rows after [cursor], in [sort]'s order (id order when none). */
export function keysetCondition(idColumn: PgColumn, cursor: Cursor, sort?: Sort): SQL {
  if (!sort) {
    return cursorCondition(idColumn, cursor);
  }
  // A row comparison: Postgres compares (value, id) pairs in order, which is exactly the keyset.
  // Both parts go the same direction, so the id tie-break follows the sort's direction too.
  const after = sort.descending ? sql`<` : sql`>`;
  return sql`(${sort.expr}, ${idColumn}) ${after} (${cursor.value}::${sql.raw(sort.cast)}, ${cursor.id}::uuid)`;
}

/** ORDER BY for [sort], with id as the tie-breaker (plain id order when none). */
export function keysetOrder(idColumn: PgColumn, sort?: Sort): SQL[] {
  if (!sort) {
    return [asc(idColumn)];
  }
  return sort.descending ? [desc(sort.expr), desc(idColumn)] : [asc(sort.expr), asc(idColumn)];
}

// Callers fetch `limit + 1` rows in keysetOrder; this splits that result into the page actually
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
