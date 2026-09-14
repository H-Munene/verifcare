import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseOrSendProblem } from './validation.js';

const schema = z.object({ name: z.string().min(1), age: z.coerce.number().int().min(0) });

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.post('/test', (req, res) => {
    const parsed = parseOrSendProblem(schema, req.body, res);
    if (!parsed) {
      return;
    }
    res.status(200).json(parsed);
  });
  return app;
}

describe('parseOrSendProblem', () => {
  it('returns the parsed value and does not touch the response on success', async () => {
    const response = await request(buildTestApp()).post('/test').send({ name: 'Ada', age: '30' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'Ada', age: 30 });
  });

  it('sends an RFC 7807 400 response and includes issue detail on failure', async () => {
    const response = await request(buildTestApp()).post('/test').send({ age: -1 });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: expect.stringContaining('name') as string,
    });
  });
});
