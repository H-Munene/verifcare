// The Compliance tab's reports (GET /compliance/*), an exception's resolution
// (POST /visit-schedules/{id}/resolutions) and the CSV exports - types match backend/openapi.yaml's
// Compliance schemas and backend/src/db/complianceReports.ts.

import { queryString, type ApiClient } from './client';

/** Nairobi calendar days, both included. */
export interface Period {
  from: string;
  to: string;
}

export interface VisitSummaryCounts {
  total: number;
  completed: number;
  missed: number;
  cancelled: number;
  open: number;
  investigated: number;
  fullyVerified: number;
  late: number;
  missingCheckout: number;
  requiredTasksNotDone: number;
  /** completed / (completed + missed), 0-1. */
  completionRate: number | null;
  /** fullyVerified / completed, 0-1. */
  verifiedRate: number | null;
}

export interface VisitSummaryRow extends VisitSummaryCounts {
  personId: string;
  personName: string;
}

export type SummaryGroupBy = 'caregiver' | 'dependant';
export const SUMMARY_SORT_KEYS = [
  'name',
  'total',
  'completionRate',
  'verifiedRate',
  'missed',
  'late',
  'missingCheckout',
] as const;
export type SummarySortKey = (typeof SUMMARY_SORT_KEYS)[number];
export type SummarySort = SummarySortKey | `-${SummarySortKey}`;

export interface VisitSummary {
  period: Period;
  groupBy: SummaryGroupBy;
  rows: VisitSummaryRow[];
  totals: VisitSummaryCounts;
}

export type ExceptionKind =
  'missed' | 'missing_checkout' | 'failed_check' | 'supervisor_override' | 'checkout_override';

export const RESOLUTION_OUTCOMES = [
  'caregiver_absent',
  'family_cancelled',
  'dependant_unavailable',
  'device_or_network_issue',
  'visit_took_place',
  'verified_manually',
  'other',
] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export const RESOLUTION_OUTCOME_LABELS: Record<ResolutionOutcome, string> = {
  caregiver_absent: 'Caregiver absent',
  family_cancelled: 'Family cancelled',
  dependant_unavailable: 'Dependant unavailable',
  device_or_network_issue: 'Device or network issue',
  visit_took_place: 'Visit took place',
  verified_manually: 'Verified manually',
  other: 'Other',
};

export interface ResolutionSummary {
  outcome: ResolutionOutcome;
  note: string;
  resolvedByName: string;
  resolvedAt: string;
}

export interface VisitResolution extends ResolutionSummary {
  id: string;
  visitScheduleId: string;
  resolvedBy: string;
}

export interface ComplianceException {
  visitScheduleId: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  caregiverId: string;
  caregiverName: string;
  dependantId: string;
  dependantName: string;
  checkinAt: string | null;
  checkoutAt: string | null;
  kinds: ExceptionKind[];
  failedChecks: { attemptType: string; failureReason: string | null; count: number }[];
  // Why the caregiver checked out without the family's code.
  checkoutOverride: { reason: string; note: string | null } | null;
  latestResolution: ResolutionSummary | null;
}

export interface ExceptionPage {
  period: Period;
  total: number;
  items: ComplianceException[];
  nextCursor: string | null;
}

export interface AlertResponse {
  period: Period;
  raised: number;
  acknowledged: number;
  unacknowledged: number;
  medianMinutesToAcknowledge: number | null;
  p90MinutesToAcknowledge: number | null;
  oldestUnacknowledgedSentAt: string | null;
  bySupervisor: {
    userId: string;
    name: string;
    acknowledged: number;
    medianMinutesToAcknowledge: number | null;
  }[];
}

export type ConsentType = 'location_verification' | 'visit_audio' | 'voice_verification';

export interface ConsentState {
  status: 'active' | 'revoked' | 'none';
  grantedByName: string | null;
  grantedAt: string | null;
  revokedByName: string | null;
  revokedAt: string | null;
}

export interface ConsentRegisterRow {
  subjectType: 'caregiver' | 'dependant';
  subjectId: string;
  name: string;
  consents: Record<ConsentType, ConsentState>;
  upcomingVisitsWithoutConsent: number;
}

export interface TermsDocumentReport {
  document: 'caregiver' | 'family_member';
  currentVersion: string;
  activeUsers: number;
  acceptedCurrent: number;
  users: {
    userId: string;
    name: string;
    acceptedCurrent: boolean;
    lastAcceptedVersion: string | null;
    lastAcceptedAt: string | null;
  }[];
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditLogPage {
  period: Period;
  items: AuditLogEntry[];
  nextCursor: string | null;
}

export interface AuditLogFilters {
  action?: string;
  entityType?: string;
  actorUserId?: string;
  entityId?: string;
}

export interface CaregiverPerformanceRow {
  caregiverId: string;
  caregiverName: string;
  assigned: number;
  completed: number;
  missed: number;
  excused: number;
  completionRate: number | null;
  checkedIn: number;
  onTimeRate: number | null;
  averageCheckinDelayMinutes: number | null;
  averageVisitMinutes: number | null;
  averagePlannedMinutes: number | null;
  requiredTasksDoneRate: number | null;
  qrVerifiedRate: number | null;
  supervisorOverrides: number;
  failedCheckins: number;
  recordingsProvided: number;
  recordingsSkipped: Record<
    'dependant_declined' | 'dependant_unwell_or_asleep' | 'technical_problem' | 'other',
    number
  >;
  offersReceived: number;
  offersAccepted: number;
  offersDeclined: number;
  offersExpired: number;
  averageOfferResponseMinutes: number | null;
  visitsCovered: number;
  weeks: {
    weekStart: string;
    completed: number;
    missed: number;
    onTime: number;
    checkedIn: number;
  }[];
}

export type ExportReport =
  'visits' | 'visit-summary' | 'caregiver-performance' | 'consents' | 'terms' | 'audit-log';

export function createComplianceApi(client: ApiClient) {
  return {
    getCaregiverPerformance: (period: Period) =>
      client.get<{ period: Period; items: CaregiverPerformanceRow[] }>(
        `/compliance/caregiver-performance${queryString(period)}`,
      ),
    getVisitSummary: (params: Period & { groupBy: SummaryGroupBy; sort: SummarySort }) =>
      client.get<VisitSummary>(`/compliance/visits${queryString(params)}`),
    listExceptions: (
      params: Period & {
        kind?: ExceptionKind;
        resolved?: boolean;
        cursor?: string;
        limit?: number;
      },
    ) => client.get<ExceptionPage>(`/compliance/exceptions${queryString(params)}`),
    getAlertResponse: (period: Period) =>
      client.get<AlertResponse>(`/compliance/alerts${queryString(period)}`),
    getConsentRegister: (params: {
      subjectType?: 'caregiver' | 'dependant';
      status?: 'missing' | 'complete';
    }) => client.get<{ items: ConsentRegisterRow[] }>(`/compliance/consents${queryString(params)}`),
    getTermsReport: () => client.get<{ documents: TermsDocumentReport[] }>('/compliance/terms'),
    listAuditLog: (params: Period & AuditLogFilters & { cursor?: string; limit?: number }) =>
      client.get<AuditLogPage>(`/compliance/audit-log${queryString(params)}`),
    getAuditLogFacets: () =>
      client.get<{ actions: string[]; entityTypes: string[] }>('/compliance/audit-log/facets'),
    resolveVisit: (visitScheduleId: string, body: { outcome: ResolutionOutcome; note: string }) =>
      client.post<VisitResolution>(`/visit-schedules/${visitScheduleId}/resolutions`, body),
    /** Downloads a report as CSV, named for the report and period the way the API names it. */
    exportReport: (
      report: ExportReport,
      params: Partial<Period> & AuditLogFilters & { groupBy?: SummaryGroupBy },
    ) => {
      const stamp = params.from && params.to ? `${params.from}-to-${params.to}` : 'current';
      return client.download(
        `/compliance/exports/${report}${queryString(params)}`,
        `mzazi-care-${report}-${stamp}.csv`,
      );
    },
  };
}
