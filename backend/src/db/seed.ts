// Local dev seed script (Linear HEZ-13). Populates DATABASE_URL with realistic sample data:
// a supervisor, three caregivers, three family members, three dependants, and a spread of visit
// schedules (completed, in-progress, missed, cancelled, scheduled) with their verification
// attempts, consent records, a visit recording, and notifications.
//
// Idempotent: truncates every table first, so it's safe to re-run. Refuses to run against
// anything that isn't obviously a local database, as a guard against ever pointing this at a real
// deployed one by accident.
//
// Usage: npm run db:seed

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createDb } from './client.js';
import * as schema from './schema.js';

try {
  // Same file drizzle-kit and vitest already auto-load - see vitest.setup.ts's comment.
  process.loadEnvFile();
} catch {
  // No .env file present - fine, DATABASE_URL is presumably set some other way.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set - see backend/.env.example.');
}
if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
  throw new Error(
    `Refusing to seed a database that isn't obviously local: ${databaseUrl}. This script truncates every table first.`,
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createDb(pool);

const ALL_TABLES = [
  'users',
  'caregivers',
  'dependants',
  'dependant_family_members',
  'dependant_care_tasks',
  'visit_plans',
  'visit_plan_clusters',
  'visit_schedules',
  'visit_recovery_cases',
  'visit_recovery_offers',
  'visit_task_completions',
  'verification_events',
  'verification_attempts',
  'checkin_qr_tokens',
  'checkin_override_requests',
  'visit_resolutions',
  'voice_checks',
  'voice_enrollments',
  'audio_records',
  'consent_records',
  'terms_acceptances',
  'family_link_requests',
  'notification_log',
  'audit_log',
] as const;

function daysFromNow(days: number, hour = 9, minute = 0): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

function placeholderS3Key(prefix: string): string {
  return `${prefix}/${randomUUID()}.m4a`;
}

async function main() {
  console.log(`Seeding ${databaseUrl}...`);
  await db.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLES.join(', ')} CASCADE`));

  // --- Users -----------------------------------------------------------------------------

  const [supervisor] = await db
    .insert(schema.users)
    .values({
      cognitoSub: `seed-supervisor-${randomUUID()}`,
      email: 'supervisor@mzazicare.test',
      fullName: 'Jane Njoroge',
      role: 'supervisor',
    })
    .returning();

  const caregiverNames = ['Alice Wanjiru', 'Brian Otieno', 'Grace Achieng'];
  const caregiverUsers: (typeof schema.users.$inferSelect)[] = [];
  for (const [i, fullName] of caregiverNames.entries()) {
    const [user] = await db
      .insert(schema.users)
      .values({
        cognitoSub: `seed-caregiver-${i}-${randomUUID()}`,
        phoneNumber: `+25470000010${i}`,
        fullName,
        role: 'caregiver',
      })
      .returning();
    caregiverUsers.push(user!);
  }
  const caregivers = [];
  for (const [i, user] of caregiverUsers.entries()) {
    const [caregiver] = await db
      .insert(schema.caregivers)
      .values({
        userId: user.id,
        employeeNumber: `EMP-00${i + 1}`,
        hireDate: '2024-01-15',
        // Spread across Nairobi, so a seeded day plan has something to work with.
        baseLat: -1.27 - i * 0.02,
        baseLng: 36.78 + i * 0.04,
        baseAreaText: ['Westlands', 'Kilimani', 'Embakasi'][i],
      })
      .returning();
    caregivers.push(caregiver!);
  }

  const familyMemberNames = ['David Mwangi', 'Susan Kamau', 'Peter Odhiambo'];
  const familyMemberUsers: (typeof schema.users.$inferSelect)[] = [];
  for (const [i, fullName] of familyMemberNames.entries()) {
    const [user] = await db
      .insert(schema.users)
      .values({
        cognitoSub: `seed-family-${i}-${randomUUID()}`,
        phoneNumber: `+25470000020${i}`,
        fullName,
        role: 'family_member',
      })
      .returning();
    familyMemberUsers.push(user!);
  }

  // --- Dependants --------------------------------------------------------------------------

  const dependantSeeds = [
    {
      fullName: 'Margaret Wambui',
      dob: '1945-03-12',
      gender: 'female' as const,
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
    },
    {
      fullName: 'John Kariuki',
      dob: '1950-07-22',
      gender: 'male' as const,
      geofenceLat: -4.0435,
      geofenceLng: 39.6682,
    },
    {
      fullName: 'Elizabeth Njeri',
      dob: '1938-11-05',
      gender: 'female' as const,
      geofenceLat: -0.0917,
      geofenceLng: 34.768,
    },
  ];
  const dependants = [];
  for (const [i, seed] of dependantSeeds.entries()) {
    const [dependant] = await db
      .insert(schema.dependants)
      .values({
        fullName: seed.fullName,
        dob: seed.dob,
        gender: seed.gender,
        geofenceLat: seed.geofenceLat,
        geofenceLng: seed.geofenceLng,
        geofenceRadiusMeters: 100,
        registeredBy: familyMemberUsers[i]!.id,
      })
      .returning();
    dependants.push(dependant!);

    await db.insert(schema.dependantFamilyMembers).values({
      dependantId: dependant!.id,
      familyMemberUserId: familyMemberUsers[i]!.id,
      relationship: 'child',
      isPrimaryContact: true,
      addedBy: familyMemberUsers[i]!.id,
    });
  }

  // --- Consent records ---------------------------------------------------------------------
  // Location for everyone; visit audio and voice checks for all but the second dependant, so that
  // visit shows the no-consent path (no recorder for them, nothing of theirs required at checkout).

  for (const [i, caregiver] of caregivers.entries()) {
    await db.insert(schema.consentRecords).values(
      (['location_verification', 'visit_audio', 'voice_verification'] as const).map(
        (consentType) => ({
          subjectType: 'caregiver' as const,
          caregiverId: caregiver.userId,
          consentType,
          grantedBy: caregiverUsers[i]!.id,
        }),
      ),
    );
  }
  for (const [i, dependant] of dependants.entries()) {
    const consentTypes =
      i === 1
        ? (['location_verification'] as const)
        : (['location_verification', 'visit_audio', 'voice_verification'] as const);
    await db.insert(schema.consentRecords).values(
      consentTypes.map((consentType) => ({
        subjectType: 'dependant' as const,
        dependantId: dependant.id,
        consentType,
        grantedBy: familyMemberUsers[i]!.id,
      })),
    );
  }

  // --- Visit schedules, spread across statuses ---------------------------------------------

  // Completed, 3 days ago: caregiver[0] + dependant[0] (audio consent -> has a recording).
  const [completedVisit] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId: caregivers[0]!.userId,
      dependantId: dependants[0]!.id,
      scheduledStart: daysFromNow(-3, 9, 0),
      scheduledEnd: daysFromNow(-3, 10, 0),
      status: 'completed',
      createdBy: supervisor!.id,
    })
    .returning();

  await db.insert(schema.verificationAttempts).values([
    {
      visitScheduleId: completedVisit!.id,
      attemptType: 'geofence',
      passed: true,
      attemptedAt: daysFromNow(-3, 9, 1),
    },
    {
      visitScheduleId: completedVisit!.id,
      attemptType: 'family_location',
      passed: true,
      attemptedAt: daysFromNow(-3, 9, 2),
    },
    {
      visitScheduleId: completedVisit!.id,
      attemptType: 'qr_scan',
      passed: true,
      attemptedAt: daysFromNow(-3, 9, 3),
    },
  ]);

  await db.insert(schema.verificationEvents).values({
    visitScheduleId: completedVisit!.id,
    checkinAt: daysFromNow(-3, 9, 3),
    checkoutAt: daysFromNow(-3, 9, 58),
    checkinGpsLat: dependantSeeds[0]!.geofenceLat,
    checkinGpsLng: dependantSeeds[0]!.geofenceLng,
    distanceFromGeofenceMeters: 12.4,
    checkinMethod: 'qr',
    qrFamilyMemberUserId: familyMemberUsers[0]!.id,
    familyDistanceFromGeofenceMeters: 9.3,
    checkoutRequestedAt: daysFromNow(-3, 9, 56),
    checkoutMethod: 'qr',
    checkoutFamilyMemberUserId: familyMemberUsers[0]!.id,
    checkoutFamilyDistanceMeters: 7.5,
  });

  // Both voices recorded and checked against the enrolments below (placeholder voiceprints: the
  // local seed never calls the voice Lambda).
  await db.insert(schema.voiceEnrollments).values([
    {
      subjectType: 'caregiver',
      caregiverId: caregivers[0]!.userId,
      voiceprintKey: `caregiver/${caregivers[0]!.userId}/${randomUUID()}.npy`,
      speechSeconds: 29.4,
      modelRevision: 'seed',
      enrolledBy: caregiverUsers[0]!.id,
    },
    {
      subjectType: 'dependant',
      dependantId: dependants[0]!.id,
      voiceprintKey: `dependant/${dependants[0]!.id}/${randomUUID()}.npy`,
      speechSeconds: 27.8,
      modelRevision: 'seed',
      enrolledBy: familyMemberUsers[0]!.id,
    },
  ]);
  const recordings = await db
    .insert(schema.audioRecords)
    .values(
      (['caregiver', 'dependant'] as const).map((role) => ({
        verificationEventId: completedVisit!.id,
        role,
        s3Key: placeholderS3Key(`${completedVisit!.id}/${role}`),
        durationSeconds: role === 'caregiver' ? 15 : 22,
        uploadedAt: daysFromNow(-3, 9, 50),
      })),
    )
    .returning();
  await db.insert(schema.voiceChecks).values(
    recordings.map((recording, i) => ({
      audioRecordId: recording.id,
      result: 'match' as const,
      score: i === 0 ? 0.74 : 0.66,
      speechSeconds: i === 0 ? 12.1 : 17.3,
      threshold: 0.5,
      modelRevision: 'seed',
    })),
  );

  // Completed, 2 days ago: caregiver[1] + dependant[1] (no audio consent -> no recording).
  const [completedVisit2] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId: caregivers[1]!.userId,
      dependantId: dependants[1]!.id,
      scheduledStart: daysFromNow(-2, 14, 0),
      scheduledEnd: daysFromNow(-2, 15, 0),
      status: 'completed',
      createdBy: supervisor!.id,
    })
    .returning();

  await db.insert(schema.verificationAttempts).values([
    {
      visitScheduleId: completedVisit2!.id,
      attemptType: 'geofence',
      passed: true,
      attemptedAt: daysFromNow(-2, 14, 1),
    },
    {
      visitScheduleId: completedVisit2!.id,
      attemptType: 'family_location',
      passed: true,
      attemptedAt: daysFromNow(-2, 14, 2),
    },
    {
      visitScheduleId: completedVisit2!.id,
      attemptType: 'qr_scan',
      passed: true,
      attemptedAt: daysFromNow(-2, 14, 3),
    },
  ]);

  await db.insert(schema.verificationEvents).values({
    visitScheduleId: completedVisit2!.id,
    checkinAt: daysFromNow(-2, 14, 3),
    checkoutAt: daysFromNow(-2, 14, 55),
    checkinGpsLat: dependantSeeds[1]!.geofenceLat,
    checkinGpsLng: dependantSeeds[1]!.geofenceLng,
    distanceFromGeofenceMeters: 8.1,
    checkinMethod: 'qr',
    qrFamilyMemberUserId: familyMemberUsers[1]!.id,
    familyDistanceFromGeofenceMeters: 6.2,
    // Checked out without the family's code, so Compliance has a check-out override to show.
    checkoutRequestedAt: daysFromNow(-2, 14, 50),
    checkoutMethod: 'override',
    checkoutOverrideReason: 'family_phone_unavailable',
  });

  // Missed, yesterday: caregiver[2] + dependant[2] - the caregiver never attempted check-in.
  const [missedVisit] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId: caregivers[2]!.userId,
      dependantId: dependants[2]!.id,
      scheduledStart: daysFromNow(-1, 11, 0),
      scheduledEnd: daysFromNow(-1, 12, 0),
      status: 'missed',
      createdBy: supervisor!.id,
    })
    .returning();

  await db.insert(schema.notificationLog).values({
    type: 'missed_visit',
    visitScheduleId: missedVisit!.id,
    recipientUserId: supervisor!.id,
    channel: 'sms',
    sentAt: daysFromNow(-1, 12, 15),
  });

  // Cancelled: caregiver[0] + dependant[1], was scheduled for today.
  await db.insert(schema.visitSchedules).values({
    caregiverId: caregivers[0]!.userId,
    dependantId: dependants[1]!.id,
    scheduledStart: daysFromNow(0, 13, 0),
    scheduledEnd: daysFromNow(0, 14, 0),
    status: 'cancelled',
    createdBy: supervisor!.id,
  });

  // Scheduled: caregiver[1] + dependant[2], tomorrow.
  await db.insert(schema.visitSchedules).values({
    caregiverId: caregivers[1]!.userId,
    dependantId: dependants[2]!.id,
    scheduledStart: daysFromNow(1, 10, 0),
    scheduledEnd: daysFromNow(1, 11, 0),
    status: 'scheduled',
    createdBy: supervisor!.id,
  });

  // In progress: caregiver[2] + dependant[0], checked in 20 minutes ago, includes one failed
  // geofence attempt before the successful retry (realistic failure-path data).
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
  const [inProgressVisit] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId: caregivers[2]!.userId,
      dependantId: dependants[0]!.id,
      scheduledStart: new Date(Date.now() - 30 * 60 * 1000),
      scheduledEnd: new Date(Date.now() + 30 * 60 * 1000),
      status: 'in_progress',
      createdBy: supervisor!.id,
    })
    .returning();

  await db.insert(schema.verificationAttempts).values([
    {
      visitScheduleId: inProgressVisit!.id,
      attemptType: 'geofence',
      passed: false,
      failureReason: 'accuracy_too_low',
      attemptedAt: new Date(twentyMinutesAgo.getTime() - 60_000),
    },
    {
      visitScheduleId: inProgressVisit!.id,
      attemptType: 'geofence',
      passed: true,
      attemptedAt: twentyMinutesAgo,
    },
    {
      visitScheduleId: inProgressVisit!.id,
      attemptType: 'family_location',
      passed: true,
      attemptedAt: new Date(twentyMinutesAgo.getTime() + 60_000),
    },
    {
      visitScheduleId: inProgressVisit!.id,
      attemptType: 'qr_scan',
      passed: true,
      attemptedAt: new Date(twentyMinutesAgo.getTime() + 120_000),
    },
  ]);

  await db.insert(schema.verificationEvents).values({
    visitScheduleId: inProgressVisit!.id,
    checkinAt: new Date(twentyMinutesAgo.getTime() + 120_000),
    checkinGpsLat: dependantSeeds[0]!.geofenceLat,
    checkinGpsLng: dependantSeeds[0]!.geofenceLng,
    distanceFromGeofenceMeters: 15.7,
    checkinMethod: 'qr',
    qrFamilyMemberUserId: familyMemberUsers[0]!.id,
    familyDistanceFromGeofenceMeters: 11.8,
  });

  console.log('Seed complete:');
  console.log(
    `  1 supervisor, ${caregivers.length} caregivers, ${familyMemberUsers.length} family members, ${dependants.length} dependants`,
  );
  console.log('  6 visit_schedules: completed x2, missed, cancelled, scheduled, in_progress');
  console.log('  Consent records, verification attempts/events, 1 visit recording, 1 notification');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
