import express from 'express';
import serverlessHttp from 'serverless-http';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// lambda.ts calls getLambdaDb() on import; mock it so tests never reach Secrets Manager.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(function SecretsManagerClient() {
    return {
      send: vi.fn().mockRejectedValue(new Error('mocked: no real Secrets Manager in tests')),
    };
  }),
  GetSecretValueCommand: vi.fn(),
}));

// pino-http relies on the response's 'finish' event, which has to fire under serverless-http's
// synthetic request/response objects too.
describe('Lambda handler (via serverless-http)', () => {
  let handler: typeof import('./lambda.js').handler;

  beforeAll(async () => {
    process.env.DATABASE_SECRET_ARN =
      'arn:aws:secretsmanager:eu-west-1:245361883778:secret:fake-abc123';
    process.env.VOICE_FUNCTION_NAME = 'fake-voice-function';
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

// serverless-http 3.x stubbed the socket as unreadable, so body-parser skipped the body and
// req.body stayed a raw Buffer. Fixed in 4.x; this guards against a regression.
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
