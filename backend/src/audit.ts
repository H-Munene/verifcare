import type { Db } from './db/client.js';
import * as schema from './db/schema.js';

// The audit trail (2026-09-27, the Compliance tab): who did what to which record, and when, for
// the Kenya Data Protection Act's accountability duties (s.41-42) and the Digital Health Act's
// s.33(2). The product owner chose to record every change, every compliance export, and reads of
// the most sensitive records (check-in photos, GPS and face scores), not changes alone.
//
// Written inside the same transaction as the change it describes, so a change that rolls back
// leaves no audit row and a committed change always has one. audit_log is append-only (trigger
// from 0002), so an entry can never be edited or removed afterwards.
//
// Actions are named `<entity>.<verb>` (e.g. `visit_schedule.update`, `consent.revoke`,
// `verification.view`), with `entityType` the table-level noun, so the audit screen can filter by
// either. Check-in steps aren't audited here: verification_attempts already records every one.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface AuditEntry {
  /** users.id of whoever did it; null for the system (a scheduled job). */
  actorUserId: string | null;
  action: string;
  entityType: string;
  /** null when the action covers no single record, e.g. an export of a whole period. */
  entityId: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? null,
  });
}

/**
 * The fields of [keys] whose values differ between [before] and [after], as `{ field: { from, to } }`,
 * for an update's audit metadata. Only the keys given are compared, so a caller lists the fields
 * that are safe to copy into the audit log and leaves out sensitive ones (ID numbers, photos, GPS),
 * which are then recorded only as changed via [redacted].
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: readonly (keyof T & string)[],
  redacted: readonly (keyof T & string)[] = [],
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of keys) {
    if (!sameValue(before[key], after[key])) {
      changes[key] = { from: plain(before[key]), to: plain(after[key]) };
    }
  }
  for (const key of redacted) {
    if (!sameValue(before[key], after[key])) {
      changes[key] = 'changed';
    }
  }
  return changes;
}

function plain(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}
