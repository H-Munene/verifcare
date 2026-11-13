// Typed request/response shapes and calls for /visit-schedules, matching
// backend/src/routes/visitSchedules.ts's actual VisitScheduleResponse interface and
// backend/openapi.yaml exactly - not re-derived from scratch. Mirrors api/caregivers.ts's exact
// module shape.

import type { ApiClient } from './client';
import type { ExceptionKind, VisitResolution } from './compliance';

export type VisitStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'missed'
  | 'cancelled'
  | 'investigated'
  | 'reassigned';

export interface VisitSchedule {
  id: string;
  caregiverId: string;
  dependantId: string;
  caregiverDisplayName: string;
  dependantDisplayName: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: VisitStatus;
  routeSequence?: number | null;
  recoveredFromVisitId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type VerificationAttemptType =
  'geofence' | 'family_location' | 'qr_scan' | 'checkout_qr' | 'checkout_code';

export type AudioSkipReason =
  'dependant_declined' | 'dependant_unwell_or_asleep' | 'technical_problem' | 'other';

export interface VerificationEvent {
  visitScheduleId: string;
  checkinAt: string | null;
  checkoutAt: string | null;
  checkinGpsLat: number | null;
  checkinGpsLng: number | null;
  distanceFromGeofenceMeters: number | null;
  checkinMethod: 'qr' | 'supervisor_override' | null;
  qrFamilyMemberName: string | null;
  familyDistanceFromGeofenceMeters: number | null;
  // The dependant's recording, or why there isn't one. Supervisors can't listen: only the family can.
  audioRecordedAt: string | null;
  audioDurationSeconds: number | null;
  audioSkipReason: AudioSkipReason | null;
  audioSkipNote: string | null;
  // Both recordings, each with its advisory voice check (shown to supervisors only).
  recordings: VisitRecording[];
  // How check-out was confirmed: the family's code, or the caregiver's override and its reason.
  checkoutRequestedAt: string | null;
  checkoutMethod: 'qr' | 'code' | 'override' | null;
  checkoutFamilyMemberName: string | null;
  checkoutOverrideReason: CheckoutOverrideReason | null;
  checkoutOverrideNote: string | null;
}

export type CheckoutOverrideReason =
  'no_family_member_present' | 'family_phone_unavailable' | 'camera_or_code_problem' | 'other';

export type VoiceCheckResult =
  'match' | 'mismatch' | 'too_short' | 'not_enrolled' | 'no_consent' | 'unavailable';

export interface VoiceCheck {
  result: VoiceCheckResult;
  score: number | null;
  speechSeconds: number | null;
  threshold: number | null;
  checkedAt: string;
}

export interface VisitRecording {
  role: 'caregiver' | 'dependant';
  recordedAt: string;
  durationSeconds: number;
  voiceCheck?: VoiceCheck | null;
}

export interface VerificationAttempt {
  id: string;
  visitScheduleId: string;
  attemptType: VerificationAttemptType;
  passed: boolean;
  failureReason: string | null;
  attemptedAt: string;
}

export interface VerificationAudit {
  event: VerificationEvent | null;
  attempts: VerificationAttempt[];
  /**
   * How the visit's exception was resolved, newest first, and why it is one (empty when it
   * isn't). Optional: an API deployed before the Compliance tab doesn't send them.
   */
  resolutions?: VisitResolution[];
  exceptionKinds?: ExceptionKind[];
}

export interface VisitSchedulePage {
  items: VisitSchedule[];
  nextCursor: string | null;
}

export interface CreateVisitScheduleRequest {
  caregiverId: string;
  dependantId: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export interface UpdateVisitScheduleRequest {
  scheduledStart?: string;
  scheduledEnd?: string;
  status?: VisitStatus;
}

export interface ListVisitSchedulesParams {
  status?: VisitStatus;
  caregiverId?: string;
  dependantId?: string;
  scheduledStartFrom?: string;
  scheduledStartTo?: string;
  sort?: 'scheduledStart' | '-scheduledStart';
  cursor?: string;
  limit?: number;
}

function toQueryString(params: ListVisitSchedulesParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** A person's recordings and their advisory voice checks (GET /voice-checks), newest first. */
export interface VoiceCheckHistory {
  enrolment: { enrolled: boolean; enrolledAt: string | null };
  items: {
    visitScheduleId: string;
    scheduledStart: string;
    caregiverName: string;
    dependantName: string;
    recordedAt: string;
    durationSeconds: number;
    result: VoiceCheckResult | null;
    score: number | null;
    speechSeconds: number | null;
    threshold: number | null;
  }[];
}

export function createVisitSchedulesApi(client: ApiClient) {
  return {
    listVisitSchedules: (params: ListVisitSchedulesParams = {}) =>
      client.get<VisitSchedulePage>(`/visit-schedules${toQueryString(params)}`),
    getVisitSchedule: (visitScheduleId: string) =>
      client.get<VisitSchedule>(`/visit-schedules/${visitScheduleId}`),
    getVisitVerification: (visitScheduleId: string) =>
      client.get<VerificationAudit>(`/visit-schedules/${visitScheduleId}/verification`),
    listVoiceChecks: (subject: { dependantId: string } | { caregiverId: string }) =>
      client.get<VoiceCheckHistory>(`/voice-checks${toQueryString(subject)}`),
    createVisitSchedule: (body: CreateVisitScheduleRequest) =>
      client.post<VisitSchedule>('/visit-schedules', body),
    updateVisitSchedule: (visitScheduleId: string, body: UpdateVisitScheduleRequest) =>
      client.patch<VisitSchedule>(`/visit-schedules/${visitScheduleId}`, body),
  };
}

export type VisitSchedulesApi = ReturnType<typeof createVisitSchedulesApi>;
