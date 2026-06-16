import express, { Request, Response, NextFunction } from 'express';
import { AppError } from './utils/errors';
import { logger } from './utils/logger';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // ── Global error handler ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      logger.warn('Application error', { code: err.code, message: err.message });
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    logger.error('Unhandled error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
