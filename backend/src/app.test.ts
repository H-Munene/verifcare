import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import type { AuthenticatedUser, UserRole } from './auth/verifier.js';
import type { Db } from './db/client.js';
import type { VisitAudioStorage } from './db/visitAudioStorage.js';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

// resolveDb has to run before the routers, otherwise app.locals.db is never set and every DB
// route returns 503.
describe('resolveDb dependency (async db resolution, as lambda.ts uses)', () => {
  it('resolves db before dispatching to any route, even ones that do not need it', async () => {
    const resolveDb = vi.fn<() => Promise<Db>>().mockResolvedValue({} as Db);

    await request(createApp({ resolveDb })).get('/health');

    expect(resolveDb).toHaveBeenCalled();
  });
});

// Several routers share the /visit-schedules prefix, and the check-in router rejects every role but
// caregiver for anything that reaches it. These run through the real mounting order, with no
// database, so a request that got past authorization answers 503 instead of a 403.
describe('routers sharing /visit-schedules are mounted so each role can reach its routes', () => {
  const visit = '/visit-schedules/00000000-0000-4000-8000-000000000000';
  const position = { gpsLat: -1.28, gpsLng: 36.81, accuracyMeters: 5, isMockLocation: false };

  function appFor(role: UserRole) {
    return createApp({
      requireAuth: (req, _res, next) => {
        const user: AuthenticatedUser = { sub: 'someone', role, email: undefined };
        req.auth = user;
        next();
      },
      visitAudioStorage: {} as VisitAudioStorage,
    });
  }

  it('lets a family member reach the check-in code and the recording', async () => {
    const app = appFor('family_member');

    expect((await request(app).post(`${visit}/checkin/qr`).send(position)).status).toBe(503);
    expect((await request(app).get(`${visit}/audio`)).status).toBe(503);
  });

  it('lets a caregiver reach the scan, the override and the upload', async () => {
    const app = appFor('caregiver');

    expect((await request(app).post(`${visit}/checkin/qr-scan`).send({ token: 'x' })).status).toBe(
      503,
    );
    expect(
      (await request(app).post(`${visit}/checkin/override`).send({ reason: 'network_problem' }))
        .status,
    ).toBe(503);
    expect((await request(app).post(`${visit}/audio/upload-url`)).status).toBe(503);
  });

  it('keeps a supervisor out of the recording but lets them reach overrides', async () => {
    const app = appFor('supervisor');

    expect((await request(app).get(`${visit}/audio`)).status).toBe(403);
    expect((await request(app).get('/checkin-overrides')).status).toBe(503);
  });
});
