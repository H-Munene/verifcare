// CSV for the Compliance tab's exports (2026-09-27): RFC 4180 quoting, written by hand because a
// few lines cover it and no CSV dependency is installed.
//
// Formula injection: a spreadsheet runs a cell starting with = + - @ (or a tab or carriage
// return) as a formula, so a caregiver's name or a resolution note typed as "=HYPERLINK(...)"
// would execute when a supervisor opens the export. Such text cells get a leading apostrophe
// (OWASP's recommended neutralisation); numbers are left alone, so -3 stays a number.

export type CsvValue = string | number | boolean | Date | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  let text = value instanceof Date ? value.toISOString() : value;
  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CSV document: the header row, then one line per row, CRLF line endings as RFC 4180 has. */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
