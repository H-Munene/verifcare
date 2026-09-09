import express, { type Express } from 'express';

// Minimal scaffold-validation app (HEZ-7). Config/env management, request logging, and
// error-handling middleware are added in HEZ-27, not here.
export function createApp(): Express {
  const app = express();

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
}
