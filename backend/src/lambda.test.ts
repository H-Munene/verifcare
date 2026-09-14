import express from 'express';
import serverlessHttp from 'serverless-http';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// lambda.ts's module-level code calls getLambdaDb(), which would otherwise make a real network
// call to Secrets Manager (and this machine has real, valid AWS credentials configured - see
// docs/project-state.md's AWS Agent Toolkit entry - so an unmocked call would not just fail fast,
// it could genuinely reach AWS). Mocked here so this test never touches the network.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(function SecretsManagerClient() {
    return {
      send: vi.fn().mockRejectedValue(new Error('mocked: no real Secrets Manager in tests')),
    };
  }),
  GetSecretValueCommand: vi.fn(),
}));

// Real risk this test exists to verify, not assume: pino-http logs a completed request by
// listening for the response's 'finish' event, and this app runs through serverless-http's
// synthetic (non-socket) request/response objects, not real Node http objects. If that event
// never fired under serverless-http, requests would either hang or pino-http would silently never
// log them - either way, a real problem this test would catch by simply failing to resolve or
// resolve with the wrong shape.
describe('Lambda handler (via serverless-http)', () => {
  let handler: typeof import('./lambda.js').handler;

  beforeAll(async () => {
    process.env.DATABASE_SECRET_ARN =
      'arn:aws:secretsmanager:eu-west-1:245361883778:secret:fake-abc123';
    ({ handler } = await import('./lambda.js'));
  });

  it('responds to a REST API Gateway proxy event for /health', async () => {
    const event = {
      httpMethod: 'GET',
      path: '/health',
      headers: { Host: 'example.execute-api.eu-west-1.amazonaws.com' },
      multiValueHeaders: {},
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      pathParameters: null,
      stageVariables: null,
      body: null,
      isBase64Encoded: false,
      requestContext: {
        requestId: 'test-api-gateway-request-id',
        identity: { sourceIp: '203.0.113.1' },
      },
    };
    const context = { awsRequestId: 'test-lambda-request-id' };

    const response = (await handler(event, context)) as { statusCode: number; body: string };

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('returns an RFC 7807 problem+json body for an unmatched route', async () => {
    const event = {
      httpMethod: 'GET',
      path: '/no-such-route',
      headers: { Host: 'example.execute-api.eu-west-1.amazonaws.com' },
      multiValueHeaders: {},
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      pathParameters: null,
      stageVariables: null,
      body: null,
      isBase64Encoded: false,
      requestContext: {
        requestId: 'test-api-gateway-request-id-2',
        identity: { sourceIp: '203.0.113.1' },
      },
    };
    const context = { awsRequestId: 'test-lambda-request-id-2' };

    const response = (await handler(event, context)) as { statusCode: number; body: string };

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    });
  });
});

// Regression test for a real, previously undetected bug (2026-09-14): serverless-http@3.x's
// synthetic request object stubbed its socket with `readable: false`, which makes the
// `on-finished` package (used internally by body-parser, which express.json() wraps) report the
// request as already finished before body-parser ever reads it - body-parser bailed out
// immediately, leaving req.body as the raw, unparsed request Buffer instead of the parsed JSON
// object. Every route expecting a JSON body (POST /users, /caregivers, /dependants, every PATCH)
// was silently broken for any real client of the deployed Lambda - it went undetected for months
// because every other backend test exercises the Express app directly via Supertest (bypassing
// serverless-http entirely, so it never reproduces this), and the web app has only ever been
// tested against the local dev backend (server.ts), not the deployed Lambda. This app's own
// `app.ts`/`lambda.ts` aren't used here deliberately - a minimal standalone app isolates the
// concern precisely (serverless-http + body-parser interaction) without needing DB/auth/Secrets
// Manager mocking. Fixed by upgrading to serverless-http@^4.0.0, which replaces the stub with a
// real PassThrough-backed socket (confirmed by reading its source directly).
describe('serverless-http + express.json() body parsing', () => {
  it('parses a JSON POST body into req.body as a real object, not a raw Buffer', async () => {
    const probeApp = express();
    probeApp.use(express.json());
    probeApp.post('/echo', (req, res) => {
      const body: unknown = req.body;
      res.json({ isBuffer: Buffer.isBuffer(body), received: body });
    });
    const probeHandler = serverlessHttp(probeApp);

    const requestBody = JSON.stringify({ probe: 'value', nested: { works: true } });
    const event = {
      httpMethod: 'POST',
      path: '/echo',
      headers: {
        Host: 'example.execute-api.eu-west-1.amazonaws.com',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(requestBody)),
      },
      multiValueHeaders: {},
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      pathParameters: null,
      stageVariables: null,
      body: requestBody,
      isBase64Encoded: false,
      requestContext: {
        requestId: 'test-api-gateway-request-id-body-parsing',
        identity: { sourceIp: '203.0.113.1' },
      },
    };
    const context = { awsRequestId: 'test-lambda-request-id-body-parsing' };

    const response = (await probeHandler(event, context)) as { statusCode: number; body: string };
    const parsed = JSON.parse(response.body) as { isBuffer: boolean; received: unknown };

    expect(response.statusCode).toBe(200);
    expect(parsed.isBuffer).toBe(false);
    expect(parsed.received).toEqual({ probe: 'value', nested: { works: true } });
  });
});
