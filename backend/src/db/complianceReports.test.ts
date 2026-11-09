import { describe, expect, it } from 'vitest';
import { assessVisit, type VisitRecord } from './complianceReports.js';

const now = new Date('2026-11-09T12:00:00Z');

function completedVisit(overrides: Partial<VisitRecord> = {}): VisitRecord {
  return {
    id: 'visit',
    status: 'completed',
    scheduledStart: new Date('2026-11-09T09:00:00Z'),
    scheduledEnd: new Date('2026-11-09T10:00:00Z'),
    caregiverId: 'caregiver',
    caregiverName: 'Caregiver',
    dependantId: 'dependant',
    dependantName: 'Dependant',
    geofenceRadiusMeters: 50,
    checkinAt: new Date('2026-11-09T09:05:00Z'),
    checkoutAt: new Date('2026-11-09T09:55:00Z'),
    distanceFromGeofenceMeters: 5,
    checkoutDistanceFromGeofenceMeters: 5,
    checkinMethod: 'qr',
    familyDistanceFromGeofenceMeters: 4,
    audioRecorded: true,
    audioSkipReason: null,
    failedChecks: [],
    requiredTasksNotDone: [],
    latestResolution: null,
    ...overrides,
  };
}

describe('assessVisit', () => {
  it('counts a QR check-in with an in-radius checkout as fully verified', () => {
    const assessment = assessVisit(completedVisit(), now);

    expect(assessment.fullyVerified).toBe(true);
    expect(assessment.exceptionKinds).toEqual([]);
  });

  it('never counts a supervisor override as verified, and reports it as an exception', () => {
    const assessment = assessVisit(completedVisit({ checkinMethod: 'supervisor_override' }), now);

    expect(assessment.fullyVerified).toBe(false);
    expect(assessment.exceptionKinds).toEqual(['supervisor_override']);
  });

  it('does not count a checkout outside the radius as verified', () => {
    const visit = completedVisit({ checkoutDistanceFromGeofenceMeters: 80 });

    expect(assessVisit(visit, now).fullyVerified).toBe(false);
  });
});
