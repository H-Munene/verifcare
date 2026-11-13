// The supervisor console's Compliance tab (2026-09-27): period reports on visit verification,
// exceptions, missed-visit alert response, consent, terms acceptance and the audit trail, each
// also downloadable as CSV for an auditor. The reports themselves live in
// db/complianceReports.ts so the screen and the exports can never disagree; this file is the
// HTTP shape around them. Supervisor-only: these are agency-wide records about everyone.
//
// A period is a pair of Nairobi calendar days (both included), defaulting to the current month,
// since the exports are monthly reports. Capped at 366 days so one request can't load years.

import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import { caregiverPerformance } from '../db/caregiverPerformance.js';
import type { Db } from '../db/client.js';
import {
  alertResponse,
  assessVisit,
  AUDIT_CREATED_AT,
  auditLogConditions,
  auditLogFacets,
  auditLogQuery,
  consentRegister,
  summariseVisits,
  termsReport,
  visitRecords,
  type ExceptionKind,
  type Period,
  type VisitRecord,
  type VisitSummaryRow,
} from '../db/complianceReports.js';
import * as schema from '../db/schema.js';
import { toCsv, type CsvValue } from '../csv.js';
import { sendProblem } from '../errors.js';
import { addDays, nairobiDate, TIME_ZONE } from '../nairobiTime.js';
import { decodeCursor, keysetCondition, paginate, type Sort } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface ComplianceRouterDependencies {
  requireAuth: RequestHandler;
  // Injectable so tests can pin "now"; outcomes and the default period depend on it.
  now?: () => Date;
}

const MAX_PERIOD_DAYS = 366;

const periodSchema = z.object({
  from: z.iso.date().optional().describe('First Nairobi day, YYYY-MM-DD; defaults to this month'),
  to: z.iso.date().optional().describe('Last Nairobi day (included); defaults to this month'),
});

/** The requested period, or the current Nairobi month; sends a 400 and returns undefined if bad. */
function resolvePeriod(
  query: { from?: string; to?: string },
  now: Date,
  res: Response,
): Period | undefined {
  const today = nairobiDate(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const nextMonthStart = addDays(monthStart, 32).slice(0, 7) + '-01';
  const from = query.from ?? monthStart;
  const to = query.to ?? addDays(nextMonthStart, -1);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days < 1 || days > MAX_PERIOD_DAYS) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: `The period must run forwards and cover at most ${MAX_PERIOD_DAYS} days.`,
    });
    return undefined;
  }
  return { from, to };
}

const SUMMARY_SORTS = [
  'name',
  'total',
  'completionRate',
  'verifiedRate',
  'missed',
  'late',
  'missingCheckout',
] as const;
type SummarySort = (typeof SUMMARY_SORTS)[number];

const visitsQuerySchema = periodSchema.extend({
  groupBy: z.enum(['caregiver', 'dependant']).default('caregiver'),
  sort: z
    .enum([...SUMMARY_SORTS, ...SUMMARY_SORTS.map((key) => `-${key}` as const)])
    .default('name'),
});

const EXCEPTION_SORT = '-scheduledStart';

const exceptionsQuerySchema = periodSchema.extend({
  kind: z
    .enum([
      'missed',
      'missing_checkout',
      'failed_check',
      'supervisor_override',
      'checkout_override',
    ])
    .optional(),
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const consentsQuerySchema = z.object({
  subjectType: z.enum(['caregiver', 'dependant']).optional(),
  // missing: at least one consent isn't active; complete: both are.
  status: z.enum(['missing', 'complete']).optional(),
});

const auditLogQuerySchema = periodSchema.extend({
  actorUserId: z.string().uuid().optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().min(1).max(64).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const EXPORT_REPORTS = [
  'visits',
  'visit-summary',
  'caregiver-performance',
  'consents',
  'terms',
  'audit-log',
] as const;
const exportParamSchema = z.enum(EXPORT_REPORTS);
// Every export's filters in one schema: each report reads the ones that apply to it.
const exportQuerySchema = periodSchema.extend({
  groupBy: visitsQuerySchema.shape.groupBy,
  actorUserId: auditLogQuerySchema.shape.actorUserId,
  entityType: auditLogQuerySchema.shape.entityType,
  entityId: auditLogQuerySchema.shape.entityId,
  action: auditLogQuerySchema.shape.action,
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

function sortSummary(rows: VisitSummaryRow[], sort: string): VisitSummaryRow[] {
  const descending = sort.startsWith('-');
  const key = (descending ? sort.slice(1) : sort) as SummarySort;
  const value = (row: VisitSummaryRow) => (key === 'name' ? row.personName : row[key]);
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // People with no rate yet (nothing completed) sort last whichever way.
    if (x === null || y === null) {
      return x === y ? 0 : x === null ? 1 : -1;
    }
    const order = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return (descending ? -order : order) || a.personName.localeCompare(b.personName);
  });
}

function exceptionOf(visit: VisitRecord, kinds: ExceptionKind[]) {
  return {
    visitScheduleId: visit.id,
    scheduledStart: visit.scheduledStart,
    scheduledEnd: visit.scheduledEnd,
    status: visit.status,
    caregiverId: visit.caregiverId,
    caregiverName: visit.caregiverName,
    dependantId: visit.dependantId,
    dependantName: visit.dependantName,
    checkinAt: visit.checkinAt,
    checkoutAt: visit.checkoutAt,
    kinds,
    failedChecks: visit.failedChecks,
    // Why the caregiver checked out without the family's code (2026-11-13).
    checkoutOverride: visit.checkoutOverrideReason
      ? { reason: visit.checkoutOverrideReason, note: visit.checkoutOverrideNote }
      : null,
    latestResolution: visit.latestResolution,
  };
}

/** "2026-09-27 09:05" in Nairobi time, for CSV cells an auditor reads directly. */
function nairobiDateTime(instant: Date | null): string | null {
  if (!instant) {
    return null;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

const yesNo = (value: boolean | null): string | null =>
  value === null ? null : value ? 'yes' : 'no';
const percent = (rate: number | null): string | null =>
  rate === null ? null : `${Math.round(rate * 100)}%`;
const metres = (value: number | null): number | null => (value === null ? null : Math.round(value));

function summaryCsvRow(name: string, row: Omit<VisitSummaryRow, 'personId' | 'personName'>) {
  return [
    name,
    row.total,
    row.completed,
    row.missed,
    row.investigated,
    row.cancelled,
    row.open,
    percent(row.completionRate),
    row.fullyVerified,
    percent(row.verifiedRate),
    row.late,
    row.missingCheckout,
    row.requiredTasksNotDone,
  ];
}

export function createComplianceRouter(dependencies: ComplianceRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  router.use(requireAuth);
  router.use(requireRole('supervisor'));

  router.get('/visits', async (req, res, next) => {
    const query = parseOrSendProblem(visitsQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const at = now();
    const period = resolvePeriod(query, at, res);
    const db = period && getDb(res);
    if (!period || !db) {
      return;
    }
    try {
      const summary = summariseVisits(await visitRecords(db, { period }), query.groupBy, at);
      res.status(200).json({
        period,
        groupBy: query.groupBy,
        rows: sortSummary(summary.rows, query.sort),
        totals: summary.totals,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/caregiver-performance', async (req, res, next) => {
    const query = parseOrSendProblem(periodSchema, req.query, res);
    if (!query) {
      return;
    }
    const at = now();
    const period = resolvePeriod(query, at, res);
    const db = period && getDb(res);
    if (!period || !db) {
      return;
    }
    try {
      const items = await caregiverPerformance(db, period, at);
      items.sort((a, b) => a.caregiverName.localeCompare(b.caregiverName));
      res.status(200).json({ period, items });
    } catch (err) {
      next(err);
    }
  });

  router.get('/exceptions', async (req, res, next) => {
    const query = parseOrSendProblem(exceptionsQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const at = now();
    const period = resolvePeriod(query, at, res);
    const db = period && getDb(res);
    if (!period || !db) {
      return;
    }
    let after: { id: string; start: number } | undefined;
    if (query.cursor) {
      try {
        const cursor = decodeCursor(query.cursor, EXCEPTION_SORT);
        after = { id: cursor.id, start: Date.parse(cursor.value ?? '') };
      } catch {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Malformed cursor.',
        });
        return;
      }
    }
    try {
      const matching = (await visitRecords(db, { period }))
        .map((visit) => ({ visit, kinds: assessVisit(visit, at).exceptionKinds }))
        .filter(
          ({ visit, kinds }) =>
            kinds.length > 0 &&
            (!query.kind || kinds.includes(query.kind)) &&
            (query.resolved === undefined || (visit.latestResolution !== null) === query.resolved),
        )
        // Newest first, id breaking ties, the same order the cursor pages through.
        .sort(
          (a, b) =>
            b.visit.scheduledStart.getTime() - a.visit.scheduledStart.getTime() ||
            b.visit.id.localeCompare(a.visit.id),
        );
      const remaining = after
        ? matching.filter(({ visit }) => {
            const start = visit.scheduledStart.getTime();
            return start < after.start || (start === after.start && visit.id < after.id);
          })
        : matching;
      const { items, nextCursor } = paginate(remaining, query.limit, ({ visit }) => ({
        id: visit.id,
        sort: EXCEPTION_SORT,
        value: visit.scheduledStart.toISOString(),
      }));
      res.status(200).json({
        period,
        total: matching.length,
        items: items.map(({ visit, kinds }) => exceptionOf(visit, kinds)),
        nextCursor,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/alerts', async (req, res, next) => {
    const query = parseOrSendProblem(periodSchema, req.query, res);
    if (!query) {
      return;
    }
    const period = resolvePeriod(query, now(), res);
    const db = period && getDb(res);
    if (!period || !db) {
      return;
    }
    try {
      res.status(200).json({ period, ...(await alertResponse(db, period)) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/consents', async (req, res, next) => {
    const query = parseOrSendProblem(consentsQuerySchema, req.query, res);
    const db = query && getDb(res);
    if (!query || !db) {
      return;
    }
    try {
      const rows = (await consentRegister(db, now())).filter((row) => {
        if (query.subjectType && row.subjectType !== query.subjectType) {
          return false;
        }
        if (!query.status) {
          return true;
        }
        const complete = Object.values(row.consents).every((c) => c.status === 'active');
        return query.status === 'complete' ? complete : !complete;
      });
      res.status(200).json({ items: rows });
    } catch (err) {
      next(err);
    }
  });

  router.get('/terms', async (_req, res, next) => {
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      res.status(200).json({ documents: await termsReport(db) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit-log/facets', async (_req, res, next) => {
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      res.status(200).json(await auditLogFacets(db));
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit-log', async (req, res, next) => {
    const query = parseOrSendProblem(auditLogQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const period = resolvePeriod(query, now(), res);
    const db = period && getDb(res);
    if (!period || !db) {
      return;
    }
    const sort: Sort = {
      expr: AUDIT_CREATED_AT,
      cast: 'timestamptz',
      param: '-createdAt',
      descending: true,
    };
    const conditions = auditLogConditions({ ...query, period });
    if (query.cursor) {
      try {
        conditions.push(
          keysetCondition(schema.auditLog.id, decodeCursor(query.cursor, sort.param), sort),
        );
      } catch {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'Malformed cursor.',
        });
        return;
      }
    }
    try {
      const rows = await auditLogQuery(db, conditions).limit(query.limit + 1);
      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({
        id: row.id,
        sort: sort.param,
        value: row.createdAt.toISOString(),
      }));
      res.status(200).json({ period, items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // CSV downloads. Every export is audit-logged (who took which records out, for which period):
  // an export is personal data leaving the system, which the DPA's accountability duty covers.
  router.get('/exports/:report', async (req, res, next) => {
    const report = parseOrSendProblem(exportParamSchema, req.params.report, res);
    if (!report) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }
    const at = now();
    const needsPeriod =
      report === 'visits' ||
      report === 'visit-summary' ||
      report === 'caregiver-performance' ||
      report === 'audit-log';
    const query = parseOrSendProblem(exportQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const period = needsPeriod ? resolvePeriod(query, at, res) : undefined;
    if (needsPeriod && !period) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      let headers: string[];
      let rows: CsvValue[][];
      if (report === 'visits' && period) {
        headers = [
          'Visit ID',
          'Scheduled start (Nairobi)',
          'Scheduled end (Nairobi)',
          'Caregiver',
          'Dependant',
          'Status',
          'Outcome',
          'Checked in (Nairobi)',
          'Checked out (Nairobi)',
          'Check-in distance from home (m)',
          'Checkout distance from home (m)',
          'Home radius (m)',
          'Check-in method',
          'Family phone distance from home (m)',
          'Recording',
          'Fully verified',
          'Late check-in',
          'Failed checks',
          'Required tasks not done',
          'Resolution',
          'Resolution note',
          'Resolved by',
          'Resolved at (Nairobi)',
        ];
        rows = (await visitRecords(db, { period })).map((visit) => {
          const assessment = assessVisit(visit, at);
          return [
            visit.id,
            nairobiDateTime(visit.scheduledStart),
            nairobiDateTime(visit.scheduledEnd),
            visit.caregiverName,
            visit.dependantName,
            visit.status,
            assessment.outcome,
            nairobiDateTime(visit.checkinAt),
            nairobiDateTime(visit.checkoutAt),
            metres(visit.distanceFromGeofenceMeters),
            metres(visit.checkoutDistanceFromGeofenceMeters),
            visit.geofenceRadiusMeters,
            visit.checkinMethod,
            metres(visit.familyDistanceFromGeofenceMeters),
            visit.audioRecorded ? 'recorded' : visit.audioSkipReason,
            yesNo(assessment.fullyVerified),
            yesNo(visit.checkinAt ? assessment.late : null),
            visit.failedChecks
              .map((f) => `${f.attemptType}: ${f.failureReason ?? 'unknown'} x${f.count}`)
              .join('; '),
            visit.requiredTasksNotDone
              .map((t) => `${t.title} (${t.reason ?? 'no reason'})`)
              .join('; '),
            visit.latestResolution?.outcome ?? null,
            visit.latestResolution?.note ?? null,
            visit.latestResolution?.resolvedByName ?? null,
            nairobiDateTime(visit.latestResolution?.resolvedAt ?? null),
          ];
        });
      } else if (report === 'visit-summary' && period) {
        const groupBy = query.groupBy;
        const summary = summariseVisits(await visitRecords(db, { period }), groupBy, at);
        headers = [
          groupBy === 'caregiver' ? 'Caregiver' : 'Dependant',
          'Visits',
          'Completed',
          'Missed',
          'Missed and investigated',
          'Cancelled',
          'Open',
          'Completion rate',
          'Fully verified',
          'Verified rate',
          'Late check-ins',
          'Missing checkouts',
          'Required tasks not done',
        ];
        rows = [
          ...sortSummary(summary.rows, 'name').map((row) => summaryCsvRow(row.personName, row)),
          summaryCsvRow('All', summary.totals),
        ];
      } else if (report === 'caregiver-performance' && period) {
        headers = [
          'Caregiver',
          'Visits assigned',
          'Completed',
          'Missed',
          'Excused',
          'Completion rate',
          'On-time rate',
          'Average check-in delay (min)',
          'Average visit length (min)',
          'Planned visit length (min)',
          'Required tasks done',
          'Confirmed by family code',
          'Supervisor overrides',
          'Failed check-in attempts',
          'Recordings provided',
          'Recordings skipped',
          'Cover offers received',
          'Offers accepted',
          'Offers declined',
          'Offers expired',
          'Average offer response (min)',
          'Visits covered for others',
        ];
        const whole = (value: number | null) => (value === null ? null : Math.round(value));
        rows = (await caregiverPerformance(db, period, at))
          .sort((a, b) => a.caregiverName.localeCompare(b.caregiverName))
          .map((row) => [
            row.caregiverName,
            row.assigned,
            row.completed,
            row.missed,
            row.excused,
            percent(row.completionRate),
            percent(row.onTimeRate),
            whole(row.averageCheckinDelayMinutes),
            whole(row.averageVisitMinutes),
            whole(row.averagePlannedMinutes),
            percent(row.requiredTasksDoneRate),
            percent(row.qrVerifiedRate),
            row.supervisorOverrides,
            row.failedCheckins,
            row.recordingsProvided,
            Object.values(row.recordingsSkipped).reduce((sum, count) => sum + count, 0),
            row.offersReceived,
            row.offersAccepted,
            row.offersDeclined,
            row.offersExpired,
            whole(row.averageOfferResponseMinutes),
            row.visitsCovered,
          ]);
      } else if (report === 'consents') {
        headers = [
          'Subject type',
          'Name',
          'Location verification consent',
          'Location consent granted by',
          'Location consent granted at (Nairobi)',
          'Location consent revoked by',
          'Location consent revoked at (Nairobi)',
          'Visit audio consent',
          'Audio consent granted by',
          'Audio consent granted at (Nairobi)',
          'Audio consent revoked by',
          'Audio consent revoked at (Nairobi)',
          'Upcoming visits without location consent',
        ];
        rows = (await consentRegister(db, at)).map((row) => [
          row.subjectType,
          row.name,
          ...(['location_verification', 'visit_audio'] as const).flatMap((type) => {
            const c = row.consents[type];
            return [
              c.status,
              c.grantedByName,
              nairobiDateTime(c.grantedAt),
              c.revokedByName,
              nairobiDateTime(c.revokedAt),
            ];
          }),
          row.upcomingVisitsWithoutConsent,
        ]);
      } else if (report === 'terms') {
        headers = [
          'App',
          'Current version',
          'User',
          'Accepted current version',
          'Last version accepted',
          'Last accepted at (Nairobi)',
        ];
        rows = (await termsReport(db)).flatMap((doc) =>
          doc.users.map((user) => [
            doc.document === 'caregiver' ? 'Caregiver app' : 'Family app',
            doc.currentVersion,
            user.name,
            yesNo(user.acceptedCurrent),
            user.lastAcceptedVersion,
            nairobiDateTime(user.lastAcceptedAt),
          ]),
        );
      } else if (report === 'audit-log' && period) {
        headers = [
          'Time (Nairobi)',
          'Actor',
          'Actor role',
          'Action',
          'Record type',
          'Record ID',
          'Details',
        ];
        rows = (await auditLogQuery(db, auditLogConditions({ ...query, period }))).map((row) => [
          nairobiDateTime(row.createdAt),
          row.actorName ?? (row.actorUserId ? 'Unknown user' : 'System'),
          row.actorRole,
          row.action,
          row.entityType,
          row.entityId,
          row.metadata ? JSON.stringify(row.metadata) : null,
        ]);
      } else {
        throw new Error(`Unhandled compliance export ${report}.`);
      }

      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }
      await recordAudit(db, {
        actorUserId: callerRow.id,
        action: 'compliance.export',
        entityType: 'compliance_report',
        entityId: null,
        metadata: { report, ...(period ?? {}), rows: rows.length },
      });

      const stamp = period ? `${period.from}-to-${period.to}` : nairobiDate(at);
      res
        .status(200)
        .type('text/csv; charset=utf-8')
        .attachment(`mzazi-care-${report}-${stamp}.csv`)
        // A byte-order mark so Excel opens UTF-8 names (e.g. accented ones) correctly.
        .send('\uFEFF' + toCsv(headers, rows));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
