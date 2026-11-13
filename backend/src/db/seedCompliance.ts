// Local compliance seed: five weeks of visit history for the people db:seed:planning made, so every
// Compliance tab has something to show. Each caregiver has a habit (often late, forgets to check
// out, skips recordings, and so on), so the performance report shows real differences.
//
// Run db:seed:planning first. This clears visits, plans, tasks, consent, terms acceptances and the
// audit log, then rebuilds them, so it can be re-run. Nothing is scheduled for today or later except
// one visit kept for the consent report, so day planning stays free to try.
// Refuses any DATABASE_URL that isn't local, like the other seeds.
//
// Usage: npm run db:seed:compliance

import { randomUUID } from 'node:crypto';
import { asc, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { addDays, dayStart, nairobiDate } from '../nairobiTime.js';
import { planDay, seededRandom } from '../planning/plan.js';
import { createDb } from './client.js';
import * as schema from './schema.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: DATABASE_URL is set some other way.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set, see backend/.env.example.');
}
if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
  throw new Error(`Refusing to seed a database that isn't obviously local: ${databaseUrl}.`);
}

const HISTORY_DAYS = 35;
const VISIT_MINUTES = 60;

// One habit per caregiver, in employee-number order. Each value is a probability per visit.
const HABITS = [
  {
    label: 'reliable',
    miss: 0.02,
    late: 0.05,
    override: 0,
    failedCheck: 0.05,
    noCheckout: 0,
    outsideCheckout: 0.02,
    skipAudio: 0.05,
    skipTask: 0.03,
  },
  {
    label: 'steady',
    miss: 0.04,
    late: 0.1,
    override: 0.02,
    failedCheck: 0.08,
    noCheckout: 0.01,
    outsideCheckout: 0.05,
    skipAudio: 0.1,
    skipTask: 0.05,
  },
  {
    label: 'often late',
    miss: 0.05,
    late: 0.4,
    override: 0.02,
    failedCheck: 0.1,
    noCheckout: 0.02,
    outsideCheckout: 0.05,
    skipAudio: 0.1,
    skipTask: 0.08,
  },
  {
    label: 'misses visits',
    miss: 0.18,
    late: 0.15,
    override: 0.04,
    failedCheck: 0.1,
    noCheckout: 0.03,
    outsideCheckout: 0.05,
    skipAudio: 0.15,
    skipTask: 0.1,
  },
  {
    label: 'location trouble',
    miss: 0.03,
    late: 0.08,
    override: 0.12,
    failedCheck: 0.3,
    noCheckout: 0.02,
    outsideCheckout: 0.08,
    skipAudio: 0.1,
    skipTask: 0.05,
  },
  {
    label: 'forgets checkout',
    miss: 0.05,
    late: 0.12,
    override: 0.03,
    failedCheck: 0.08,
    noCheckout: 0.12,
    outsideCheckout: 0.12,
    skipAudio: 0.1,
    skipTask: 0.05,
  },
  {
    label: 'skips recordings',
    miss: 0.04,
    late: 0.1,
    override: 0.02,
    failedCheck: 0.06,
    noCheckout: 0.02,
    outsideCheckout: 0.04,
    skipAudio: 0.4,
    skipTask: 0.05,
  },
  {
    label: 'skips tasks',
    miss: 0.07,
    late: 0.2,
    override: 0.03,
    failedCheck: 0.1,
    noCheckout: 0.03,
    outsideCheckout: 0.06,
    skipAudio: 0.1,
    skipTask: 0.25,
  },
  {
    label: 'reliable',
    miss: 0.02,
    late: 0.06,
    override: 0.01,
    failedCheck: 0.05,
    noCheckout: 0.01,
    outsideCheckout: 0.03,
    skipAudio: 0.08,
    skipTask: 0.04,
  },
  {
    label: 'struggling',
    miss: 0.25,
    late: 0.35,
    override: 0.06,
    failedCheck: 0.15,
    noCheckout: 0.06,
    outsideCheckout: 0.1,
    skipAudio: 0.2,
    skipTask: 0.15,
  },
];

const TASKS = [
  { title: 'Give morning medication', category: 'medication', required: true },
  { title: 'Check blood pressure', category: 'health_check', required: true },
  { title: 'Help with a short walk', category: 'mobility', required: false },
];
const FAILURE_REASONS = ['out_of_range', 'insufficient_accuracy', 'mock_location_detected'];
const TASK_SKIP_REASONS = [
  'client_declined',
  'client_unavailable',
  'equipment_unavailable',
] as const;
const AUDIO_SKIP_REASONS = [
  'dependant_declined',
  'dependant_unwell_or_asleep',
  'technical_problem',
  'other',
] as const;
const RESOLUTIONS: { outcome: schema.VisitResolutionOutcome; weight: number; note: string }[] = [
  { outcome: 'caregiver_absent', weight: 35, note: 'Caregiver did not attend and gave no notice.' },
  { outcome: 'family_cancelled', weight: 20, note: 'Family called to say they were travelling.' },
  {
    outcome: 'dependant_unavailable',
    weight: 20,
    note: 'Dependant was at a hospital appointment.',
  },
  {
    outcome: 'device_or_network_issue',
    weight: 15,
    note: 'Caregiver attended but the phone had no network.',
  },
  { outcome: 'other', weight: 10, note: 'Road closed by flooding.' },
];

const random = seededRandom(20261111);
const chance = (p: number) => random() < p;
const between = (low: number, high: number) => low + random() * (high - low);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const minutes = (instant: Date, m: number) => new Date(instant.getTime() + m * 60_000);
function weighted<T extends { weight: number }>(items: T[]): T {
  let target = random() * items.reduce((sum, item) => sum + item.weight, 0);
  for (const item of items) {
    target -= item.weight;
    if (target <= 0) {
      return item;
    }
  }
  return items[items.length - 1]!;
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createDb(pool);

// Large batches in one statement, kept under Postgres's 65,535 parameter limit.
async function insertAll<T extends Parameters<typeof db.insert>[0]>(
  table: T,
  rows: T['$inferInsert'][],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 400) {
    await db.insert(table).values(rows.slice(i, i + 400));
  }
}

async function main() {
  const supervisor = (
    await db
      .select()
      .from(schema.users)
      .where(sql`${schema.users.role} = 'supervisor'`)
      .limit(1)
  )[0];
  const caregivers = await db
    .select({
      id: schema.caregivers.userId,
      baseLat: schema.caregivers.baseLat,
      baseLng: schema.caregivers.baseLng,
    })
    .from(schema.caregivers)
    .orderBy(asc(schema.caregivers.employeeNumber));
  const dependants = await db
    .select({
      id: schema.dependants.id,
      lat: schema.dependants.geofenceLat,
      lng: schema.dependants.geofenceLng,
      familyId: schema.dependantFamilyMembers.familyMemberUserId,
    })
    .from(schema.dependants)
    .innerJoin(
      schema.dependantFamilyMembers,
      sql`${schema.dependantFamilyMembers.dependantId} = ${schema.dependants.id}`,
    )
    .orderBy(asc(schema.dependants.id));
  if (!supervisor || caregivers.length !== HABITS.length || dependants.length === 0) {
    throw new Error(
      'Run npm run db:seed:planning first: this adds history to the people it makes.',
    );
  }
  const supervisorId = supervisor.id;

  console.log(`Seeding compliance history into ${databaseUrl}...`);
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE visit_plans, visit_schedules, dependant_care_tasks, consent_records, terms_acceptances, audit_log CASCADE',
    ),
  );

  const today = nairobiDate(new Date());
  const firstDay = addDays(today, -HISTORY_DAYS);
  const at = (day: string, h: number, m = 0) => minutes(dayStart(day), h * 60 + m);
  const audit: (typeof schema.auditLog.$inferInsert)[] = [];
  const log = (
    createdAt: Date,
    actorUserId: string | null,
    action: string,
    entityType: string,
    entityId: string | null,
    metadata?: Record<string, unknown>,
  ) =>
    audit.push({
      createdAt,
      actorUserId,
      action,
      entityType,
      entityId,
      metadata: metadata ?? null,
    });

  // --- Consent and terms ----------------------------------------------------------------------
  // Most people have both consents. A few revoked one, so the register shows gaps.
  const consentStart = at(addDays(firstDay, -10), 10);
  const consents: (typeof schema.consentRecords.$inferInsert)[] = [];
  const grant = (
    subject: { caregiverId: string } | { dependantId: string },
    consentType: 'location_verification' | 'visit_audio' | 'voice_verification',
    grantedBy: string,
    revokedAt?: Date,
  ) => {
    const id = randomUUID();
    consents.push({
      id,
      subjectType: 'caregiverId' in subject ? 'caregiver' : 'dependant',
      ...subject,
      consentType,
      grantedBy,
      grantedAt: consentStart,
      revokedAt: revokedAt ?? null,
      revokedBy: revokedAt ? grantedBy : null,
    });
    log(consentStart, grantedBy, 'consent.grant', 'consent_record', id, { consentType });
    if (revokedAt) {
      log(revokedAt, grantedBy, 'consent.revoke', 'consent_record', id, { consentType });
    }
  };
  const locationRevokedOn = addDays(today, -10);
  const LOCATION_REVOKED = 5;
  for (const [i, c] of caregivers.entries()) {
    grant({ caregiverId: c.id }, 'location_verification', c.id);
    if (i !== 7) {
      for (const consentType of ['visit_audio', 'voice_verification'] as const) {
        grant(
          { caregiverId: c.id },
          consentType,
          c.id,
          i === 3 ? at(addDays(today, -8), 18) : undefined,
        );
      }
    }
  }
  for (const [i, d] of dependants.entries()) {
    grant(
      { dependantId: d.id },
      'location_verification',
      d.familyId,
      i === LOCATION_REVOKED ? at(locationRevokedOn, 9) : undefined,
    );
    if (i !== 20 && i !== 27) {
      for (const consentType of ['visit_audio', 'voice_verification'] as const) {
        grant(
          { dependantId: d.id },
          consentType,
          d.familyId,
          i === 2 || i === 13 ? at(addDays(today, -15), 17) : undefined,
        );
      }
    }
  }
  await insertAll(schema.consentRecords, consents);
  const audioConsent = new Map<string, Date | null>(
    consents
      .filter((c) => c.consentType === 'visit_audio')
      .map((c) => [(c.caregiverId ?? c.dependantId)!, c.revokedAt ?? null]),
  );
  const hasAudio = (id: string, when: Date) =>
    audioConsent.has(id) && (audioConsent.get(id) === null || audioConsent.get(id)! > when);

  // The current terms are version 4. Some people only accepted 3, and a few never accepted any.
  const terms: (typeof schema.termsAcceptances.$inferInsert)[] = [];
  const accept = (userId: string, document: 'caregiver' | 'family_member', versions: string[]) =>
    versions.forEach((version, v) => {
      const id = randomUUID();
      const acceptedAt = at(addDays(firstDay, version === '4' ? 5 + v : -30), 8);
      terms.push({
        id,
        userId,
        document,
        version,
        acceptedAt,
        locationConsent: true,
        audioConsent: true,
        // Version 4 added the voice box.
        voiceConsent: version === '4' ? true : null,
      });
      log(acceptedAt, userId, 'terms.accept', 'terms_acceptance', id, { document, version });
    });
  caregivers.forEach((c, i) =>
    accept(c.id, 'caregiver', i === 9 ? [] : i >= 7 ? ['3'] : ['3', '4']),
  );
  dependants.forEach((d, i) =>
    accept(d.familyId, 'family_member', i % 7 === 3 ? [] : i % 5 === 0 ? ['3'] : ['4']),
  );
  await insertAll(schema.termsAcceptances, terms);

  // --- Care tasks -----------------------------------------------------------------------------
  const tasks: (typeof schema.dependantCareTasks.$inferInsert)[] = [];
  const tasksOf = new Map<string, { id: string; required: boolean; title: string }[]>();
  for (const d of dependants) {
    const own = TASKS.map((t) => ({ ...t, id: randomUUID() }));
    tasksOf.set(d.id, own);
    for (const t of own) {
      tasks.push({ ...t, dependantId: d.id, createdBy: supervisorId, createdAt: consentStart });
      log(consentStart, supervisorId, 'care_task.create', 'care_task', t.id);
    }
  }
  await insertAll(schema.dependantCareTasks, tasks);

  // --- Caseloads ------------------------------------------------------------------------------
  // The planner itself decides who looks after whom, with the same timetable every weekday.
  const reference = planDay({
    stops: dependants.map((d) => ({ id: d.id, lat: d.lat, lng: d.lng })),
    caregivers: caregivers.map((c) => ({ id: c.id, base: { lat: c.baseLat!, lng: c.baseLng! } })),
    shiftStart: at(today, 8),
    shiftEnd: at(today, 18),
    visitMinutes: VISIT_MINUTES,
  });
  const dependantById = new Map(dependants.map((d, i) => [d.id, { ...d, index: i }]));
  const habitOf = new Map(caregivers.map((c, i) => [c.id, HABITS[i]!]));

  // --- Visits ---------------------------------------------------------------------------------
  const visits: (typeof schema.visitSchedules.$inferInsert)[] = [];
  const events: (typeof schema.verificationEvents.$inferInsert)[] = [];
  const attempts: (typeof schema.verificationAttempts.$inferInsert)[] = [];
  const audio: (typeof schema.audioRecords.$inferInsert)[] = [];
  const completions: (typeof schema.visitTaskCompletions.$inferInsert)[] = [];
  const notifications: (typeof schema.notificationLog.$inferInsert)[] = [];
  const resolutions: (typeof schema.visitResolutions.$inferInsert)[] = [];
  const cases: (typeof schema.visitRecoveryCases.$inferInsert)[] = [];
  const offers: (typeof schema.visitRecoveryOffers.$inferInsert)[] = [];

  // A visit that happened: check-in, checks, checkout, recording and tasks.
  function attend(
    visitId: string,
    caregiverId: string,
    dependantId: string,
    start: Date,
    habit: (typeof HABITS)[number],
  ): 'completed' | 'in_progress' {
    const dependant = dependantById.get(dependantId)!;
    const late = chance(habit.late);
    const checkinAt = minutes(start, late ? between(16, 55) : between(-5, 12));
    const override = chance(habit.override);
    const failures = override ? 1 + Math.floor(random() * 2) : chance(habit.failedCheck) ? 1 : 0;
    for (let f = 0; f < failures; f += 1) {
      attempts.push({
        visitScheduleId: visitId,
        attemptType: 'geofence',
        passed: false,
        failureReason: override ? 'out_of_range' : pick(FAILURE_REASONS),
        attemptedAt: minutes(checkinAt, -(failures - f) * 2),
      });
    }
    if (!override) {
      attempts.push(
        ...(['geofence', 'family_location', 'qr_scan'] as const).map((attemptType, k) => ({
          visitScheduleId: visitId,
          attemptType,
          passed: true,
          attemptedAt: minutes(checkinAt, k * 0.5 - 1),
        })),
      );
    }
    const checkedOut = !chance(habit.noCheckout);
    const checkoutAt = checkedOut ? minutes(checkinAt, between(40, 65)) : null;
    const audioAllowed = hasAudio(caregiverId, start) && hasAudio(dependantId, start);
    const skipAudio = audioAllowed && checkedOut && chance(habit.skipAudio);
    const skipReason = skipAudio ? pick(AUDIO_SKIP_REASONS) : null;
    events.push({
      visitScheduleId: visitId,
      checkinAt,
      checkoutAt,
      checkinGpsLat: dependant.lat,
      checkinGpsLng: dependant.lng,
      distanceFromGeofenceMeters: override ? between(140, 400) : between(4, 70),
      checkoutDistanceFromGeofenceMeters: checkedOut
        ? chance(habit.outsideCheckout)
          ? between(130, 450)
          : between(3, 60)
        : null,
      checkinMethod: override ? 'supervisor_override' : 'qr',
      qrFamilyMemberUserId: override ? null : dependant.familyId,
      familyDistanceFromGeofenceMeters: override ? null : between(2, 40),
      audioSkipReason: skipReason,
      audioSkipNote: skipReason === 'other' ? 'Too much noise from building works.' : null,
      // Confirmed with the family's code, or now and then overridden with a reason (0019).
      ...(checkoutAt
        ? chance(0.08)
          ? {
              checkoutRequestedAt: minutes(checkoutAt, -3),
              checkoutMethod: 'override' as const,
              checkoutOverrideReason: 'family_phone_unavailable' as const,
            }
          : {
              checkoutRequestedAt: minutes(checkoutAt, -3),
              checkoutMethod: 'qr' as const,
              checkoutFamilyMemberUserId: dependant.familyId,
              checkoutFamilyDistanceMeters: between(2, 30),
            }
        : {}),
    });
    log(checkinAt, caregiverId, 'visit.checkin', 'visit_schedule', visitId, {
      method: override ? 'supervisor_override' : 'qr',
    });
    if (!checkoutAt) {
      return 'in_progress';
    }
    // Two recordings per visit since 0019: the caregiver's, and the dependant's unless skipped.
    if (audioAllowed) {
      for (const role of skipAudio
        ? (['caregiver'] as const)
        : (['caregiver', 'dependant'] as const)) {
        audio.push({
          verificationEventId: visitId,
          role,
          s3Key: `${visitId}/${role}/${randomUUID()}.m4a`,
          durationSeconds: role === 'caregiver' ? 15 : 22,
          uploadedAt: minutes(checkoutAt, -4),
        });
        log(minutes(checkoutAt, -4), caregiverId, 'visit_audio.upload', 'visit_schedule', visitId, {
          role,
        });
      }
    }
    for (const task of tasksOf.get(dependantId)!) {
      const status = task.required
        ? chance(habit.skipTask)
          ? 'not_completed'
          : 'completed'
        : chance(0.6)
          ? 'completed'
          : 'not_applicable';
      completions.push({
        visitScheduleId: visitId,
        careTaskId: task.id,
        status,
        reason: status === 'not_completed' ? pick(TASK_SKIP_REASONS) : null,
        completedAt: minutes(checkinAt, between(10, 35)),
      });
    }
    log(minutes(checkoutAt, -2), caregiverId, 'visit_task.record', 'visit_schedule', visitId);
    log(checkoutAt, caregiverId, 'visit.checkout', 'visit_schedule', visitId);
    return 'completed';
  }

  for (let day = firstDay; day < today; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    const dayOffset = dayStart(day).getTime() - dayStart(today).getTime();
    const age = HISTORY_DAYS - (Date.parse(day) - Date.parse(firstDay)) / 86_400_000;
    // When each caregiver is free again, so a cover visit goes after their own (visits can't overlap).
    const freeFrom = new Map(
      reference.routes.map((r) => [
        r.caregiverId,
        minutes(new Date(r.stops.at(-1)!.scheduledEnd.getTime() + dayOffset), 30),
      ]),
    );
    for (const route of reference.routes) {
      const habit = habitOf.get(route.caregiverId)!;
      for (const stop of route.stops) {
        const dependant = dependantById.get(stop.id)!;
        if (dependant.index === LOCATION_REVOKED && day >= locationRevokedOn) {
          continue;
        }
        const id = randomUUID();
        const start = new Date(stop.scheduledStart.getTime() + dayOffset);
        const end = minutes(start, VISIT_MINUTES);
        const visit = {
          id,
          caregiverId: route.caregiverId,
          dependantId: stop.id,
          scheduledStart: start,
          scheduledEnd: end,
          status: 'scheduled',
          createdBy: supervisorId,
          createdAt: minutes(start, -24 * 60),
        };
        visits.push(visit);
        log(visit.createdAt, supervisorId, 'visit_schedule.create', 'visit_schedule', id);

        if (chance(0.03)) {
          visit.status = 'cancelled';
          log(minutes(start, -180), supervisorId, 'visit_schedule.update', 'visit_schedule', id, {
            status: 'cancelled',
          });
          continue;
        }
        if (!chance(habit.miss)) {
          visit.status = attend(id, route.caregiverId, stop.id, start, habit);
          continue;
        }

        // A miss. Sometimes another caregiver takes it over; otherwise a supervisor follows up.
        if (chance(0.35)) {
          const caseId = randomUUID();
          const others = reference.routes.filter((r) => r.caregiverId !== route.caregiverId);
          const [first, second] = [pick(others), pick(others)];
          const offeredAt = minutes(start, 20);
          const covered = chance(0.7) && second.caregiverId !== first.caregiverId;
          offers.push({
            caseId,
            caregiverId: first.caregiverId,
            rank: 1,
            distanceMeters: between(1500, 6000),
            proposedStart: minutes(start, 75),
            proposedEnd: minutes(start, 75 + VISIT_MINUTES),
            ...(chance(0.5)
              ? { status: 'declined', respondedAt: minutes(offeredAt, between(2, 12)) }
              : { status: 'expired' }),
            offeredAt,
            expiresAt: minutes(offeredAt, 15),
          });
          log(offeredAt, null, 'visit_recovery.offer', 'visit_schedule', id);
          if (covered) {
            const replacementId = randomUUID();
            const coverStart = new Date(
              Math.max(minutes(start, 90).getTime(), freeFrom.get(second.caregiverId)!.getTime()),
            );
            freeFrom.set(second.caregiverId, minutes(coverStart, VISIT_MINUTES + 30));
            offers.push({
              caseId,
              caregiverId: second.caregiverId,
              rank: 2,
              distanceMeters: between(2000, 8000),
              proposedStart: coverStart,
              proposedEnd: minutes(coverStart, VISIT_MINUTES),
              status: 'accepted',
              offeredAt: minutes(offeredAt, 15),
              expiresAt: minutes(offeredAt, 30),
              respondedAt: minutes(offeredAt, between(17, 28)),
            });
            const replacement = {
              id: replacementId,
              caregiverId: second.caregiverId,
              dependantId: stop.id,
              scheduledStart: coverStart,
              scheduledEnd: minutes(coverStart, VISIT_MINUTES),
              status: 'scheduled',
              createdBy: supervisorId,
              recoveredFromVisitId: id,
              createdAt: minutes(offeredAt, 20),
            };
            visits.push(replacement);
            replacement.status = attend(
              replacementId,
              second.caregiverId,
              stop.id,
              coverStart,
              HABITS[0]!,
            );
            visit.status = 'reassigned';
            cases.push({
              id: caseId,
              visitScheduleId: id,
              status: 'recovered',
              replacementVisitId: replacementId,
              openedAt: offeredAt,
              closedAt: minutes(offeredAt, 25),
            });
            log(
              minutes(offeredAt, 22),
              second.caregiverId,
              'visit_recovery.accept',
              'visit_schedule',
              id,
            );
            continue;
          }
          cases.push({
            id: caseId,
            visitScheduleId: id,
            status: 'exhausted',
            openedAt: offeredAt,
            closedAt: minutes(offeredAt, 30),
          });
        }

        visit.status = 'missed';
        log(minutes(end, 5), null, 'visit_schedule.mark_missed', 'visit_schedule', id);
        const notificationId = randomUUID();
        const sentAt = minutes(end, 5);
        // Older alerts have nearly all been seen; the last four days' are still waiting.
        const acknowledged = age > 4 && chance(0.92);
        const acknowledgedAt = acknowledged ? minutes(sentAt, 4 + random() ** 2 * 300) : null;
        notifications.push({
          id: notificationId,
          type: 'missed_visit',
          visitScheduleId: id,
          recipientUserId: supervisorId,
          channel: 'sms',
          sentAt,
          acknowledgedAt,
          acknowledgedBy: acknowledged ? supervisorId : null,
        });
        if (acknowledgedAt) {
          log(
            acknowledgedAt,
            supervisorId,
            'notification.acknowledge',
            'notification',
            notificationId,
          );
          if (age > 2 && chance(0.75)) {
            const resolution = weighted(RESOLUTIONS);
            const resolvedAt = minutes(acknowledgedAt, between(30, 600));
            resolutions.push({
              visitScheduleId: id,
              outcome: resolution.outcome,
              note: resolution.note,
              resolvedBy: supervisorId,
              resolvedAt,
            });
            visit.status = 'investigated';
            log(resolvedAt, supervisorId, 'visit.resolve', 'visit_schedule', id, {
              outcome: resolution.outcome,
            });
          }
        }
      }
    }
  }

  // Booked before this dependant's location consent was revoked, so it can't be verified.
  const revoked = dependants[LOCATION_REVOKED]!;
  const owner = reference.routes.find((r) => r.stops.some((s) => s.id === revoked.id))!;
  const bookedId = randomUUID();
  visits.push({
    id: bookedId,
    caregiverId: owner.caregiverId,
    dependantId: revoked.id,
    scheduledStart: at(addDays(today, 3), 10),
    scheduledEnd: at(addDays(today, 3), 11),
    status: 'scheduled',
    createdBy: supervisorId,
    createdAt: at(addDays(locationRevokedOn, -2), 15),
  });

  // A supervisor's own activity: listening to recordings, viewing checks, exporting reports.
  for (const visit of visits.filter(() => chance(0.04))) {
    log(
      minutes(visit.scheduledEnd, 240),
      supervisorId,
      pick(['verification.view', 'visit_audio.listen']),
      'visit_schedule',
      visit.id!,
    );
  }
  for (const report of ['visit-summary', 'consents', 'caregiver-performance']) {
    log(at(addDays(today, -3), 16), supervisorId, 'compliance.export', 'compliance_report', null, {
      report,
    });
  }

  await insertAll(schema.visitSchedules, visits);
  await insertAll(schema.verificationEvents, events);
  await insertAll(schema.verificationAttempts, attempts);
  await insertAll(schema.audioRecords, audio);
  await insertAll(schema.visitTaskCompletions, completions);
  await insertAll(schema.notificationLog, notifications);
  await insertAll(schema.visitResolutions, resolutions);
  await insertAll(schema.visitRecoveryCases, cases);
  await insertAll(schema.visitRecoveryOffers, offers);
  await insertAll(schema.auditLog, audit);

  const count = (status: string) => visits.filter((v) => v.status === status).length;
  console.log(
    `Seed complete: ${visits.length} visits from ${firstDay} (completed ${count('completed')}, missed ${count('missed')}, investigated ${count('investigated')}, reassigned ${count('reassigned')}, cancelled ${count('cancelled')}, no checkout ${count('in_progress')}), ${notifications.length} alerts, ${audit.length} audit entries.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
