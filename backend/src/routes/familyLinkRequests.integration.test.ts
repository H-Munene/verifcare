// Integration tests for family link requests and POST /dependants/{id}/family-members/link against
// a real local Postgres, using the same test-auth-header pattern as the other route tests. The
// point is the real routing (only a primary contact's contact resolves), the no-leak answer, and
// the link rows approval creates.

import { eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import { createFakeVoiceService } from '../voiceService.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createDependantsRouter } from './dependants.js';
import { createFamilyLinkRequestsRouter } from './familyLinkRequests.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function auth(sub: string, role: UserRole = 'family_member'): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface RequestsBody {
  incoming: {
    id: string;
    requester: { fullName: string; email: string | null; phoneNumber: string | null };
    relationship: string | null;
    dependants: { id: string; fullName: string; alreadyLinked: boolean }[];
  }[];
  outgoing: {
    id: string;
    targetContact: string;
    status: string;
    unread: boolean;
    linkedDependants: { id: string; fullName: string }[];
  }[];
}

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = getDb();
  const requireAuth: express.RequestHandler = (req, res, next) => {
    const header = req.headers['x-test-auth'];
    if (typeof header !== 'string') {
      res.status(401).json({ title: 'Unauthorized' });
      return;
    }
    req.auth = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AuthenticatedUser;
    next();
  };
  app.use('/family-link-requests', createFamilyLinkRequestsRouter({ requireAuth }));
  app.use(
    '/dependants',
    createDependantsRouter({
      voice: createFakeVoiceService(),
      requireAuth,
      cognitoAdmin: {
        assignRole: () => Promise.resolve(),
        createUser: () => Promise.reject(new Error('not used')),
      },
    }),
  );
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

async function user(
  sub: string,
  phoneNumber: string,
  email: string,
  role: UserRole = 'family_member',
) {
  const [row] = await getDb()
    .insert(schema.users)
    .values({ cognitoSub: sub, fullName: `User ${sub}`, phoneNumber, email, role })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test user.');
  }
  return row;
}

async function dependant(name: string, registeredBy: string) {
  const [row] = await getDb()
    .insert(schema.dependants)
    .values({
      fullName: name,
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 20,
      registeredBy,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test dependant.');
  }
  return row;
}

async function link(dependantId: string, userId: string, isPrimaryContact: boolean) {
  await getDb().insert(schema.dependantFamilyMembers).values({
    dependantId,
    familyMemberUserId: userId,
    isPrimaryContact,
    addedBy: userId,
  });
}

describe.skipIf(!hasTestDb)('family link requests (real Postgres)', () => {
  let app: Express;
  const list = async (sub: string) =>
    (await request(app).get('/family-link-requests').set('x-test-auth', auth(sub)))
      .body as RequestsBody;
  const ask = (sub: string, contact: string, relationship?: string) =>
    request(app)
      .post('/family-link-requests')
      .set('x-test-auth', auth(sub))
      .send({ contact, relationship });

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('answers the same whoever the contact is, and routes only to a primary contact', async () => {
    const primary = await user('fm-primary', '+254700000001', 'Achieng@Example.com');
    const other = await user('fm-other', '+254700000002', 'other@example.com');
    await user('fm-asker', '+254700000003', 'asker@example.com');
    const wanjiku = await dependant('Wanjiku Kamau', primary.id);
    await link(wanjiku.id, primary.id, true);
    await link(wanjiku.id, other.id, false);

    const answers = await Promise.all([
      ask('fm-asker', 'achieng@example.com', 'Grandson'), // a primary contact, any case
      ask('fm-asker', 'other@example.com'), // linked, but not a primary contact
      ask('fm-asker', 'nobody@example.com'), // no account at all
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(202);
      expect(answer.body).toEqual(answers[0].body);
    }

    // The requester sees all three as pending - nothing tells them which ones matched.
    const mine = await list('fm-asker');
    expect(mine.outgoing.map((r) => [r.targetContact, r.status])).toEqual(
      expect.arrayContaining([
        ['achieng@example.com', 'pending'],
        ['other@example.com', 'pending'],
        ['nobody@example.com', 'pending'],
      ]),
    );

    // Only the primary contact receives one, with who is asking and what they could link.
    const incoming = (await list('fm-primary')).incoming;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({
      requester: { fullName: 'User fm-asker', email: 'asker@example.com' },
      relationship: 'Grandson',
      dependants: [{ id: wanjiku.id, fullName: 'Wanjiku Kamau', alreadyLinked: false }],
    });
    expect((await list('fm-other')).incoming).toHaveLength(0);

    const asker = await getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.cognitoSub, 'fm-asker'));
    const createAudit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'family_link_request.create'));
    expect(createAudit).toHaveLength(3);
    expect(createAudit[0]).toMatchObject({
      entityType: 'family_link_request',
      actorUserId: asker[0]?.id,
    });

    // Asking again while it's open doesn't add another - a genuine no-op, no new audit row either.
    await ask('fm-asker', 'ACHIENG@example.com');
    expect((await list('fm-primary')).incoming).toHaveLength(1);
    expect(
      await getDb()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'family_link_request.create')),
    ).toHaveLength(3);
  });

  it('matches a primary contact by phone too', async () => {
    const primary = await user('fm-primary', '+254700000001', 'achieng@example.com');
    await user('fm-asker', '+254700000003', 'asker@example.com');
    const wanjiku = await dependant('Wanjiku Kamau', primary.id);
    await link(wanjiku.id, primary.id, true);
    await ask('fm-asker', '+254700000001');
    expect((await list('fm-primary')).incoming).toHaveLength(1);
  });

  it('approving links the chosen dependants and tells the requester once', async () => {
    const primary = await user('fm-primary', '+254700000001', 'achieng@example.com');
    const asker = await user('fm-asker', '+254700000003', 'asker@example.com');
    const wanjiku = await dependant('Wanjiku Kamau', primary.id);
    const baraka = await dependant('Baraka Kamau', primary.id);
    const notMine = await dependant('Someone Else', asker.id);
    await link(wanjiku.id, primary.id, true);
    await link(baraka.id, primary.id, true);
    await ask('fm-asker', 'achieng@example.com', 'Grandson');
    const [incoming] = (await list('fm-primary')).incoming;

    // Not a dependant the approver is the primary contact of.
    const refused = await request(app)
      .post(`/family-link-requests/${incoming!.id}/approve`)
      .set('x-test-auth', auth('fm-primary'))
      .send({ dependantIds: [wanjiku.id, notMine.id] });
    expect(refused.status).toBe(403);

    // Someone else's request looks missing.
    await user('fm-stranger', '+254700000009', 'stranger@example.com');
    const stranger = await request(app)
      .post(`/family-link-requests/${incoming!.id}/approve`)
      .set('x-test-auth', auth('fm-stranger'))
      .send({ dependantIds: [wanjiku.id] });
    expect(stranger.status).toBe(404);

    const approved = await request(app)
      .post(`/family-link-requests/${incoming!.id}/approve`)
      .set('x-test-auth', auth('fm-primary'))
      .send({ dependantIds: [wanjiku.id] });
    expect(approved.status).toBe(200);

    // The refused (403) and stranger (404) attempts above left no audit row - only this one did.
    const approveAudit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'family_link_request.approve'));
    expect(approveAudit).toHaveLength(1);
    expect(approveAudit[0]).toMatchObject({
      entityType: 'family_link_request',
      entityId: incoming!.id,
      actorUserId: primary.id,
      metadata: { requesterUserId: asker.id, dependantIds: [wanjiku.id] },
    });

    const links = await getDb().select().from(schema.dependantFamilyMembers);
    expect(links).toContainEqual(
      expect.objectContaining({
        dependantId: wanjiku.id,
        familyMemberUserId: asker.id,
        relationship: 'Grandson',
        isPrimaryContact: false,
        addedBy: primary.id,
      }),
    );
    expect(
      links.some((l) => l.dependantId === baraka.id && l.familyMemberUserId === asker.id),
    ).toBe(false);

    // Answered once only.
    const again = await request(app)
      .post(`/family-link-requests/${incoming!.id}/reject`)
      .set('x-test-auth', auth('fm-primary'));
    expect(again.status).toBe(409);
    expect(
      await getDb()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'family_link_request.reject')),
    ).toHaveLength(0);

    // The requester's outcome is unread until they've seen it.
    let [outcome] = (await list('fm-asker')).outgoing;
    expect(outcome).toMatchObject({
      status: 'approved',
      unread: true,
      linkedDependants: [{ id: wanjiku.id, fullName: 'Wanjiku Kamau' }],
    });
    const seen = await request(app)
      .post('/family-link-requests/outcomes/seen')
      .set('x-test-auth', auth('fm-asker'));
    expect(seen.status).toBe(204);
    [outcome] = (await list('fm-asker')).outgoing;
    expect(outcome?.unread).toBe(false);
    expect((await list('fm-primary')).incoming).toHaveLength(0);
  });

  it('rejecting links nothing and tells the requester', async () => {
    const primary = await user('fm-primary', '+254700000001', 'achieng@example.com');
    await user('fm-asker', '+254700000003', 'asker@example.com');
    const wanjiku = await dependant('Wanjiku Kamau', primary.id);
    await link(wanjiku.id, primary.id, true);
    await ask('fm-asker', 'achieng@example.com');
    const [incoming] = (await list('fm-primary')).incoming;

    const rejected = await request(app)
      .post(`/family-link-requests/${incoming!.id}/reject`)
      .set('x-test-auth', auth('fm-primary'));
    expect(rejected.status).toBe(200);
    expect(await getDb().select().from(schema.dependantFamilyMembers)).toHaveLength(1);
    expect((await list('fm-asker')).outgoing[0]).toMatchObject({
      status: 'rejected',
      unread: true,
      linkedDependants: [],
    });

    const [audit] = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'family_link_request.reject'));
    expect(audit).toMatchObject({
      entityType: 'family_link_request',
      entityId: incoming!.id,
      actorUserId: primary.id,
    });
  });

  it('is for family members only', async () => {
    await user('sup-1', '+254700000010', 'sup@example.com', 'supervisor');
    const response = await request(app)
      .get('/family-link-requests')
      .set('x-test-auth', auth('sup-1', 'supervisor'));
    expect(response.status).toBe(403);
  });
});

describe.skipIf(!hasTestDb)('POST /dependants/{id}/family-members/link (real Postgres)', () => {
  let app: Express;

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('lets the primary contact link an existing account by email, and no one else', async () => {
    const primary = await user('fm-primary', '+254700000001', 'achieng@example.com');
    const member = await user('fm-member', '+254700000002', 'member@example.com');
    const brian = await user('fm-brian', '+254700000003', 'Brian@Example.com');
    const wanjiku = await dependant('Wanjiku Kamau', primary.id);
    await link(wanjiku.id, primary.id, true);
    await link(wanjiku.id, member.id, false);
    const linkBy = (sub: string, email: string) =>
      request(app)
        .post(`/dependants/${wanjiku.id}/family-members/link`)
        .set('x-test-auth', auth(sub))
        .send({ email, relationship: 'Grandson' });

    expect((await linkBy('fm-member', 'brian@example.com')).status).toBe(403);

    const missing = await linkBy('fm-primary', 'nobody@example.com');
    expect(missing.status).toBe(404);
    expect((missing.body as { detail: string }).detail).toContain('ask you to link them');

    const linked = await linkBy('fm-primary', 'brian@example.com');
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      fullName: 'User fm-brian',
      relationship: 'Grandson',
      isPrimaryContact: false,
      addedByName: 'User fm-primary',
    });
    expect(linked.body).not.toHaveProperty('idNumber');

    expect((await linkBy('fm-primary', 'brian@example.com')).status).toBe(409);

    // The forbidden, not-found and duplicate attempts wrote nothing - only the one real link did.
    const audit = await getDb().select().from(schema.auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'family_member.link',
      entityType: 'family_member',
      entityId: brian.id,
      actorUserId: primary.id,
    });
  });
});
