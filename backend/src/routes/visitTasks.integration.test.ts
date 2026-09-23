// Integration tests for GET/PUT /visit-schedules/{visitScheduleId}/tasks[/{careTaskId}]
// (docs/visit-task-checklist-plan.md) against a real local Postgres - see
// users.integration.test.ts's header comment for why, and for the test-auth-header pattern used
// here too.

import { and, eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createVisitTasksRouter } from './visitTasks.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface TaskListItem {
  careTaskId: string;
  title: string;
  required: boolean;
  status: string | null;
  reason: string | null;
}
interface ProblemBody {
  title: string;
  detail?: string;
}
function taskListBody(response: request.Response): TaskListItem[] {
  return response.body as TaskListItem[];
}
function problemBody(response: request.Response): ProblemBody {
  return response.body as ProblemBody;
}

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

  app.use('/visit-schedules', createVisitTasksRouter({ requireAuth }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

async function createTestUser(
  sub: string,
  role: UserRole,
  phoneNumber: string,
): Promise<typeof schema.users.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.users)
    .values({ cognitoSub: sub, fullName: `User ${sub}`, phoneNumber, role })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test user.');
  }
  return row;
}

async function createTestCaregiver(
  sub: string,
  phoneNumber: string,
): Promise<typeof schema.caregivers.$inferSelect> {
  const user = await createTestUser(sub, 'caregiver', phoneNumber);
  const db = getDb();
  const [row] = await db.insert(schema.caregivers).values({ userId: user.id }).returning();
  if (!row) {
    throw new Error('Failed to insert test caregiver.');
  }
  return row;
}

async function createTestDependant(
  registeredById: string,
): Promise<typeof schema.dependants.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.dependants)
    .values({
      fullName: 'Test Dependant',
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 100,
      registeredBy: registeredById,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test dependant.');
  }
  return row;
}

async function createTestVisit(
  caregiverId: string,
  dependantId: string,
  createdById: string,
  status: 'scheduled' | 'in_progress' = 'in_progress',
): Promise<typeof schema.visitSchedules.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId,
      dependantId,
      scheduledStart: new Date('2026-10-01T09:00:00Z'),
      scheduledEnd: new Date('2026-10-01T10:00:00Z'),
      status,
      createdBy: createdById,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test visit.');
  }
  return row;
}

async function createTestCareTask(
  dependantId: string,
  createdById: string,
  overrides: Partial<typeof schema.dependantCareTasks.$inferInsert> = {},
): Promise<typeof schema.dependantCareTasks.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.dependantCareTasks)
    .values({ dependantId, title: 'Assist with bathing', createdBy: createdById, ...overrides })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test care task.');
  }
  return row;
}

describe.skipIf(!hasTestDb)(
  'GET/PUT /visit-schedules/{visitScheduleId}/tasks (real Postgres)',
  () => {
    let app: Express;

    beforeAll(async () => {
      await setupTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      app = buildTestApp();
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    describe('GET .../tasks', () => {
      it("returns the dependant's active tasks, live-joined against any existing completions", async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        await createTestCareTask(dependant.id, supervisor.id, {
          title: 'Retired task',
          active: false,
        });
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/tasks`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(200);
        const body = taskListBody(response);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({ careTaskId: task.id, status: null });
      });

      it('reflects a completion already recorded this visit', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
        await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'completed' });

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/tasks`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(taskListBody(response)[0]).toMatchObject({
          careTaskId: task.id,
          status: 'completed',
        });
      });

      it("409s before check-in (visit still 'scheduled')", async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createTestVisit(
          caregiver.userId,
          dependant.id,
          supervisor.id,
          'scheduled',
        );

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/tasks`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(409);
      });

      it("403s a caregiver requesting another caregiver's visit", async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        await createTestCaregiver('cg-2', '+254700000003');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/tasks`)
          .set('x-test-auth', testAuthHeader('cg-2', 'caregiver'));

        expect(response.status).toBe(403);
      });
    });

    describe('PUT .../tasks/{careTaskId}', () => {
      it('records a completed task with no reason required', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'completed' });

        expect(response.status).toBe(200);
      });

      it('rejects not_completed with no reason (matches the DB CHECK)', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'not_completed' });

        expect(response.status).toBe(400);
        expect(problemBody(response).detail).toMatch(/reason is required/);
      });

      it('rejects a reason alongside completed', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'completed', reason: 'client_declined' });

        expect(response.status).toBe(400);
      });

      it('upserts on a second submission rather than duplicating the row', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'not_completed', reason: 'client_declined' });
        const second = await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'completed' });

        expect(second.status).toBe(200);
        const db = getDb();
        const rows = await db
          .select()
          .from(schema.visitTaskCompletions)
          .where(
            and(
              eq(schema.visitTaskCompletions.visitScheduleId, visit.id),
              eq(schema.visitTaskCompletions.careTaskId, task.id),
            ),
          );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'completed', reason: null });
      });

      it('rejects once the visit is no longer in_progress (locked after checkout)', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const task = await createTestCareTask(dependant.id, supervisor.id);
        const visit = await createTestVisit(
          caregiver.userId,
          dependant.id,
          supervisor.id,
          'scheduled',
        );

        const response = await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${task.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'completed' });

        expect(response.status).toBe(409);
      });

      it('404s a task that belongs to a different dependant', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const otherDependant = await createTestDependant(supervisor.id);
        const otherTask = await createTestCareTask(otherDependant.id, supervisor.id);
        const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .put(`/visit-schedules/${visit.id}/tasks/${otherTask.id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'completed' });

        expect(response.status).toBe(404);
      });
    });
  },
);
