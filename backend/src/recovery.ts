// Automatic missed-visit recovery (2026-11-09). Runs from the same scheduled Lambda as the
// missed-visit sweep.
//
// The sweep only marks a visit missed after its scheduled end, which is too late to send anyone. So
// recovery starts earlier, at the point a check-in counts as late, while there is still time.
//
// One offer goes out at a time, to the nearest eligible caregiver, and passes to the next if it
// expires or is declined. "Nearest" is measured from where the caregiver last checked in or out
// today, then from their registered home base (user decision): no live tracking of staff.
//
// The original visit isn't touched until someone accepts, so if its caregiver turns up late they
// can still check in, and the next run closes the case and withdraws any offer.

import { and, asc, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { Db } from './db/client.js';
import { LATE_CHECKIN_TOLERANCE_MINUTES } from './db/complianceReports.js';
import { subjectsWithActiveConsent } from './db/consents.js';
import * as schema from './db/schema.js';
import { haversineDistanceMeters } from './geo.js';
import { dayStart, nairobiDate } from './nairobiTime.js';
import { travelMinutes } from './planning/plan.js';

export const OFFER_MINUTES = 5;
export const MAX_OFFERS = 3;

// Mirrors the overlap constraints' WHERE clause, so a caregiver who looks free here can't then be
// refused by the database when they accept.
const STATUSES_NOT_OCCUPYING = ['cancelled', 'reassigned'];

const ROUNDING_MS = 5 * 60_000;

type Case = typeof schema.visitRecoveryCases.$inferSelect;
type Visit = typeof schema.visitSchedules.$inferSelect;

export interface Candidate {
  caregiverId: string;
  distanceMeters: number;
  proposedStart: Date;
  proposedEnd: Date;
}

/** Where each caregiver is believed to be: their latest check-in or check-out today, else base. */
async function lastKnownPositions(
  db: Db,
  caregiverIds: string[],
  now: Date,
): Promise<Map<string, { lat: number; lng: number }>> {
  const positions = new Map<string, { lat: number; lng: number }>();
  const caregivers = await db
    .select({
      id: schema.caregivers.userId,
      lat: schema.caregivers.baseLat,
      lng: schema.caregivers.baseLng,
    })
    .from(schema.caregivers)
    .where(inArray(schema.caregivers.userId, caregiverIds));
  for (const { id, lat, lng } of caregivers) {
    if (lat !== null && lng !== null) {
      positions.set(id, { lat, lng });
    }
  }

  const events = await db
    .select({
      caregiverId: schema.visitSchedules.caregiverId,
      checkinAt: schema.verificationEvents.checkinAt,
      checkoutAt: schema.verificationEvents.checkoutAt,
      checkinLat: schema.verificationEvents.checkinGpsLat,
      checkinLng: schema.verificationEvents.checkinGpsLng,
      checkoutLat: schema.verificationEvents.checkoutGpsLat,
      checkoutLng: schema.verificationEvents.checkoutGpsLng,
    })
    .from(schema.verificationEvents)
    .innerJoin(
      schema.visitSchedules,
      eq(schema.visitSchedules.id, schema.verificationEvents.visitScheduleId),
    )
    .where(
      and(
        inArray(schema.visitSchedules.caregiverId, caregiverIds),
        gt(schema.verificationEvents.checkinAt, dayStart(nairobiDate(now))),
      ),
    )
    .orderBy(asc(schema.verificationEvents.checkinAt));
  // Oldest first, so the latest of the day is the one left standing.
  for (const event of events) {
    const out = event.checkoutAt && event.checkoutLat !== null && event.checkoutLng !== null;
    const lat = out ? event.checkoutLat : event.checkinLat;
    const lng = out ? event.checkoutLng : event.checkinLng;
    if (lat !== null && lng !== null) {
      positions.set(event.caregiverId, { lat, lng });
    }
  }
  return positions;
}

/** Everyone who could cover [visit], nearest first. */
export async function rankCandidates(
  db: Db,
  visit: Visit,
  alreadyOffered: string[],
  now: Date,
): Promise<Candidate[]> {
  const eligible = await db
    .select({ id: schema.caregivers.userId })
    .from(schema.caregivers)
    .innerJoin(schema.users, eq(schema.users.id, schema.caregivers.userId))
    .where(
      and(
        eq(schema.caregivers.active, true),
        eq(schema.users.status, 'active'),
        notInArray(schema.caregivers.userId, [visit.caregiverId, ...alreadyOffered]),
      ),
    );
  const ids = eligible.map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }

  const [consented, positions, [dependant], busy] = await Promise.all([
    subjectsWithActiveConsent(
      db,
      ids.map((id) => ({ subjectType: 'caregiver' as const, id })),
      'location_verification',
    ),
    lastKnownPositions(db, ids, now),
    db
      .select({
        lat: schema.dependants.geofenceLat,
        lng: schema.dependants.geofenceLng,
      })
      .from(schema.dependants)
      .where(eq(schema.dependants.id, visit.dependantId)),
    db
      .select({
        caregiverId: schema.visitSchedules.caregiverId,
        start: schema.visitSchedules.scheduledStart,
        end: schema.visitSchedules.scheduledEnd,
      })
      .from(schema.visitSchedules)
      .where(
        and(
          inArray(schema.visitSchedules.caregiverId, ids),
          notInArray(schema.visitSchedules.status, STATUSES_NOT_OCCUPYING),
          gt(schema.visitSchedules.scheduledEnd, now),
        ),
      ),
  ]);
  if (!dependant) {
    throw new Error(`visit_schedules ${visit.id} references a nonexistent dependant.`);
  }

  const lengthMs = visit.scheduledEnd.getTime() - visit.scheduledStart.getTime();
  const candidates: Candidate[] = [];
  for (const id of ids) {
    const position = positions.get(id);
    if (!position || !consented.has(id)) {
      continue;
    }
    const distanceMeters = haversineDistanceMeters(
      position.lat,
      position.lng,
      dependant.lat,
      dependant.lng,
    );
    const start =
      Math.ceil((now.getTime() + travelMinutes(distanceMeters) * 60_000) / ROUNDING_MS) *
      ROUNDING_MS;
    const proposedStart = new Date(start);
    const proposedEnd = new Date(start + lengthMs);
    const clashes = busy.some(
      (v) => v.caregiverId === id && v.start < proposedEnd && v.end > proposedStart,
    );
    if (!clashes) {
      candidates.push({ caregiverId: id, distanceMeters, proposedStart, proposedEnd });
    }
  }
  return candidates.sort(
    (a, b) => a.distanceMeters - b.distanceMeters || a.caregiverId.localeCompare(b.caregiverId),
  );
}

async function closeCase(
  db: Db,
  recoveryCase: Case,
  status: 'exhausted' | 'closed',
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.visitRecoveryCases)
      .set({ status, closedAt: now })
      .where(eq(schema.visitRecoveryCases.id, recoveryCase.id));
    await tx
      .update(schema.visitRecoveryOffers)
      .set({ status: 'withdrawn', respondedAt: now })
      .where(
        and(
          eq(schema.visitRecoveryOffers.caseId, recoveryCase.id),
          eq(schema.visitRecoveryOffers.status, 'offered'),
        ),
      );
    if (status === 'exhausted') {
      await tx.insert(schema.notificationLog).values({
        type: 'no_cover_found',
        visitScheduleId: recoveryCase.visitScheduleId,
        recipientUserId: null,
        channel: 'in_app',
        sentAt: now,
      });
    }
    await recordAudit(tx, {
      actorUserId: null,
      action: status === 'exhausted' ? 'visit_recovery.no_cover' : 'visit_recovery.close',
      entityType: 'visit_schedule',
      entityId: recoveryCase.visitScheduleId,
      metadata: { caseId: recoveryCase.id },
    });
  });
}

/** Sends the next offer for an open case, or gives up if there is nobody left to ask. */
export async function offerNext(db: Db, recoveryCase: Case, now: Date): Promise<void> {
  const previous = await db
    .select({
      caregiverId: schema.visitRecoveryOffers.caregiverId,
      status: schema.visitRecoveryOffers.status,
    })
    .from(schema.visitRecoveryOffers)
    .where(eq(schema.visitRecoveryOffers.caseId, recoveryCase.id));
  if (previous.some((offer) => offer.status === 'offered')) {
    return;
  }
  const [visit] = await db
    .select()
    .from(schema.visitSchedules)
    .where(eq(schema.visitSchedules.id, recoveryCase.visitScheduleId));
  if (!visit) {
    throw new Error(`Recovery case ${recoveryCase.id} references a nonexistent visit.`);
  }

  const next =
    previous.length >= MAX_OFFERS
      ? undefined
      : (
          await rankCandidates(
            db,
            visit,
            previous.map((offer) => offer.caregiverId),
            now,
          )
        )[0];
  if (!next) {
    await closeCase(db, recoveryCase, 'exhausted', now);
    return;
  }
  await db.transaction(async (tx) => {
    const [offer] = await tx
      .insert(schema.visitRecoveryOffers)
      .values({
        caseId: recoveryCase.id,
        caregiverId: next.caregiverId,
        rank: previous.length + 1,
        distanceMeters: next.distanceMeters,
        proposedStart: next.proposedStart,
        proposedEnd: next.proposedEnd,
        offeredAt: now,
        expiresAt: new Date(now.getTime() + OFFER_MINUTES * 60_000),
      })
      .returning({ id: schema.visitRecoveryOffers.id });
    await recordAudit(tx, {
      actorUserId: null,
      action: 'visit_recovery.offer',
      entityType: 'visit_schedule',
      entityId: recoveryCase.visitScheduleId,
      metadata: {
        offerId: offer?.id,
        caregiverId: next.caregiverId,
        rank: previous.length + 1,
        distanceMeters: Math.round(next.distanceMeters),
      },
    });
  });
}

/** One pass: expire stale offers, close cases that resolved themselves, open new ones, re-offer. */
export async function runVisitRecovery(
  db: Db,
  now: Date = new Date(),
): Promise<{ opened: number; open: number }> {
  await db
    .update(schema.visitRecoveryOffers)
    .set({ status: 'expired', respondedAt: now })
    .where(
      and(
        eq(schema.visitRecoveryOffers.status, 'offered'),
        lt(schema.visitRecoveryOffers.expiresAt, now),
      ),
    );

  const lateBefore = new Date(now.getTime() - LATE_CHECKIN_TOLERANCE_MINUTES * 60_000);
  const opened = await db
    .insert(schema.visitRecoveryCases)
    .select(
      db
        .select({
          id: sql`uuid_generate_v7()`.as('id'),
          visitScheduleId: schema.visitSchedules.id,
          status: sql`'open'`.as('status'),
          replacementVisitId: sql`null::uuid`.as('replacement_visit_id'),
          openedAt: sql`${now.toISOString()}::timestamptz`.as('opened_at'),
          closedAt: sql`null::timestamptz`.as('closed_at'),
        })
        .from(schema.visitSchedules)
        .leftJoin(
          schema.visitRecoveryCases,
          eq(schema.visitRecoveryCases.visitScheduleId, schema.visitSchedules.id),
        )
        .where(
          and(
            eq(schema.visitSchedules.status, 'scheduled'),
            lt(schema.visitSchedules.scheduledStart, lateBefore),
            gt(schema.visitSchedules.scheduledEnd, now),
            isNull(schema.visitRecoveryCases.id),
          ),
        ),
    )
    .onConflictDoNothing()
    .returning({ visitScheduleId: schema.visitRecoveryCases.visitScheduleId });
  for (const { visitScheduleId } of opened) {
    await recordAudit(db, {
      actorUserId: null,
      action: 'visit_recovery.open',
      entityType: 'visit_schedule',
      entityId: visitScheduleId,
    });
  }

  const openCases = await db
    .select({ recoveryCase: schema.visitRecoveryCases, visitStatus: schema.visitSchedules.status })
    .from(schema.visitRecoveryCases)
    .innerJoin(
      schema.visitSchedules,
      eq(schema.visitSchedules.id, schema.visitRecoveryCases.visitScheduleId),
    )
    .where(eq(schema.visitRecoveryCases.status, 'open'));
  for (const { recoveryCase, visitStatus } of openCases) {
    // Checked in late, cancelled, or swept as missed: nothing left to cover.
    if (visitStatus !== 'scheduled') {
      await closeCase(db, recoveryCase, 'closed', now);
    } else {
      await offerNext(db, recoveryCase, now);
    }
  }
  return { opened: opened.length, open: openCases.length };
}
