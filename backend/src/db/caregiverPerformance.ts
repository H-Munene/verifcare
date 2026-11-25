// The caregiver performance report (2026-11-09): how each caregiver's visits went over a period.
// Built on visitRecords and assessVisit, so its figures can't disagree with the other Compliance
// reports.
//
// Deliberately a set of separate measures with no overall score. A single number would hide why
// someone scored as they did, and this could inform decisions about a person's job.
//
// A miss a supervisor has accounted for as outside the caregiver's control is counted as excused,
// not held against them. A visit taken over by someone else counts as a miss for the original
// caregiver, because they didn't arrive, and as covered for the one who stepped in.

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { addDays, dayStart, nairobiDate } from '../nairobiTime.js';
import type { Db } from './client.js';
import { assessVisit, visitRecords, type Period, type VisitRecord } from './complianceReports.js';
import * as schema from './schema.js';

const EXCUSED_OUTCOMES: readonly schema.VisitResolutionOutcome[] = [
  'family_cancelled',
  'dependant_unavailable',
  'device_or_network_issue',
  'visit_took_place',
  'verified_manually',
];

export interface WeeklyPerformance {
  /** The Monday the week starts on, YYYY-MM-DD in Nairobi. */
  weekStart: string;
  completed: number;
  missed: number;
  onTime: number;
  checkedIn: number;
}

export interface CaregiverPerformanceRow {
  caregiverId: string;
  caregiverName: string;
  assigned: number;
  completed: number;
  /** Misses that count against the caregiver. */
  missed: number;
  /** Misses accounted for as outside their control. */
  excused: number;
  /** completed / (completed + missed); null when neither happened. */
  completionRate: number | null;
  checkedIn: number;
  /** Check-ins within the lateness tolerance, out of all check-ins; null with no check-ins. */
  onTimeRate: number | null;
  averageCheckinDelayMinutes: number | null;
  averageVisitMinutes: number | null;
  averagePlannedMinutes: number | null;
  /** Required tasks marked done, out of those recorded; null with none recorded. */
  requiredTasksDoneRate: number | null;
  qrVerifiedRate: number | null;
  supervisorOverrides: number;
  failedCheckins: number;
  recordingsProvided: number;
  recordingsSkipped: Record<schema.AudioSkipReason, number>;
  offersReceived: number;
  offersAccepted: number;
  offersDeclined: number;
  offersExpired: number;
  averageOfferResponseMinutes: number | null;
  visitsCovered: number;
  weeks: WeeklyPerformance[];
}

export interface TaskTally {
  caregiverId: string;
  done: number;
  recorded: number;
}

export interface OfferRecord {
  caregiverId: string;
  status: string;
  offeredAt: Date;
  respondedAt: Date | null;
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

const minutesBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60_000;

function mondayOf(date: string): string {
  // Sunday is 0 in getUTCDay, and its Monday is six days earlier.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** The report's arithmetic, separate from the queries so its rules can be tested directly. */
export function summarisePerformance(
  caregivers: { id: string; name: string }[],
  records: VisitRecord[],
  tasks: TaskTally[],
  offers: OfferRecord[],
  now: Date,
): CaregiverPerformanceRow[] {
  return caregivers.map(({ id, name }) => {
    const visits = records.filter((v) => v.caregiverId === id && v.status !== 'cancelled');
    let completed = 0;
    let missed = 0;
    let excused = 0;
    let onTime = 0;
    let visitsCovered = 0;
    const delays: number[] = [];
    const durations: number[] = [];
    const planned: number[] = [];
    const weeks = new Map<string, WeeklyPerformance>();
    const skipped: Record<schema.AudioSkipReason, number> = {
      dependant_declined: 0,
      dependant_unwell_or_asleep: 0,
      technical_problem: 0,
      other: 0,
    };
    let recordingsProvided = 0;
    let qrCheckins = 0;
    let supervisorOverrides = 0;
    let failedCheckins = 0;

    for (const visit of visits) {
      const assessment = assessVisit(visit, now);
      const weekStart = mondayOf(nairobiDate(visit.scheduledStart));
      const week = weeks.get(weekStart) ?? {
        weekStart,
        completed: 0,
        missed: 0,
        onTime: 0,
        checkedIn: 0,
      };
      weeks.set(weekStart, week);

      const didNotArrive = assessment.outcome === 'missed' || visit.status === 'reassigned';
      if (didNotArrive) {
        if (visit.latestResolution && EXCUSED_OUTCOMES.includes(visit.latestResolution.outcome)) {
          excused += 1;
        } else {
          missed += 1;
          week.missed += 1;
        }
      }
      if (assessment.outcome === 'completed') {
        completed += 1;
        week.completed += 1;
        if (visit.recoveredFromVisitId) {
          visitsCovered += 1;
        }
      }
      if (visit.checkinAt) {
        week.checkedIn += 1;
        delays.push(Math.max(0, minutesBetween(visit.scheduledStart, visit.checkinAt)));
        if (!assessment.late) {
          onTime += 1;
          week.onTime += 1;
        }
        // A typed code (2026-11-25) is the same family code as a scanned one.
        if (visit.checkinMethod === 'qr' || visit.checkinMethod === 'code') {
          qrCheckins += 1;
        } else if (visit.checkinMethod === 'supervisor_override') {
          supervisorOverrides += 1;
        }
      }
      if (visit.checkinAt && visit.checkoutAt) {
        durations.push(minutesBetween(visit.checkinAt, visit.checkoutAt));
        planned.push(minutesBetween(visit.scheduledStart, visit.scheduledEnd));
      }
      if (visit.audioRecorded) {
        recordingsProvided += 1;
      } else if (visit.audioSkipReason) {
        skipped[visit.audioSkipReason] += 1;
      }
      failedCheckins += visit.failedChecks.reduce((sum, check) => sum + check.count, 0);
    }

    const tally = tasks.find((t) => t.caregiverId === id);
    const own = offers.filter((o) => o.caregiverId === id);
    const answered = own.filter(
      (o) => o.respondedAt && (o.status === 'accepted' || o.status === 'declined'),
    );
    const checkedIn = delays.length;

    return {
      caregiverId: id,
      caregiverName: name,
      assigned: visits.length,
      completed,
      missed,
      excused,
      completionRate: rate(completed, completed + missed),
      checkedIn,
      onTimeRate: rate(onTime, checkedIn),
      averageCheckinDelayMinutes: average(delays),
      averageVisitMinutes: average(durations),
      averagePlannedMinutes: average(planned),
      requiredTasksDoneRate: tally ? rate(tally.done, tally.recorded) : null,
      qrVerifiedRate: rate(qrCheckins, checkedIn),
      supervisorOverrides,
      failedCheckins,
      recordingsProvided,
      recordingsSkipped: skipped,
      offersReceived: own.length,
      offersAccepted: own.filter((o) => o.status === 'accepted').length,
      offersDeclined: own.filter((o) => o.status === 'declined').length,
      offersExpired: own.filter((o) => o.status === 'expired').length,
      averageOfferResponseMinutes: average(
        answered.map((o) => minutesBetween(o.offeredAt, o.respondedAt!)),
      ),
      visitsCovered,
      weeks: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    };
  });
}

export async function caregiverPerformance(
  db: Db,
  period: Period,
  now: Date,
): Promise<CaregiverPerformanceRow[]> {
  const start = dayStart(period.from);
  const end = dayStart(addDays(period.to, 1));

  const [records, caregivers, tasks, offers] = await Promise.all([
    visitRecords(db, { period }),
    db
      .select({ id: schema.caregivers.userId, name: schema.users.fullName })
      .from(schema.caregivers)
      .innerJoin(schema.users, eq(schema.users.id, schema.caregivers.userId)),
    db
      .select({
        caregiverId: schema.visitSchedules.caregiverId,
        done: sql<number>`count(*) filter (where ${schema.visitTaskCompletions.status} = 'completed')::int`,
        recorded: sql<number>`count(*) filter (where ${schema.visitTaskCompletions.status} != 'not_applicable')::int`,
      })
      .from(schema.visitTaskCompletions)
      .innerJoin(
        schema.dependantCareTasks,
        eq(schema.dependantCareTasks.id, schema.visitTaskCompletions.careTaskId),
      )
      .innerJoin(
        schema.visitSchedules,
        eq(schema.visitSchedules.id, schema.visitTaskCompletions.visitScheduleId),
      )
      .where(
        and(
          eq(schema.dependantCareTasks.required, true),
          gte(schema.visitSchedules.scheduledStart, start),
          lt(schema.visitSchedules.scheduledStart, end),
        ),
      )
      .groupBy(schema.visitSchedules.caregiverId),
    db
      .select({
        caregiverId: schema.visitRecoveryOffers.caregiverId,
        status: schema.visitRecoveryOffers.status,
        offeredAt: schema.visitRecoveryOffers.offeredAt,
        respondedAt: schema.visitRecoveryOffers.respondedAt,
      })
      .from(schema.visitRecoveryOffers)
      .where(
        and(
          gte(schema.visitRecoveryOffers.offeredAt, start),
          lt(schema.visitRecoveryOffers.offeredAt, end),
          inArray(schema.visitRecoveryOffers.status, [
            'offered',
            'accepted',
            'declined',
            'expired',
            'withdrawn',
          ]),
        ),
      ),
  ]);

  // Everyone with something to show, not every caregiver ever registered.
  const active = new Set([
    ...records.map((v) => v.caregiverId),
    ...offers.map((o) => o.caregiverId),
  ]);
  return summarisePerformance(
    caregivers.filter((c) => active.has(c.id)),
    records,
    tasks,
    offers,
    now,
  );
}
