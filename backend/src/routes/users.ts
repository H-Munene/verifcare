// POST/GET /users, GET/PATCH /users/{userId} (HEZ-29). Two overlapping concerns live here:
// registration (including a genuinely new Cognito self-signup completing its own role
// assignment - see auth/cognitoAdmin.ts's header comment for why that path exists at all) and
// ordinary profile CRUD.
//
// Ownership/RBAC rules (confirmed with the user before implementing, not assumed):
// - POST /users: a caller with no role yet (a brand-new self-signup) or an existing non-supervisor
//   role may only create a row for themselves (cognitoSub must equal their own sub), and only with
//   role: family_member - never supervisor. A supervisor may create a row for anyone, with either
//   role. Every successful create also assigns the Cognito custom:role attribute server-side
//   (cognitoAdmin.assignRole), since the app client can no longer write that attribute itself
//   (infra/lib/auth.ts) - Cognito's role and this row's role are kept in sync by construction.
// - GET /users (list): supervisor-only, per openapi.yaml's own description.
// - GET/PATCH /users/{userId}: a supervisor may act on any user. A non-supervisor may only act on
//   their own row (matched by cognitoSub === caller's sub, looked up on the target row - the path
//   userId is this project's internal UUID v7, not the Cognito sub, so ownership can't be checked
//   from the path parameter alone). A non-supervisor may not change `status` (offboarding) even on
//   their own row.

import { and, asc, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import type { UserRole } from '../auth/verifier.js';
import { changedFields, recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface UsersRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  // POST /users needs identity-only verification (role optional - it's the endpoint that assigns
  // the first one); every other route here needs the stronger requireAuth (role required). Both
  // are applied per-route below, not uniformly at mount time in app.ts.
  requireAuth: RequestHandler;
  requireVerifiedIdentity: RequestHandler;
}

interface UserResponse {
  id: string;
  // Not secret - already visible to the caller via their own decoded JWT for a self-view, and
  // needed by a supervisor's search-by-email/phone flow (2026-09-14, extending HEZ-55/56) to link
  // an existing identity without needing it typed in manually.
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
  // Mirrors the DB's chk_users_phone_required_unless_supervisor check constraint. openapi.yaml's
  // plain JSON Schema CreateUserRequest can't express "required unless role is X" directly, so
  // without this the same rule would only surface as an opaque 500 from a raw Postgres constraint
  // violation instead of a clean 400 - found by testing against a real database, not assumed.
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
  // Exact-match filters, not search/prefix - added 2026-09-14 so a supervisor can look up an
  // existing user by phone/email (e.g. when registering a dependant's primary contact) instead of
  // needing their internal id or Cognito sub already. Both columns are UNIQUE in the DB, so either
  // filter alone returns at most one result. No new privilege: this route is already
  // supervisor-only, and a supervisor can already see every user's email/phone via the unfiltered
  // list - this only adds a convenient way to find one, not a new exposure.
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Express 5's params type allows string | string[], so req.params.userId isn't a plain string on
// its own - validated the same way any other input is, via parseOrSendProblem, rather than cast.
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
      // requireVerifiedIdentity always runs ahead of this route; a missing req.identity here is a
      // wiring bug, not a client error, but still surfaced as 401 - see requireRole's identical
      // reasoning for why that's the right status even for a programmer error.
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
      // Assigning the Cognito role before the DB insert (not after) is deliberate: if the DB
      // insert then fails (e.g. a duplicate cognitoSub -> 409), the caller's token already carries
      // the intended role on their next attempt, so a retry naturally recovers. The reverse order
      // risks a DB row whose owner's token can never prove the role this endpoint was supposed to
      // grant them.
      await cognitoAdmin.assignRole(body.cognitoSub, body.role);

      // Self-registration (the only non-supervisor path, see the isSelf check above) has no prior
      // users row for the caller - resolved below from the row the transaction is about to create
      // instead. A supervisor creating someone else's row already has their own, looked up here
      // (before the transaction - getUserByCognitoSub only reads, so it needn't be inside it).
      const supervisorRow = isSelf ? undefined : await getUserByCognitoSub(db, caller.sub);

      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
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
        if (!inserted) {
          throw new Error('Insert into users returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: isSelf ? inserted.id : (supervisorRow?.id ?? null),
          action: 'user.create',
          entityType: 'user',
          entityId: inserted.id,
          metadata: { role: body.role },
        });
        return inserted;
      });
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

  // GET /users/me: the caller's own row. Clients only know their Cognito sub, but other responses
  // refer to users by internal id (e.g. a dependant's family-member links), so without this a
  // mobile app couldn't tell which link is the caller's own - needed to show "You" and to show
  // the Edit action only to the primary contact. Registered before /:userId so "me" never
  // reaches that route's uuid validation.
  router.get('/me', requireAuth, async (req, res, next) => {
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
      const row = await getUserByCognitoSub(db, caller.sub);
      if (!row) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json(toUserResponse(row));
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

      // The actor is existing itself when self-editing; otherwise a supervisor's own row, looked
      // up before the transaction (a read, so it needn't be inside it).
      const actorRow = isSelf ? existing : await getUserByCognitoSub(db, caller.sub);

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.users)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(schema.users.id, userId))
          .returning();
        if (!row) {
          throw new Error('Update to users returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: actorRow?.id ?? null,
          action: 'user.update',
          entityType: 'user',
          entityId: userId,
          // email/phoneNumber are never copied into the log verbatim - only that they changed.
          metadata: changedFields(existing, row, ['fullName', 'status'], ['email', 'phoneNumber']),
        });
        return row;
      });
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
