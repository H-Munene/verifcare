// Mzazi Care operates in Kenya (county/ward locations, +254 numbers), so a "day" is a Nairobi day
// whoever's browser asks. Kenya has no daylight saving, so the offset is fixed. Shared by the
// Overview (routes/dashboard.ts) and the Compliance reports (routes/compliance.ts), which must
// agree on where a day, and so a reporting period, starts and ends.

export const TIME_ZONE = 'Africa/Nairobi';
export const UTC_OFFSET = '+03:00';

/** YYYY-MM-DD for the Nairobi calendar day that [instant] falls in. */
export function nairobiDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(instant);
}

/** The instant a Nairobi calendar day (YYYY-MM-DD) starts. */
export function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00${UTC_OFFSET}`);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
