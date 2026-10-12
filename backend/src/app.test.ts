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

// resolveDb has to run before the routers, otherwise app.locals.db is never set and every DB
// route returns 503.
describe('resolveDb dependency (async db resolution, as lambda.ts uses)', () => {
  it('resolves db before dispatching to any route, even ones that do not need it', async () => {
    const resolveDb = vi.fn<() => Promise<Db>>().mockResolvedValue({} as Db);

    await request(createApp({ resolveDb })).get('/health');

    expect(resolveDb).toHaveBeenCalled();
  });
});
