import { z } from 'zod';
import { state, voices, strobe, matrix } from '../state.ts';
import { matrixPressSchema, matrixReleaseSchema } from '../matrix.ts';
import { builtinPresets, launchOf, targetsOf } from '../voices.ts';
import { padIndex, restOwner, REST_TOKEN } from '../pads.ts';
import { validate } from '../validation.ts';
import { HttpError } from '../../errors.ts';
import type { Express, Request } from 'express';
import type { EffectLibrary } from '../effect-library.ts';
import type { PresetLookup } from '../voices.ts';
import type { RouteContext } from './common.ts';

export function presetLookup(library?: { effects: Pick<EffectLibrary, 'get'> } | null): PresetLookup {
  if (!library) return builtinPresets;
  return (id) => {
    const entry = library.effects.get(id);
    if (!entry) return null;
    if (entry.source === 'user') return { spec: entry.preset.spec, name: entry.preset.name };
    const row = entry.preset;
    return row.legacy ? null : { spec: row.spec, lengthBeats: row.lengthBeats, name: row.name };
  };
}

// Target stable fixture IDs so a replacement fixture cannot inherit a removed fixture’s voice.
const targets = z.union([z.literal('shared'), z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).max(1024)]);

const startSchema = z.object({
  effect: z.unknown().optional(),
  preset: z.string().min(1).max(64).optional(),
  targets: targets.optional(),
  mode: z.enum(['once', 'latched']).optional(),
  ms: z.number().positive().finite().optional(),
  beats: z.number().positive().finite().optional(),
}).strict().superRefine((body, ctx) => {
  if ((body.effect === undefined) === (body.preset === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'give either effect or preset' });
  }
  if (body.ms !== undefined && body.beats !== undefined) ctx.addIssue({ code: 'custom', message: 'give ms or beats, not both' });
  if (body.mode === 'latched' && (body.ms !== undefined || body.beats !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['mode'], message: 'a latched voice has no length' });
  }
});

const holdSchema = z.object({ token: z.string().min(1).max(64).optional() }).strict();
const layoutBody = z.object({ pads: z.unknown() }).strict();

function padAt(req: Request): { bank: number; slot: number; index: number } {
  const bank = Number(req.params.bank);
  const slot = Number(req.params.slot);
  return { bank, slot, index: padIndex(bank, slot) };
}

function tokenOf(req: Request): string {
  const body = validate(holdSchema, req.body ?? {}, 'pad');
  const query = typeof req.query.token === 'string' ? req.query.token : undefined;
  return validate(holdSchema, { token: body.token ?? query }, 'pad').token ?? REST_TOKEN;
}

function msOf(req: Request): number | undefined {
  if (req.query.ms === undefined) return undefined;
  const ms = typeof req.query.ms === 'string' && req.query.ms.trim() ? Number(req.query.ms) : NaN;
  if (!(Number.isFinite(ms) && ms > 0)) throw new HttpError(400, 'pad: ms must be a positive number of milliseconds');
  return ms;
}

export function attachVoiceRoutes(app: Express, ctx: RouteContext): void {
  const lookup = () => presetLookup(ctx.integrations.library);

  app.get('/api/voices', (_req, res) => {
    res.json({ ok: true, voices: voices.list() });
  });

  app.post('/api/voices', (req, res) => {
    const body = validate(startSchema, req.body ?? {}, 'voice');
    const launch = launchOf(body, lookup());
    const mode = body.mode ?? 'once';
    const voice = voices.start({
      spec: launch.spec, targets: targetsOf(body.targets, state.fixtures.map((f) => f.id)), mode, tier: 'voice', source: 'api',
      label: launch.label,
      ...(mode === 'once' ? { lengthMs: body.ms, lengthBeats: body.ms === undefined ? body.beats ?? launch.lengthBeats : undefined } : {}),
    });
    res.json({ ok: true, id: voice.id });
  });

  app.delete('/api/voices/:id', (req, res) => {
    if (!voices.stop(req.params.id)) return res.status(404).json({ ok: false, error: 'No such voice' });
    res.json({ ok: true });
  });

  app.delete('/api/voices', (_req, res) => {
    res.json({ ok: true, stopped: voices.stopAll() });
  });

  // Renew REST leases without relaunching so holds cannot restart once or loop playback.
  const pads = () => {
    if (!ctx.integrations.pads) throw new HttpError(409, 'No pads on this server');
    return ctx.integrations.pads;
  };

  app.get('/api/pads', (_req, res) => {
    res.json({ ok: true, ...pads().view() });
  });

  app.put('/api/pads', (req, res) => {
    const body = validate(layoutBody, req.body ?? {}, 'pads');
    res.json({ ok: true, layout: pads().store.replace(body.pads) });
  });

  app.put('/api/pads/:bank/:slot', (req, res) => {
    const { bank, slot } = padAt(req);
    res.json({ ok: true, pad: pads().store.set(bank, slot, req.body ?? {}) });
  });

  app.post('/api/pads/:bank/:slot/press', (req, res) => {
    const { bank, slot } = padAt(req);
    const token = tokenOf(req);
    if (!pads().entry(bank, slot).content) return res.status(204).end();
    const voice = pads().press(bank, slot, restOwner(bank, slot), token);
    res.json({ ok: true, id: voice?.id ?? null, token });
  });

  app.post('/api/pads/:bank/:slot/renew', (req, res) => {
    const { bank, slot } = padAt(req);
    pads();
    res.json({ ok: true, renewed: voices.renew(restOwner(bank, slot), tokenOf(req)) });
  });

  app.post('/api/pads/:bank/:slot/release', (req, res) => {
    const { bank, slot } = padAt(req);
    const token = tokenOf(req);
    const released = pads().release(bank, slot, restOwner(bank, slot), token);
    voices.release(restOwner(bank, slot), token);
    if (!released && !pads().entry(bank, slot).content) return res.status(204).end();
    res.json({ ok: true, released });
  });

  app.post('/api/pads/:bank/:slot/toggle', (req, res) => {
    const { bank, slot, index } = padAt(req);
    if (!pads().entry(bank, slot).content && !pads().lit()[index]) return res.status(204).end();
    res.json({ ok: true, id: pads().toggle(bank, slot)?.id ?? null });
  });

  app.post('/api/pads/:bank/:slot/once', (req, res) => {
    const { bank, slot } = padAt(req);
    const ms = msOf(req);
    if (!pads().entry(bank, slot).content) return res.status(204).end();
    res.json({ ok: true, id: pads().once(bank, slot, ms)?.id ?? null });
  });

  // Allow strobe-off without acknowledgement so safety gating never prevents stopping it.
  const strobeStatus = () => ({ ok: true, ...strobe.status() });

  app.get('/api/strobe', (_req, res) => {
    res.json(strobeStatus());
  });

  app.post('/api/strobe/on', (_req, res) => {
    strobe.on('latched');
    res.json(strobeStatus());
  });

  app.post('/api/strobe/off', (_req, res) => {
    strobe.off();
    res.json(strobeStatus());
  });

  app.post('/api/strobe/burst/:ms', (req, res) => {
    const ms = /^\d+$/.test(req.params.ms) ? Number(req.params.ms) : NaN;
    strobe.burst(ms);
    res.json(strobeStatus());
  });

  const restCell = (token: string) => `rest:${token}`;
  const matrixAnswer = (status: ReturnType<typeof matrix.status>) => {
    ctx.integrations.broadcast();
    return { ok: true, ...status };
  };

  app.get('/api/matrix', (_req, res) => {
    res.json({ ok: true, ...matrix.status() });
  });

  app.post('/api/matrix/press', (req, res) => {
    const body = validate(matrixPressSchema, req.body ?? {}, 'matrix');
    res.json(matrixAnswer(matrix.press(restCell(body.token ?? body.colour.toUpperCase()), body.colour)));
  });

  app.post('/api/matrix/release', (req, res) => {
    const body = validate(matrixReleaseSchema, req.body ?? {}, 'matrix');
    res.json(matrixAnswer(matrix.release(restCell(body.token ?? body.colour!.toUpperCase()))));
  });

  app.put('/api/matrix', (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    res.json(matrixAnswer(matrix.setMode(body.mode)));
  });

  app.put('/api/strobe', (req, res) => {
    strobe.update(req.body ?? {});
    ctx.integrations.broadcast();
    res.json(strobeStatus());
  });
}
