// GET /dashboard/overview - everything the supervisor console's Overview page shows, in one
// request (2026-09-26, user request): the chosen day's visits with where they happen and how far
// each has got, a 14-day outcome trend, and what needs a supervisor's attention. One aggregate
// endpoint rather than the page stitching several lists together, because the list endpoints
// don't carry check-in times or home locations and would need many paged calls to count.

import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { addDays, dayStart, nairobiDate, TIME_ZONE } from '../nairobiTime.js';
import { parseOrSendProblem } from '../validation.js';
import { trendOutcome, visitState } from '../visitOutcome.js';

export interface DashboardRouterDependencies {
  requireAuth: RequestHandler;
  // Injectable so tests can pin "now"; a visit's state depends on it.
  now?: () => Date;
}

const TREND_DAYS = 14;
// The Overview lists every item needing attention in a scrolling panel (user request,
// 2026-09-26); the cap only bounds the response, and `total` still says how many there are.
const ATTENTION_LIST_LIMIT = 100;

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
      // The 14 days before the trend, for the Overview's "change vs the previous 14 days"
      // (2026-09-26): its completion rate is compared with this period's.
      const previousFrom = addDays(trendFrom, -TREND_DAYS);

      // ponytail: loads 28 days of visit rows and counts them here, fine at pilot volume; move
      // the counting into a GROUP BY if a supervisor's visit volume gets large.
      const loaded = await visitsBetween(db, dayStart(previousFrom), dayStart(nextDay));
      const trendStart = dayStart(trendFrom);
      const trendVisits = loaded.filter((v) => v.scheduledStart >= trendStart);
      const previousPeriod = { completed: 0, missed: 0 };
      for (const visit of loaded) {
        if (visit.scheduledStart < trendStart) {
          const outcome = trendOutcome(visit, now);
          if (outcome === 'completed' || outcome === 'missed') {
            previousPeriod[outcome] += 1;
          }
        }
      }
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

      // Caregivers at a home with no family member present, waiting on a supervisor right now.
      const pendingOverrides = await db
        .select({
          id: schema.checkinOverrideRequests.id,
          visitScheduleId: schema.checkinOverrideRequests.visitScheduleId,
          reason: schema.checkinOverrideRequests.reason,
          note: schema.checkinOverrideRequests.note,
          requestedAt: schema.checkinOverrideRequests.requestedAt,
          dependantName: schema.dependants.fullName,
          caregiverName: schema.users.fullName,
        })
        .from(schema.checkinOverrideRequests)
        .innerJoin(
          schema.visitSchedules,
          eq(schema.visitSchedules.id, schema.checkinOverrideRequests.visitScheduleId),
        )
        .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
        .innerJoin(schema.users, eq(schema.users.id, schema.checkinOverrideRequests.requestedBy))
        .where(eq(schema.checkinOverrideRequests.status, 'pending'))
        .orderBy(asc(schema.checkinOverrideRequests.requestedAt));

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
        previousPeriod,
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
          pendingCheckinOverrides: {
            total: pendingOverrides.length,
            items: pendingOverrides.slice(0, ATTENTION_LIST_LIMIT).map((o) => ({
              ...o,
              requestedAt: o.requestedAt.toISOString(),
            })),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
