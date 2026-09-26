// TEMPORARY sample data for the Overview (2026-09-26, user request: "for now ... sample data that
// will load on the dashboard simulating a busy day"). Used only when VITE_DASHBOARD_SAMPLE_DATA is
// "true" in the local .env, and the page labels it as sample data, so it can't be mistaken for
// real visits. Generated in the browser rather than written to the database because the web app
// talks to the deployed API, and fake people there would show up on every other page too.
// Remove this file (and its two call sites in api/dashboard.ts) once real visits exist.
//
// The day is deterministic per date, so a reload shows the same visits, and each visit's state
// follows backend/src/routes/dashboard.ts's rules against the real clock, so the map moves through
// the day the way the live one will.

import type { DashboardOverview, OverviewVisit, TrendDay, VisitState } from './dashboard';

const TIME_ZONE = 'Africa/Nairobi';

const CAREGIVERS = [
  'Amina Wanjiru',
  'Grace Achieng',
  'Peter Mwangi',
  'Faith Chebet',
  'John Kariuki',
  'Mercy Nduta',
  'Brian Omondi',
  'Lucy Wambui',
];

// Homes spread across Nairobi's neighbourhoods, so the map reads as a real city-wide round.
const HOMES: { name: string; lat: number; lng: number }[] = [
  { name: 'Joseph Otieno', lat: -1.2921, lng: 36.7853 }, // Kilimani
  { name: 'Wanjiku Kamau', lat: -1.2676, lng: 36.8108 }, // Westlands
  { name: 'Mary Njeri', lat: -1.3133, lng: 36.7876 }, // Kibera
  { name: 'Samuel Kiprono', lat: -1.3197, lng: 36.7073 }, // Karen
  { name: 'Esther Atieno', lat: -1.3356, lng: 36.7621 }, // Lang'ata
  { name: 'Daniel Mutua', lat: -1.2733, lng: 36.8506 }, // Eastleigh
  { name: 'Ruth Wairimu', lat: -1.2218, lng: 36.8969 }, // Kasarani
  { name: 'Ali Hassan', lat: -1.3232, lng: 36.8983 }, // Embakasi
  { name: 'Agnes Chepkoech', lat: -1.2141, lng: 36.7713 }, // Ruaka
  { name: 'Francis Njoroge', lat: -1.2611, lng: 36.8235 }, // Parklands
  { name: 'Hellen Akinyi', lat: -1.3099, lng: 36.8411 }, // South B
  { name: 'Moses Kibet', lat: -1.2875, lng: 36.8986 }, // Donholm
  { name: 'Janet Muthoni', lat: -1.2839, lng: 36.7465 }, // Kawangware
  { name: 'George Ouma', lat: -1.2231, lng: 36.8067 }, // Runda
  { name: 'Beatrice Nyambura', lat: -1.1981, lng: 36.9131 }, // Githurai
  { name: 'Patrick Waweru', lat: -1.2804, lng: 36.7825 }, // Kileleshwa
  { name: 'Rose Adhiambo', lat: -1.2468, lng: 36.8726 }, // Mathare North
  { name: 'Stephen Kamau', lat: -1.3024, lng: 36.8747 }, // Industrial Area edge
];

/** A small seeded PRNG, so each date's sample day is the same on every load. */
function seededRandom(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function nairobiInstant(date: string, minutes: number): Date {
  return new Date(new Date(`${date}T00:00:00+03:00`).getTime() + minutes * 60_000);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function stateAt(start: Date, end: Date, checkinAt: Date | null, now: Date): VisitState {
  if (checkinAt) {
    return 'checked_in';
  }
  if (now > end) {
    return 'no_checkin';
  }
  return now < start ? 'upcoming' : 'awaiting_checkin';
}

function sampleVisits(date: string, now: Date): OverviewVisit[] {
  const random = seededRandom(date);
  const visits: OverviewVisit[] = [];
  // Each caregiver does a round of three or four visits between 06:30 and 19:00.
  CAREGIVERS.forEach((caregiver, c) => {
    let minute = 6 * 60 + 30 + Math.floor(random() * 90);
    const rounds = 3 + Math.floor(random() * 2);
    for (let r = 0; r < rounds && minute < 18 * 60; r++) {
      const home = HOMES[(c * 2 + r * 5) % HOMES.length]!;
      const length = [45, 60, 60, 90][Math.floor(random() * 4)]!;
      const start = nairobiInstant(date, minute);
      const end = nairobiInstant(date, minute + length);
      // Most caregivers arrive within a few minutes; about one visit in seven never checks in.
      const shows = random() > 0.14;
      const arrival = nairobiInstant(date, minute + Math.floor(random() * 14));
      const checkinAt = shows && arrival <= now ? arrival : null;
      const leaving = nairobiInstant(date, minute + length - Math.floor(random() * 10));
      const checkoutAt = checkinAt && leaving <= now ? leaving : null;
      visits.push({
        id: `sample-${date}-${c}-${r}`,
        state: stateAt(start, end, checkinAt, now),
        status: checkoutAt ? 'completed' : checkinAt ? 'in_progress' : 'scheduled',
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        checkinAt: checkinAt?.toISOString() ?? null,
        checkoutAt: checkoutAt?.toISOString() ?? null,
        caregiver: {
          id: `sample-caregiver-${c}`,
          fullName: caregiver,
          phoneNumber: `+2547${String(10000000 + c * 1234567).slice(0, 8)}`,
        },
        dependant: {
          id: `sample-dependant-${home.name}`,
          fullName: home.name,
          lat: home.lat,
          lng: home.lng,
        },
      });
      minute += length + 30 + Math.floor(random() * 90);
    }
  });
  return visits.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
}

function sampleTrend(date: string, today: OverviewVisit[]): TrendDay[] {
  return Array.from({ length: 14 }, (_, i) => {
    const day = shiftDate(date, i - 13);
    if (i === 13) {
      return {
        date: day,
        completed: today.filter((v) => v.checkoutAt).length,
        missed: today.filter((v) => v.state === 'no_checkin').length,
        cancelled: 1,
        open: today.filter((v) => !v.checkoutAt && v.state !== 'no_checkin').length,
      };
    }
    const random = seededRandom(`trend-${day}`);
    const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
    const total = weekend ? 12 + Math.floor(random() * 5) : 22 + Math.floor(random() * 8);
    const missed = Math.floor(random() * random() * 5);
    const cancelled = Math.floor(random() * 3);
    return { date: day, completed: total - missed - cancelled, missed, cancelled, open: 0 };
  });
}

const acknowledged = new Set<string>();

export function acknowledgeSampleAlert(id: string): void {
  acknowledged.add(id);
}

export function sampleOverview(date: string): DashboardOverview {
  const realNow = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(realNow);
  // A past day is over, and a future one hasn't started.
  const now =
    date < today ? nairobiInstant(date, 24 * 60) : date > today ? nairobiInstant(date, 0) : realNow;
  const visits = sampleVisits(date, now);
  const missed = visits.filter((v) => v.state === 'no_checkin');
  const alerts = [
    ...missed.map((v) => ({
      id: `alert-${v.id}`,
      sentAt: new Date(Date.parse(v.scheduledEnd) + 15 * 60_000).toISOString(),
      visitScheduleId: v.id,
      scheduledStart: v.scheduledStart,
      dependantName: v.dependant.fullName,
      caregiverName: v.caregiver.fullName,
    })),
    {
      id: 'alert-yesterday',
      sentAt: nairobiInstant(shiftDate(date, -1), 17 * 60).toISOString(),
      visitScheduleId: 'sample-yesterday',
      scheduledStart: nairobiInstant(shiftDate(date, -1), 15 * 60).toISOString(),
      dependantName: 'Hellen Akinyi',
      caregiverName: 'Brian Omondi',
    },
  ].filter((a) => !acknowledged.has(a.id));

  return {
    date,
    timeZone: TIME_ZONE,
    generatedAt: realNow.toISOString(),
    sample: true,
    visits,
    trend: sampleTrend(date, visits),
    previousPeriod: (() => {
      // The 14 days before, generated the same way as the trend's past days.
      const earlier = sampleTrend(shiftDate(date, -14), []).slice(0, 13);
      return {
        completed: earlier.reduce((n, d) => n + d.completed, 0),
        missed: earlier.reduce((n, d) => n + d.missed, 0) + 3,
      };
    })(),
    attention: {
      missedVisitAlerts: { total: alerts.length, items: alerts.slice(0, 5) },
      flaggedPhotos: 2,
      dependantsWithoutPhoto: {
        total: 3,
        items: [
          { id: 'sample-no-photo-1', fullName: 'Nancy Wanjiru' },
          { id: 'sample-no-photo-2', fullName: 'Tom Mboya Otieno' },
          { id: 'sample-no-photo-3', fullName: 'Zipporah Moraa' },
        ],
      },
    },
  };
}
