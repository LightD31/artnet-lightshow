import { z } from 'zod';
import { buffer, LEVELS } from '../log.ts';
import type { LevelName } from '../log.ts';
import { validate } from '../validation.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';

const logQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  level: z.enum(Object.keys(LEVELS) as [LevelName, ...LevelName[]]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();

/**
 * Running the server: its log, its health, and restarting it.
 */
export function attachOpsRoutes(app: Express, _ctx: RouteContext): void {
  // The log: the last entries (after `after`, at `level` and above), and the
  // seq to ask for more after. The log view polls this while it is open.
  app.get('/api/logs', (req, res) => {
    const { after = 0, level = 'trace', limit = 500 } = validate(logQuery, req.query, 'logs');
    res.json({ ok: true, last: buffer.last, entries: buffer.since(after, { level, limit }) });
  });
}
