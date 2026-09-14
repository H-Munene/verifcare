// Shared structured logger. Used both for request logging (app.ts's pino-http middleware) and
// for error logging (errors.ts), so request and error logs share one format/stream and can be
// correlated by CloudWatch Logs Insights.
//
// Detects "running in Lambda" via AWS_LAMBDA_FUNCTION_NAME - a variable the Lambda runtime itself
// always sets, unlike NODE_ENV, which nothing in this project's infra currently sets for the
// deployed function. In Lambda: plain structured JSON (what CloudWatch Logs wants). Locally via
// `npm run dev`: pino-pretty, for a human-readable console. Under Vitest (VITEST is set
// automatically by the test runner): plain JSON at 'silent' by default, not pretty - pino-pretty's
// worker-thread transport adds startup overhead and noisy output to every test run for no benefit.

import pino from 'pino';

const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const isTest = Boolean(process.env.VITEST);

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
  transport: isLambda || isTest ? undefined : { target: 'pino-pretty' },
});
