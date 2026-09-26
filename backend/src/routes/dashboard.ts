// GET /dashboard/overview - everything the supervisor console's Overview page shows, in one
// request (2026-09-26, user request): the chosen day's visits with where they happen and how far
// each has got, a 14-day outcome trend, and what needs a supervisor's attention. One aggregate
// endpoint rather than the page stitching several lists together, because the list endpoints
// don't carry check-in times or home locations and would need many paged calls to count.

import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.js';
import { checkinPhotoStatuses } from '../db/checkinPhotos.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';

export interface DashboardRouterDependencies {
  requireAuth: RequestHandler;
  // Injectable so tests can pin "now"; a visit's state depends on it.
  now?: () => Date;
}

// Mzazi Care operates in Kenya (county/ward locations, +254 numbers), so a "day" is a Nairobi day
// whoever's browser asks. Kenya has no daylight saving, so the offset is fixed.
const TIME_ZONE = 'Africa/Nairobi';
const UTC_OFFSET = '+03:00';
const TREND_DAYS = 14;
const ATTENTION_LIST_LIMIT = 5;

/**
 * Where a visit stands, as the Overview map colours it (user's definitions, 2026-09-26):
 * - upcoming: not checked in, and its start time hasn't come yet (grey)
 * - awaiting_checkin: not checked in, and now is between its start and end (amber)
 * - checked_in: the caregiver checked in, whether or not they've checked out since (green)
 * - no_checkin: its end time passed with no check-in, or it was marked missed (red)
 * A visit marked missed or investigated is red even if the missed-visit sweep ran before its end
 * time; the time rule alone also catches a visit the sweep hasn't reached yet, so the map never
 * waits on the sweep to show a visit nobody turned up for.
 */
export type VisitState = 'upcoming' | 'awaiting_checkin' | 'checked_in' | 'no_checkin';

export function visitState(
  visit: { status: string; scheduledStart: Date; scheduledEnd: Date; checkinAt: Date | null },
  now: Date,
): VisitState {
  if (visit.checkinAt) {
    return 'checked_in';
  }
  if (visit.status === 'missed' || visit.status === 'investigated' || now > visit.scheduledEnd) {
    return 'no_checkin';
  }
  return now < visit.scheduledStart ? 'upcoming' : 'awaiting_checkin';
}

/** The trend chart's outcome for one visit: the map's state, with checked-out visits completed. */
type TrendOutcome = 'completed' | 'missed' | 'cancelled' | 'open';

function trendOutcome(
  visit: Parameters<typeof visitState>[0] & { checkoutAt: Date | null },
  now: Date,
): TrendOutcome {
  if (visit.status === 'cancelled') {
    return 'cancelled';
  }
  const state = visitState(visit, now);
  if (state === 'no_checkin') {
    return 'missed';
  }
  // Checked in but not out yet (or never checked out) is still open, not a completed visit.
  return state === 'checked_in' && (visit.checkoutAt || visit.status === 'completed')
    ? 'completed'
    : 'open';
}

/** YYYY-MM-DD for the Nairobi calendar day that [instant] falls in. */
function nairobiDate(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(instant);
}

function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00${UTC_OFFSET}`);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const overviewQuerySchema = z.object({
  date: z.iso.date().optional().describe('Nairobi calendar day, YYYY-MM-DD; defaults to today'),
});

function getDb(res: Response): Db | undefined {
  const db = res.req.app.locals.db as Db | undefined;
  if (!db) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'No database client is configured.',
    });
  }
  return db;
}

// Visits with their caregiver, dependant and check-in times - shared by the day's list and the
// trend, which differ only in the time window.
async function visitsBetween(db: Db, from: Date, to: Date) {
  return db
    .select({
      id: schema.visitSchedules.id,
      status: schema.visitSchedules.status,
      scheduledStart: schema.visitSchedules.scheduledStart,
      scheduledEnd: schema.visitSchedules.scheduledEnd,
      checkinAt: schema.verificationEvents.checkinAt,
      checkoutAt: schema.verificationEvents.checkoutAt,
      caregiverId: schema.visitSchedules.caregiverId,
      caregiverName: schema.users.fullName,
      caregiverPhone: schema.users.phoneNumber,
      dependantId: schema.dependants.id,
      dependantName: schema.dependants.fullName,
      lat: schema.dependants.geofenceLat,
      lng: schema.dependants.geofenceLng,
    })
    .from(schema.visitSchedules)
    .innerJoin(schema.users, eq(schema.users.id, schema.visitSchedules.caregiverId))
    .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
    .leftJoin(
      schema.verificationEvents,
      eq(schema.verificationEvents.visitScheduleId, schema.visitSchedules.id),
    )
    .where(
      and(
        gte(schema.visitSchedules.scheduledStart, from),
        lt(schema.visitSchedules.scheduledStart, to),
      ),
    )
    .orderBy(asc(schema.visitSchedules.scheduledStart));
}

export function createDashboardRouter(dependencies: DashboardRouterDependencies): Router {
  const router = Router();
  const { requireAuth, now: clock = () => new Date() } = dependencies;
  router.use(requireAuth);

  router.get('/overview', requireRole('supervisor'), async (req, res, next) => {
    const query = parseOrSendProblem(overviewQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const now = clock();
      const date = query.date ?? nairobiDate(now);
      const nextDay = addDays(date, 1);
      const trendFrom = addDays(date, -(TREND_DAYS - 1));

      // ponytail: the trend loads 14 days of visit rows and counts them here, fine at pilot
      // volume; move the counting into a GROUP BY if a supervisor's visit volume gets large.
      const trendVisits = await visitsBetween(db, dayStart(trendFrom), dayStart(nextDay));
      const dayFrom = dayStart(date);
      const dayVisits = trendVisits.filter((v) => v.scheduledStart >= dayFrom);

      const trendDays = Array.from({ length: TREND_DAYS }, (_, i) => ({
        date: addDays(trendFrom, i),
        completed: 0,
        missed: 0,
        cancelled: 0,
        open: 0,
      }));
      const byDate = new Map(trendDays.map((d) => [d.date, d]));
      for (const visit of trendVisits) {
        const day = byDate.get(nairobiDate(visit.scheduledStart));
        if (day) {
          day[trendOutcome(visit, now)] += 1;
        }
      }

      // Missed-visit alerts nobody has acknowledged yet, newest first, with the visit they're
      // about so the page can name who and link to it.
      const unacknowledged = and(
        eq(schema.notificationLog.type, 'missed_visit'),
        isNull(schema.notificationLog.acknowledgedAt),
      );
      const [alertTotal] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.notificationLog)
        .where(unacknowledged);
      const alertRows = await db
        .select({
          id: schema.notificationLog.id,
          sentAt: schema.notificationLog.sentAt,
          visitScheduleId: schema.visitSchedules.id,
          scheduledStart: schema.visitSchedules.scheduledStart,
          dependantName: schema.dependants.fullName,
          caregiverName: schema.users.fullName,
        })
        .from(schema.notificationLog)
        .innerJoin(
          schema.visitSchedules,
          eq(schema.visitSchedules.id, schema.notificationLog.visitScheduleId),
        )
        .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
        .innerJoin(schema.users, eq(schema.users.id, schema.visitSchedules.caregiverId))
        .where(unacknowledged)
        .orderBy(desc(schema.notificationLog.id))
        .limit(ATTENTION_LIST_LIMIT);

      const [flagged] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.biometricEnrollments)
        .where(eq(schema.biometricEnrollments.status, 'flagged'));

      // Active dependants without a usable photo can't be scheduled (the scheduling guardrail).
      const activeDependants = await db
        .select({ id: schema.dependants.id, fullName: schema.dependants.fullName })
        .from(schema.dependants)
        .where(eq(schema.dependants.status, 'active'))
        .orderBy(asc(schema.dependants.fullName));
      const photoStatuses = await checkinPhotoStatuses(
        db,
        activeDependants.map((d) => d.id),
      );
      const withoutPhoto = activeDependants.filter((d) => photoStatuses.get(d.id) === 'missing');

      res.status(200).json({
        date,
        timeZone: TIME_ZONE,
        generatedAt: now.toISOString(),
        visits: dayVisits
          .filter((v) => v.status !== 'cancelled')
          .map((v) => ({
            id: v.id,
            state: visitState(v, now),
            status: v.status,
            scheduledStart: v.scheduledStart.toISOString(),
            scheduledEnd: v.scheduledEnd.toISOString(),
            checkinAt: v.checkinAt?.toISOString() ?? null,
            checkoutAt: v.checkoutAt?.toISOString() ?? null,
            caregiver: {
              id: v.caregiverId,
              fullName: v.caregiverName,
              phoneNumber: v.caregiverPhone,
            },
            dependant: { id: v.dependantId, fullName: v.dependantName, lat: v.lat, lng: v.lng },
          })),
        trend: trendDays,
        attention: {
          missedVisitAlerts: {
            total: alertTotal?.count ?? 0,
            items: alertRows.map((a) => ({
              id: a.id,
              sentAt: a.sentAt?.toISOString() ?? null,
              visitScheduleId: a.visitScheduleId,
              scheduledStart: a.scheduledStart.toISOString(),
              dependantName: a.dependantName,
              caregiverName: a.caregiverName,
            })),
          },
          flaggedPhotos: flagged?.count ?? 0,
          dependantsWithoutPhoto: {
            total: withoutPhoto.length,
            items: withoutPhoto.slice(0, ATTENTION_LIST_LIMIT),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
