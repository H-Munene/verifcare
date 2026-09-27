// Visit statistics for one person's detail page (2026-09-27, user request): shared by
// GET /dependants/{id}/stats and GET /caregivers/{id}/stats, which differ only in which column
// picks the visits. The console can't work these out itself - the visit lists are cursor-paged
// and don't carry check-in times - so one small aggregate per page beats paging through history.
//
// Outcomes use the Overview's own rules (routes/dashboard.ts trendOutcome), so a missed visit is
// counted the same way on the dashboard and on a person's page.

import { and, asc, desc, eq, gt, gte, isNotNull, lt } from 'drizzle-orm';
import { trendOutcome, type TrendOutcome } from '../visitOutcome.js';
import type { Db } from './client.js';
import * as schema from './schema.js';

export const STATS_WINDOW_DAYS = 30;

export interface VisitSummary {
  id: string;
  scheduledStart: string;
  scheduledEnd: string;
  caregiverId: string;
  caregiverName: string;
  dependantId: string;
  dependantName: string;
}

export interface VisitStatsResponse {
  windowDays: number;
  /** Visits that started in the last windowDays days, by outcome. */
  visits: Record<TrendOutcome, number> & { total: number };
  /** completed / (completed + missed); null when neither happened in the window. */
  completionRate: number | null;
  /** Start of the most recent missed visit in the window, if any. */
  lastMissedVisitStart: string | null;
  /** The next visit still to come (scheduled, starting after now). */
  nextVisit: VisitSummary | null;
  /** The most recent visit someone actually checked in to, however long ago. */
  lastVisit: (VisitSummary & { checkinAt: string; checkoutAt: string | null }) | null;
}

const caregiverUsers = schema.users;

function visitColumns() {
  return {
    id: schema.visitSchedules.id,
    status: schema.visitSchedules.status,
    scheduledStart: schema.visitSchedules.scheduledStart,
    scheduledEnd: schema.visitSchedules.scheduledEnd,
    caregiverId: schema.visitSchedules.caregiverId,
    caregiverName: caregiverUsers.fullName,
    dependantId: schema.visitSchedules.dependantId,
    dependantName: schema.dependants.fullName,
    checkinAt: schema.verificationEvents.checkinAt,
    checkoutAt: schema.verificationEvents.checkoutAt,
  };
}

function summary(row: {
  id: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  caregiverId: string;
  caregiverName: string;
  dependantId: string;
  dependantName: string;
}): VisitSummary {
  return {
    id: row.id,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    caregiverId: row.caregiverId,
    caregiverName: row.caregiverName,
    dependantId: row.dependantId,
    dependantName: row.dependantName,
  };
}

export async function visitStatsFor(
  db: Db,
  subject: { dependantId: string } | { caregiverId: string },
  now: Date,
): Promise<VisitStatsResponse> {
  const subjectCondition =
    'dependantId' in subject
      ? eq(schema.visitSchedules.dependantId, subject.dependantId)
      : eq(schema.visitSchedules.caregiverId, subject.caregiverId);

  const base = () =>
    db
      .select(visitColumns())
      .from(schema.visitSchedules)
      .innerJoin(caregiverUsers, eq(caregiverUsers.id, schema.visitSchedules.caregiverId))
      .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
      .leftJoin(
        schema.verificationEvents,
        eq(schema.verificationEvents.visitScheduleId, schema.visitSchedules.id),
      );

  const windowStart = new Date(now.getTime() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // ponytail: counts one person's 30 days of visits in memory (a handful of rows); move to a
  // GROUP BY if outcome rules ever become expressible in SQL and volumes grow.
  const windowRows = await base().where(
    and(
      subjectCondition,
      gte(schema.visitSchedules.scheduledStart, windowStart),
      lt(schema.visitSchedules.scheduledStart, now),
    ),
  );

  const visits = { total: windowRows.length, completed: 0, missed: 0, cancelled: 0, open: 0 };
  let lastMissed: Date | null = null;
  for (const row of windowRows) {
    const outcome = trendOutcome(row, now);
    visits[outcome] += 1;
    if (outcome === 'missed' && (!lastMissed || row.scheduledStart > lastMissed)) {
      lastMissed = row.scheduledStart;
    }
  }
  const decided = visits.completed + visits.missed;

  const [next] = await base()
    .where(
      and(
        subjectCondition,
        eq(schema.visitSchedules.status, 'scheduled'),
        gt(schema.visitSchedules.scheduledStart, now),
      ),
    )
    .orderBy(asc(schema.visitSchedules.scheduledStart))
    .limit(1);

  const [last] = await base()
    .where(and(subjectCondition, isNotNull(schema.verificationEvents.checkinAt)))
    .orderBy(desc(schema.verificationEvents.checkinAt))
    .limit(1);

  return {
    windowDays: STATS_WINDOW_DAYS,
    visits,
    completionRate: decided > 0 ? visits.completed / decided : null,
    lastMissedVisitStart: lastMissed?.toISOString() ?? null,
    nextVisit: next ? summary(next) : null,
    lastVisit: last?.checkinAt
      ? {
          ...summary(last),
          checkinAt: last.checkinAt.toISOString(),
          checkoutAt: last.checkoutAt?.toISOString() ?? null,
        }
      : null,
  };
}
