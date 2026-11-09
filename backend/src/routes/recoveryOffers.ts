// GET /recovery-offers/mine, POST /recovery-offers/{id}/accept|decline (2026-11-09): a caregiver's
// side of automatic missed-visit recovery (src/recovery.ts).
//
// An offer shows only the ward and the times until it is accepted. A caregiver who declines has no
// need for a dependant's name or address.

import { and, eq, gt } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { isPostgresExclusionViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { offerNext } from '../recovery.js';
import { parseOrSendProblem } from '../validation.js';

export interface RecoveryOffersRouterDependencies {
  requireAuth: RequestHandler;
  now?: () => Date;
}

const offerIdParamSchema = z.string().uuid();

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

// Thrown inside the transaction so nothing it has done is kept.
class OfferNoLongerOpen extends Error {}

export function createRecoveryOffersRouter(dependencies: RecoveryOffersRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  router.use(requireAuth, requireRole('caregiver'));

  async function callerId(db: Db, sub: string): Promise<string> {
    const row = await getUserByCognitoSub(db, sub);
    if (!row) {
      throw new Error(`No users row found for authenticated caller sub ${sub}.`);
    }
    return row.id;
  }

  router.get('/mine', async (req, res, next) => {
    const db = getDb(res);
    if (!db || !req.auth) {
      return;
    }
    try {
      const at = now();
      const caregiverId = await callerId(db, req.auth.sub);
      const rows = await db
        .select({
          id: schema.visitRecoveryOffers.id,
          proposedStart: schema.visitRecoveryOffers.proposedStart,
          proposedEnd: schema.visitRecoveryOffers.proposedEnd,
          distanceMeters: schema.visitRecoveryOffers.distanceMeters,
          expiresAt: schema.visitRecoveryOffers.expiresAt,
          ward: schema.dependants.ward,
        })
        .from(schema.visitRecoveryOffers)
        .innerJoin(
          schema.visitRecoveryCases,
          eq(schema.visitRecoveryCases.id, schema.visitRecoveryOffers.caseId),
        )
        .innerJoin(
          schema.visitSchedules,
          eq(schema.visitSchedules.id, schema.visitRecoveryCases.visitScheduleId),
        )
        .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
        .where(
          and(
            eq(schema.visitRecoveryOffers.caregiverId, caregiverId),
            eq(schema.visitRecoveryOffers.status, 'offered'),
            gt(schema.visitRecoveryOffers.expiresAt, at),
            eq(schema.visitRecoveryCases.status, 'open'),
            // Gone the moment the original caregiver checks in, not at the next sweep.
            eq(schema.visitSchedules.status, 'scheduled'),
          ),
        );
      res.status(200).json({
        items: rows.map((row) => ({
          id: row.id,
          proposedStart: row.proposedStart.toISOString(),
          proposedEnd: row.proposedEnd.toISOString(),
          distanceMeters: Math.round(row.distanceMeters),
          expiresAt: row.expiresAt.toISOString(),
          ward: row.ward,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:offerId/accept', async (req, res, next) => {
    const offerId = parseOrSendProblem(offerIdParamSchema, req.params.offerId, res);
    const db = offerId && getDb(res);
    if (!offerId || !db || !req.auth) {
      return;
    }
    try {
      const at = now();
      const caregiverId = await callerId(db, req.auth.sub);

      const replacement = await db.transaction(async (tx) => {
        // Locked and re-read, so a late check-in or a second acceptance can't slip in between.
        const [row] = await tx
          .select({
            offer: schema.visitRecoveryOffers,
            recoveryCase: schema.visitRecoveryCases,
            visit: schema.visitSchedules,
          })
          .from(schema.visitRecoveryOffers)
          .innerJoin(
            schema.visitRecoveryCases,
            eq(schema.visitRecoveryCases.id, schema.visitRecoveryOffers.caseId),
          )
          .innerJoin(
            schema.visitSchedules,
            eq(schema.visitSchedules.id, schema.visitRecoveryCases.visitScheduleId),
          )
          .where(
            and(
              eq(schema.visitRecoveryOffers.id, offerId),
              eq(schema.visitRecoveryOffers.caregiverId, caregiverId),
            ),
          )
          .for('update');
        if (!row) {
          return undefined;
        }
        const { offer, recoveryCase, visit } = row;
        if (
          offer.status !== 'offered' ||
          offer.expiresAt <= at ||
          recoveryCase.status !== 'open' ||
          visit.status !== 'scheduled'
        ) {
          throw new OfferNoLongerOpen();
        }

        await tx
          .update(schema.visitSchedules)
          .set({ status: 'reassigned', updatedAt: at })
          .where(eq(schema.visitSchedules.id, visit.id));

        // The offer may have sat for a few minutes, so never start in the past.
        const start = offer.proposedStart > at ? offer.proposedStart : at;
        const length = offer.proposedEnd.getTime() - offer.proposedStart.getTime();
        const [created] = await tx
          .insert(schema.visitSchedules)
          .values({
            id: uuidv7(),
            caregiverId,
            dependantId: visit.dependantId,
            scheduledStart: start,
            scheduledEnd: new Date(start.getTime() + length),
            createdBy: visit.createdBy,
            recoveredFromVisitId: visit.id,
          })
          .returning();
        if (!created) {
          throw new Error('Insert into visit_schedules returned no row.');
        }

        await tx
          .update(schema.visitRecoveryOffers)
          .set({ status: 'accepted', respondedAt: at })
          .where(eq(schema.visitRecoveryOffers.id, offer.id));
        await tx
          .update(schema.visitRecoveryCases)
          .set({ status: 'recovered', replacementVisitId: created.id, closedAt: at })
          .where(eq(schema.visitRecoveryCases.id, recoveryCase.id));
        await recordAudit(tx, {
          actorUserId: caregiverId,
          action: 'visit_recovery.accept',
          entityType: 'visit_schedule',
          entityId: visit.id,
          metadata: { offerId: offer.id, replacementVisitId: created.id },
        });
        return created;
      });

      if (!replacement) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json({
        visitScheduleId: replacement.id,
        scheduledStart: replacement.scheduledStart.toISOString(),
        scheduledEnd: replacement.scheduledEnd.toISOString(),
      });
    } catch (err) {
      if (err instanceof OfferNoLongerOpen) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This visit no longer needs cover.',
        });
        return;
      }
      if (isPostgresExclusionViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'You now have another visit at this time, so this one can no longer be yours.',
        });
        return;
      }
      next(err);
    }
  });

  router.post('/:offerId/decline', async (req, res, next) => {
    const offerId = parseOrSendProblem(offerIdParamSchema, req.params.offerId, res);
    const db = offerId && getDb(res);
    if (!offerId || !db || !req.auth) {
      return;
    }
    try {
      const at = now();
      const caregiverId = await callerId(db, req.auth.sub);
      const [declined] = await db
        .update(schema.visitRecoveryOffers)
        .set({ status: 'declined', respondedAt: at })
        .where(
          and(
            eq(schema.visitRecoveryOffers.id, offerId),
            eq(schema.visitRecoveryOffers.caregiverId, caregiverId),
            eq(schema.visitRecoveryOffers.status, 'offered'),
          ),
        )
        .returning();
      if (!declined) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      const [recoveryCase] = await db
        .select()
        .from(schema.visitRecoveryCases)
        .where(eq(schema.visitRecoveryCases.id, declined.caseId));
      // Straight to the next caregiver rather than waiting for the next run: time matters here.
      if (recoveryCase?.status === 'open') {
        await offerNext(db, recoveryCase, at);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
