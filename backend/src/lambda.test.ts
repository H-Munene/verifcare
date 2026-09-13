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
