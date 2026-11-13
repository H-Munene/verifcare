// POST/GET /caregivers, GET/PATCH /caregivers/{caregiverId} (HEZ-29, HEZ-54). Every endpoint here
// is supervisor-only (confirmed with the user before implementing) - architecture.md frames
// caregiver registration as a supervisor action, unlike
// family_member/supervisor self-signup, and nothing currently needs a caregiver to self-view or
// self-edit their own record. Adding that later is a small, additive change (one requireRole call
// becoming an ownership check, the same shape routes/users.ts already has) once the caregiver
// mobile app actually needs it - not built ahead of that real need.
//
// caregivers is a 1:1 shared-PK extension of users (caregivers.userId === users.id), so every
// response here is a join, and POST /caregivers creates both rows in one transaction.
//
// POST /caregivers creates the Cognito identity itself (2026-09-22, HEZ-54, corrected same day -
// a caregiver never self-registers, full stop, not just "not yet") via cognitoAdmin.createUser,
// same as routes/dependants.ts's email-only family-member path - there's no caregiver self-signup
// flow (HEZ-63/64) to create that identity any other way, and there never will be one, so a
// pre-existing Cognito account can't be assumed. This replaced an earlier GET
// /caregivers/cognito-lookup endpoint that looked one up instead of creating it, built on the
// mistaken premise that a caregiver might already have a Cognito account from self-signing-up
// elsewhere.

import { and, eq, sql } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  isCognitoInvalidParameterError,
  isCognitoUserAlreadyExistsError,
  type CognitoAdmin,
} from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import { changedFields, recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { visitStatsFor } from '../db/visitStats.js';
import { sendProblem } from '../errors.js';
import {
  decodeCursor,
  keysetCondition,
  keysetOrder,
  paginate,
  resolveSort,
  type SortKey,
} from '../pagination.js';
import { E164_MESSAGE, E164_PHONE_NUMBER, parseOrSendProblem } from '../validation.js';

export interface CaregiversRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  requireAuth: RequestHandler;
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
  baseLat: number | null;
  baseLng: number | null;
  baseAreaText: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Registration now collects a caregiver's own personal/professional details (2026-09-22, HEZ-54,
// confirmed with the user) - employeeNumber/hireDate are deliberately absent here (DB-generated,
// see schema.ts), unlike updateCaregiverRequestSchema below where a supervisor may still want to
// correct either by hand later.
// Where a planned route starts. Optional so a caregiver can exist before it's known, but a caregiver
// without one is left out of day plans, and the plan says so.
const homeBaseFields = {
  baseLat: z.number().min(-90).max(90).optional(),
  baseLng: z.number().min(-180).max(180).optional(),
  baseAreaText: z.string().trim().min(1).max(200).optional(),
};

const caregiverHomeBase = (body: { baseLat?: number; baseLng?: number }) =>
  (body.baseLat === undefined) === (body.baseLng === undefined);
const HOME_BASE_MESSAGE = 'baseLat and baseLng must be given together.';

const createCaregiverRequestSchema = z
  .object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phoneNumber: z.string().regex(E164_PHONE_NUMBER, E164_MESSAGE),
    idType: z.enum(['national_id', 'passport']),
    idNumber: z.string().min(1),
    dob: z.string().regex(DATE_ONLY, 'dob must be YYYY-MM-DD'),
    gender: z.enum(['male', 'female']),
    occupation: z.enum(['nurse', 'community_health_worker', 'caregiver']),
    ...homeBaseFields,
  })
  .refine(caregiverHomeBase, { message: HOME_BASE_MESSAGE, path: ['baseLng'] });

const updateCaregiverRequestSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phoneNumber: z.string().regex(E164_PHONE_NUMBER, E164_MESSAGE).optional(),
    idType: z.enum(['national_id', 'passport']).optional(),
    idNumber: z.string().min(1).optional(),
    dob: z.string().regex(DATE_ONLY, 'dob must be YYYY-MM-DD').optional(),
    gender: z.enum(['male', 'female']).optional(),
    occupation: z.enum(['nurse', 'community_health_worker', 'caregiver']).optional(),
    employeeNumber: z.string().min(1).optional(),
    hireDate: z.string().regex(DATE_ONLY, 'hireDate must be YYYY-MM-DD').optional(),
    active: z.boolean().optional(),
    ...homeBaseFields,
  })
  .refine(caregiverHomeBase, { message: HOME_BASE_MESSAGE, path: ['baseLng'] });

// Express 5's params type allows string | string[], so req.params.caregiverId isn't a plain
// string on its own - validated the same way any other input is, via parseOrSendProblem.
const caregiverIdParamSchema = z.string().uuid();

// Sortable columns (2026-09-26, the supervisor console's tables). hire_date can be NULL, and a
// keyset sort can't page over NULLs, so a missing hire date sorts as the earliest possible date.
const CAREGIVER_SORT_KEYS = {
  name: { expr: schema.users.fullName, cast: 'text' },
  hireDate: { expr: sql`coalesce(${schema.caregivers.hireDate}, '-infinity'::date)`, cast: 'date' },
} as const satisfies Record<string, SortKey>;

const listCaregiversQuerySchema = z.object({
  sort: z.enum(['name', '-name', 'hireDate', '-hireDate']).optional(),
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
    email: schema.users.email,
    phoneNumber: schema.users.phoneNumber,
    idType: schema.users.idType,
    idNumber: schema.users.idNumber,
    dob: schema.caregivers.dob,
    gender: schema.caregivers.gender,
    occupation: schema.caregivers.occupation,
    employeeNumber: schema.caregivers.employeeNumber,
    hireDate: schema.caregivers.hireDate,
    baseLat: schema.caregivers.baseLat,
    baseLng: schema.caregivers.baseLng,
    baseAreaText: schema.caregivers.baseAreaText,
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
  baseLat: number | null;
  baseLng: number | null;
  baseAreaText: string | null;
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
    baseLat: row.baseLat,
    baseLng: row.baseLng,
    baseAreaText: row.baseAreaText,
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
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }

    try {
      // Same ordering rationale as routes/users.ts and routes/dependants.ts's email-only
      // family-member path: create the Cognito identity before the DB insert, so a failed insert
      // (e.g. duplicate email/phoneNumber) still leaves a retry able to succeed rather than
      // orphaning a Cognito account with no local row. createUser sets custom:role in the same
      // call, so no separate assignRole is needed here.
      const cognitoSub = await cognitoAdmin.createUser({
        email: body.email,
        phoneNumber: body.phoneNumber,
        fullName: body.fullName,
        role: 'caregiver',
      });

      // A read, so it needn't be inside the transaction below - this router is supervisor-only
      // (router.use above), so the caller always has their own row already.
      const callerRow = await getUserByCognitoSub(db, caller.sub);

      const result = await db.transaction(async (tx) => {
        const [userRow] = await tx
          .insert(schema.users)
          .values({
            id: uuidv7(),
            cognitoSub,
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
            baseLat: body.baseLat,
            baseLng: body.baseLng,
            baseAreaText: body.baseAreaText,
          })
          .returning();
        if (!caregiverRow) {
          throw new Error('Insert into caregivers returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: callerRow?.id ?? null,
          action: 'caregiver.create',
          entityType: 'caregiver',
          entityId: userRow.id,
          metadata: {
            fullName: userRow.fullName,
            gender: caregiverRow.gender,
            occupation: caregiverRow.occupation,
          },
        });
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
          baseLat: result.caregiverRow.baseLat,
          baseLng: result.caregiverRow.baseLng,
          baseAreaText: result.caregiverRow.baseAreaText,
          active: result.caregiverRow.active,
          createdAt: result.caregiverRow.createdAt,
          updatedAt: result.caregiverRow.updatedAt,
        }),
      );
    } catch (err) {
      if (isCognitoUserAlreadyExistsError(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A Cognito identity with this email already exists.',
        });
        return;
      }
      // Anything Cognito rejects that the schema above didn't catch, as a 400 rather than a 500.
      if (isCognitoInvalidParameterError(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail:
            (err as { message?: string }).message ??
            'Cognito rejected one of the submitted fields.',
        });
        return;
      }
      if (isPostgresUniqueViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A user with this email or phoneNumber already exists.',
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
      const sort = resolveSort(query.sort, CAREGIVER_SORT_KEYS);
      if (query.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(query.cursor, sort?.param);
        } catch {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'Malformed cursor.',
          });
          return;
        }
        conditions.push(keysetCondition(schema.caregivers.userId, cursor, sort));
      }

      const rows = await db
        .select(caregiverSelection())
        .from(schema.caregivers)
        .innerJoin(schema.users, eq(schema.caregivers.userId, schema.users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(...keysetOrder(schema.caregivers.userId, sort))
        .limit(query.limit + 1);

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({
        id: row.userId,
        sort: sort?.param,
        value: sort
          ? sort.param.endsWith('hireDate')
            ? (row.hireDate ?? '-infinity')
            : row.fullName
          : undefined,
      }));
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

  // Visit statistics for the caregiver's page (2026-09-27) - see db/visitStats.ts. Supervisor-
  // only like every route here (the router-level gate above).
  router.get('/:caregiverId/stats', async (req, res, next) => {
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
        .select({ userId: schema.caregivers.userId })
        .from(schema.caregivers)
        .where(eq(schema.caregivers.userId, caregiverId));
      if (!row) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json(await visitStatsFor(db, { caregiverId }, new Date()));
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
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }

    try {
      // Split by which table each field actually lives on - email/idType/idNumber belong to
      // users, not caregivers, unlike everything else PATCH accepts.
      const { phoneNumber, fullName, email, idType, idNumber, ...caregiverFields } = body;
      // A read, so it needn't be inside the transaction below - this router is supervisor-only.
      const callerRow = await getUserByCognitoSub(db, caller.sub);
      const result = await db.transaction(async (tx) => {
        const [beforeUser] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, caregiverId));
        const [beforeCaregiver] = await tx
          .select()
          .from(schema.caregivers)
          .where(eq(schema.caregivers.userId, caregiverId));
        if (!beforeUser || !beforeCaregiver) {
          return undefined;
        }

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
        await recordAudit(tx, {
          actorUserId: callerRow?.id ?? null,
          action: 'caregiver.update',
          entityType: 'caregiver',
          entityId: caregiverId,
          metadata: {
            // idNumber/email/phoneNumber never copied verbatim - only that they changed.
            ...changedFields(
              beforeUser,
              userRow,
              ['fullName', 'idType'],
              ['email', 'phoneNumber', 'idNumber'],
            ),
            ...changedFields(beforeCaregiver, caregiverRow, [
              'dob',
              'gender',
              'occupation',
              'employeeNumber',
              'hireDate',
              'active',
            ]),
          },
        });
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
          email: result.userRow.email,
          phoneNumber: result.userRow.phoneNumber,
          idType: result.userRow.idType,
          idNumber: result.userRow.idNumber,
          dob: result.caregiverRow.dob,
          gender: result.caregiverRow.gender,
          occupation: result.caregiverRow.occupation,
          employeeNumber: result.caregiverRow.employeeNumber,
          hireDate: result.caregiverRow.hireDate,
          baseLat: result.caregiverRow.baseLat,
          baseLng: result.caregiverRow.baseLng,
          baseAreaText: result.caregiverRow.baseAreaText,
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
