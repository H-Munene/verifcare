// POST /consent-records, GET /consent-records, POST /consent-records/{id}/revoke (HEZ-40).
//
// Who may grant/revoke consent for a subject (confirmed with the user before implementing, not
// assumed): this table already covers both subject types (caregiver, dependant), and this
// codebase already has two different, fully-established RBAC patterns for who manages each one -
// dependants.ts lets a supervisor (any dependant) or a linked family member (their own dependant
// only) act, while caregivers.ts is entirely supervisor-only everywhere (caregivers never
// self-register or self-manage anywhere in this codebase). Confirmed: mirror each subject's own
// existing pattern here rather than inventing a third rule - dependant subject: supervisor or the
// dependant's linked family member; caregiver subject: supervisor only. `grantedBy` is always the
// authenticated caller's own users row, never client-supplied - CreateConsentRecordRequest's own
// schema has no such field.
//
// Revoking uses the exact same authorization as granting (also confirmed, not assumed) - whoever
// could grant a subject's consent can also revoke it, re-derived from the existing row's own
// subjectType/caregiverId/dependantId rather than trusted from the request. Revoking is
// idempotent: revoking an already-revoked record leaves its original revoked_at untouched and
// simply returns the row as-is, rather than erroring or overwriting real audit history.
//
// authorizeSubject() below is deliberately the same shape as
// A boolean-returning helper that sends its own 403/404, scoped to this router's own
// upload-url/confirm flow, but the underlying ownership rule is identical.

import { eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { AuthenticatedUser } from '../auth/verifier.js';
import { requireRole } from '../auth/middleware.js';
import { recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';
import { findFamilyMemberLink } from './dependants.js';

export interface ConsentRecordsRouterDependencies {
  requireAuth: RequestHandler;
}

interface ConsentRecordResponse {
  id: string;
  subjectType: 'caregiver' | 'dependant';
  caregiverId: string | null;
  dependantId: string | null;
  consentType: 'location_verification' | 'visit_audio';
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
}

function toResponse(row: typeof schema.consentRecords.$inferSelect): ConsentRecordResponse {
  return {
    id: row.id,
    subjectType: row.subjectType,
    caregiverId: row.caregiverId,
    dependantId: row.dependantId,
    consentType: row.consentType,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

const createConsentRecordRequestSchema = z.object({
  subjectType: z.enum(['caregiver', 'dependant']),
  subjectId: z.string().uuid(),
  consentType: z.enum(['location_verification', 'visit_audio']),
});

const listConsentRecordsQuerySchema = z.object({
  subjectType: z.enum(['caregiver', 'dependant']),
  subjectId: z.string().uuid(),
});

const consentRecordIdParamSchema = z.string().uuid();

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

// Sends its own 403/404 and returns false on failure - same "send the response, return a falsy
// sentinel" pattern this codebase already establishes (validation.ts, auth/middleware.ts).
async function authorizeSubject(
  db: Db,
  caller: AuthenticatedUser,
  subjectType: 'caregiver' | 'dependant',
  subjectId: string,
  res: Response,
): Promise<boolean> {
  if (caller.role === 'supervisor') {
    const [subject] =
      subjectType === 'caregiver'
        ? await db
            .select({ id: schema.caregivers.userId })
            .from(schema.caregivers)
            .where(eq(schema.caregivers.userId, subjectId))
        : await db
            .select({ id: schema.dependants.id })
            .from(schema.dependants)
            .where(eq(schema.dependants.id, subjectId));
    if (!subject) {
      sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
      return false;
    }
    return true;
  }

  // family_member: dependant only, and only one they're linked to - a caregiver's consent is
  // supervisor-only, matching caregivers.ts being entirely supervisor-gated everywhere else.
  if (subjectType !== 'dependant') {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'A family member may only act on a dependant, not a caregiver.',
    });
    return false;
  }
  const [dependant] = await db
    .select({ id: schema.dependants.id })
    .from(schema.dependants)
    .where(eq(schema.dependants.id, subjectId));
  if (!dependant) {
    sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
    return false;
  }
  const link = await findFamilyMemberLink(db, subjectId, caller.sub);
  if (!link) {
    sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
    return false;
  }
  return true;
}

export function createConsentRecordsRouter(dependencies: ConsentRecordsRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  // caregiver is forbidden on every route in this file - a caregiver's own consent is granted by
  // their supervisor (see the file header comment), never by the caregiver themselves.
  router.use(requireAuth, requireRole('supervisor', 'family_member'));

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createConsentRecordRequestSchema, req.body, res);
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
      const authorized = await authorizeSubject(db, caller, body.subjectType, body.subjectId, res);
      if (!authorized) {
        return;
      }
      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.consentRecords)
          .values({
            id: uuidv7(),
            subjectType: body.subjectType,
            caregiverId: body.subjectType === 'caregiver' ? body.subjectId : null,
            dependantId: body.subjectType === 'dependant' ? body.subjectId : null,
            consentType: body.consentType,
            grantedBy: callerRow.id,
          })
          .returning();
        if (!inserted) {
          throw new Error('Insert into consent_records returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'consent.grant',
          entityType: 'consent_record',
          entityId: inserted.id,
          metadata: {
            subjectType: body.subjectType,
            subjectId: body.subjectId,
            consentType: body.consentType,
          },
        });
        return inserted;
      });
      res.status(201).json(toResponse(row));
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listConsentRecordsQuerySchema, req.query, res);
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
      const authorized = await authorizeSubject(
        db,
        caller,
        query.subjectType,
        query.subjectId,
        res,
      );
      if (!authorized) {
        return;
      }

      const subjectColumn =
        query.subjectType === 'caregiver'
          ? schema.consentRecords.caregiverId
          : schema.consentRecords.dependantId;
      const rows = await db
        .select()
        .from(schema.consentRecords)
        .where(eq(subjectColumn, query.subjectId));
      res.status(200).json(rows.map(toResponse));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:consentRecordId/revoke', async (req, res, next) => {
    const consentRecordId = parseOrSendProblem(
      consentRecordIdParamSchema,
      req.params.consentRecordId,
      res,
    );
    if (!consentRecordId) {
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
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.id, consentRecordId));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      const subjectId = existing.caregiverId ?? existing.dependantId;
      if (!subjectId) {
        throw new Error(
          `consent_records ${consentRecordId} has neither caregiverId nor dependantId.`,
        );
      }
      const authorized = await authorizeSubject(db, caller, existing.subjectType, subjectId, res);
      if (!authorized) {
        return;
      }

      if (existing.revokedAt) {
        res.status(200).json(toResponse(existing));
        return;
      }

      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.consentRecords)
          .set({ revokedAt: new Date(), revokedBy: callerRow.id })
          .where(eq(schema.consentRecords.id, consentRecordId))
          .returning();
        if (!row) {
          throw new Error('Update to consent_records returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'consent.revoke',
          entityType: 'consent_record',
          entityId: consentRecordId,
          metadata: {
            consentType: existing.consentType,
            subjectType: existing.subjectType,
            subjectId,
          },
        });
        return row;
      });
      res.status(200).json(toResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
