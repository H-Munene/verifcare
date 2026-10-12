// POST/GET /users, GET/PATCH /users/{userId}.
//
// Access rules:
// - POST /users: non-supervisors (including brand-new signups) may only create their own row, as
//   family_member. Supervisors may create anyone with either role. Also sets Cognito custom:role.
// - GET /users: supervisor-only.
// - GET/PATCH /users/{userId}: supervisors any user; others only their own row (matched on
//   cognitoSub, since userId is our internal id), and they can't change `status`.

import { and, asc, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import type { UserRole } from '../auth/verifier.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface UsersRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  // POST /users only needs a verified identity since it assigns the first role; the rest need
  // requireAuth.
  requireAuth: RequestHandler;
  requireVerifiedIdentity: RequestHandler;
}

interface UserResponse {
  id: string;
  // Not secret; supervisors need it to link an existing user found by email/phone.
  cognitoSub: string;
  email: string | null;
  phoneNumber: string | null;
  fullName: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'deactivated';
  createdAt: string;
  updatedAt: string;
}

function toUserResponse(row: typeof schema.users.$inferSelect): UserResponse {
  return {
    id: row.id,
    cognitoSub: row.cognitoSub,
    email: row.email,
    phoneNumber: row.phoneNumber,
    fullName: row.fullName,
    role: row.role as UserRole,
    status: row.status as UserResponse['status'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const createUserRequestSchema = z
  .object({
    cognitoSub: z.string().min(1),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(1).optional(),
    fullName: z.string().min(1),
    role: z.enum(['supervisor', 'family_member']),
  })
  // Mirrors chk_users_phone_required_unless_supervisor so it's a 400, not a 500.
  .refine((data) => data.role === 'supervisor' || data.phoneNumber !== undefined, {
    message: 'phoneNumber is required unless role is supervisor.',
    path: ['phoneNumber'],
  });

const updateUserRequestSchema = z.object({
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  fullName: z.string().min(1).optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
});

const listUsersQuerySchema = z.object({
  role: z.enum(['supervisor', 'caregiver', 'family_member']).optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  // Exact-match lookups. Both columns are unique, so each returns at most one user.
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Express 5 types params as string | string[], so validate rather than cast.
const userIdParamSchema = z.string().uuid();

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

export function createUsersRouter(dependencies: UsersRouterDependencies): Router {
  const router = Router();
  const { cognitoAdmin, requireAuth, requireVerifiedIdentity } = dependencies;

  router.post('/', requireVerifiedIdentity, async (req, res, next) => {
    const body = parseOrSendProblem(createUserRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    const caller = req.identity;
    if (!caller) {
      // Shouldn't happen behind requireVerifiedIdentity.
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }

    const isSupervisor = caller.role === 'supervisor';
    const isSelf = body.cognitoSub === caller.sub;
    if (!isSupervisor) {
      if (!isSelf) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'You may only register your own account.',
        });
        return;
      }
      if (body.role !== 'family_member') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'Self-registration is only available for the family_member role.',
        });
        return;
      }
    }

    try {
      // Assign the Cognito role before inserting, so a failed insert can simply be retried.
      await cognitoAdmin.assignRole(body.cognitoSub, body.role);

      const [row] = await db
        .insert(schema.users)
        .values({
          id: uuidv7(),
          cognitoSub: body.cognitoSub,
          email: body.email,
          phoneNumber: body.phoneNumber,
          fullName: body.fullName,
          role: body.role,
        })
        .returning();
      if (!row) {
        throw new Error('Insert into users returned no row.');
      }
      res.status(201).json(toUserResponse(row));
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

  router.get('/', requireAuth, requireRole('supervisor'), async (req, res, next) => {
    const query = parseOrSendProblem(listUsersQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const conditions = [];
      if (query.role) {
        conditions.push(eq(schema.users.role, query.role));
      }
      if (query.status) {
        conditions.push(eq(schema.users.status, query.status));
      }
      if (query.email) {
        conditions.push(eq(schema.users.email, query.email));
      }
      if (query.phoneNumber) {
        conditions.push(eq(schema.users.phoneNumber, query.phoneNumber));
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
        conditions.push(cursorCondition(schema.users.id, cursor));
      }

      const rows = await db
        .select()
        .from(schema.users)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(schema.users.id))
        .limit(query.limit + 1);

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({ id: row.id }));
      res.status(200).json({ items: items.map(toUserResponse), nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:userId', requireAuth, async (req, res, next) => {
    const userId = parseOrSendProblem(userIdParamSchema, req.params.userId, res);
    if (!userId) {
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
      const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      if (!row) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (caller.role !== 'supervisor' && row.cognitoSub !== caller.sub) {
        sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
        return;
      }
      res.status(200).json(toUserResponse(row));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:userId', requireAuth, async (req, res, next) => {
    const userId = parseOrSendProblem(userIdParamSchema, req.params.userId, res);
    if (!userId) {
      return;
    }
    const body = parseOrSendProblem(updateUserRequestSchema, req.body, res);
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
      const [existing] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      const isSupervisor = caller.role === 'supervisor';
      const isSelf = existing.cognitoSub === caller.sub;
      if (!isSupervisor && !isSelf) {
        sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
        return;
      }
      if (!isSupervisor && body.status !== undefined) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'Only a supervisor may change a user’s status.',
        });
        return;
      }

      const [updated] = await db
        .update(schema.users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.users.id, userId))
        .returning();
      if (!updated) {
        throw new Error('Update to users returned no row.');
      }
      res.status(200).json(toUserResponse(updated));
    } catch (err) {
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

  return router;
}
