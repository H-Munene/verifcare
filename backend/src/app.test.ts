import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import type { Db } from './db/client.js';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

// Regression test for a real bug (2026-09-14): lambda.ts used to attach req.app.locals.db via a
// middleware it added itself, AFTER calling createApp() - but createApp() had already registered
// every router and the catch-all 404 handler by then, and every one of those sends its own
// response without ever calling next() through to later middleware, so that middleware could
// never actually run, for any request, ever. app.locals.db was permanently undefined in the
// deployed Lambda - every DB-touching route always 503'd with "No database client is configured,"
// undetected because every other backend test either passes `db` directly (the synchronous shape)
// or never exercises a DB route through the real deployed Lambda handler. Fixed by making
// createApp() itself responsible for wiring an async resolveDb dependency in as middleware,
// positioned before its own routers - this test proves that positioning directly, rather than
// trusting a caller (lambda.ts) to register things in the right order.
describe('resolveDb dependency (async db resolution, as lambda.ts uses)', () => {
  it('resolves db before dispatching to any route, even ones that do not need it', async () => {
    const resolveDb = vi.fn<() => Promise<Db>>().mockResolvedValue({} as Db);

    await request(createApp({ resolveDb })).get('/health');

    expect(resolveDb).toHaveBeenCalled();
  });
});
