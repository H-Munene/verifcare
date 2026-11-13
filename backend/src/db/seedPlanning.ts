// Local planning seed: 10 caregivers and 30 dependants spread across Nairobi, every one with
// location consent and a home position, so a day plan made in the web console has real clusters to
// show. Your supervisor accounts are copied from the Cognito pool so you can sign in against it.
//
// Empties every table first and refuses any DATABASE_URL that isn't local, like seed.ts.
//
// Usage: npm run db:seed:planning

import {
  ListUsersCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserType } from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { seededRandom } from '../planning/plan.js';
import { createDb } from './client.js';
import * as schema from './schema.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: DATABASE_URL and USER_POOL_ID are set some other way.
}

const databaseUrl = process.env.DATABASE_URL;
const userPoolId = process.env.USER_POOL_ID;
if (!databaseUrl || !userPoolId) {
  throw new Error('DATABASE_URL and USER_POOL_ID must be set, see backend/.env.example.');
}
if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
  throw new Error(`Refusing to seed a database that isn't obviously local: ${databaseUrl}.`);
}

// Rough centres of Nairobi areas. Dependant counts are uneven on purpose, so the plan has to
// balance workloads rather than give each area its own caregiver.
const AREAS = [
  { name: 'Westlands', lat: -1.2675, lng: 36.8108, dependants: 6 },
  { name: 'Kilimani', lat: -1.29, lng: 36.784, dependants: 5 },
  { name: 'Langata', lat: -1.336, lng: 36.778, dependants: 3 },
  { name: 'Embakasi', lat: -1.32, lng: 36.9, dependants: 5 },
  { name: 'Kasarani', lat: -1.221, lng: 36.897, dependants: 4 },
  { name: 'Eastleigh', lat: -1.274, lng: 36.851, dependants: 3 },
  { name: 'Ruaka', lat: -1.205, lng: 36.779, dependants: 2 },
  { name: 'South B', lat: -1.31, lng: 36.835, dependants: 2 },
  { name: 'Donholm', lat: -1.296, lng: 36.89, dependants: 0 },
  { name: 'Kileleshwa', lat: -1.278, lng: 36.783, dependants: 0 },
];

const FAMILY_NAMES = [
  'Wanjiru',
  'Otieno',
  'Achieng',
  'Kamau',
  'Njeri',
  'Mwangi',
  'Atieno',
  'Kiptoo',
  'Wairimu',
  'Omondi',
  'Chebet',
  'Mutua',
  'Nyambura',
  'Kipchoge',
  'Akinyi',
];
const GIVEN_NAMES = [
  'Mary',
  'Joseph',
  'Grace',
  'Peter',
  'Ruth',
  'James',
  'Esther',
  'John',
  'Lucy',
  'Daniel',
  'Agnes',
  'Samuel',
  'Faith',
  'David',
  'Mercy',
];

const random = seededRandom(20261110);
// About 900 m either way, so homes in one area aren't stacked on one point.
const jitter = () => (random() - 0.5) * 0.016;
// Person k gets given name k % 15 and a family name shifted by k / 15, so no two of the first 225
// people share a full name. Dependants are 0-29, caregivers 30-39, family members 40-69.
const nameAt = (k: number) =>
  `${GIVEN_NAMES[k % GIVEN_NAMES.length]} ${FAMILY_NAMES[(k + Math.floor(k / GIVEN_NAMES.length)) % FAMILY_NAMES.length]}`;
// GIVEN_NAMES alternates female, male, starting female.
const genderAt = (k: number) => ((k % GIVEN_NAMES.length) % 2 === 0 ? 'female' : 'male');
const attribute = (user: UserType, name: string) =>
  user.Attributes?.find((a) => a.Name === name)?.Value;

async function cognitoSupervisors(): Promise<UserType[]> {
  const client = new CognitoIdentityProviderClient({ region: userPoolId!.split('_')[0] });
  const users: UserType[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListUsersCommand({ UserPoolId: userPoolId, PaginationToken: token }),
    );
    users.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token);
  return users.filter((u) => attribute(u, 'custom:role') === 'supervisor');
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createDb(pool);

async function main() {
  const supervisorAccounts = await cognitoSupervisors();
  if (supervisorAccounts.length === 0) {
    throw new Error(`No supervisor accounts in ${userPoolId}, so nobody could sign in to plan.`);
  }

  console.log(`Seeding ${databaseUrl}...`);
  const tables = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`),
  );

  const supervisors = await db
    .insert(schema.users)
    .values(
      supervisorAccounts.map((u) => ({
        cognitoSub: attribute(u, 'sub')!,
        email: attribute(u, 'email') ?? null,
        fullName: attribute(u, 'name') ?? attribute(u, 'email') ?? 'Supervisor',
        role: 'supervisor',
      })),
    )
    .returning();
  const supervisorId = supervisors[0]!.id;

  for (const [i, area] of AREAS.entries()) {
    const [user] = await db
      .insert(schema.users)
      .values({
        cognitoSub: `seed-caregiver-${randomUUID()}`,
        phoneNumber: `+2547000001${String(i).padStart(2, '0')}`,
        fullName: nameAt(30 + i),
        role: 'caregiver',
      })
      .returning();
    await db.insert(schema.caregivers).values({
      userId: user!.id,
      dob: `19${80 + i}-0${(i % 9) + 1}-15`,
      gender: genderAt(30 + i),
      occupation: (['nurse', 'community_health_worker', 'caregiver'] as const)[i % 3],
      baseLat: area.lat + jitter(),
      baseLng: area.lng + jitter(),
      baseAreaText: area.name,
    });
    await db.insert(schema.consentRecords).values({
      subjectType: 'caregiver',
      caregiverId: user!.id,
      consentType: 'location_verification',
      grantedBy: user!.id,
    });
  }

  let n = 0;
  for (const area of AREAS) {
    for (let j = 0; j < area.dependants; j += 1, n += 1) {
      const [family] = await db
        .insert(schema.users)
        .values({
          cognitoSub: `seed-family-${randomUUID()}`,
          phoneNumber: `+2547000002${String(n).padStart(2, '0')}`,
          fullName: nameAt(40 + n),
          role: 'family_member',
        })
        .returning();
      const [dependant] = await db
        .insert(schema.dependants)
        .values({
          fullName: nameAt(n),
          dob: `19${40 + (n % 20)}-0${(n % 9) + 1}-10`,
          gender: genderAt(n),
          homeAddressText: area.name,
          county: 'Nairobi',
          geofenceLat: area.lat + jitter(),
          geofenceLng: area.lng + jitter(),
          geofenceRadiusMeters: 100,
          registeredBy: supervisorId,
        })
        .returning();
      await db.insert(schema.dependantFamilyMembers).values({
        dependantId: dependant!.id,
        familyMemberUserId: family!.id,
        relationship: 'child',
        isPrimaryContact: true,
        addedBy: supervisorId,
      });
      await db.insert(schema.consentRecords).values({
        subjectType: 'dependant',
        dependantId: dependant!.id,
        consentType: 'location_verification',
        grantedBy: family!.id,
      });
    }
  }

  console.log(
    `Seed complete: ${supervisors.length} supervisor(s) from Cognito, ${AREAS.length} caregivers, ${n} dependants.`,
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
