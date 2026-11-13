// Server-side sorting (2026-09-26, the supervisor console's
// sortable, filterable tables), against a real local Postgres. The point is that paging a sorted
// list visits every row exactly once in order - including ties and a nullable column - and that a
// cursor made for one sort is refused on another.

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import type { AuthenticatedUser } from '../auth/verifier.js';
import { createFakeVoiceService } from '../voiceService.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createCaregiversRouter } from './caregivers.js';
import { createDependantsRouter } from './dependants.js';
import { createVisitSchedulesRouter } from './visitSchedules.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

const supervisor = Buffer.from(
  JSON.stringify({ sub: 'sup', role: 'supervisor', email: undefined } satisfies AuthenticatedUser),
).toString('base64url');

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = getDb();
  const requireAuth: express.RequestHandler = (req, res, next) => {
    const header = req.headers['x-test-auth'];
    if (typeof header !== 'string') {
      res.status(401).json({ title: 'Unauthorized' });
      return;
    }
    req.auth = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AuthenticatedUser;
    next();
  };
  // The list routes never call Cognito.
  const cognitoAdmin = {} as CognitoAdmin;
  app.use(
    '/dependants',
    createDependantsRouter({ cognitoAdmin, requireAuth, voice: createFakeVoiceService() }),
  );
  app.use(
    '/caregivers',
    createCaregiversRouter({ cognitoAdmin, requireAuth, voice: createFakeVoiceService() }),
  );
  app.use('/visit-schedules', createVisitSchedulesRouter({ requireAuth }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

describe.skipIf(!hasTestDb)('sorted and filtered lists (real Postgres)', () => {
  let app: Express;
  let supervisorId: string;

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const [row] = await getDb()
      .insert(schema.users)
      .values({
        cognitoSub: 'sup',
        fullName: 'Sarah Kimani',
        phoneNumber: '+254700000001',
        role: 'supervisor',
      })
      .returning();
    supervisorId = row!.id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  /** Every row of a list, page by page, following nextCursor. */
  async function allPages<T>(path: string, limit = 2): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const response = await request(app)
        .get(`${path}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
        .set('x-test-auth', supervisor);
      expect(response.status).toBe(200);
      const page = response.body as Page<T>;
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }

  async function addDependants(people: [string, string][]) {
    return getDb()
      .insert(schema.dependants)
      .values(
        people.map(([fullName, dob]) => ({
          fullName,
          dob,
          geofenceLat: -1.29,
          geofenceLng: 36.82,
          geofenceRadiusMeters: 20,
          registeredBy: supervisorId,
        })),
      )
      .returning();
  }

  describe('dependants', () => {
    // Two share a name and two a birthday, so the id tie-break is exercised across page edges.
    const people: [string, string][] = [
      ['Mary Njeri', '1948-03-02'],
      ['Ali Hassan', '1950-01-01'],
      ['Mary Njeri', '1939-07-15'],
      ['Esther Atieno', '1950-01-01'],
      ['Joseph Otieno', '1944-11-30'],
    ];

    it('pages through every dependant once, by name either way', async () => {
      await addDependants(people);
      type Row = { id: string; fullName: string };

      const up = await allPages<Row>('/dependants?sort=name');
      expect(up.map((d) => d.fullName)).toEqual([
        'Ali Hassan',
        'Esther Atieno',
        'Joseph Otieno',
        'Mary Njeri',
        'Mary Njeri',
      ]);
      expect(new Set(up.map((d) => d.id)).size).toBe(5);

      const down = await allPages<Row>('/dependants?sort=-name');
      expect(down.map((d) => d.id)).toEqual([...up.map((d) => d.id)].reverse());
    });

    it('sorts by date of birth', async () => {
      await addDependants(people);
      const rows = await allPages<{ dob: string }>('/dependants?sort=-dob');
      expect(rows.map((d) => d.dob)).toEqual([
        '1950-01-01',
        '1950-01-01',
        '1948-03-02',
        '1944-11-30',
        '1939-07-15',
      ]);
    });

    it('refuses a cursor from another sort', async () => {
      await addDependants(people);
      const first = await request(app)
        .get('/dependants?sort=name&limit=2')
        .set('x-test-auth', supervisor);
      const { nextCursor } = first.body as Page<unknown>;
      const response = await request(app)
        .get(`/dependants?sort=dob&limit=2&cursor=${nextCursor}`)
        .set('x-test-auth', supervisor);
      expect(response.status).toBe(400);
    });
  });

  describe('caregivers', () => {
    async function addCaregiver(fullName: string, hireDate: string | null, n: number) {
      const [user] = await getDb()
        .insert(schema.users)
        .values({
          cognitoSub: `cg-${n}`,
          fullName,
          phoneNumber: `+25471000000${n}`,
          role: 'caregiver',
        })
        .returning();
      await getDb().insert(schema.caregivers).values({ userId: user!.id, hireDate });
    }

    it('sorts by hire date, a missing one first ascending, across pages', async () => {
      await addCaregiver('Grace Achieng', '2024-05-01', 1);
      await addCaregiver('Amina Wanjiru', null, 2);
      await addCaregiver('Peter Mwangi', '2023-01-10', 3);
      await addCaregiver('Faith Chebet', '2024-05-01', 4);

      const up = await allPages<{ fullName: string; hireDate: string | null }>(
        '/caregivers?sort=hireDate',
      );
      expect(up.map((c) => c.hireDate)).toEqual([null, '2023-01-10', '2024-05-01', '2024-05-01']);

      const byName = await allPages<{ fullName: string }>('/caregivers?sort=-name');
      expect(byName.map((c) => c.fullName)).toEqual([
        'Peter Mwangi',
        'Grace Achieng',
        'Faith Chebet',
        'Amina Wanjiru',
      ]);
    });
  });

  describe('visits', () => {
    it('sorts by scheduled start, latest first, across pages', async () => {
      const [cgUser] = await getDb()
        .insert(schema.users)
        .values({
          cognitoSub: 'cg',
          fullName: 'Amina',
          phoneNumber: '+254710000009',
          role: 'caregiver',
        })
        .returning();
      await getDb().insert(schema.caregivers).values({ userId: cgUser!.id });
      const [dependant] = await addDependants([['Joseph Otieno', '1944-11-30']]);
      const starts = [
        '2026-10-03T09:00:00Z',
        '2026-10-01T09:00:00Z',
        '2026-10-05T09:00:00Z',
        '2026-10-02T09:00:00Z',
      ];
      await getDb()
        .insert(schema.visitSchedules)
        .values(
          starts.map((start) => ({
            caregiverId: cgUser!.id,
            dependantId: dependant!.id,
            scheduledStart: new Date(start),
            scheduledEnd: new Date(Date.parse(start) + 3_600_000),
            createdBy: supervisorId,
          })),
        );

      const rows = await allPages<{ scheduledStart: string }>(
        '/visit-schedules?sort=-scheduledStart',
      );
      expect(rows.map((v) => v.scheduledStart)).toEqual([
        '2026-10-05T09:00:00.000Z',
        '2026-10-03T09:00:00.000Z',
        '2026-10-02T09:00:00.000Z',
        '2026-10-01T09:00:00.000Z',
      ]);
    });
  });
});
