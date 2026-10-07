import { z } from 'zod';
import { buffer, LEVELS } from '../log.ts';
import type { LevelName } from '../log.ts';
import { validate } from '../validation.ts';
import { health } from '../health.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';

const logQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  level: z.enum(Object.keys(LEVELS) as [LevelName, ...LevelName[]]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

export function attachOpsRoutes(app: Express, ctx: RouteContext): void {
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/api/health', (_req, res) => res.json(health({ autoShow: ctx.autoShow })));

  // Require a supervisor for restart so the command cannot stop a server that nobody will relaunch.
  app.post('/api/server/restart', (_req, res) => {
    if (!ctx.restart || !ctx.restart('from the app')) {
      return res.status(409).json({
        ok: false,
        error: 'This server is not running under the supervisor (npm start runs it under one) — restart it yourself.',
      });
    }
    res.json({ ok: true, restarting: true });
  });

  app.get('/api/logs', (req, res) => {
    const { after = 0, level = 'trace', limit = 500 } = validate(logQuery, req.query, 'logs');
    res.json({ ok: true, last: buffer.last, entries: buffer.since(after, { level, limit }) });
  });
}
