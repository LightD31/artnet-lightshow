import { engineStatus } from '../engine.ts';
import { validate } from '../validation.ts';
import { settings, RESTART_PATHS, CONFIG_FILE } from '../settings.ts';
import { generateToken } from '../auth.ts';
import { runPreflight } from '../preflight.ts';
import { modelManager, modelDownloadSchema } from '../model-manager.ts';
import * as pythonEnv from '../../python-env.ts';
import { HttpError, messageOf } from '../../errors.ts';
import type { Express } from 'express';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

/**
 * Setting up: the pre-show check, the analysis models, and the settings.
 */
export function attachSetupRoutes(app: Express, ctx: RouteContext): void {
  const { midi, spotify, prolink, analysisCache, applier } = ctx;

  // ─── Preflight ────────────────────────────────────────────────────────────
  // The same checks `npm run preflight` runs, with the live subsystems wired in
  // so MIDI and the playback sources report what is actually connected rather
  // than what is merely configured.
  //
  // POST, not GET: it probes the network, spawns tools and may download
  // models. A GET can be fired from any web page by an <img> tag with no
  // Origin header, which is exactly what the origin check cannot catch.
  app.post('/api/preflight', asyncHandler(async (_req, res) => {
    const report = await runPreflight({ midi, spotify, prolink, analysisCache, downloadModels: true });
    res.json({ ok: true, report });
  }));

  // ─── Analysis models ──────────────────────────────────────────────────────
  // What is on this machine and fetching the rest (see model-manager.ts). The
  // list runs a Python process, so it is cached for a few seconds; the page
  // polls it while a download runs to draw the progress.
  app.get('/api/models', asyncHandler(async (req, res) => {
    try {
      const listing = await modelManager.list({ refresh: req.query.refresh === '1' });
      res.json({ ok: true, ...listing, job: modelManager.job() });
    } catch (err) {
      res.json({ ok: false, error: messageOf(err), job: modelManager.job() });
    }
  }));

  app.post('/api/models/download', asyncHandler(async (req, res) => {
    const { ids } = validate(modelDownloadSchema, req.body || {}, 'models');
    const known = new Set((await modelManager.list()).models.map((m) => m.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new HttpError(400, `unknown model: ${unknown.join(', ')}`);
    res.json({ ok: true, job: modelManager.download(ids) });
  }));

  // ─── Settings ─────────────────────────────────────────────────────────────
  // Everything the operator can configure. Secrets are never sent back: the
  // client gets a per-secret "is one set?" flag and may replace or clear a
  // value, but cannot read it.

  app.get('/api/settings', (_req, res) => {
    const { settings: values, secrets } = settings.redacted();
    res.json({
      ok: true,
      settings: values,
      secrets,
      restartKeys: RESTART_PATHS,
      pendingRestart: applier.pendingRestart(),
      // Which interpreter the analyzer actually resolved to, and whether it can
      // import what it needs. Shown under the Python field, because "I ran pip
      // install" and "the analyzer can import librosa" are different claims.
      python: pythonEnv.resolve(),
      // Read-only context the page shows next to the restart-only fields.
      running: applier.bootValues.server,
      // Where the engine is actually rendering and how its frames are going,
      // shown under the thread setting — it can differ from the setting when
      // the worker could not run, and that is worth saying.
      engine: engineStatus(),
      configFile: CONFIG_FILE,
    });
  });

  app.put('/api/settings', (req, res) => {
    try {
      const changed = settings.update(req.body || {});
      applier.applyChanged(changed);
      const { settings: values, secrets } = settings.redacted();
      res.json({
        ok: true,
        changed,
        settings: values,
        secrets,
        pendingRestart: applier.pendingRestart(),
      });
    } catch (err) {
      // Zod errors carry the offending path; surface it rather than a bare 500.
      const issues = err && typeof err === 'object'
        ? (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues : undefined;
      const detail = issues
        ? issues.map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')
        : messageOf(err);
      res.status(400).json({ ok: false, error: detail });
    }
  });

  // A token the operator can actually use, rather than asking them to run a
  // node one-liner. Returned once, in the clear, because it has to be copied
  // into Companion and the browser extension — it is not stored until saved.
  app.post('/api/settings/token/suggest', (_req, res) => {
    res.json({ ok: true, token: generateToken() });
  });
}
