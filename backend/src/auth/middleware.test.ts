import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRequireAuth, createRequireVerifiedIdentity, requireRole } from './middleware.js';
import type { IdTokenVerifier } from './verifier.js';

function buildTestApp(verifier: IdTokenVerifier) {
  const app = express();
  const requireAuth = createRequireAuth(verifier);
  const requireVerifiedIdentity = createRequireVerifiedIdentity(verifier);

  app.get(
    '/whoami',
    requireAuth,
    requireRole('supervisor', 'caregiver', 'family_member'),
    (req, res) => {
      res.status(200).json(req.auth);
    },
  );
  app.get('/supervisor-only', requireAuth, requireRole('supervisor'), (req, res) => {
    res.status(200).json(req.auth);
  });
  app.get('/identity-only', requireVerifiedIdentity, (req, res) => {
    res.status(200).json(req.identity);
  });

  return app;
}

describe('createRequireAuth', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const verifier: IdTokenVerifier = { verify: vi.fn() };

    const response = await request(buildTestApp(verifier)).get('/whoami');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ title: 'Unauthorized', status: 401 });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is not a Bearer token', async () => {
    const verifier: IdTokenVerifier = { verify: vi.fn() };

    const response = await request(buildTestApp(verifier))
      .get('/whoami')
      .set('Authorization', 'Basic abc123');

    expect(response.status).toBe(401);
  });

  it('returns 401 when verification rejects (invalid signature, expired, etc.)', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockRejectedValue(new Error('token expired')),
    };

    const response = await request(buildTestApp(verifier))
      .get('/whoami')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(401);
  });

  it('returns 401 when the verified payload has no usable custom:role claim', async () => {
    const verifier: IdTokenVerifier = { verify: vi.fn().mockResolvedValue({ sub: 'abc' }) };

    const response = await request(buildTestApp(verifier))
      .get('/whoami')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(401);
  });

  it('attaches req.auth and proceeds on a valid token', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi
        .fn()
        .mockResolvedValue({ sub: 'abc-123', 'custom:role': 'caregiver', email: 'c@example.com' }),
    };

    const response = await request(buildTestApp(verifier))
      .get('/whoami')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sub: 'abc-123', role: 'caregiver', email: 'c@example.com' });
  });
});

describe('requireRole', () => {
  it('returns 403 when the authenticated user does not have an allowed role', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ sub: 'abc-123', 'custom:role': 'caregiver' }),
    };

    const response = await request(buildTestApp(verifier))
      .get('/supervisor-only')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ title: 'Forbidden', status: 403 });
  });

  it('proceeds when the authenticated user has an allowed role', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ sub: 'abc-123', 'custom:role': 'supervisor' }),
    };

    const response = await request(buildTestApp(verifier))
      .get('/supervisor-only')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(200);
  });
});

describe('createRequireVerifiedIdentity', () => {
  it('returns 401 when the Authorization header is missing, same as requireAuth', async () => {
    const verifier: IdTokenVerifier = { verify: vi.fn() };

    const response = await request(buildTestApp(verifier)).get('/identity-only');

    expect(response.status).toBe(401);
  });

  it('returns 401 when verification rejects', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockRejectedValue(new Error('bad signature')),
    };

    const response = await request(buildTestApp(verifier))
      .get('/identity-only')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(401);
  });

  it('proceeds with role undefined for a verified token with no custom:role claim - the whole point of this middleware', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ sub: 'brand-new-user' }),
    };

    const response = await request(buildTestApp(verifier))
      .get('/identity-only')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sub: 'brand-new-user' });
  });

  it('proceeds with the role attached when the token already has one', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ sub: 'abc-123', 'custom:role': 'supervisor' }),
    };

    const response = await request(buildTestApp(verifier))
      .get('/identity-only')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sub: 'abc-123', role: 'supervisor' });
  });

  it('still returns 401 for a tampered token whose custom:role is not a known role', async () => {
    const verifier: IdTokenVerifier = {
      verify: vi.fn().mockResolvedValue({ sub: 'abc-123', 'custom:role': 'admin' }),
    };

    const response = await request(buildTestApp(verifier))
      .get('/identity-only')
      .set('Authorization', 'Bearer some.jwt.token');

    expect(response.status).toBe(401);
  });
});
