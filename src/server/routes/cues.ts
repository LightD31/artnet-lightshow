import { getClientState } from '../state.ts';
import { cueWriteSchema, cueRestoreSchema, reorderSchema } from '../cues.ts';
import { validate } from '../validation.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';

/**
 * The cue stack: looks saved under a name, recalled in one press.
 */
export function attachCueRoutes(app: Express, ctx: RouteContext): void {
  const { integrations, cues } = ctx;

  // ─── Cue stack ────────────────────────────────────────────────────────────
  // Named looks. GET returns the full stored look; the state broadcast carries
  // only the summaries the buttons need.
  app.get('/api/cues', (_req, res) => res.json({ ok: true, cues: cues.list() }));

  app.post('/api/cues', (req, res) => {
    try {
      const body = validate(cueWriteSchema, req.body || {}, 'cue');
      const cue = cues.create(body);
      integrations.broadcast();
      res.json({ ok: true, cue });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Note: /api/cues/reorder must come before :id
  app.post('/api/cues/reorder', (req, res) => {
    try {
      const { ids } = validate(reorderSchema, req.body || {}, 'cue-reorder');
      cues.reorder(ids);
      integrations.broadcast();
      res.json({ ok: true, cues: cues.summaries() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // A recapture answers with the look it replaced too, so the page can offer
  // an undo: overwriting a cue with the wrong look was one click from gone.
  app.put('/api/cues/:id', (req, res) => {
    try {
      const body = validate(cueWriteSchema, req.body || {}, 'cue');
      const existing = cues.get(req.params.id);
      const previous = body.recapture && existing ? JSON.parse(JSON.stringify(existing.look)) : undefined;
      const cue = cues.update(req.params.id, body);
      if (!cue) return res.status(404).json({ ok: false, error: 'No such cue' });
      integrations.broadcast();
      res.json({ ok: true, cue, ...(previous ? { previous } : {}) });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Answers with what was removed and from where, so the client can offer an
  // undo that puts the same cue back in the same slot rather than appending a
  // copy with a new id.
  app.delete('/api/cues/:id', (req, res) => {
    try {
      const removed = cues.remove(req.params.id);
      if (!removed) return res.status(404).json({ ok: false, error: 'No such cue' });
      integrations.broadcast();
      res.json({ ok: true, cue: removed.cue, index: removed.index });
    } catch (err) { res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/cues/restore', (req, res) => {
    try {
      const { cue, index } = validate(cueRestoreSchema, req.body || {}, 'cue-restore');
      const restored = cues.insert(cue, index);
      if (!restored) return res.status(409).json({ ok: false, error: 'That cue is already in the stack' });
      integrations.broadcast();
      res.json({ ok: true, cue: restored });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/cues/:id/recall', (req, res) => {
    try {
      if (!cues.recall(req.params.id)) return res.status(404).json({ ok: false, error: 'No such cue' });
      // recallLook goes through applyPatch, which broadcasts on its own.
      res.json({ ok: true, state: getClientState() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });
}
