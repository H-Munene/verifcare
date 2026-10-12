// POST/GET /caregivers, GET/PATCH /caregivers/{caregiverId} (HEZ-29). Every endpoint here is
// supervisor-only (confirmed with the user before implementing) - architecture.md frames caregiver
// registration as a supervisor action, unlike family_member/supervisor self-signup, and nothing
// currently needs a caregiver to self-view or self-edit their own record. Adding that later is a
// small, additive change (one requireRole call becoming an ownership check, the same shape
// routes/users.ts already has) once the caregiver mobile app actually needs it - not built ahead
// of that real need.
//
// caregivers is a 1:1 shared-PK extension of users (caregivers.userId === users.id), so every
// response here is a join, and POST /caregivers creates both rows in one transaction.

import { and, asc, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface CaregiversRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  requireAuth: RequestHandler;
}

interface CaregiverResponse {
  userId: string;
  fullName: string;
  phoneNumber: string | null;
  employeeNumber: string | null;
  hireDate: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const createCaregiverRequestSchema = z.object({
  cognitoSub: z.string().min(1),
  phoneNumber: z.string().min(1),
  fullName: z.string().min(1),
  employeeNumber: z.string().min(1).optional(),
  hireDate: z.string().regex(DATE_ONLY, 'hireDate must be YYYY-MM-DD').optional(),
});

const updateCaregiverRequestSchema = z.object({
  phoneNumber: z.string().min(1).optional(),
  fullName: z.string().min(1).optional(),
  employeeNumber: z.string().min(1).optional(),
  hireDate: z.string().regex(DATE_ONLY, 'hireDate must be YYYY-MM-DD').optional(),
  active: z.boolean().optional(),
});

// Express 5's params type allows string | string[], so req.params.caregiverId isn't a plain
// string on its own - validated the same way any other input is, via parseOrSendProblem.
const caregiverIdParamSchema = z.string().uuid();

const listCaregiversQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function caregiverSelection() {
  return {
    userId: schema.caregivers.userId,
    fullName: schema.users.fullName,
    phoneNumber: schema.users.phoneNumber,
    employeeNumber: schema.caregivers.employeeNumber,
    hireDate: schema.caregivers.hireDate,
    active: schema.caregivers.active,
    createdAt: schema.caregivers.createdAt,
    updatedAt: schema.caregivers.updatedAt,
  };
}

function toCaregiverResponse(row: {
  userId: string;
  fullName: string;
  phoneNumber: string | null;
  employeeNumber: string | null;
  hireDate: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CaregiverResponse {
  return {
    userId: row.userId,
    fullName: row.fullName,
    phoneNumber: row.phoneNumber,
    employeeNumber: row.employeeNumber,
    hireDate: row.hireDate,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function getDb(res: import('express').Response): Db | undefined {
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

export function createCaregiversRouter(dependencies: CaregiversRouterDependencies): Router {
  const router = Router();
  const { cognitoAdmin, requireAuth } = dependencies;
  // Every route in this router needs the same auth (see the file header comment) - applied once
  // here rather than repeated on each route.
  router.use(requireAuth, requireRole('supervisor'));

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createCaregiverRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      // Same ordering rationale as routes/users.ts: assign the Cognito role before the DB insert,
      // so a failed insert (e.g. duplicate cognitoSub) still leaves a retry able to succeed.
      await cognitoAdmin.assignRole(body.cognitoSub, 'caregiver');

      const result = await db.transaction(async (tx) => {
        const [userRow] = await tx
          .insert(schema.users)
          .values({
            id: uuidv7(),
            cognitoSub: body.cognitoSub,
            phoneNumber: body.phoneNumber,
            fullName: body.fullName,
            role: 'caregiver',
          })
          .returning();
        if (!userRow) {
          throw new Error('Insert into users returned no row.');
        }
        const [caregiverRow] = await tx
          .insert(schema.caregivers)
          .values({
            userId: userRow.id,
            employeeNumber: body.employeeNumber,
            hireDate: body.hireDate,
          })
          .returning();
        if (!caregiverRow) {
          throw new Error('Insert into caregivers returned no row.');
        }
        return { userRow, caregiverRow };
      });

      res.status(201).json(
        toCaregiverResponse({
          userId: result.userRow.id,
          fullName: result.userRow.fullName,
          phoneNumber: result.userRow.phoneNumber,
          employeeNumber: result.caregiverRow.employeeNumber,
          hireDate: result.caregiverRow.hireDate,
          active: result.caregiverRow.active,
          createdAt: result.caregiverRow.createdAt,
          updatedAt: result.caregiverRow.updatedAt,
        }),
      );
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A user with this cognitoSub, phoneNumber, or employeeNumber already exists.',
        });
        return;
      }
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listCaregiversQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const conditions = [];
      if (query.active !== undefined) {
        conditions.push(eq(schema.caregivers.active, query.active));
      }
      if (query.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(query.cursor);
        } catch {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'Malformed cursor.',
          });
          return;
        }
        conditions.push(cursorCondition(schema.caregivers.userId, cursor));
      }

      const rows = await db
        .select(caregiverSelection())
        .from(schema.caregivers)
        .innerJoin(schema.users, eq(schema.caregivers.userId, schema.users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(schema.caregivers.userId))
        .limit(query.limit + 1);

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({ id: row.userId }));
      res.status(200).json({ items: items.map(toCaregiverResponse), nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:caregiverId', async (req, res, next) => {
    const caregiverId = parseOrSendProblem(caregiverIdParamSchema, req.params.caregiverId, res);
    if (!caregiverId) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const [row] = await db
        .select(caregiverSelection())
        .from(schema.caregivers)
        .innerJoin(schema.users, eq(schema.caregivers.userId, schema.users.id))
        .where(eq(schema.caregivers.userId, caregiverId));
      if (!row) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json(toCaregiverResponse(row));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:caregiverId', async (req, res, next) => {
    const caregiverId = parseOrSendProblem(caregiverIdParamSchema, req.params.caregiverId, res);
    if (!caregiverId) {
      return;
    }
    const body = parseOrSendProblem(updateCaregiverRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const { phoneNumber, fullName, ...caregiverFields } = body;
      const result = await db.transaction(async (tx) => {
        if (phoneNumber !== undefined || fullName !== undefined) {
          await tx
            .update(schema.users)
            .set({
              ...(phoneNumber !== undefined && { phoneNumber }),
              ...(fullName !== undefined && { fullName }),
              updatedAt: new Date(),
            })
            .where(eq(schema.users.id, caregiverId));
        }
        const [caregiverRow] = await tx
          .update(schema.caregivers)
          .set({ ...caregiverFields, updatedAt: new Date() })
          .where(eq(schema.caregivers.userId, caregiverId))
          .returning();
        if (!caregiverRow) {
          return undefined;
        }
        const [userRow] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, caregiverId));
        if (!userRow) {
          throw new Error('caregivers row exists with no matching users row.');
        }
        return { caregiverRow, userRow };
      });

      if (!result) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json(
        toCaregiverResponse({
          userId: result.caregiverRow.userId,
          fullName: result.userRow.fullName,
          phoneNumber: result.userRow.phoneNumber,
          employeeNumber: result.caregiverRow.employeeNumber,
          hireDate: result.caregiverRow.hireDate,
          active: result.caregiverRow.active,
          createdAt: result.caregiverRow.createdAt,
          updatedAt: result.caregiverRow.updatedAt,
        }),
      );
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A user with this phoneNumber or employeeNumber already exists.',
        });
        return;
      }
      next(err);
    }
  });

  return router;
}
