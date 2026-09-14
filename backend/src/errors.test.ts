import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('error handling shape (via app.ts)', () => {
  it('returns an RFC 7807 problem+json body for an unmatched route', async () => {
    const response = await request(createApp()).get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: expect.stringContaining('/no-such-route') as string,
    });
  });
});
