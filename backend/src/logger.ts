// Shared logger for request and error logs. JSON in Lambda (detected via
// AWS_LAMBDA_FUNCTION_NAME), pino-pretty locally, silent under Vitest.

import pino from 'pino';

const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const isTest = Boolean(process.env.VITEST);

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
  transport: isLambda || isTest ? undefined : { target: 'pino-pretty' },
});
