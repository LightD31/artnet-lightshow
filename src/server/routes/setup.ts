import { engineStatus } from '../engine.ts';
import { validate } from '../validation.ts';
import { settings, RESTART_PATHS, CONFIG_FILE } from '../settings.ts';
import { generateToken } from '../auth.ts';
import { runPreflight } from '../preflight.ts';
import { modelManager, modelDownloadSchema } from '../model-manager.ts';
import { pythonSetup, pythonSetupSchema } from '../python-setup.ts';
import * as pythonEnv from '../../python-env.ts';
import { HttpError, messageOf } from '../../errors.ts';
import type { Express } from 'express';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

const restartKeysFor = (pending: string[]): string[] =>
  (pending.includes('deezer.arl') ? [...RESTART_PATHS, 'deezer.arl'] : RESTART_PATHS);

export function attachSetupRoutes(app: Express, ctx: RouteContext): void {
  const { midi, spotify, prolink, analysisCache, applier } = ctx;

  app.post('/api/preflight', asyncHandler(async (_req, res) => {
    const report = await runPreflight({ midi, spotify, prolink, analysisCache, downloadModels: true });
    res.json({ ok: true, report });
  }));

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

  app.get('/api/python/setup', asyncHandler(async (_req, res) => {
    res.json({ ok: true, ...(await pythonSetup.status()) });
  }));

  app.post('/api/python/setup', asyncHandler(async (req, res) => {
    const { build } = validate(pythonSetupSchema, req.body || {}, 'python setup');
    const running = pythonSetup.job();
    if (running && running.ok === null) throw new HttpError(409, 'The analysis environment is already being set up.');
    const job = pythonSetup.start(build);
    if (job.ok === false) throw new HttpError(409, job.error || 'The setup could not start.');
    res.json({ ok: true, job });
  }));

  app.post('/api/python/setup/cancel', asyncHandler(async (_req, res) => {
    res.json({ ok: pythonSetup.cancel() });
  }));

  app.get('/api/settings', (_req, res) => {
    const { settings: values, secrets } = settings.redacted();
    const pendingRestart = applier.pendingRestart();
    res.json({
      ok: true,
      settings: values,
      secrets,
      restartKeys: restartKeysFor(pendingRestart),
      pendingRestart,
      python: pythonEnv.resolve(),
      running: applier.bootValues.server,
      engine: engineStatus(),
      configFile: CONFIG_FILE,
    });
  });

  app.put('/api/settings', (req, res) => {
    try {
      const changed = settings.update(req.body || {});
      applier.applyChanged(changed);
      const { settings: values, secrets } = settings.redacted();
      const pendingRestart = applier.pendingRestart();
      res.json({
        ok: true,
        changed,
        settings: values,
        secrets,
        restartKeys: restartKeysFor(pendingRestart),
        pendingRestart,
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

  app.post('/api/settings/token/suggest', (_req, res) => {
    res.json({ ok: true, token: generateToken() });
  });
}
