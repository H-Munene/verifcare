// Family link requests (2026-09-26, user request) - how a family member who isn't linked yet asks
// to join a dependant's family, through the dependant's primary contact:
//
//   Requester app -> POST /family-link-requests (primary contact's email or phone)
//   Primary contact app -> GET /family-link-requests (incoming) -> POST .../{id}/approve|reject
//   Requester app -> GET /family-link-requests (outcome) -> POST .../outcomes/seen
//
// Nothing about who is registered is revealed to the requester (user decision): the request is
// accepted with the same answer whatever the contact is, stored, and listed back to them as
// pending. It only reaches anyone when the contact belonged to a primary contact at the time
// (primaryContactUserId). The primary contact picks which of their dependants to link when
// approving, so dependants' names are never shown to someone before they're linked. The outcome
// stays an unread in-app notification for the requester until they've seen it.
//
// A supervisor linking someone during registration, or a primary contact linking an existing
// account by email (POST /dependants/{id}/family-members/link), needs no request - see
// routes/dependants.ts.

import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.js';
import { recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';

export interface FamilyLinkRequestsRouterDependencies {
  requireAuth: RequestHandler;
}

// E.164, the same rule dependants.ts applies to phone numbers (the app normalizes a local Kenyan
// number before sending).
const e164 = /^\+[1-9]\d{1,14}$/;

const createRequestSchema = z.object({
  contact: z
    .string()
    .trim()
    .min(1)
    .refine((value) => e164.test(value) || z.string().email().safeParse(value).success, {
      message: "contact must be the primary contact's email address or E.164 phone number.",
    }),
  relationship: z.string().trim().min(1).max(100).optional(),
});

const approveRequestSchema = z.object({
  dependantIds: z.array(z.string().uuid()).min(1),
});

const requestIdParamSchema = z.string().uuid();

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

// Emails compare case-insensitively (Cognito keeps whatever case was typed at sign-up).
function normalizeContact(contact: string): string {
  return e164.test(contact) ? contact : contact.toLowerCase();
}

/** The dependants [userId] is the primary contact of, active ones only. */
async function primaryDependantsOf(db: Db, userId: string) {
  return db
    .select({ id: schema.dependants.id, fullName: schema.dependants.fullName })
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
    )
    .orderBy(schema.dependants.fullName);
}

export function createFamilyLinkRequestsRouter(
  dependencies: FamilyLinkRequestsRouterDependencies,
): Router {
  const router = Router();
  router.use(dependencies.requireAuth, requireRole('family_member'));

  async function callerRow(db: Db, req: Parameters<RequestHandler>[0], res: Response) {
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return null;
    }
    const row = await getUserByCognitoSub(db, caller.sub);
    if (!row) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Finish registering first.',
      });
      return null;
    }
    return row;
  }

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const requester = await callerRow(db, req, res);
      if (!requester) {
        return;
      }
      const targetContact = normalizeContact(body.contact);

      // Resolve the contact only if it belongs to someone else who is a primary contact now.
      const [target] = await db
        .selectDistinct({ id: schema.users.id })
        .from(schema.users)
        .innerJoin(
          schema.dependantFamilyMembers,
          eq(schema.dependantFamilyMembers.familyMemberUserId, schema.users.id),
        )
        .innerJoin(
          schema.dependants,
          eq(schema.dependants.id, schema.dependantFamilyMembers.dependantId),
        )
        .where(
          and(
            or(
              eq(sql`lower(${schema.users.email})`, targetContact),
              eq(schema.users.phoneNumber, targetContact),
            ),
            ne(schema.users.id, requester.id),
            eq(schema.dependantFamilyMembers.isPrimaryContact, true),
            eq(schema.dependants.status, 'active'),
          ),
        );

      // Asking again while a request is open keeps the one request rather than adding another.
      await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.familyLinkRequests)
          .values({
            requesterUserId: requester.id,
            targetContact,
            primaryContactUserId: target?.id ?? null,
            relationship: body.relationship ?? null,
          })
          .onConflictDoNothing()
          .returning();
        // onConflictDoNothing means a request to the same contact is already open - a genuine
        // no-op, so no audit row for it.
        if (inserted) {
          await recordAudit(tx, {
            actorUserId: requester.id,
            action: 'family_link_request.create',
            entityType: 'family_link_request',
            entityId: inserted.id,
            // targetContact is an email/phone number - never copied into the log verbatim.
          });
        }
      });

      // The same answer whatever happened above.
      res.status(202).json({
        detail: "If that person is a dependant's primary contact, they'll get your request.",
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const me = await callerRow(db, req, res);
      if (!me) {
        return;
      }

      // Incoming: open requests addressed to the caller, with who is asking and which of the
      // caller's dependants they could be linked to.
      const incomingRows = await db
        .select({ request: schema.familyLinkRequests, requester: schema.users })
        .from(schema.familyLinkRequests)
        .innerJoin(schema.users, eq(schema.users.id, schema.familyLinkRequests.requesterUserId))
        .where(
          and(
            eq(schema.familyLinkRequests.primaryContactUserId, me.id),
            eq(schema.familyLinkRequests.status, 'pending'),
          ),
        )
        .orderBy(desc(schema.familyLinkRequests.createdAt));
      const myDependants = incomingRows.length > 0 ? await primaryDependantsOf(db, me.id) : [];
      const requesterIds = incomingRows.map((row) => row.requester.id);
      const existingLinks =
        requesterIds.length > 0 && myDependants.length > 0
          ? await db
              .select({
                dependantId: schema.dependantFamilyMembers.dependantId,
                userId: schema.dependantFamilyMembers.familyMemberUserId,
              })
              .from(schema.dependantFamilyMembers)
              .where(
                and(
                  inArray(schema.dependantFamilyMembers.familyMemberUserId, requesterIds),
                  inArray(
                    schema.dependantFamilyMembers.dependantId,
                    myDependants.map((d) => d.id),
                  ),
                ),
              )
          : [];
      const linked = new Set(existingLinks.map((l) => `${l.userId}:${l.dependantId}`));

      // Outgoing: everything the caller has asked for, newest first.
      const outgoingRows = await db
        .select()
        .from(schema.familyLinkRequests)
        .where(eq(schema.familyLinkRequests.requesterUserId, me.id))
        .orderBy(desc(schema.familyLinkRequests.createdAt));
      const linkedIds = [...new Set(outgoingRows.flatMap((row) => row.linkedDependantIds ?? []))];
      const linkedNames = new Map(
        linkedIds.length > 0
          ? (
              await db
                .select({ id: schema.dependants.id, fullName: schema.dependants.fullName })
                .from(schema.dependants)
                .where(inArray(schema.dependants.id, linkedIds))
            ).map((d) => [d.id, d.fullName])
          : [],
      );

      res.status(200).json({
        incoming: incomingRows.map(({ request, requester }) => ({
          id: request.id,
          requester: {
            fullName: requester.fullName,
            email: requester.email,
            phoneNumber: requester.phoneNumber,
          },
          relationship: request.relationship,
          createdAt: request.createdAt.toISOString(),
          dependants: myDependants.map((d) => ({
            id: d.id,
            fullName: d.fullName,
            alreadyLinked: linked.has(`${requester.id}:${d.id}`),
          })),
        })),
        outgoing: outgoingRows.map((request) => ({
          id: request.id,
          targetContact: request.targetContact,
          relationship: request.relationship,
          status: request.status,
          createdAt: request.createdAt.toISOString(),
          decidedAt: request.decidedAt?.toISOString() ?? null,
          // A decided request the requester hasn't seen yet is an unread notification.
          unread: request.status !== 'pending' && request.requesterSeenAt === null,
          linkedDependants: (request.linkedDependantIds ?? []).flatMap((id) => {
            const fullName = linkedNames.get(id);
            return fullName ? [{ id, fullName }] : [];
          }),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Loads an open request addressed to the caller, or sends 404 (another primary contact's
  // request looks the same as a missing one) / 409 (already decided).
  async function openRequestFor(db: Db, id: string, meId: string, res: Response) {
    const [request] = await db
      .select()
      .from(schema.familyLinkRequests)
      .where(
        and(
          eq(schema.familyLinkRequests.id, id),
          eq(schema.familyLinkRequests.primaryContactUserId, meId),
        ),
      );
    if (!request) {
      sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
      return null;
    }
    if (request.status !== 'pending') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This request has already been answered.',
      });
      return null;
    }
    return request;
  }

  router.post('/:requestId/approve', async (req, res, next) => {
    const requestId = parseOrSendProblem(requestIdParamSchema, req.params.requestId, res);
    if (!requestId) {
      return;
    }
    const body = parseOrSendProblem(approveRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const me = await callerRow(db, req, res);
      if (!me) {
        return;
      }
      const request = await openRequestFor(db, requestId, me.id, res);
      if (!request) {
        return;
      }
      // Only dependants the caller is still the primary contact of - the role may have moved on
      // since the request arrived.
      const mine = new Set((await primaryDependantsOf(db, me.id)).map((d) => d.id));
      const dependantIds = [...new Set(body.dependantIds)];
      if (dependantIds.some((id) => !mine.has(id))) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'You can only link people to dependants you are the primary contact of.',
        });
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .insert(schema.dependantFamilyMembers)
          .values(
            dependantIds.map((dependantId) => ({
              dependantId,
              familyMemberUserId: request.requesterUserId,
              relationship: request.relationship,
              isPrimaryContact: false,
              addedBy: me.id,
            })),
          )
          // Already linked to one of them (e.g. by a supervisor meanwhile) - leave that link as is.
          .onConflictDoNothing();
        await tx
          .update(schema.familyLinkRequests)
          .set({ status: 'approved', linkedDependantIds: dependantIds, decidedAt: new Date() })
          .where(eq(schema.familyLinkRequests.id, request.id));
        await recordAudit(tx, {
          actorUserId: me.id,
          action: 'family_link_request.approve',
          entityType: 'family_link_request',
          entityId: request.id,
          metadata: { requesterUserId: request.requesterUserId, dependantIds },
        });
      });
      res
        .status(200)
        .json({ id: request.id, status: 'approved', linkedDependantIds: dependantIds });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:requestId/reject', async (req, res, next) => {
    const requestId = parseOrSendProblem(requestIdParamSchema, req.params.requestId, res);
    if (!requestId) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const me = await callerRow(db, req, res);
      if (!me) {
        return;
      }
      const request = await openRequestFor(db, requestId, me.id, res);
      if (!request) {
        return;
      }
      await db.transaction(async (tx) => {
        await tx
          .update(schema.familyLinkRequests)
          .set({ status: 'rejected', decidedAt: new Date() })
          .where(eq(schema.familyLinkRequests.id, request.id));
        await recordAudit(tx, {
          actorUserId: me.id,
          action: 'family_link_request.reject',
          entityType: 'family_link_request',
          entityId: request.id,
          metadata: { requesterUserId: request.requesterUserId },
        });
      });
      res.status(200).json({ id: request.id, status: 'rejected' });
    } catch (err) {
      next(err);
    }
  });

  // The requester has seen their outcomes (opened the notifications sheet), so they stop counting
  // as unread.
  router.post('/outcomes/seen', async (req, res, next) => {
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const me = await callerRow(db, req, res);
      if (!me) {
        return;
      }
      await db
        .update(schema.familyLinkRequests)
        .set({ requesterSeenAt: new Date() })
        .where(
          and(
            eq(schema.familyLinkRequests.requesterUserId, me.id),
            isNotNull(schema.familyLinkRequests.decidedAt),
            isNull(schema.familyLinkRequests.requesterSeenAt),
          ),
        );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
