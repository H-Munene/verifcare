// POST/GET /dependants, GET/PATCH /dependants/{dependantId},
// POST/GET /dependants/{dependantId}/family-members,
// PATCH /dependants/{dependantId}/family-members/{userId}.
//
// Access rules (caregivers are forbidden throughout):
// - POST /dependants: supervisor or family_member. A family member can only name themselves as
//   the primary contact.
// - GET /dependants, GET /dependants/{id}: supervisors see all; family members only linked ones.
// - PATCH /dependants/{id}: supervisor, or the primary contact (who can't change status).
// - POST /dependants/{id}/family-members: supervisor or any linked family member.
// - GET /dependants/{id}/family-members: supervisor or any linked family member.
// - PATCH /dependants/{id}/family-members/{userId}: supervisor-only.
//
// Making someone the primary contact demotes the current one in the same transaction.

import { and, asc, eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  isCognitoUserAlreadyExistsError,
  isCognitoUserNotFoundError,
  type CognitoAdmin,
} from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface DependantsRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  requireAuth: RequestHandler;
}

interface DependantResponse {
  id: string;
  fullName: string;
  dob: string;
  gender: 'male' | 'female' | null;
  homeAddressText: string | null;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusMeters: number;
  cognitiveMonitoringEnabled: boolean;
  status: 'active' | 'deactivated';
  registeredBy: string;
  createdAt: string;
  updatedAt: string;
}

function toDependantResponse(row: typeof schema.dependants.$inferSelect): DependantResponse {
  return {
    id: row.id,
    fullName: row.fullName,
    dob: row.dob,
    gender: row.gender,
    homeAddressText: row.homeAddressText,
    geofenceLat: row.geofenceLat,
    geofenceLng: row.geofenceLng,
    geofenceRadiusMeters: row.geofenceRadiusMeters,
    cognitiveMonitoringEnabled: row.cognitiveMonitoringEnabled,
    status: row.status,
    registeredBy: row.registeredBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface DependantFamilyMemberResponse {
  dependantId: string;
  familyMemberUserId: string;
  relationship: string | null;
  isPrimaryContact: boolean;
  addedBy: string;
  createdAt: string;
}

function toFamilyMemberResponse(
  row: typeof schema.dependantFamilyMembers.$inferSelect,
): DependantFamilyMemberResponse {
  return {
    dependantId: row.dependantId,
    familyMemberUserId: row.familyMemberUserId,
    relationship: row.relationship,
    isPrimaryContact: row.isPrimaryContact,
    addedBy: row.addedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

// Explicit columns so the joined query returns the same flat shape as the plain one.
function dependantColumns() {
  return {
    id: schema.dependants.id,
    fullName: schema.dependants.fullName,
    dob: schema.dependants.dob,
    gender: schema.dependants.gender,
    homeAddressText: schema.dependants.homeAddressText,
    geofenceLat: schema.dependants.geofenceLat,
    geofenceLng: schema.dependants.geofenceLng,
    geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
    cognitiveMonitoringEnabled: schema.dependants.cognitiveMonitoringEnabled,
    status: schema.dependants.status,
    registeredBy: schema.dependants.registeredBy,
    createdAt: schema.dependants.createdAt,
    updatedAt: schema.dependants.updatedAt,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Exactly one of cognitoSub (link an existing Cognito user) or email (create a new one).
const addFamilyMemberRequestSchema = z
  .object({
    cognitoSub: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(1),
    fullName: z.string().min(1),
    relationship: z.string().min(1).optional(),
    isPrimaryContact: z.boolean().default(false),
  })
  .refine((data) => Boolean(data.cognitoSub) !== Boolean(data.email), {
    message:
      'Provide exactly one of cognitoSub (link an existing identity) or email (create a new one).',
    path: ['cognitoSub'],
  });
type AddFamilyMemberBody = z.infer<typeof addFamilyMemberRequestSchema>;

const createDependantRequestSchema = z.object({
  fullName: z.string().min(1),
  dob: z.string().regex(DATE_ONLY, 'dob must be YYYY-MM-DD'),
  gender: z.enum(['male', 'female']).optional(),
  homeAddressText: z.string().min(1).optional(),
  geofenceLat: z.number(),
  geofenceLng: z.number(),
  geofenceRadiusMeters: z.number().int().min(1),
  cognitiveMonitoringEnabled: z.boolean().default(false),
  primaryFamilyMember: addFamilyMemberRequestSchema,
});

const updateDependantRequestSchema = z.object({
  fullName: z.string().min(1).optional(),
  gender: z.enum(['male', 'female']).optional(),
  homeAddressText: z.string().min(1).optional(),
  geofenceLat: z.number().optional(),
  geofenceLng: z.number().optional(),
  geofenceRadiusMeters: z.number().int().min(1).optional(),
  cognitiveMonitoringEnabled: z.boolean().optional(),
  status: z.enum(['active', 'deactivated']).optional(),
});

const updateFamilyMemberRequestSchema = z.object({
  relationship: z.string().min(1).optional(),
  isPrimaryContact: z.boolean().optional(),
});

const listDependantsQuerySchema = z.object({
  status: z.enum(['active', 'deactivated']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Express 5 types params as string | string[], so validate rather than cast.
const dependantIdParamSchema = z.string().uuid();
const familyMemberUserIdParamSchema = z.string().uuid();

function getDb(res: Response): Db | undefined {
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

// Returns the caller's users row and their link to the dependant, or undefined if not linked.
async function findFamilyMemberLink(
  db: Db,
  dependantId: string,
  callerSub: string,
): Promise<
  | {
      callerRow: typeof schema.users.$inferSelect;
      link: typeof schema.dependantFamilyMembers.$inferSelect;
    }
  | undefined
> {
  const callerRow = await getUserByCognitoSub(db, callerSub);
  if (!callerRow) {
    return undefined;
  }
  const [link] = await db
    .select()
    .from(schema.dependantFamilyMembers)
    .where(
      and(
        eq(schema.dependantFamilyMembers.dependantId, dependantId),
        eq(schema.dependantFamilyMembers.familyMemberUserId, callerRow.id),
      ),
    );
  return link ? { callerRow, link } : undefined;
}

async function getUserByEmail(
  db: Db,
  email: string,
): Promise<typeof schema.users.$inferSelect | undefined> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return row;
}

type ResolvedFamilyMember =
  | { kind: 'existing'; userId: string }
  | { kind: 'new'; cognitoSub: string; body: AddFamilyMemberBody };

// Resolves the family member's users row, creating it if needed. Sends a 400/409 and returns
// undefined on failure.
//
// - Existing user who isn't a family_member: 409.
// - Existing family_member: reused as-is. phoneNumber/fullName are only used for new rows, so
//   linking can't overwrite someone else's profile.
// - New, by cognitoSub: assign the Cognito role before inserting. Auth reads the role from the
//   JWT only, so a row without it would leave the user locked out.
// - New, by email: the DB is checked first so we don't create orphan Cognito users. createUser
//   sets the role and emails a temporary password.
async function resolveFamilyMemberIdentity(
  db: Db,
  cognitoAdmin: CognitoAdmin,
  body: AddFamilyMemberBody,
  fieldPath: string,
  res: Response,
): Promise<ResolvedFamilyMember | undefined> {
  if (body.cognitoSub) {
    const existing = await getUserByCognitoSub(db, body.cognitoSub);
    if (existing) {
      if (existing.role !== 'family_member') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This Cognito identity is already registered with a different role.',
        });
        return undefined;
      }
      return { kind: 'existing', userId: existing.id };
    }

    try {
      await cognitoAdmin.assignRole(body.cognitoSub, 'family_member');
    } catch (err) {
      if (isCognitoUserNotFoundError(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: `${fieldPath}.cognitoSub does not correspond to an existing Cognito user.`,
        });
        return undefined;
      }
      throw err;
    }
    return { kind: 'new', cognitoSub: body.cognitoSub, body };
  }

  // Schema's refine() guarantees email is present when cognitoSub isn't.
  const email = body.email;
  if (!email) {
    throw new Error(
      'addFamilyMemberRequestSchema invariant violated: neither cognitoSub nor email present.',
    );
  }

  const existingByEmail = await getUserByEmail(db, email);
  if (existingByEmail) {
    if (existingByEmail.role !== 'family_member') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This email is already registered here with a different role.',
      });
      return undefined;
    }
    return { kind: 'existing', userId: existingByEmail.id };
  }

  try {
    const cognitoSub = await cognitoAdmin.createUser({
      email,
      phoneNumber: body.phoneNumber,
      fullName: body.fullName,
      role: 'family_member',
    });
    return { kind: 'new', cognitoSub, body };
  } catch (err) {
    if (isCognitoUserAlreadyExistsError(err)) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `${fieldPath}.email already has a Cognito identity with no linked account here - this needs its Cognito sub to link directly, since it can't be found by searching.`,
      });
      return undefined;
    }
    throw err;
  }
}

export function createDependantsRouter(dependencies: DependantsRouterDependencies): Router {
  const router = Router();
  const { cognitoAdmin, requireAuth } = dependencies;
  router.use(requireAuth, requireRole('supervisor', 'family_member'));

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createDependantRequestSchema, req.body, res);
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

    if (caller.role !== 'supervisor' && body.primaryFamilyMember.cognitoSub !== caller.sub) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You may only register yourself as the primary family member.',
      });
      return;
    }

    try {
      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const resolved = await resolveFamilyMemberIdentity(
        db,
        cognitoAdmin,
        body.primaryFamilyMember,
        'primaryFamilyMember.cognitoSub',
        res,
      );
      if (!resolved) {
        return;
      }

      const dependantRow = await db.transaction(async (tx) => {
        const [dependant] = await tx
          .insert(schema.dependants)
          .values({
            id: uuidv7(),
            fullName: body.fullName,
            dob: body.dob,
            gender: body.gender,
            homeAddressText: body.homeAddressText,
            geofenceLat: body.geofenceLat,
            geofenceLng: body.geofenceLng,
            geofenceRadiusMeters: body.geofenceRadiusMeters,
            cognitiveMonitoringEnabled: body.cognitiveMonitoringEnabled,
            registeredBy: callerRow.id,
          })
          .returning();
        if (!dependant) {
          throw new Error('Insert into dependants returned no row.');
        }

        let familyMemberUserId: string;
        if (resolved.kind === 'existing') {
          familyMemberUserId = resolved.userId;
        } else {
          const [userRow] = await tx
            .insert(schema.users)
            .values({
              id: uuidv7(),
              cognitoSub: resolved.cognitoSub,
              email: resolved.body.email,
              phoneNumber: resolved.body.phoneNumber,
              fullName: resolved.body.fullName,
              role: 'family_member',
            })
            .returning();
          if (!userRow) {
            throw new Error('Insert into users returned no row.');
          }
          familyMemberUserId = userRow.id;
        }

        // Always primary, whatever the request said.
        await tx.insert(schema.dependantFamilyMembers).values({
          dependantId: dependant.id,
          familyMemberUserId,
          relationship: body.primaryFamilyMember.relationship,
          isPrimaryContact: true,
          addedBy: callerRow.id,
        });

        return dependant;
      });

      res.status(201).json(toDependantResponse(dependantRow));
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

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listDependantsQuerySchema, req.query, res);
    if (!query) {
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
      const conditions = [];
      if (query.status) {
        conditions.push(eq(schema.dependants.status, query.status));
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
        conditions.push(cursorCondition(schema.dependants.id, cursor));
      }

      let rows;
      if (caller.role === 'supervisor') {
        rows = await db
          .select(dependantColumns())
          .from(schema.dependants)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(schema.dependants.id))
          .limit(query.limit + 1);
      } else {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }
        conditions.push(eq(schema.dependantFamilyMembers.familyMemberUserId, callerRow.id));
        rows = await db
          .select(dependantColumns())
          .from(schema.dependants)
          .innerJoin(
            schema.dependantFamilyMembers,
            eq(schema.dependants.id, schema.dependantFamilyMembers.dependantId),
          )
          .where(and(...conditions))
          .orderBy(asc(schema.dependants.id))
          .limit(query.limit + 1);
      }

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({ id: row.id }));
      res.status(200).json({ items: items.map(toDependantResponse), nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:dependantId', async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
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
      const [row] = await db
        .select()
        .from(schema.dependants)
        .where(eq(schema.dependants.id, dependantId));
      if (!row) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (caller.role !== 'supervisor') {
        const found = await findFamilyMemberLink(db, dependantId, caller.sub);
        if (!found) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
      }
      res.status(200).json(toDependantResponse(row));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:dependantId', async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
      return;
    }
    const body = parseOrSendProblem(updateDependantRequestSchema, req.body, res);
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
      const [existing] = await db
        .select()
        .from(schema.dependants)
        .where(eq(schema.dependants.id, dependantId));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      if (caller.role !== 'supervisor') {
        if (body.status !== undefined) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'Only a supervisor may change a dependant’s status.',
          });
          return;
        }
        const found = await findFamilyMemberLink(db, dependantId, caller.sub);
        if (!found?.link.isPrimaryContact) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail:
              'Only a supervisor or this dependant’s primary-contact family member may update it.',
          });
          return;
        }
      }

      const [updated] = await db
        .update(schema.dependants)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.dependants.id, dependantId))
        .returning();
      if (!updated) {
        throw new Error('Update to dependants returned no row.');
      }
      res.status(200).json(toDependantResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:dependantId/family-members', async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
      return;
    }
    const body = parseOrSendProblem(addFamilyMemberRequestSchema, req.body, res);
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
      const [dependant] = await db
        .select()
        .from(schema.dependants)
        .where(eq(schema.dependants.id, dependantId));
      if (!dependant) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      let callerRowId: string;
      if (caller.role === 'supervisor') {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }
        callerRowId = callerRow.id;
      } else {
        const found = await findFamilyMemberLink(db, dependantId, caller.sub);
        if (!found) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail:
              'Only a supervisor or an existing linked family member may add another family member.',
          });
          return;
        }
        callerRowId = found.callerRow.id;
      }

      const resolved = await resolveFamilyMemberIdentity(db, cognitoAdmin, body, 'cognitoSub', res);
      if (!resolved) {
        return;
      }

      const link = await db.transaction(async (tx) => {
        let familyMemberUserId: string;
        if (resolved.kind === 'existing') {
          familyMemberUserId = resolved.userId;
        } else {
          const [userRow] = await tx
            .insert(schema.users)
            .values({
              id: uuidv7(),
              cognitoSub: resolved.cognitoSub,
              email: resolved.body.email,
              phoneNumber: resolved.body.phoneNumber,
              fullName: resolved.body.fullName,
              role: 'family_member',
            })
            .returning();
          if (!userRow) {
            throw new Error('Insert into users returned no row.');
          }
          familyMemberUserId = userRow.id;
        }

        if (body.isPrimaryContact) {
          await tx
            .update(schema.dependantFamilyMembers)
            .set({ isPrimaryContact: false })
            .where(
              and(
                eq(schema.dependantFamilyMembers.dependantId, dependantId),
                eq(schema.dependantFamilyMembers.isPrimaryContact, true),
              ),
            );
        }

        const [row] = await tx
          .insert(schema.dependantFamilyMembers)
          .values({
            dependantId,
            familyMemberUserId,
            relationship: body.relationship,
            isPrimaryContact: body.isPrimaryContact,
            addedBy: callerRowId,
          })
          .returning();
        if (!row) {
          throw new Error('Insert into dependant_family_members returned no row.');
        }
        return row;
      });

      res.status(201).json(toFamilyMemberResponse(link));
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail:
            'This family member is already linked to this dependant, or the cognitoSub/email/phoneNumber is already in use.',
        });
        return;
      }
      next(err);
    }
  });

  router.get('/:dependantId/family-members', async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
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
      const [dependant] = await db
        .select()
        .from(schema.dependants)
        .where(eq(schema.dependants.id, dependantId));
      if (!dependant) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (caller.role !== 'supervisor') {
        const found = await findFamilyMemberLink(db, dependantId, caller.sub);
        if (!found) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
      }

      const rows = await db
        .select()
        .from(schema.dependantFamilyMembers)
        .where(eq(schema.dependantFamilyMembers.dependantId, dependantId));
      res.status(200).json(rows.map(toFamilyMemberResponse));
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    '/:dependantId/family-members/:userId',
    requireRole('supervisor'),
    async (req, res, next) => {
      const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
      if (!dependantId) {
        return;
      }
      const familyMemberUserId = parseOrSendProblem(
        familyMemberUserIdParamSchema,
        req.params.userId,
        res,
      );
      if (!familyMemberUserId) {
        return;
      }
      const body = parseOrSendProblem(updateFamilyMemberRequestSchema, req.body, res);
      if (!body) {
        return;
      }
      const db = getDb(res);
      if (!db) {
        return;
      }

      try {
        const [existing] = await db
          .select()
          .from(schema.dependantFamilyMembers)
          .where(
            and(
              eq(schema.dependantFamilyMembers.dependantId, dependantId),
              eq(schema.dependantFamilyMembers.familyMemberUserId, familyMemberUserId),
            ),
          );
        if (!existing) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }

        const updated = await db.transaction(async (tx) => {
          if (body.isPrimaryContact) {
            await tx
              .update(schema.dependantFamilyMembers)
              .set({ isPrimaryContact: false })
              .where(
                and(
                  eq(schema.dependantFamilyMembers.dependantId, dependantId),
                  eq(schema.dependantFamilyMembers.isPrimaryContact, true),
                ),
              );
          }
          const [row] = await tx
            .update(schema.dependantFamilyMembers)
            .set(body)
            .where(
              and(
                eq(schema.dependantFamilyMembers.dependantId, dependantId),
                eq(schema.dependantFamilyMembers.familyMemberUserId, familyMemberUserId),
              ),
            )
            .returning();
          return row;
        });
        if (!updated) {
          throw new Error('Update to dependant_family_members returned no row.');
        }
        res.status(200).json(toFamilyMemberResponse(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
