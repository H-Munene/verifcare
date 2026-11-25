// The Compliance tab's reports (2026-09-27): period-based evidence that visits were delivered and
// verified, how exceptions were handled, how fast missed-visit alerts were answered, who consented
// to what, and who accepted the terms. See docs/compliance-research.md for why each exists.
//
// Shared by the JSON endpoints and the CSV exports (routes/compliance.ts), so a report on screen
// and the file an auditor is sent can never disagree. Visit outcomes use the Overview's own rules
// (visitOutcome.ts), so a missed visit is counted the same everywhere.
//
// ponytail: each report loads its period's rows and aggregates in memory. A year of one agency's
// visits is a few thousand rows, well within that; move the grouping into SQL if an agency's
// volume ever makes a report slow.

import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { addDays, dayStart } from '../nairobiTime.js';
import { CURRENT_TERMS } from '../terms.js';
import { trendOutcome, type TrendOutcome } from '../visitOutcome.js';
import type { Db } from './client.js';
import * as schema from './schema.js';

// A check-in more than this long after the scheduled start counts as late (the product owner's
// choice, 2026-09-27, a common EVV grace period). A report figure only: late check-ins are not
// blocked.
export const LATE_CHECKIN_TOLERANCE_MINUTES = 15;

/** A reporting period: Nairobi calendar days, both ends included. */
export interface Period {
  from: string;
  to: string;
}

function bounds(period: Period): { start: Date; end: Date } {
  return { start: dayStart(period.from), end: dayStart(addDays(period.to, 1)) };
}

function inPeriod(column: Parameters<typeof gte>[0], period: Period): SQL | undefined {
  const { start, end } = bounds(period);
  return and(gte(column, start), lt(column, end));
}

// ---------------------------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------------------------

export interface VisitResolutionSummary {
  outcome: schema.VisitResolutionOutcome;
  note: string;
  resolvedByName: string;
  resolvedAt: Date;
}

export interface VisitRecord {
  id: string;
  status: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  caregiverId: string;
  caregiverName: string;
  dependantId: string;
  dependantName: string;
  geofenceRadiusMeters: number;
  checkinAt: Date | null;
  checkoutAt: Date | null;
  distanceFromGeofenceMeters: number | null;
  checkoutDistanceFromGeofenceMeters: number | null;
  checkinMethod: schema.CheckinMethod | null;
  familyDistanceFromGeofenceMeters: number | null;
  /** How check-out was confirmed. Null for visits checked out before family confirmation (0019). */
  checkoutMethod: schema.CheckoutMethod | null;
  checkoutOverrideReason: schema.CheckoutOverrideReason | null;
  checkoutOverrideNote: string | null;
  /** Whether the dependant's recording exists. */
  audioRecorded: boolean;
  audioSkipReason: schema.AudioSkipReason | null;
  /** Set when this visit took over from another caregiver's late visit. */
  recoveredFromVisitId: string | null;
  /** Failed check-in attempts, e.g. `geofence: out_of_range`, one entry per attempt. */
  failedChecks: { attemptType: string; failureReason: string | null; count: number }[];
  /** Required tasks recorded as not completed, with the reason given. */
  requiredTasksNotDone: { title: string; reason: string | null }[];
  latestResolution: VisitResolutionSummary | null;
}

/** An exception is a visit a supervisor should account for. */
export type ExceptionKind =
  'missed' | 'missing_checkout' | 'failed_check' | 'supervisor_override' | 'checkout_override';

export interface VisitAssessment {
  outcome: TrendOutcome;
  /**
   * Every check passed: checked in with a family member's code, scanned or typed, after the
   * caregiver's phone passed the geofence, and checked out inside the radius. A
   * supervisor override never counts, nor does a check-out override. Visits checked out before
   * checkout location was recorded (migration 0015) can't show the last part, so they don't count.
   */
  fullyVerified: boolean;
  late: boolean;
  missingCheckout: boolean;
  exceptionKinds: ExceptionKind[];
}

export function assessVisit(visit: VisitRecord, now: Date): VisitAssessment {
  const outcome = trendOutcome(visit, now);
  const late =
    visit.checkinAt !== null &&
    visit.checkinAt.getTime() - visit.scheduledStart.getTime() >
      LATE_CHECKIN_TOLERANCE_MINUTES * 60_000;
  const missingCheckout =
    visit.status !== 'cancelled' &&
    visit.checkinAt !== null &&
    visit.checkoutAt === null &&
    now > visit.scheduledEnd;
  const fullyVerified =
    visit.checkinAt !== null &&
    visit.checkoutAt !== null &&
    (visit.checkinMethod === 'qr' || visit.checkinMethod === 'code') &&
    visit.checkoutMethod !== 'override' &&
    visit.checkoutDistanceFromGeofenceMeters !== null &&
    visit.checkoutDistanceFromGeofenceMeters <= visit.geofenceRadiusMeters;

  const exceptionKinds: ExceptionKind[] = [];
  if (outcome === 'missed') {
    exceptionKinds.push('missed');
  }
  if (missingCheckout) {
    exceptionKinds.push('missing_checkout');
  }
  if (visit.status !== 'cancelled' && visit.failedChecks.length > 0) {
    exceptionKinds.push('failed_check');
  }
  if (visit.checkinMethod === 'supervisor_override') {
    exceptionKinds.push('supervisor_override');
  }
  if (visit.checkoutMethod === 'override') {
    exceptionKinds.push('checkout_override');
  }
  return { outcome, fullyVerified, late, missingCheckout, exceptionKinds };
}

/**
 * Every visit that started in a period (or one visit, for judging whether it can be resolved),
 * with what the reports need to judge it.
 */
export async function visitRecords(
  db: Db,
  scope: { period: Period } | { visitScheduleId: string },
): Promise<VisitRecord[]> {
  const visitCondition =
    'period' in scope
      ? inPeriod(schema.visitSchedules.scheduledStart, scope.period)
      : eq(schema.visitSchedules.id, scope.visitScheduleId);

  const rows = await db
    .select({
      id: schema.visitSchedules.id,
      status: schema.visitSchedules.status,
      scheduledStart: schema.visitSchedules.scheduledStart,
      scheduledEnd: schema.visitSchedules.scheduledEnd,
      caregiverId: schema.visitSchedules.caregiverId,
      caregiverName: schema.users.fullName,
      dependantId: schema.dependants.id,
      dependantName: schema.dependants.fullName,
      geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
      checkinAt: schema.verificationEvents.checkinAt,
      checkoutAt: schema.verificationEvents.checkoutAt,
      distanceFromGeofenceMeters: schema.verificationEvents.distanceFromGeofenceMeters,
      checkoutDistanceFromGeofenceMeters:
        schema.verificationEvents.checkoutDistanceFromGeofenceMeters,
      checkinMethod: schema.verificationEvents.checkinMethod,
      familyDistanceFromGeofenceMeters: schema.verificationEvents.familyDistanceFromGeofenceMeters,
      checkoutMethod: schema.verificationEvents.checkoutMethod,
      checkoutOverrideReason: schema.verificationEvents.checkoutOverrideReason,
      checkoutOverrideNote: schema.verificationEvents.checkoutOverrideNote,
      audioSkipReason: schema.verificationEvents.audioSkipReason,
      recoveredFromVisitId: schema.visitSchedules.recoveredFromVisitId,
      audioRecordId: schema.audioRecords.id,
    })
    .from(schema.visitSchedules)
    .innerJoin(schema.users, eq(schema.users.id, schema.visitSchedules.caregiverId))
    .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
    .leftJoin(
      schema.verificationEvents,
      eq(schema.verificationEvents.visitScheduleId, schema.visitSchedules.id),
    )
    // The dependant's recording only: two per visit since 0019, and one row per visit is wanted.
    .leftJoin(
      schema.audioRecords,
      and(
        eq(schema.audioRecords.verificationEventId, schema.visitSchedules.id),
        eq(schema.audioRecords.role, 'dependant'),
      ),
    )
    .where(visitCondition)
    .orderBy(asc(schema.visitSchedules.scheduledStart), asc(schema.visitSchedules.id));
  if (rows.length === 0) {
    return [];
  }

  // The per-visit details below join back to visit_schedules on the same condition rather than
  // passing thousands of ids in an IN list.
  const failed = await db
    .select({
      visitScheduleId: schema.verificationAttempts.visitScheduleId,
      attemptType: schema.verificationAttempts.attemptType,
      failureReason: schema.verificationAttempts.failureReason,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.verificationAttempts)
    .innerJoin(
      schema.visitSchedules,
      eq(schema.visitSchedules.id, schema.verificationAttempts.visitScheduleId),
    )
    .where(and(visitCondition, eq(schema.verificationAttempts.passed, false)))
    .groupBy(
      schema.verificationAttempts.visitScheduleId,
      schema.verificationAttempts.attemptType,
      schema.verificationAttempts.failureReason,
    );

  const tasksNotDone = await db
    .select({
      visitScheduleId: schema.visitTaskCompletions.visitScheduleId,
      title: schema.dependantCareTasks.title,
      reason: schema.visitTaskCompletions.reason,
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
        visitCondition,
        eq(schema.dependantCareTasks.required, true),
        eq(schema.visitTaskCompletions.status, 'not_completed'),
      ),
    );

  const resolutions = await latestResolutions(db, visitCondition);

  const failedByVisit = groupBy(failed, (row) => row.visitScheduleId);
  const tasksByVisit = groupBy(tasksNotDone, (row) => row.visitScheduleId);
  return rows.map(({ audioRecordId, ...row }) => ({
    ...row,
    audioRecorded: audioRecordId !== null,
    failedChecks: (failedByVisit.get(row.id) ?? []).map(
      ({ attemptType, failureReason, count }) => ({
        attemptType,
        failureReason,
        count,
      }),
    ),
    requiredTasksNotDone: (tasksByVisit.get(row.id) ?? []).map(({ title, reason }) => ({
      title,
      reason,
    })),
    latestResolution: resolutions.get(row.id) ?? null,
  }));
}

/** Each visit's most recent resolution (a later one supersedes an earlier one). */
async function latestResolutions(
  db: Db,
  visitCondition: SQL | undefined,
): Promise<Map<string, VisitResolutionSummary>> {
  const rows = await db
    .selectDistinctOn([schema.visitResolutions.visitScheduleId], {
      visitScheduleId: schema.visitResolutions.visitScheduleId,
      outcome: schema.visitResolutions.outcome,
      note: schema.visitResolutions.note,
      resolvedByName: schema.users.fullName,
      resolvedAt: schema.visitResolutions.resolvedAt,
    })
    .from(schema.visitResolutions)
    .innerJoin(
      schema.visitSchedules,
      eq(schema.visitSchedules.id, schema.visitResolutions.visitScheduleId),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.visitResolutions.resolvedBy))
    .where(visitCondition)
    .orderBy(
      schema.visitResolutions.visitScheduleId,
      desc(schema.visitResolutions.resolvedAt),
      desc(schema.visitResolutions.id),
    );
  return new Map(rows.map(({ visitScheduleId, ...resolution }) => [visitScheduleId, resolution]));
}

/** Every resolution of one visit, newest first, for its side panel's history. */
export async function visitResolutionHistory(db: Db, visitScheduleId: string) {
  return db
    .select({
      id: schema.visitResolutions.id,
      visitScheduleId: schema.visitResolutions.visitScheduleId,
      outcome: schema.visitResolutions.outcome,
      note: schema.visitResolutions.note,
      resolvedBy: schema.visitResolutions.resolvedBy,
      resolvedByName: schema.users.fullName,
      resolvedAt: schema.visitResolutions.resolvedAt,
    })
    .from(schema.visitResolutions)
    .innerJoin(schema.users, eq(schema.users.id, schema.visitResolutions.resolvedBy))
    .where(eq(schema.visitResolutions.visitScheduleId, visitScheduleId))
    .orderBy(desc(schema.visitResolutions.resolvedAt), desc(schema.visitResolutions.id));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list) {
      list.push(row);
    } else {
      map.set(key(row), [row]);
    }
  }
  return map;
}

export interface VisitSummaryCounts {
  /** Every visit that started in the period, cancelled ones included. */
  total: number;
  completed: number;
  missed: number;
  cancelled: number;
  open: number;
  /** Missed visits a supervisor has resolved (status investigated). */
  investigated: number;
  fullyVerified: number;
  late: number;
  missingCheckout: number;
  /** Required tasks recorded as not completed, across the visits. */
  requiredTasksNotDone: number;
  /** completed / (completed + missed); null when neither happened. */
  completionRate: number | null;
  /** fullyVerified / completed; null when nothing was completed. */
  verifiedRate: number | null;
}

export interface VisitSummaryRow extends VisitSummaryCounts {
  personId: string;
  personName: string;
}

function emptyCounts(): Omit<VisitSummaryCounts, 'completionRate' | 'verifiedRate'> {
  return {
    total: 0,
    completed: 0,
    missed: 0,
    cancelled: 0,
    open: 0,
    investigated: 0,
    fullyVerified: 0,
    late: 0,
    missingCheckout: 0,
    requiredTasksNotDone: 0,
  };
}

function withRates(counts: ReturnType<typeof emptyCounts>): VisitSummaryCounts {
  const decided = counts.completed + counts.missed;
  return {
    ...counts,
    completionRate: decided > 0 ? counts.completed / decided : null,
    verifiedRate: counts.completed > 0 ? counts.fullyVerified / counts.completed : null,
  };
}

/** Per-caregiver or per-dependant counts over the period, plus the period's totals. */
export function summariseVisits(
  records: VisitRecord[],
  groupByPerson: 'caregiver' | 'dependant',
  now: Date,
): { rows: VisitSummaryRow[]; totals: VisitSummaryCounts } {
  const people = new Map<string, { name: string; counts: ReturnType<typeof emptyCounts> }>();
  const totals = emptyCounts();
  for (const visit of records) {
    const id = groupByPerson === 'caregiver' ? visit.caregiverId : visit.dependantId;
    const name = groupByPerson === 'caregiver' ? visit.caregiverName : visit.dependantName;
    let person = people.get(id);
    if (!person) {
      person = { name, counts: emptyCounts() };
      people.set(id, person);
    }
    const assessment = assessVisit(visit, now);
    for (const counts of [person.counts, totals]) {
      counts.total += 1;
      counts[assessment.outcome] += 1;
      counts.investigated += visit.status === 'investigated' ? 1 : 0;
      counts.fullyVerified += assessment.fullyVerified ? 1 : 0;
      counts.late += assessment.late ? 1 : 0;
      counts.missingCheckout += assessment.missingCheckout ? 1 : 0;
      counts.requiredTasksNotDone += visit.requiredTasksNotDone.length;
    }
  }
  return {
    rows: [...people].map(([personId, { name, counts }]) => ({
      personId,
      personName: name,
      ...withRates(counts),
    })),
    totals: withRates(totals),
  };
}

// ---------------------------------------------------------------------------------------------
// Missed-visit alert response
// ---------------------------------------------------------------------------------------------

export interface AlertResponseStats {
  raised: number;
  acknowledged: number;
  unacknowledged: number;
  /** Minutes from an alert being raised to its acknowledgement; null when none were. */
  medianMinutesToAcknowledge: number | null;
  p90MinutesToAcknowledge: number | null;
}

export interface AlertResponseReport extends AlertResponseStats {
  bySupervisor: {
    userId: string;
    name: string;
    acknowledged: number;
    medianMinutesToAcknowledge: number | null;
  }[];
  /** The oldest alerts still waiting, so the report can say how long. */
  oldestUnacknowledgedSentAt: Date | null;
}

/** Nearest-rank percentile of [values] (sorted here), in whole minutes rounded to one decimal. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round((sorted[index] ?? 0) * 10) / 10;
}

export async function alertResponse(db: Db, period: Period): Promise<AlertResponseReport> {
  const acknowledger = alias(schema.users, 'acknowledger');
  const rows = await db
    .select({
      sentAt: schema.notificationLog.sentAt,
      acknowledgedAt: schema.notificationLog.acknowledgedAt,
      acknowledgedBy: schema.notificationLog.acknowledgedBy,
      acknowledgerName: acknowledger.fullName,
    })
    .from(schema.notificationLog)
    .leftJoin(acknowledger, eq(acknowledger.id, schema.notificationLog.acknowledgedBy))
    .where(
      and(
        eq(schema.notificationLog.type, 'missed_visit'),
        isNotNull(schema.notificationLog.sentAt),
        inPeriod(schema.notificationLog.sentAt, period),
      ),
    );

  const minutes: number[] = [];
  const bySupervisor = new Map<string, { name: string; minutes: number[] }>();
  let oldestUnacknowledgedSentAt: Date | null = null;
  for (const row of rows) {
    if (!row.sentAt) {
      continue;
    }
    if (!row.acknowledgedAt) {
      if (!oldestUnacknowledgedSentAt || row.sentAt < oldestUnacknowledgedSentAt) {
        oldestUnacknowledgedSentAt = row.sentAt;
      }
      continue;
    }
    const taken = Math.max(0, (row.acknowledgedAt.getTime() - row.sentAt.getTime()) / 60_000);
    minutes.push(taken);
    if (row.acknowledgedBy) {
      const entry = bySupervisor.get(row.acknowledgedBy) ?? {
        name: row.acknowledgerName ?? 'Unknown supervisor',
        minutes: [],
      };
      entry.minutes.push(taken);
      bySupervisor.set(row.acknowledgedBy, entry);
    }
  }

  return {
    raised: rows.length,
    acknowledged: minutes.length,
    unacknowledged: rows.length - minutes.length,
    medianMinutesToAcknowledge: percentile(minutes, 50),
    p90MinutesToAcknowledge: percentile(minutes, 90),
    oldestUnacknowledgedSentAt,
    bySupervisor: [...bySupervisor]
      .map(([userId, entry]) => ({
        userId,
        name: entry.name,
        acknowledged: entry.minutes.length,
        medianMinutesToAcknowledge: percentile(entry.minutes, 50),
      }))
      .sort((a, b) => b.acknowledged - a.acknowledged || a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------------------------
// Consent register
// ---------------------------------------------------------------------------------------------

export type ConsentType = (typeof schema.consentTypeEnum.enumValues)[number];

export interface ConsentState {
  status: 'active' | 'revoked' | 'none';
  grantedByName: string | null;
  grantedAt: Date | null;
  revokedByName: string | null;
  revokedAt: Date | null;
}

export interface ConsentRegisterRow {
  subjectType: 'caregiver' | 'dependant';
  subjectId: string;
  name: string;
  consents: Record<ConsentType, ConsentState>;
  /**
   * Visits still to come for someone without location-verification consent. Scheduling is blocked
   * without it, so these are visits booked before a consent was revoked: they can't be verified.
   */
  upcomingVisitsWithoutConsent: number;
}

const NO_CONSENT: ConsentState = {
  status: 'none',
  grantedByName: null,
  grantedAt: null,
  revokedByName: null,
  revokedAt: null,
};

export async function consentRegister(db: Db, now: Date): Promise<ConsentRegisterRow[]> {
  const grantor = alias(schema.users, 'grantor');
  const revoker = alias(schema.users, 'revoker');
  const records = await db
    .select({
      caregiverId: schema.consentRecords.caregiverId,
      dependantId: schema.consentRecords.dependantId,
      consentType: schema.consentRecords.consentType,
      grantedAt: schema.consentRecords.grantedAt,
      revokedAt: schema.consentRecords.revokedAt,
      grantedByName: grantor.fullName,
      revokedByName: revoker.fullName,
    })
    .from(schema.consentRecords)
    .innerJoin(grantor, eq(grantor.id, schema.consentRecords.grantedBy))
    .leftJoin(revoker, eq(revoker.id, schema.consentRecords.revokedBy))
    .orderBy(asc(schema.consentRecords.grantedAt));

  const caregivers = await db
    .select({ id: schema.caregivers.userId, name: schema.users.fullName })
    .from(schema.caregivers)
    .innerJoin(schema.users, eq(schema.users.id, schema.caregivers.userId))
    .where(eq(schema.users.status, 'active'));
  const dependants = await db
    .select({ id: schema.dependants.id, name: schema.dependants.fullName })
    .from(schema.dependants)
    .where(eq(schema.dependants.status, 'active'));

  const upcoming = await db
    .select({
      caregiverId: schema.visitSchedules.caregiverId,
      dependantId: schema.visitSchedules.dependantId,
    })
    .from(schema.visitSchedules)
    .where(
      and(
        eq(schema.visitSchedules.status, 'scheduled'),
        gte(schema.visitSchedules.scheduledStart, now),
      ),
    );

  // Records are in grant order, so the last one seen per subject and type is the latest; an
  // active record anywhere wins over a later revoked one (a re-grant after a revoke).
  const latest = new Map<string, ConsentState>();
  for (const record of records) {
    const subjectId = record.caregiverId ?? record.dependantId;
    if (!subjectId) {
      continue;
    }
    const key = `${subjectId}:${record.consentType}`;
    const state: ConsentState = {
      status: record.revokedAt ? 'revoked' : 'active',
      grantedByName: record.grantedByName,
      grantedAt: record.grantedAt,
      revokedByName: record.revokedByName,
      revokedAt: record.revokedAt,
    };
    if (latest.get(key)?.status !== 'active' || state.status === 'active') {
      latest.set(key, state);
    }
  }

  const consentsOf = (subjectId: string): Record<ConsentType, ConsentState> => ({
    location_verification: latest.get(`${subjectId}:location_verification`) ?? NO_CONSENT,
    visit_audio: latest.get(`${subjectId}:visit_audio`) ?? NO_CONSENT,
    voice_verification: latest.get(`${subjectId}:voice_verification`) ?? NO_CONSENT,
  });
  const hasLocationConsent = (subjectId: string) =>
    latest.get(`${subjectId}:location_verification`)?.status === 'active';

  const rows: ConsentRegisterRow[] = [
    ...caregivers.map((c) => ({
      subjectType: 'caregiver' as const,
      subjectId: c.id,
      name: c.name,
      consents: consentsOf(c.id),
      upcomingVisitsWithoutConsent: hasLocationConsent(c.id)
        ? 0
        : upcoming.filter((v) => v.caregiverId === c.id).length,
    })),
    ...dependants.map((d) => ({
      subjectType: 'dependant' as const,
      subjectId: d.id,
      name: d.name,
      consents: consentsOf(d.id),
      upcomingVisitsWithoutConsent: hasLocationConsent(d.id)
        ? 0
        : upcoming.filter((v) => v.dependantId === d.id).length,
    })),
  ];
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Terms and privacy notice acceptance
// ---------------------------------------------------------------------------------------------

export interface TermsDocumentReport {
  document: 'caregiver' | 'family_member';
  currentVersion: string;
  activeUsers: number;
  acceptedCurrent: number;
  /** Every active user of the app, those who haven't accepted the current version first. */
  users: {
    userId: string;
    name: string;
    acceptedCurrent: boolean;
    lastAcceptedVersion: string | null;
    lastAcceptedAt: Date | null;
  }[];
}

export async function termsReport(db: Db): Promise<TermsDocumentReport[]> {
  const users = await db
    .select({ id: schema.users.id, name: schema.users.fullName, role: schema.users.role })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.status, 'active'),
        inArray(schema.users.role, ['caregiver', 'family_member']),
      ),
    );
  const acceptances = await db
    .select({
      userId: schema.termsAcceptances.userId,
      document: schema.termsAcceptances.document,
      version: schema.termsAcceptances.version,
      acceptedAt: schema.termsAcceptances.acceptedAt,
    })
    .from(schema.termsAcceptances)
    .orderBy(asc(schema.termsAcceptances.acceptedAt));

  return (['caregiver', 'family_member'] as const).map((document) => {
    const currentVersion = CURRENT_TERMS[document].version;
    const latestByUser = new Map<string, { version: string; acceptedAt: Date }>();
    const acceptedCurrent = new Set<string>();
    for (const acceptance of acceptances) {
      if (acceptance.document !== document) {
        continue;
      }
      latestByUser.set(acceptance.userId, acceptance);
      if (acceptance.version === currentVersion) {
        acceptedCurrent.add(acceptance.userId);
      }
    }
    const documentUsers = users
      .filter((user) => user.role === document)
      .map((user) => ({
        userId: user.id,
        name: user.name,
        acceptedCurrent: acceptedCurrent.has(user.id),
        lastAcceptedVersion: latestByUser.get(user.id)?.version ?? null,
        lastAcceptedAt: latestByUser.get(user.id)?.acceptedAt ?? null,
      }))
      .sort(
        (a, b) =>
          Number(a.acceptedCurrent) - Number(b.acceptedCurrent) || a.name.localeCompare(b.name),
      );
    return {
      document,
      currentVersion,
      activeUsers: documentUsers.length,
      acceptedCurrent: documentUsers.filter((user) => user.acceptedCurrent).length,
      users: documentUsers,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------

export interface AuditLogFilters {
  period: Period;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
}

// Newest first, truncated to milliseconds so the keyset cursor round-trips (pagination.ts).
export const AUDIT_CREATED_AT = sql`date_trunc('milliseconds', ${schema.auditLog.createdAt})`;

export function auditLogConditions(filters: AuditLogFilters): SQL[] {
  const conditions: (SQL | undefined)[] = [
    inPeriod(schema.auditLog.createdAt, filters.period),
    filters.actorUserId ? eq(schema.auditLog.actorUserId, filters.actorUserId) : undefined,
    filters.entityType ? eq(schema.auditLog.entityType, filters.entityType) : undefined,
    filters.entityId ? eq(schema.auditLog.entityId, filters.entityId) : undefined,
    filters.action ? eq(schema.auditLog.action, filters.action) : undefined,
  ];
  return conditions.filter((c): c is SQL => c !== undefined);
}

export function auditLogQuery(db: Db, conditions: SQL[]) {
  return db
    .select({
      id: schema.auditLog.id,
      createdAt: schema.auditLog.createdAt,
      actorUserId: schema.auditLog.actorUserId,
      actorName: schema.users.fullName,
      actorRole: schema.users.role,
      action: schema.auditLog.action,
      entityType: schema.auditLog.entityType,
      entityId: schema.auditLog.entityId,
      metadata: schema.auditLog.metadata,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(AUDIT_CREATED_AT), desc(schema.auditLog.id));
}

/** The distinct actions and entity types recorded, for the audit screen's filter menus. */
export async function auditLogFacets(
  db: Db,
): Promise<{ actions: string[]; entityTypes: string[] }> {
  const actions = await db
    .selectDistinct({ value: schema.auditLog.action })
    .from(schema.auditLog)
    .orderBy(asc(schema.auditLog.action));
  const entityTypes = await db
    .selectDistinct({ value: schema.auditLog.entityType })
    .from(schema.auditLog)
    .orderBy(asc(schema.auditLog.entityType));
  return { actions: actions.map((a) => a.value), entityTypes: entityTypes.map((e) => e.value) };
}
