// POST/GET /caregivers, GET/PATCH /caregivers/{caregiverId}, GET /caregivers/cognito-lookup
// (HEZ-29, HEZ-54). Every endpoint here is supervisor-only (confirmed with the user before
// implementing) - architecture.md frames caregiver registration as a supervisor action, unlike
// family_member/supervisor self-signup, and nothing currently needs a caregiver to self-view or
// self-edit their own record. Adding that later is a small, additive change (one requireRole call
// becoming an ownership check, the same shape routes/users.ts already has) once the caregiver
// mobile app actually needs it - not built ahead of that real need.
//
// caregivers is a 1:1 shared-PK extension of users (caregivers.userId === users.id), so every
// response here is a join, and POST /caregivers creates both rows in one transaction.
//
// GET /caregivers/cognito-lookup (2026-09-22, HEZ-54) exists because POST /caregivers requires an
// already-existing cognitoSub, and there's no caregiver self-signup flow anywhere in this product
// yet (HEZ-63/64 still Backlog) - a supervisor registering a caregiver needs a way to resolve
// "this caregiver's email" into their Cognito sub first. Registered before the /:caregiverId
// routes below, not after - Express matches routes in registration order, and /:caregiverId would
// otherwise swallow "cognito-lookup" as a (invalid) caregiverId value.

import { and, asc, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import type { BiometricFaceCollection } from '../db/biometricFaceCollection.js';
import { cleanupBiometricEnrollmentsForSubject } from '../db/biometricOffboarding.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface CaregiversRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  requireAuth: RequestHandler;
  // Optional so existing callers/tests that don't touch biometric enrollment at all (most of them)
  // don't need to construct one - offboarding cleanup (HEZ-85) is simply skipped without it.
  faceCollection?: BiometricFaceCollection;
}

interface CaregiverResponse {
  userId: string;
  fullName: string;
  email: string | null;
  phoneNumber: string | null;
  idType: 'national_id' | 'passport' | null;
  idNumber: string | null;
  dob: string | null;
  gender: 'male' | 'female' | null;
  occupation: 'nurse' | 'community_health_worker' | 'caregiver' | null;
  // Auto-generated at registration (HEZ-54), not supervisor-entered - see schema.ts's own comments
  // on caregivers.employeeNumber/hireDate for why. Still returned here since a supervisor may need
  // to see or later correct one via PATCH.
  employeeNumber: string | null;
  hireDate: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Registration now collects a caregiver's own personal/professional details (2026-09-22, HEZ-54,
// confirmed with the user) - employeeNumber/hireDate are deliberately absent here (DB-generated,
// see schema.ts), unlike updateCaregiverRequestSchema below where a supervisor may still want to
// correct either by hand later.
const createCaregiverRequestSchema = z.object({
  cognitoSub: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
  phoneNumber: z.string().min(1),
  idType: z.enum(['national_id', 'passport']),
  idNumber: z.string().min(1),
  dob: z.string().regex(DATE_ONLY, 'dob must be YYYY-MM-DD'),
  gender: z.enum(['male', 'female']),
  occupation: z.enum(['nurse', 'community_health_worker', 'caregiver']),
});

const updateCaregiverRequestSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  idType: z.enum(['national_id', 'passport']).optional(),
  idNumber: z.string().min(1).optional(),
  dob: z.string().regex(DATE_ONLY, 'dob must be YYYY-MM-DD').optional(),
  gender: z.enum(['male', 'female']).optional(),
  occupation: z.enum(['nurse', 'community_health_worker', 'caregiver']).optional(),
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

const cognitoLookupQuerySchema = z.object({
  email: z.string().email(),
});

function caregiverSelection() {
  return {
    userId: schema.caregivers.userId,
    fullName: schema.users.fullName,
    email: schema.users.email,
    phoneNumber: schema.users.phoneNumber,
    idType: schema.users.idType,
    idNumber: schema.users.idNumber,
    dob: schema.caregivers.dob,
    gender: schema.caregivers.gender,
    occupation: schema.caregivers.occupation,
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
  email: string | null;
  phoneNumber: string | null;
  idType: 'national_id' | 'passport' | null;
  idNumber: string | null;
  dob: string | null;
  gender: 'male' | 'female' | null;
  occupation: 'nurse' | 'community_health_worker' | 'caregiver' | null;
  employeeNumber: string | null;
  hireDate: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CaregiverResponse {
  return {
    userId: row.userId,
    fullName: row.fullName,
    email: row.email,
    phoneNumber: row.phoneNumber,
    idType: row.idType,
    idNumber: row.idNumber,
    dob: row.dob,
    gender: row.gender,
    occupation: row.occupation,
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
  const { cognitoAdmin, requireAuth, faceCollection } = dependencies;
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
            email: body.email,
            phoneNumber: body.phoneNumber,
            fullName: body.fullName,
            idType: body.idType,
            idNumber: body.idNumber,
            role: 'caregiver',
          })
          .returning();
        if (!userRow) {
          throw new Error('Insert into users returned no row.');
        }
        // employeeNumber/hireDate are deliberately not set here - schema.ts's own DB defaults
        // generate them (a sequence-backed 'CG-0001' style number, and the actual registration
        // date), per the user's request that they be auto-assigned, not supervisor-entered.
        const [caregiverRow] = await tx
          .insert(schema.caregivers)
          .values({
            userId: userRow.id,
            dob: body.dob,
            gender: body.gender,
            occupation: body.occupation,
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
          email: result.userRow.email,
          phoneNumber: result.userRow.phoneNumber,
          idType: result.userRow.idType,
          idNumber: result.userRow.idNumber,
          dob: result.caregiverRow.dob,
          gender: result.caregiverRow.gender,
          occupation: result.caregiverRow.occupation,
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
          detail: 'A user with this cognitoSub, email, or phoneNumber already exists.',
        });
        return;
      }
      next(err);
    }
  });

  // Registered before GET /:caregiverId - see this file's header comment for why the ordering
  // matters here specifically.
  router.get('/cognito-lookup', async (req, res, next) => {
    const query = parseOrSendProblem(cognitoLookupQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    try {
      const identity = await cognitoAdmin.lookupUserByEmail(query.email);
      if (!identity) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'No Cognito user has this email.',
        });
        return;
      }
      res.status(200).json(identity);
    } catch (err) {
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
      // Split by which table each field actually lives on - email/idType/idNumber belong to
      // users, not caregivers, unlike everything else PATCH accepts.
      const { phoneNumber, fullName, email, idType, idNumber, ...caregiverFields } = body;
      const result = await db.transaction(async (tx) => {
        if (
          phoneNumber !== undefined ||
          fullName !== undefined ||
          email !== undefined ||
          idType !== undefined ||
          idNumber !== undefined
        ) {
          await tx
            .update(schema.users)
            .set({
              ...(phoneNumber !== undefined && { phoneNumber }),
              ...(fullName !== undefined && { fullName }),
              ...(email !== undefined && { email }),
              ...(idType !== undefined && { idType }),
              ...(idNumber !== undefined && { idNumber }),
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

      // Best-effort, after the transaction above has already committed - see
      // db/biometricOffboarding.ts's header comment for why this isn't inside it.
      if (body.active === false && faceCollection) {
        await cleanupBiometricEnrollmentsForSubject(db, faceCollection, 'caregiver', caregiverId);
      }

      res.status(200).json(
        toCaregiverResponse({
          userId: result.caregiverRow.userId,
          fullName: result.userRow.fullName,
          email: result.userRow.email,
          phoneNumber: result.userRow.phoneNumber,
          idType: result.userRow.idType,
          idNumber: result.userRow.idNumber,
          dob: result.caregiverRow.dob,
          gender: result.caregiverRow.gender,
          occupation: result.caregiverRow.occupation,
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
          detail: 'A user with this email, phoneNumber, or employeeNumber already exists.',
        });
        return;
      }
      next(err);
    }
  });

  return router;
}
