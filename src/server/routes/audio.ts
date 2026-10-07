import { z } from 'zod';
import { validate } from '../validation.ts';
import { settings, schema } from '../settings.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';

const audio = schema.shape.audio.shape;

const audioPatchSchema = z.object({
  mode: audio.mode.optional(),
  master: audio.master.partial().strict().optional(),
  ldjTrigger: audio.ldjTrigger.optional(),
}).strict();

export function attachAudioRoutes(app: Express, ctx: RouteContext): void {
  const { integrations, applier } = ctx;

  app.get('/api/audio', (_req, res) => res.json({ ok: true, ...integrations.audio.summary() }));

  app.put('/api/audio', (req, res) => {
    try {
      const body = validate(audioPatchSchema, req.body ?? {}, 'audio');
      const patch = { ...body, ...(body.master ? { master: { ...settings.get('audio.master'), ...body.master } } : {}) };
      const changed = settings.update({ audio: patch });
      applier.applyChanged(changed);
      res.json({ ok: true, changed, settings: settings.group('audio'), detectors: integrations.audio.detectors() });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });
}
