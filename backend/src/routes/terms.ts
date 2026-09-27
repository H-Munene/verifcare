// GET /terms/current, POST /terms/current/accept (2026-09-26) - the mobile apps' consent screen.
//
// Each app shows the current terms document for its user's role (src/terms.ts) until the user has
// accepted that exact version; the screen can't be dismissed, and declining closes the app. The
// server, not the app, decides what "current" means, so publishing a new version asks everyone
// again without an app release.
//
// Only caregivers and family members have terms here - supervisors use the admin web app, which
// has no consent screen (not requested). The caller must already have a users row (a family
// member finishes self-registration before reaching the app's home, where the screen is shown),
// since an acceptance is recorded against that row.
//
// Consent checkboxes (2026-09-27, terms v2): accepting also means ticking two required boxes -
// photos used to verify identity at visits, and audio recorded during visits - and this endpoint
// refuses an acceptance without both, so no app (or stale build) can record agreement to terms
// whose consents weren't given. Each acceptance then creates the matching consent_records rows,
// which is what the rest of the system checks (e.g. scheduling): for a caregiver, their own
// consent; for a family member, consent on behalf of every active dependant they're the primary
// contact of (proof of that authority is assumed for the POC - a user decision, to be refined
// with leadership). Dependants they register later get the same consent at registration
// (routes/dependants.ts). The primary contact, not every linked relative, because the primary
// contact is the one person answerable for the dependant (the same reason only they approve link
// requests in routes/familyLinkRequests.ts).

import { and, eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { grantConsents, type ConsentSubject } from '../db/consents.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { CURRENT_TERMS, type TermsDocument, type TermsDocumentType } from '../terms.js';
import { parseOrSendProblem } from '../validation.js';

export interface TermsRouterDependencies {
  requireAuth: RequestHandler;
}

const acceptTermsRequestSchema = z.object({
  // The version the user was actually shown - checked against the current one so an app holding
  // stale text can't record agreement to wording the user never saw.
  version: z.string().min(1),
  // The consent screen's two required checkboxes - literal true, so a missing or false value is a
  // 400 rather than an acceptance without consent.
  biometricConsent: z.literal(true, {
    error: 'Consent to photo identity verification is required to accept the terms.',
  }),
  audioConsent: z.literal(true, {
    error: 'Consent to audio recording during visits is required to accept the terms.',
  }),
});

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

function documentTypeFor(role: string): TermsDocumentType | null {
  return role === 'caregiver' || role === 'family_member' ? role : null;
}

interface CurrentTermsResponse extends TermsDocument {
  // When the caller accepted this exact version, or null if they haven't yet.
  acceptedAt: string | null;
}

async function acceptanceOf(db: Db, userId: string, terms: TermsDocument): Promise<Date | null> {
  const [row] = await db
    .select({ acceptedAt: schema.termsAcceptances.acceptedAt })
    .from(schema.termsAcceptances)
    .where(
      and(
        eq(schema.termsAcceptances.userId, userId),
        eq(schema.termsAcceptances.document, terms.document),
        eq(schema.termsAcceptances.version, terms.version),
      ),
    );
  return row?.acceptedAt ?? null;
}

// Who a user's acceptance consents for: a caregiver consents for themselves; a family member for
// the active dependants they're the primary contact of (see the header). A caregiver user with no
// caregivers row (not registered as a caregiver yet) has no subject, since consent_records points
// at the caregivers row.
async function consentSubjectsOf(
  db: Pick<Db, 'select'>,
  userId: string,
  document: TermsDocumentType,
): Promise<ConsentSubject[]> {
  if (document === 'caregiver') {
    const rows = await db
      .select({ id: schema.caregivers.userId })
      .from(schema.caregivers)
      .where(eq(schema.caregivers.userId, userId));
    return rows.map((row) => ({ subjectType: 'caregiver', id: row.id }));
  }
  const rows = await db
    .select({ id: schema.dependants.id })
    .from(schema.dependantFamilyMembers)
    .innerJoin(
      schema.dependants,
      eq(schema.dependants.id, schema.dependantFamilyMembers.dependantId),
    )
    .where(
      and(
        eq(schema.dependantFamilyMembers.familyMemberUserId, userId),
        eq(schema.dependantFamilyMembers.isPrimaryContact, true),
        eq(schema.dependants.status, 'active'),
      ),
    );
  return rows.map((row) => ({ subjectType: 'dependant', id: row.id }));
}

export function createTermsRouter(dependencies: TermsRouterDependencies): Router {
  const router = Router();
  router.use(dependencies.requireAuth);

  // Resolves the caller's users row and current document, or sends the Problem and returns null.
  async function resolveCaller(
    db: Db,
    req: Parameters<RequestHandler>[0],
    res: Response,
  ): Promise<{ userId: string; terms: TermsDocument } | null> {
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return null;
    }
    const documentType = documentTypeFor(caller.role);
    if (!documentType) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'There are no app terms for this role.',
      });
      return null;
    }
    const user = await getUserByCognitoSub(db, caller.sub);
    if (!user) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Finish registering before accepting the terms.',
      });
      return null;
    }
    return { userId: user.id, terms: CURRENT_TERMS[documentType] };
  }

  router.get('/current', async (req, res, next) => {
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const resolved = await resolveCaller(db, req, res);
      if (!resolved) {
        return;
      }
      const acceptedAt = await acceptanceOf(db, resolved.userId, resolved.terms);
      const body: CurrentTermsResponse = {
        ...resolved.terms,
        acceptedAt: acceptedAt ? acceptedAt.toISOString() : null,
      };
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post('/current/accept', async (req, res, next) => {
    const body = parseOrSendProblem(acceptTermsRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const resolved = await resolveCaller(db, req, res);
      if (!resolved) {
        return;
      }
      const { userId, terms } = resolved;
      if (body.version !== terms.version) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'These terms have been updated. Please review the current version.',
        });
        return;
      }
      // Accepting again is harmless and keeps the original acceptance time (the table is
      // append-only, so the first record stands). One transaction, so an acceptance is never
      // recorded without the consent records it promises, or the other way round.
      await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.termsAcceptances)
          .values({
            userId,
            document: terms.document,
            version: terms.version,
            biometricConsent: body.biometricConsent,
            audioConsent: body.audioConsent,
          })
          .onConflictDoNothing()
          .returning();
        await grantConsents(tx, await consentSubjectsOf(tx, userId, terms.document), userId);
        // onConflictDoNothing means this exact version was already accepted (the table is
        // append-only) - a genuine no-op, so no audit row for it.
        if (inserted) {
          await recordAudit(tx, {
            actorUserId: userId,
            action: 'terms.accept',
            entityType: 'terms_acceptance',
            entityId: inserted.id,
            metadata: {
              document: terms.document,
              version: terms.version,
              consentTypesGranted: ['biometric_verification', 'audio_cognitive_monitoring'],
            },
          });
        }
      });
      const acceptedAt = await acceptanceOf(db, userId, terms);
      res.status(200).json({
        document: terms.document,
        version: terms.version,
        acceptedAt: acceptedAt?.toISOString() ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
