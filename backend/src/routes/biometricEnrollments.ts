// POST /biometric-enrollments/upload-url, POST/GET /biometric-enrollments (HEZ-31),
// GET /biometric-enrollments/flagged, POST /biometric-enrollments/{id}/approve|reject (HEZ-85).
//
// Who enrolls whom (confirmed with the user before implementing, not assumed):
// - supervisor: may enroll any caregiver or any dependant.
// - family_member: may only enroll a dependant, and only one they're linked to (the same
//   ownership check routes/dependants.ts's other routes use - see findFamilyMemberLink there).
// - caregiver is forbidden on every route in this file - caregivers don't enroll anyone,
//   themselves included, per the user's own description of this flow.
//
// quality_score computation (Rekognition DetectFaces, synchronous, at confirm time) lives in
// db/biometricStorage.ts, not here - see that file's header comment for the full reasoning.
//
// Re-enrollment (a new image confirmed for a subject/imageOrder that already has an active row):
// the previous active row is marked 'superseded' in the same transaction as the new insert - the
// natural reading of the active/superseded/deleted/flagged status column, which the schema defines
// but no code path used before HEZ-31.
//
// Uniqueness (HEZ-85): after DetectFaces' quality check passes, db/biometricFaceCollection.ts's
// checkDuplicate() searches every previously enrolled face (across both caregivers and dependants -
// confirmed with the user as global, not per-role) for a match belonging to a *different* subject.
// A match flags the row (status 'flagged', not written to the collection yet) instead of
// hard-rejecting it - AWS's own CompareFaces documentation cautions that probabilistic face-match
// results affecting someone's access should go to a human, not an automatic block, and that
// reasoning applies just as much to a duplicate-enrollment decision. A supervisor then approves
// (indexes the face, promotes to active) or rejects (marks deleted, never indexed) it via the two
// new endpoints below.

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { AuthenticatedUser } from '../auth/verifier.js';
import { requireRole } from '../auth/middleware.js';
import type { BiometricFaceCollection } from '../db/biometricFaceCollection.js';
import { biometricKeyPrefix, type BiometricStorage } from '../db/biometricStorage.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';
import { findFamilyMemberLink } from './dependants.js';

export interface BiometricEnrollmentsRouterDependencies {
  requireAuth: RequestHandler;
  storage: BiometricStorage;
  faceCollection: BiometricFaceCollection;
}

type BiometricEnrollmentStatus = 'active' | 'superseded' | 'deleted' | 'flagged';

interface BiometricEnrollmentResponse {
  id: string;
  subjectType: 'caregiver' | 'dependant';
  caregiverId: string | null;
  dependantId: string | null;
  imageOrder: number;
  imageUrl: string;
  qualityScore: number | null;
  status: BiometricEnrollmentStatus;
  matchedSubjectType: 'caregiver' | 'dependant' | null;
  matchedSubjectId: string | null;
  matchedSimilarity: number | null;
  enrolledBy: string;
  enrolledAt: string;
  updatedAt: string;
}

// Async, not a plain mapper, since imageUrl is a freshly-signed S3 GET URL (storage.createViewUrl)
// generated per request - the row itself never exposes its raw s3Key to a client (see
// biometricStorage.ts's own comment on createViewUrl for why).
async function toResponse(
  row: typeof schema.biometricEnrollments.$inferSelect,
  storage: BiometricStorage,
): Promise<BiometricEnrollmentResponse> {
  return {
    id: row.id,
    subjectType: row.subjectType,
    caregiverId: row.caregiverId,
    dependantId: row.dependantId,
    imageOrder: row.imageOrder,
    imageUrl: await storage.createViewUrl(row.s3Key),
    qualityScore: row.qualityScore,
    status: row.status as BiometricEnrollmentStatus,
    matchedSubjectType: row.matchedSubjectType,
    matchedSubjectId: row.matchedSubjectId,
    matchedSimilarity: row.matchedSimilarity,
    enrolledBy: row.enrolledBy,
    enrolledAt: row.enrolledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const subjectTypeSchema = z.enum(['caregiver', 'dependant']);

const createUploadUrlRequestSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().uuid(),
  imageOrder: z.number().int().min(1).max(3),
  contentType: z.enum(['image/jpeg', 'image/png']),
});

const createBiometricEnrollmentRequestSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().uuid(),
  s3Key: z.string().min(1),
  imageOrder: z.number().int().min(1).max(3),
});

const listBiometricEnrollmentsQuerySchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().uuid(),
});

const listFlaggedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Express 5's params type allows string | string[], so req.params.id isn't a plain string on its
// own - validated the same way any other input is, via parseOrSendProblem.
const enrollmentIdParamSchema = z.string().uuid();

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

function subjectCondition(subjectType: 'caregiver' | 'dependant', subjectId: string) {
  return subjectType === 'caregiver'
    ? eq(schema.biometricEnrollments.caregiverId, subjectId)
    : eq(schema.biometricEnrollments.dependantId, subjectId);
}

// Checks both that the subject exists and that the caller is allowed to act on it, sending the
// appropriate 404/403 itself and returning false on failure - same "send the response, return a
// falsy sentinel" pattern validation.ts/auth/middleware.ts already establish.
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

  // family_member: dependant only, and only one they're linked to.
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

export function createBiometricEnrollmentsRouter(
  dependencies: BiometricEnrollmentsRouterDependencies,
): Router {
  const router = Router();
  const { requireAuth, storage, faceCollection } = dependencies;
  // caregiver is forbidden on every route in this file (see the file header comment).
  router.use(requireAuth, requireRole('supervisor', 'family_member'));

  router.post('/upload-url', async (req, res, next) => {
    const body = parseOrSendProblem(createUploadUrlRequestSchema, req.body, res);
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

      const result = await storage.createUploadUrl(body);
      res.status(201).json({ ...result, expiresAt: result.expiresAt.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createBiometricEnrollmentRequestSchema, req.body, res);
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

      const expectedPrefix = biometricKeyPrefix(body.subjectType, body.subjectId, body.imageOrder);
      if (!body.s3Key.startsWith(expectedPrefix)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 's3Key does not match this subjectType/subjectId/imageOrder.',
        });
        return;
      }

      const exists = await storage.objectExists(body.s3Key);
      if (!exists) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'No object was found at s3Key - upload it via the presigned URL first.',
        });
        return;
      }

      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const assessment = await storage.assessFaceQuality(body.s3Key);
      if (!assessment.ok) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail:
            assessment.reason === 'no_face_detected'
              ? 'No face was detected in this image.'
              : 'More than one face was detected in this image.',
        });
        return;
      }

      const duplicate = await faceCollection.checkDuplicate({
        s3Key: body.s3Key,
        self: { subjectType: body.subjectType, subjectId: body.subjectId },
      });

      let row: typeof schema.biometricEnrollments.$inferSelect;
      if (duplicate.duplicate) {
        // Flagged, not hard-rejected (see file header) - written with no rekognitionFaceId, since
        // indexing is deferred until a supervisor approves it via POST /{id}/approve.
        const [inserted] = await db
          .insert(schema.biometricEnrollments)
          .values({
            id: uuidv7(),
            subjectType: body.subjectType,
            caregiverId: body.subjectType === 'caregiver' ? body.subjectId : undefined,
            dependantId: body.subjectType === 'dependant' ? body.subjectId : undefined,
            s3Key: body.s3Key,
            imageOrder: body.imageOrder,
            qualityScore: assessment.qualityScore,
            status: 'flagged',
            matchedSubjectType: duplicate.matchedSubjectType,
            matchedSubjectId: duplicate.matchedSubjectId,
            matchedSimilarity: duplicate.similarity,
            enrolledBy: callerRow.id,
          })
          .returning();
        if (!inserted) {
          throw new Error('Insert into biometric_enrollments returned no row.');
        }
        row = inserted;
      } else {
        const faceId = await faceCollection.indexFace({
          s3Key: body.s3Key,
          subjectType: body.subjectType,
          subjectId: body.subjectId,
        });

        row = await db.transaction(async (tx) => {
          await tx
            .update(schema.biometricEnrollments)
            .set({ status: 'superseded', updatedAt: new Date() })
            .where(
              and(
                subjectCondition(body.subjectType, body.subjectId),
                eq(schema.biometricEnrollments.imageOrder, body.imageOrder),
                eq(schema.biometricEnrollments.status, 'active'),
              ),
            );

          const [inserted] = await tx
            .insert(schema.biometricEnrollments)
            .values({
              id: uuidv7(),
              subjectType: body.subjectType,
              caregiverId: body.subjectType === 'caregiver' ? body.subjectId : undefined,
              dependantId: body.subjectType === 'dependant' ? body.subjectId : undefined,
              s3Key: body.s3Key,
              imageOrder: body.imageOrder,
              qualityScore: assessment.qualityScore,
              status: 'active',
              rekognitionFaceId: faceId,
              enrolledBy: callerRow.id,
            })
            .returning();
          if (!inserted) {
            throw new Error('Insert into biometric_enrollments returned no row.');
          }
          return inserted;
        });
      }

      res.status(201).json(await toResponse(row, storage));
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This s3Key has already been recorded.',
        });
        return;
      }
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listBiometricEnrollmentsQuerySchema, req.query, res);
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

      const rows = await db
        .select()
        .from(schema.biometricEnrollments)
        .where(
          and(
            subjectCondition(query.subjectType, query.subjectId),
            ne(schema.biometricEnrollments.status, 'deleted'),
          ),
        )
        .orderBy(
          sql`CASE WHEN ${schema.biometricEnrollments.status} = 'active' THEN 0 ELSE 1 END`,
          sql`${schema.biometricEnrollments.qualityScore} DESC NULLS LAST`,
        );

      res.status(200).json(await Promise.all(rows.map((row) => toResponse(row, storage))));
    } catch (err) {
      next(err);
    }
  });

  // Supervisor-only (narrower than the router-level supervisor+family_member gate) - a family
  // member has no legitimate reason to see cross-subject duplicate-match review data.
  router.get('/flagged', requireRole('supervisor'), async (req, res, next) => {
    const query = parseOrSendProblem(listFlaggedQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const conditions = [eq(schema.biometricEnrollments.status, 'flagged')];
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
        conditions.push(cursorCondition(schema.biometricEnrollments.id, cursor));
      }

      const rows = await db
        .select()
        .from(schema.biometricEnrollments)
        .where(and(...conditions))
        .orderBy(asc(schema.biometricEnrollments.id))
        .limit(query.limit + 1);

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({ id: row.id }));
      res.status(200).json({
        items: await Promise.all(items.map((row) => toResponse(row, storage))),
        nextCursor,
      });
    } catch (err) {
      next(err);
    }
  });

  // Supervisor-only. Indexes the face now (deferred at confirm time while flagged), then applies
  // the same supersede-then-activate transaction the normal confirm path uses.
  router.post('/:id/approve', requireRole('supervisor'), async (req, res, next) => {
    const id = parseOrSendProblem(enrollmentIdParamSchema, req.params.id, res);
    if (!id) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(schema.biometricEnrollments)
        .where(eq(schema.biometricEnrollments.id, id));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (existing.status !== 'flagged') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `Only a flagged enrollment can be approved (current status: ${existing.status}).`,
        });
        return;
      }
      const subjectType = existing.subjectType;
      const subjectId = subjectType === 'caregiver' ? existing.caregiverId : existing.dependantId;
      if (!subjectId) {
        throw new Error(`biometric_enrollments row ${id} has no subject id for its subjectType.`);
      }

      const faceId = await faceCollection.indexFace({
        s3Key: existing.s3Key,
        subjectType,
        subjectId,
      });

      const updated = await db.transaction(async (tx) => {
        await tx
          .update(schema.biometricEnrollments)
          .set({ status: 'superseded', updatedAt: new Date() })
          .where(
            and(
              subjectCondition(subjectType, subjectId),
              eq(schema.biometricEnrollments.imageOrder, existing.imageOrder),
              eq(schema.biometricEnrollments.status, 'active'),
            ),
          );

        const [row] = await tx
          .update(schema.biometricEnrollments)
          .set({ status: 'active', rekognitionFaceId: faceId, updatedAt: new Date() })
          .where(eq(schema.biometricEnrollments.id, id))
          .returning();
        return row;
      });
      if (!updated) {
        throw new Error('Update to biometric_enrollments returned no row.');
      }
      res.status(200).json(await toResponse(updated, storage));
    } catch (err) {
      next(err);
    }
  });

  // Supervisor-only. Never indexed (deferred while flagged, and never will be now) - just marks
  // the row deleted so it's excluded from every listing/selection going forward, keeping it as a
  // permanent record of the rejected duplicate attempt.
  router.post('/:id/reject', requireRole('supervisor'), async (req, res, next) => {
    const id = parseOrSendProblem(enrollmentIdParamSchema, req.params.id, res);
    if (!id) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(schema.biometricEnrollments)
        .where(eq(schema.biometricEnrollments.id, id));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (existing.status !== 'flagged') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `Only a flagged enrollment can be rejected (current status: ${existing.status}).`,
        });
        return;
      }

      const [updated] = await db
        .update(schema.biometricEnrollments)
        .set({ status: 'deleted', updatedAt: new Date() })
        .where(eq(schema.biometricEnrollments.id, id))
        .returning();
      if (!updated) {
        throw new Error('Update to biometric_enrollments returned no row.');
      }
      res.status(200).json(await toResponse(updated, storage));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
