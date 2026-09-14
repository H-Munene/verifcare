import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, paginate } from './pagination.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor', () => {
    const original = { id: 'abc-123' };

    const decoded = decodeCursor(encodeCursor(original));

    expect(decoded).toEqual(original);
  });

  it('throws on non-base64url garbage', () => {
    expect(() => decodeCursor('not-a-cursor-at-all!!!')).toThrow(/Malformed pagination cursor/);
  });

  it('throws when the decoded value is missing the id field', () => {
    const cursor = Buffer.from(JSON.stringify({ notId: 'abc' })).toString('base64url');

    expect(() => decodeCursor(cursor)).toThrow(/Malformed pagination cursor/);
  });

  it('throws when id is an empty string', () => {
    const cursor = Buffer.from(JSON.stringify({ id: '' })).toString('base64url');

    expect(() => decodeCursor(cursor)).toThrow(/Malformed pagination cursor/);
  });

  it('throws when the decoded value is not an object', () => {
    const cursor = Buffer.from(JSON.stringify('just a string')).toString('base64url');

    expect(() => decodeCursor(cursor)).toThrow(/Malformed pagination cursor/);
  });
});

describe('paginate', () => {
  interface Row {
    id: string;
  }
  const cursorOf = (row: Row) => ({ id: row.id });
  const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: `row-${i}` }));

  it('returns all rows with no nextCursor when fewer than limit + 1 were fetched', () => {
    const { items, nextCursor } = paginate(rows, 10, cursorOf);

    expect(items).toEqual(rows);
    expect(nextCursor).toBeNull();
  });

  it('returns exactly limit rows and a nextCursor when more than limit were fetched', () => {
    const { items, nextCursor } = paginate(rows, 3, cursorOf);

    expect(items).toHaveLength(3);
    expect(items).toEqual(rows.slice(0, 3));
    expect(nextCursor).not.toBeNull();

    const decoded = decodeCursor(nextCursor as string);
    expect(decoded.id).toBe(rows[2]?.id);
  });

  it('returns no nextCursor when rowsFetched.length exactly equals limit', () => {
    const { items, nextCursor } = paginate(rows, 5, cursorOf);

    expect(items).toHaveLength(5);
    expect(nextCursor).toBeNull();
  });
});
