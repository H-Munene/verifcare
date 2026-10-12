import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

describe('toCsv', () => {
  it('quotes commas, quotes and line breaks, and leaves plain values bare', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x, y', 'say "hi"'],
          ['two\nlines', 3],
        ],
      ),
    ).toBe('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",3\r\n');
  });

  it('neutralises text that a spreadsheet would run as a formula, but not numbers', () => {
    expect(toCsv(['v'], [['=HYPERLINK("x")'], ['+1'], ['@SUM(A1)'], ['-x'], [-3]])).toBe(
      'v\r\n"\'=HYPERLINK(""x"")"\r\n\'+1\r\n\'@SUM(A1)\r\n\'-x\r\n-3\r\n',
    );
  });

  it('writes dates as ISO instants and empty values as empty cells', () => {
    expect(toCsv(['d', 'n'], [[new Date('2026-09-27T07:00:00Z'), null]])).toBe(
      'd,n\r\n2026-09-27T07:00:00.000Z,\r\n',
    );
  });
});
