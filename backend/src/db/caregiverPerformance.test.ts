import { describe, expect, it } from 'vitest';
import { summarisePerformance, type OfferRecord } from './caregiverPerformance.js';
import type { VisitRecord } from './complianceReports.js';

const now = new Date('2026-11-20T12:00:00Z');
const caregivers = [{ id: 'c1', name: 'Amina' }];

function visit(overrides: Partial<VisitRecord> = {}): VisitRecord {
  return {
    id: 'v',
    status: 'completed',
    scheduledStart: new Date('2026-11-10T06:00:00Z'), // a Tuesday morning in Nairobi
    scheduledEnd: new Date('2026-11-10T07:00:00Z'),
    caregiverId: 'c1',
    caregiverName: 'Amina',
    dependantId: 'd',
    dependantName: 'Joseph',
    geofenceRadiusMeters: 50,
    checkinAt: new Date('2026-11-10T06:05:00Z'),
    checkoutAt: new Date('2026-11-10T06:50:00Z'),
    distanceFromGeofenceMeters: 5,
    checkoutDistanceFromGeofenceMeters: 5,
    checkinMethod: 'qr',
    familyDistanceFromGeofenceMeters: 4,
    audioRecorded: true,
    audioSkipReason: null,
    recoveredFromVisitId: null,
    failedChecks: [],
    requiredTasksNotDone: [],
    latestResolution: null,
    ...overrides,
  };
}

const missed = (overrides: Partial<VisitRecord> = {}) =>
  visit({
    status: 'missed',
    checkinAt: null,
    checkoutAt: null,
    audioRecorded: false,
    ...overrides,
  });

const resolvedAs = (outcome: NonNullable<VisitRecord['latestResolution']>['outcome']) => ({
  outcome,
  note: 'n',
  resolvedByName: 's',
  resolvedAt: now,
});

const summarise = (records: VisitRecord[], offers: OfferRecord[] = []) =>
  summarisePerformance(caregivers, records, [], offers, now)[0]!;

describe('summarisePerformance', () => {
  it('counts completions and works out the rate', () => {
    const row = summarise([visit(), visit(), missed()]);

    expect(row).toMatchObject({ assigned: 3, completed: 2, missed: 1 });
    expect(row.completionRate).toBeCloseTo(2 / 3);
  });

  it('leaves a rate empty rather than calling nothing zero percent', () => {
    const row = summarise([]);

    expect(row.completionRate).toBeNull();
    expect(row.onTimeRate).toBeNull();
    expect(row.averageVisitMinutes).toBeNull();
  });

  it('never counts a cancelled visit', () => {
    const row = summarise([visit({ status: 'cancelled', checkinAt: null, checkoutAt: null })]);

    expect(row.assigned).toBe(0);
  });

  it('excuses a miss resolved as outside the caregiver control', () => {
    const row = summarise([missed({ latestResolution: resolvedAs('family_cancelled') })]);

    expect(row).toMatchObject({ missed: 0, excused: 1 });
    expect(row.completionRate).toBeNull();
  });

  it('holds a miss against them when the resolution says they were absent', () => {
    const row = summarise([missed({ latestResolution: resolvedAs('caregiver_absent') })]);

    expect(row).toMatchObject({ missed: 1, excused: 0 });
  });

  it('counts a visit taken over by someone else as a miss for the original', () => {
    const row = summarise([visit({ status: 'reassigned', checkinAt: null, checkoutAt: null })]);

    expect(row.missed).toBe(1);
  });

  it('credits the caregiver who covered a visit', () => {
    const row = summarise([visit({ recoveredFromVisitId: 'original' })]);

    expect(row.visitsCovered).toBe(1);
  });

  it('treats 15 minutes as on time and 16 as late', () => {
    const start = new Date('2026-11-10T06:00:00Z');
    const row = summarise([
      visit({ scheduledStart: start, checkinAt: new Date(start.getTime() + 15 * 60_000) }),
      visit({ scheduledStart: start, checkinAt: new Date(start.getTime() + 16 * 60_000) }),
    ]);

    expect(row.onTimeRate).toBeCloseTo(0.5);
  });

  it('counts an early arrival as no delay, not a negative one', () => {
    const row = summarise([visit({ checkinAt: new Date('2026-11-10T05:50:00Z') })]);

    expect(row.averageCheckinDelayMinutes).toBe(0);
  });

  it('compares actual visit length with what was planned', () => {
    const row = summarise([visit()]);

    expect(row.averageVisitMinutes).toBe(45);
    expect(row.averagePlannedMinutes).toBe(60);
  });

  it('separates QR check-ins from supervisor overrides', () => {
    const row = summarise([visit(), visit({ checkinMethod: 'supervisor_override' })]);

    expect(row.qrVerifiedRate).toBeCloseTo(0.5);
    expect(row.supervisorOverrides).toBe(1);
  });

  it('adds up failed check-in attempts', () => {
    const row = summarise([
      visit({
        failedChecks: [
          { attemptType: 'geofence', failureReason: 'out_of_range', count: 2 },
          { attemptType: 'qr_scan', failureReason: 'expired_qr', count: 1 },
        ],
      }),
    ]);

    expect(row.failedCheckins).toBe(3);
  });

  it('tallies recordings and why they were skipped', () => {
    const row = summarise([
      visit(),
      visit({ audioRecorded: false, audioSkipReason: 'dependant_declined' }),
    ]);

    expect(row.recordingsProvided).toBe(1);
    expect(row.recordingsSkipped.dependant_declined).toBe(1);
  });

  it('summarises cover offers, timing only those answered', () => {
    const offeredAt = new Date('2026-11-10T06:00:00Z');
    const after = (minutes: number) => new Date(offeredAt.getTime() + minutes * 60_000);
    const row = summarise(
      [],
      [
        { caregiverId: 'c1', status: 'accepted', offeredAt, respondedAt: after(2) },
        { caregiverId: 'c1', status: 'declined', offeredAt, respondedAt: after(4) },
        { caregiverId: 'c1', status: 'expired', offeredAt, respondedAt: after(5) },
        { caregiverId: 'c2', status: 'accepted', offeredAt, respondedAt: after(1) },
      ],
    );

    expect(row).toMatchObject({
      offersReceived: 3,
      offersAccepted: 1,
      offersDeclined: 1,
      offersExpired: 1,
      averageOfferResponseMinutes: 3,
    });
  });

  it('groups weeks from Monday, in Nairobi time', () => {
    const row = summarise([
      visit({
        // Sunday 22:00 UTC is already Monday in Nairobi, so this opens a new week.
        scheduledStart: new Date('2026-11-08T22:00:00Z'),
        scheduledEnd: new Date('2026-11-08T23:00:00Z'),
        checkinAt: new Date('2026-11-08T22:05:00Z'),
        checkoutAt: new Date('2026-11-08T22:50:00Z'),
      }),
      visit(),
      missed({
        scheduledStart: new Date('2026-11-17T06:00:00Z'),
        scheduledEnd: new Date('2026-11-17T07:00:00Z'),
      }),
    ]);

    expect(row.weeks).toEqual([
      { weekStart: '2026-11-09', completed: 2, missed: 0, onTime: 2, checkedIn: 2 },
      { weekStart: '2026-11-16', completed: 0, missed: 1, onTime: 0, checkedIn: 0 },
    ]);
  });
});
