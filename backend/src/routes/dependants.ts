// POST/GET /dependants, GET/PATCH /dependants/{dependantId},
// POST/GET /dependants/{dependantId}/family-members,
// PATCH /dependants/{dependantId}/family-members/{userId} (HEZ-30).
//
// Ownership/RBAC rules (confirmed with the user before implementing, not assumed - see
// project-state.md's HEZ-30 entry for the full reasoning behind each):
// - caregiver is forbidden on every route in this file - caregiver-to-dependant visibility
//   belongs with visit scheduling (HEZ-32+), not this issue.
// - POST /dependants: supervisor or family_member. A non-supervisor caller may only name
//   themselves (primaryFamilyMember.cognitoSub === caller.sub) as the primary contact, mirroring
//   routes/users.ts's POST /users self-only rule.
// - GET /dependants (list) / GET /dependants/{id}: supervisor sees everything; family_member sees
//   only dependants linked to them via dependant_family_members.
// - PATCH /dependants/{id}: supervisor (any field, including status), or the dependant's
//   primary-contact family member (any field except status - offboarding stays supervisor-only,
//   mirroring PATCH /users). A linked-but-non-primary family member may not update at all.
// - POST /dependants/{id}/family-members: supervisor, or any existing linked family member of
//   that dependant - architecture.md's own stated rule ("later members are added by an existing
//   linked family member or by a supervisor").
// - GET /dependants/{id}/family-members: supervisor, or a family_member linked to that dependant.
// - PATCH /dependants/{id}/family-members/{userId}: supervisor-only. Architecture.md's rule above
//   only covers adding a new link, not editing one; the user chose the more conservative option
//   for editing.
//
// New-family-member-user handling (resolveFamilyMemberIdentity, shared by POST /dependants and
// POST /dependants/{id}/family-members - both need to resolve a submitted cognitoSub the same way):
// - No existing users row for that cognitoSub: assign the Cognito custom:role attribute
//   (cognitoAdmin.assignRole) BEFORE the DB insert, same ordering as routes/users.ts/
//   routes/caregivers.ts, so a failed insert still leaves a retry that can recover. This is
//   required for correctness, not just consistency: requireAuth/requireRole only ever read the
//   JWT's custom:role claim, never the DB, so a users row created without also setting this
//   attribute would leave that person permanently unable to authenticate as a family_member (and
//   unable to self-heal via POST /users, which would 409 on the now-existing cognitoSub).
// - An existing users row with a role other than family_member: reject with 409 - a
//   supervisor/caregiver account can't also be linked as a dependant's family contact.
// - An existing users row with role family_member: reuse it as-is. The request's phoneNumber/
//   fullName are only used when creating a brand-new row - an unrelated linking action must not
//   be able to silently overwrite someone else's own profile (editable only via that person's own
//   PATCH /users/{id}), which would reopen the same class of gap HEZ-29's privilege-escalation fix
//   closed.
//
// Reassigning isPrimaryContact to a different family member (via either the add-link or
// edit-link endpoint) auto-demotes the dependant's current primary contact in the same
// transaction - this is what openapi.yaml's own description of the PATCH endpoint already implies
// ("reassigning isPrimaryContact... enforced by a partial unique index").

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  isCognitoInvalidParameterError,
  isCognitoUserAlreadyExistsError,
  isCognitoUserNotFoundError,
  type CognitoAdmin,
} from '../auth/cognitoAdmin.js';
import { requireRole } from '../auth/middleware.js';
import { changedFields, recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { grantConsents, hasGivenTermsConsents } from '../db/consents.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { visitStatsFor } from '../db/visitStats.js';
import { sendProblem } from '../errors.js';
import {
  decodeCursor,
  keysetCondition,
  keysetOrder,
  paginate,
  resolveSort,
  type SortKey,
} from '../pagination.js';
import { E164_MESSAGE, E164_PHONE_NUMBER, parseOrSendProblem } from '../validation.js';
import { removeEnrollment } from '../voiceChecks.js';
import type { VoiceService } from '../voiceService.js';

export interface DependantsRouterDependencies {
  cognitoAdmin: CognitoAdmin;
  requireAuth: RequestHandler;
  // Deactivating a dependant deletes their voiceprint.
  voice: VoiceService;
}

interface DependantResponse {
  id: string;
  fullName: string;
  dob: string;
  gender: 'male' | 'female' | null;
  homeAddressText: string | null;
  primaryConditionSummary: string | null;
  county: string | null;
  constituency: string | null;
  ward: string | null;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusMeters: number;
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
    primaryConditionSummary: row.primaryConditionSummary,
    county: row.county,
    constituency: row.constituency,
    ward: row.ward,
    geofenceLat: row.geofenceLat,
    geofenceLng: row.geofenceLng,
    geofenceRadiusMeters: row.geofenceRadiusMeters,
    status: row.status,
    registeredBy: row.registeredBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface CareTaskResponse {
  id: string;
  dependantId: string;
  title: string;
  description: string | null;
  category: string | null;
  required: boolean;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function toCareTaskResponse(row: typeof schema.dependantCareTasks.$inferSelect): CareTaskResponse {
  return {
    id: row.id,
    dependantId: row.dependantId,
    title: row.title,
    description: row.description,
    category: row.category,
    required: row.required,
    active: row.active,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface DependantFamilyMemberResponse {
  dependantId: string;
  familyMemberUserId: string;
  fullName: string;
  relationship: string | null;
  isPrimaryContact: boolean;
  addedBy: string;
  createdAt: string;
  // The member's registration details (2026-09-26, user request: an expandable details section on
  // web and mobile). Email and phone go to everyone who can see the list - other family members of
  // the same dependant use them to coordinate care. The identity document goes to supervisors only
  // (user decision): another family member has no need for it, and a national ID number is
  // sensitive under the Kenya Data Protection Act, so it's left out of their response entirely
  // rather than merely hidden by the app.
  email: string | null;
  phoneNumber: string | null;
  addedByName: string | null;
  idType?: string | null;
  idNumber?: string | null;
}

/**
 * Builds family-member responses with each member's details and the name of whoever added them,
 * in one users query however many links. [includeIdentity]: only for a supervisor caller.
 */
async function familyMemberResponses(
  db: Db,
  links: (typeof schema.dependantFamilyMembers.$inferSelect)[],
  includeIdentity: boolean,
): Promise<DependantFamilyMemberResponse[]> {
  if (links.length === 0) {
    return [];
  }
  const userIds = [...new Set(links.flatMap((link) => [link.familyMemberUserId, link.addedBy]))];
  const people = new Map(
    (
      await db
        .select({
          id: schema.users.id,
          fullName: schema.users.fullName,
          email: schema.users.email,
          phoneNumber: schema.users.phoneNumber,
          idType: schema.users.idType,
          idNumber: schema.users.idNumber,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, userIds))
    ).map((person) => [person.id, person]),
  );
  return links.map((link) => {
    const member = people.get(link.familyMemberUserId);
    if (!member) {
      throw new Error(`No users row for linked family member ${link.familyMemberUserId}.`);
    }
    return {
      dependantId: link.dependantId,
      familyMemberUserId: link.familyMemberUserId,
      fullName: member.fullName,
      relationship: link.relationship,
      isPrimaryContact: link.isPrimaryContact,
      addedBy: link.addedBy,
      createdAt: link.createdAt.toISOString(),
      email: member.email,
      phoneNumber: member.phoneNumber,
      addedByName: people.get(link.addedBy)?.fullName ?? null,
      ...(includeIdentity && { idType: member.idType, idNumber: member.idNumber }),
    };
  });
}

async function familyMemberResponse(
  db: Db,
  link: typeof schema.dependantFamilyMembers.$inferSelect,
  includeIdentity: boolean,
): Promise<DependantFamilyMemberResponse> {
  const [response] = await familyMemberResponses(db, [link], includeIdentity);
  if (!response) {
    throw new Error('familyMemberResponses returned nothing for one link.');
  }
  return response;
}

// Explicit column map (not a bare .select()) so a joined query (the family_member branch of
// GET /dependants) returns the same flat shape as an unjoined one - same reasoning as
// routes/caregivers.ts's caregiverSelection().
function dependantColumns() {
  return {
    id: schema.dependants.id,
    fullName: schema.dependants.fullName,
    dob: schema.dependants.dob,
    gender: schema.dependants.gender,
    homeAddressText: schema.dependants.homeAddressText,
    primaryConditionSummary: schema.dependants.primaryConditionSummary,
    county: schema.dependants.county,
    constituency: schema.dependants.constituency,
    ward: schema.dependants.ward,
    geofenceLat: schema.dependants.geofenceLat,
    geofenceLng: schema.dependants.geofenceLng,
    geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
    status: schema.dependants.status,
    registeredBy: schema.dependants.registeredBy,
    createdAt: schema.dependants.createdAt,
    updatedAt: schema.dependants.updatedAt,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Exactly one of cognitoSub/email identifies the family member - cognitoSub links an identity
// that already exists in Cognito (resolved by the frontend's search-by-phone/email against our
// own users table, or supplied directly by any other caller that already knows it); email creates
// a brand-new Cognito identity from scratch for someone who has never touched Cognito at all
// (2026-09-14, extending the original cognitoSub-only design - see resolveFamilyMemberIdentity
// below for the full resolution rules for each).
const addFamilyMemberRequestSchema = z
  .object({
    cognitoSub: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(1),
    fullName: z.string().min(1),
    idType: z.enum(['national_id', 'passport']).optional(),
    idNumber: z.string().min(1).optional(),
    relationship: z.string().min(1).optional(),
    isPrimaryContact: z.boolean().default(false),
  })
  // Only enforced when email is set - that's the only path that actually calls Cognito's
  // AdminCreateUser with this value (see resolveFamilyMemberIdentity below); the cognitoSub path
  // (linking an existing identity) never uses body.phoneNumber at all, and the frontend resends
  // whatever that existing user's own stored phone number happens to be (possibly empty) - a field-
  // level regex here would wrongly reject linking an existing user over a value that's never used.
  .refine((data) => !data.email || E164_PHONE_NUMBER.test(data.phoneNumber), {
    message: E164_MESSAGE,
    path: ['phoneNumber'],
  })
  .refine((data) => Boolean(data.cognitoSub) !== Boolean(data.email), {
    message:
      'Provide exactly one of cognitoSub (link an existing identity) or email (create a new one).',
    path: ['cognitoSub'],
  })
  .refine((data) => Boolean(data.idType) === Boolean(data.idNumber), {
    message: 'idType and idNumber must be provided together.',
    path: ['idType'],
  })
  // Only enforced on the email path (registering a brand-new user, the admin web app's "New
  // user" mode) - the cognitoSub path can also create a brand-new `users` row (see
  // resolveFamilyMemberIdentity's own comment) for a Cognito identity that was created outside
  // this admin flow entirely, where the admin app never collects an ID document at all. Requiring
  // it unconditionally would reject that legitimate, already-exercised path.
  .refine((data) => !data.email || Boolean(data.idType), {
    message: 'idType and idNumber are required when registering a brand-new user by email.',
    path: ['idType'],
  });
type AddFamilyMemberBody = z.infer<typeof addFamilyMemberRequestSchema>;

const createDependantRequestSchema = z.object({
  fullName: z.string().min(1),
  dob: z.string().regex(DATE_ONLY, 'dob must be YYYY-MM-DD'),
  gender: z.enum(['male', 'female']).optional(),
  homeAddressText: z.string().min(1).optional(),
  primaryConditionSummary: z.string().min(1).optional(),
  // Required for every new registration (confirmed with the user, not assumed) - resolved
  // client-side in the admin web app as the geofence pin is placed, unlike homeAddressText's own
  // optional free-text treatment. Nullable at the DB level regardless (see schema.ts's comment).
  county: z.string().min(1),
  constituency: z.string().min(1),
  ward: z.string().min(1),
  geofenceLat: z.number(),
  geofenceLng: z.number(),
  geofenceRadiusMeters: z.number().int().min(1),
  primaryFamilyMember: addFamilyMemberRequestSchema,
});

const updateDependantRequestSchema = z.object({
  fullName: z.string().min(1).optional(),
  gender: z.enum(['male', 'female']).optional(),
  homeAddressText: z.string().min(1).optional(),
  primaryConditionSummary: z.string().min(1).optional(),
  county: z.string().min(1).optional(),
  constituency: z.string().min(1).optional(),
  ward: z.string().min(1).optional(),
  geofenceLat: z.number().optional(),
  geofenceLng: z.number().optional(),
  geofenceRadiusMeters: z.number().int().min(1).optional(),
  status: z.enum(['active', 'deactivated']).optional(),
});

const linkExistingMemberRequestSchema = z.object({
  email: z.string().trim().email(),
  relationship: z.string().trim().min(1).max(100).optional(),
});

const updateFamilyMemberRequestSchema = z.object({
  relationship: z.string().min(1).optional(),
  isPrimaryContact: z.boolean().optional(),
});

const careTaskIdParamSchema = z.string().uuid();

const createCareTaskRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  required: z.boolean().optional(),
});

const updateCareTaskRequestSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  required: z.boolean().optional(),
  active: z.boolean().optional(),
});

const listCareTasksQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

// Sortable columns (2026-09-26, the supervisor console's tables): "name" ascending, "-name"
// descending; without one the list keeps its id order.
const DEPENDANT_SORT_KEYS = {
  name: { expr: schema.dependants.fullName, cast: 'text' },
  dob: { expr: schema.dependants.dob, cast: 'date' },
} as const satisfies Record<string, SortKey>;

const listDependantsQuerySchema = z.object({
  status: z.enum(['active', 'deactivated']).optional(),
  sort: z.enum(['name', '-name', 'dob', '-dob']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Express 5's params type allows string | string[], so these aren't plain strings on their own -
// validated the same way any other input is, via parseOrSendProblem.
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

// Looks up whether callerSub is linked to dependantId, returning both the caller's own users row
// (needed by callers for addedBy/registeredBy-style columns) and the link row itself (needed to
// check isPrimaryContact). Returns undefined if the caller has no users row, or no link exists.
// Exported for the routers that need the exact same
// family_member-to-dependant ownership check, not a re-derived copy of it.
export async function findFamilyMemberLink(
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

// Shared by POST /dependants (primaryFamilyMember) and POST /dependants/{id}/family-members (the
// request body itself). Sends the appropriate 400/409 response itself and returns undefined on
// failure, matching validation.ts/auth/middleware.ts's established "send the response, return
// undefined" pattern. Two resolution paths, per the schema's cognitoSub-xor-email requirement:
//
// cognitoSub given (link an existing Cognito identity):
// - An existing users row with a role other than family_member: reject with 409 - a
//   supervisor/caregiver account can't also be linked as a dependant's family contact.
// - An existing users row with role family_member: reuse it as-is. The request's phoneNumber/
//   fullName are only used when creating a brand-new row - an unrelated linking action must not
//   be able to silently overwrite someone else's own profile (editable only via that person's own
//   PATCH /users/{id}), which would reopen the same class of gap HEZ-29's privilege-escalation fix
//   closed.
// - No existing users row for that cognitoSub: assign the Cognito custom:role attribute
//   (cognitoAdmin.assignRole) BEFORE the DB insert, same ordering as routes/users.ts/
//   routes/caregivers.ts, so a failed insert still leaves a retry that can recover. This is
//   required for correctness, not just consistency: requireAuth/requireRole only ever read the
//   JWT's custom:role claim, never the DB, so a users row created without also setting this
//   attribute would leave that person permanently unable to authenticate as a family_member.
//
// email given (create a brand-new Cognito identity from scratch, 2026-09-14):
// - An existing users row with that email: same existing-role-mismatch/reuse rules as the
//   cognitoSub path above - the DB is checked first specifically so a genuine match never reaches
//   Cognito at all (avoids creating an orphaned Cognito identity for an email that turns out to
//   already be registered here).
// - No existing users row: cognitoAdmin.createUser() creates the Cognito identity and sets
//   custom:role in the same call (no separate assignRole needed, unlike the cognitoSub path),
//   sends a real invitation email with a Cognito-generated temporary password. The new person
//   completes sign-in via the NEW_PASSWORD_REQUIRED flow the login page already handles.
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
    if (isCognitoInvalidParameterError(err)) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail:
          (err as { message?: string }).message ?? 'Cognito rejected one of the submitted fields.',
      });
      return undefined;
    }
    throw err;
  }
}

export function createDependantsRouter(dependencies: DependantsRouterDependencies): Router {
  const router = Router();
  const { cognitoAdmin, requireAuth } = dependencies;
  // caregiver is forbidden on every route in this file (see the file header comment); the one
  // route that's narrower still (supervisor-only) adds its own requireRole afterward.
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
            primaryConditionSummary: body.primaryConditionSummary,
            county: body.county,
            constituency: body.constituency,
            ward: body.ward,
            geofenceLat: body.geofenceLat,
            geofenceLng: body.geofenceLng,
            geofenceRadiusMeters: body.geofenceRadiusMeters,
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
              idType: resolved.body.idType,
              idNumber: resolved.body.idNumber,
              role: 'family_member',
            })
            .returning();
          if (!userRow) {
            throw new Error('Insert into users returned no row.');
          }
          familyMemberUserId = userRow.id;
        }

        // Always the primary contact, regardless of what primaryFamilyMember.isPrimaryContact
        // said - that's what makes this the *primary* family member, per openapi.yaml's own
        // description of this endpoint.
        await tx.insert(schema.dependantFamilyMembers).values({
          dependantId: dependant.id,
          familyMemberUserId,
          relationship: body.primaryFamilyMember.relationship,
          isPrimaryContact: true,
          addedBy: callerRow.id,
        });

        // A primary contact who ticked the consent boxes when accepting the family app's terms
        // consented for the dependants they register or are the primary contact for (see
        // routes/terms.ts's header), so this new dependant gets the same consent now, granted by
        // them - otherwise it couldn't be scheduled until they accepted the terms again. Applies
        // when a supervisor registers the dependant for them too, since the consent is theirs.
        if (await hasGivenTermsConsents(tx, familyMemberUserId)) {
          await grantConsents(
            tx,
            [{ subjectType: 'dependant', id: dependant.id }],
            familyMemberUserId,
          );
        }

        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'dependant.create',
          entityType: 'dependant',
          entityId: dependant.id,
          metadata: {
            county: dependant.county,
            constituency: dependant.constituency,
            ward: dependant.ward,
            primaryFamilyMemberId: familyMemberUserId,
          },
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
      const sort = resolveSort(query.sort, DEPENDANT_SORT_KEYS);
      if (query.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(query.cursor, sort?.param);
        } catch {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'Malformed cursor.',
          });
          return;
        }
        conditions.push(keysetCondition(schema.dependants.id, cursor, sort));
      }

      let rows;
      if (caller.role === 'supervisor') {
        rows = await db
          .select(dependantColumns())
          .from(schema.dependants)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(...keysetOrder(schema.dependants.id, sort))
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
          .orderBy(...keysetOrder(schema.dependants.id, sort))
          .limit(query.limit + 1);
      }

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({
        id: row.id,
        sort: sort?.param,
        value: sort ? (sort.param.endsWith('dob') ? row.dob : row.fullName) : undefined,
      }));
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

  // Visit statistics for the dependant's page (2026-09-27) - see db/visitStats.ts. The same
  // access rule as GET /:dependantId: a supervisor, or a family member linked to this dependant,
  // since these are facts about that dependant's own care.
  router.get('/:dependantId/stats', async (req, res, next) => {
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
        .select({ id: schema.dependants.id })
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
      res.status(200).json(await visitStatsFor(db, { dependantId }, new Date()));
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

      let actorRow: typeof schema.users.$inferSelect | undefined;
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
        // The primary contact may move the location (e.g. after a house move), but not the
        // radius: caregiver check-in is verified against it, so widening it would weaken that
        // check for every future visit (user decision 2026-09-24).
        if (body.geofenceRadiusMeters !== undefined) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'Only a supervisor may change a dependant’s geofence radius.',
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
        actorRow = found.callerRow;
      } else {
        actorRow = await getUserByCognitoSub(db, caller.sub);
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.dependants)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(schema.dependants.id, dependantId))
          .returning();
        if (!row) {
          throw new Error('Update to dependants returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: actorRow?.id ?? null,
          action: 'dependant.update',
          entityType: 'dependant',
          entityId: dependantId,
          metadata: changedFields(
            existing,
            row,
            [
              'fullName',
              'gender',
              'homeAddressText',
              'primaryConditionSummary',
              'county',
              'constituency',
              'ward',
              'geofenceRadiusMeters',
              'status',
            ],
            // Geofence coordinates are GPS data - never copied into the log verbatim.
            ['geofenceLat', 'geofenceLng'],
          ),
        });
        return row;
      });
      if (updated.status === 'deactivated' && existing.status !== 'deactivated') {
        await removeEnrollment(db, dependencies.voice, {
          subjectType: 'dependant',
          id: dependantId,
        });
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
        // Adding someone as primary demotes the current primary contact (below), and editing an
        // existing link is supervisor-only - so a non-primary member must not be able to take that
        // role away from the current primary contact by this route instead.
        if (body.isPrimaryContact && !found.link.isPrimaryContact) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail:
              'Only a supervisor or the current primary contact may add a family member as the primary contact.',
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
              idType: resolved.body.idType,
              idNumber: resolved.body.idNumber,
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
        await recordAudit(tx, {
          actorUserId: callerRowId,
          action: 'family_member.add',
          entityType: 'family_member',
          entityId: familyMemberUserId,
          metadata: {
            dependantId,
            relationship: body.relationship ?? null,
            isPrimaryContact: body.isPrimaryContact,
          },
        });
        return row;
      });

      res.status(201).json(await familyMemberResponse(db, link, caller.role === 'supervisor'));
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

  // POST /dependants/{id}/family-members/link (2026-09-26): the primary contact links someone who
  // already has a Mzazi Care account, found by their exact email, straight away - no request or
  // approval, since the primary contact is the one who would approve it. Someone without an
  // account is told to sign up and send a link request instead (routes/familyLinkRequests.ts).
  // Unlike POST .../family-members above, this never creates an account or a Cognito identity -
  // that path is the supervisor's "New user" flow. Answering "no account uses that email" does
  // reveal whether an email is registered, but only to a dependant's primary contact, and it is
  // what linking by email needs.
  router.post('/:dependantId/family-members/link', async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
      return;
    }
    const body = parseOrSendProblem(linkExistingMemberRequestSchema, req.body, res);
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
      const found = await findFamilyMemberLink(db, dependantId, caller.sub);
      if (!found?.link.isPrimaryContact) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: "Only the dependant's primary contact can link family members.",
        });
        return;
      }
      const [member] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            eq(sql`lower(${schema.users.email})`, body.email.toLowerCase()),
            eq(schema.users.role, 'family_member'),
          ),
        );
      if (!member) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail:
            'No VerifCare account uses that email. They can create an account in the app and ask you to link them.',
        });
        return;
      }
      const link = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.dependantFamilyMembers)
          .values({
            dependantId,
            familyMemberUserId: member.id,
            relationship: body.relationship ?? null,
            isPrimaryContact: false,
            addedBy: found.callerRow.id,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          return undefined;
        }
        await recordAudit(tx, {
          actorUserId: found.callerRow.id,
          action: 'family_member.link',
          entityType: 'family_member',
          entityId: member.id,
          metadata: { dependantId, relationship: body.relationship ?? null },
        });
        return inserted;
      });
      if (!link) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'That person is already linked to this dependant.',
        });
        return;
      }
      res.status(201).json(await familyMemberResponse(db, link, false));
    } catch (err) {
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

      const links = await db
        .select()
        .from(schema.dependantFamilyMembers)
        .where(eq(schema.dependantFamilyMembers.dependantId, dependantId));
      res.status(200).json(await familyMemberResponses(db, links, caller.role === 'supervisor'));
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
      const caller = req.auth;
      if (!caller) {
        sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
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
        // A read, so it needn't be inside the transaction below - this route is supervisor-only.
        const actorRow = await getUserByCognitoSub(db, caller.sub);

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
          if (!row) {
            return undefined;
          }
          await recordAudit(tx, {
            actorUserId: actorRow?.id ?? null,
            action: 'family_member.update',
            entityType: 'family_member',
            entityId: familyMemberUserId,
            metadata: changedFields(existing, row, ['relationship', 'isPrimaryContact']),
          });
          return row;
        });
        if (!updated) {
          throw new Error('Update to dependant_family_members returned no row.');
        }
        // Supervisor-only route (requireRole above).
        res.status(200).json(await familyMemberResponse(db, updated, true));
      } catch (err) {
        next(err);
      }
    },
  );

  // Visit task checklist (docs/visit-task-checklist-plan.md) - the care plan itself. Authoring
  // (POST/PATCH) is supervisor-only, matching the user's own "these will be defined by the
  // supervisor" confirmation; GET reuses this router's own broader gate (supervisor,
  // family_member) plus the same ownership check GET /:dependantId already uses, so a family
  // member can see the care plan for a dependant they're linked to, not author it.

  router.post('/:dependantId/care-tasks', requireRole('supervisor'), async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
      return;
    }
    const body = parseOrSendProblem(createCareTaskRequestSchema, req.body, res);
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
        .select({ id: schema.dependants.id })
        .from(schema.dependants)
        .where(eq(schema.dependants.id, dependantId));
      if (!dependant) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.dependantCareTasks)
          .values({
            id: uuidv7(),
            dependantId,
            title: body.title,
            description: body.description,
            category: body.category,
            required: body.required,
            createdBy: callerRow.id,
          })
          .returning();
        if (!inserted) {
          throw new Error('Insert into dependant_care_tasks returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'care_task.create',
          entityType: 'care_task',
          entityId: inserted.id,
          metadata: {
            dependantId,
            title: inserted.title,
            category: inserted.category,
            required: inserted.required,
          },
        });
        return inserted;
      });
      res.status(201).json(toCareTaskResponse(row));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:dependantId/care-tasks', async (req, res, next) => {
    const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
    if (!dependantId) {
      return;
    }
    const query = parseOrSendProblem(listCareTasksQuerySchema, req.query, res);
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
      const [dependant] = await db
        .select({ id: schema.dependants.id })
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

      const conditions = [eq(schema.dependantCareTasks.dependantId, dependantId)];
      if (query.active !== undefined) {
        conditions.push(eq(schema.dependantCareTasks.active, query.active));
      }
      const rows = await db
        .select()
        .from(schema.dependantCareTasks)
        .where(and(...conditions))
        .orderBy(asc(schema.dependantCareTasks.createdAt));
      res.status(200).json(rows.map(toCareTaskResponse));
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    '/:dependantId/care-tasks/:careTaskId',
    requireRole('supervisor'),
    async (req, res, next) => {
      const dependantId = parseOrSendProblem(dependantIdParamSchema, req.params.dependantId, res);
      if (!dependantId) {
        return;
      }
      const careTaskId = parseOrSendProblem(careTaskIdParamSchema, req.params.careTaskId, res);
      if (!careTaskId) {
        return;
      }
      const body = parseOrSendProblem(updateCareTaskRequestSchema, req.body, res);
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
          .from(schema.dependantCareTasks)
          .where(
            and(
              eq(schema.dependantCareTasks.id, careTaskId),
              eq(schema.dependantCareTasks.dependantId, dependantId),
            ),
          );
        if (!existing) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }
        // A read, so it needn't be inside the transaction below - this route is supervisor-only.
        const actorRow = await getUserByCognitoSub(db, caller.sub);

        const row = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(schema.dependantCareTasks)
            .set(body)
            .where(
              and(
                eq(schema.dependantCareTasks.id, careTaskId),
                eq(schema.dependantCareTasks.dependantId, dependantId),
              ),
            )
            .returning();
          if (!updated) {
            return undefined;
          }
          await recordAudit(tx, {
            actorUserId: actorRow?.id ?? null,
            action: 'care_task.update',
            entityType: 'care_task',
            entityId: careTaskId,
            metadata: changedFields(existing, updated, [
              'title',
              'description',
              'category',
              'required',
              'active',
            ]),
          });
          return updated;
        });
        if (!row) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }
        res.status(200).json(toCareTaskResponse(row));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
