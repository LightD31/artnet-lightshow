import { z } from 'zod';
import { state, voices } from '../state.ts';
import { builtinPresets, launchOf, targetsOf } from '../voices.ts';
import { padIndex, restOwner, REST_TOKEN } from '../pads.ts';
import { validate } from '../validation.ts';
import { HttpError } from '../../errors.ts';
import type { Express, Request } from 'express';
import type { EffectLibrary } from '../effect-library.ts';
import type { PresetLookup } from '../voices.ts';
import type { RouteContext } from './common.ts';

/**
 * Presets by id or alias as a launch takes them: the library's (built-ins
 * with their length, then the ones saved here), or the built-ins alone when
 * no library is there.
 */
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

// As many fixture ids as identify takes; ids, not places in the patch, so a
// fixture removed and another added never inherits a voice.
const targets = z.union([z.literal('shared'), z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).max(1024)]);

// A launch from outside: what to play and on what, once or latched, and a
// once's length. Everything else a voice has (its tier, its source, a
// lease, a key, a maximum latch) is the server's to set: an unknown field is
// refused, not ignored.
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

// A REST hold's token: the caller's own, as a socket's is, or REST_TOKEN.
const holdSchema = z.object({ token: z.string().min(1).max(64).optional() }).strict();
const layoutBody = z.object({ pads: z.unknown() }).strict();

/** The pad a route names, from its URL; a 400 naming the bank or the slot that is none. */
function padAt(req: Request): { bank: number; slot: number; index: number } {
  const bank = Number(req.params.bank);
  const slot = Number(req.params.slot);
  return { bank, slot, index: padIndex(bank, slot) };
}

/** The token a REST press or release names, in its body or `?token=`; REST_TOKEN when none. */
function tokenOf(req: Request): string {
  const body = validate(holdSchema, req.body ?? {}, 'pad');
  const query = typeof req.query.token === 'string' ? req.query.token : undefined;
  return validate(holdSchema, { token: body.token ?? query }, 'pad').token ?? REST_TOKEN;
}

/** A once's `?ms=`: a positive number of milliseconds, or none. */
function msOf(req: Request): number | undefined {
  if (req.query.ms === undefined) return undefined;
  const ms = typeof req.query.ms === 'string' && req.query.ms.trim() ? Number(req.query.ms) : NaN;
  if (!(Number.isFinite(ms) && ms > 0)) throw new HttpError(400, 'pad: ms must be a positive number of milliseconds');
  return ms;
}

/**
 * The voices over the look: what plays, an effect launched once or latched
 * (always the voice tier: nothing launched from here outranks the strobe),
 * one stopped, all stopped. A stop needs no acknowledgement; a launch of an
 * effect that waits for it is a 409.
 */
export function attachVoiceRoutes(app: Express, ctx: RouteContext): void {
  // Read when a request comes: a test may stand in with no library.
  const lookup = () => presetLookup(ctx.integrations.library);

  app.get('/api/voices', (_req, res) => {
    res.json({ ok: true, voices: voices.list() });
  });

  // A once voice with no length plays its preset's, or its kind's (voices.ts lengthBeatsOf).
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

  // ── Pads ──────────────────────────────────────────────────────────────────
  // The layout, one pad or all sixteen at once, and the pads played from
  // outside: HA presses once or toggles (it cannot hold), Companion and the
  // pages hold over the socket. An empty pad answers 204 and plays nothing.
  // A REST hold is leased to the pad's REST owner under the caller's token,
  // or REST_TOKEN: pressing again within the lease renews it, and a bare
  // release lets go of only the bare press's hold.
  const pads = () => {
    // Read when a request comes, as the library is: a stand-in may have none.
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

  // The hold this pad's press launched goes, whatever the pad holds now.
  app.post('/api/pads/:bank/:slot/release', (req, res) => {
    const { bank, slot } = padAt(req);
    const released = pads().release(bank, slot, restOwner(bank, slot), tokenOf(req));
    if (!released && !pads().entry(bank, slot).content) return res.status(204).end();
    res.json({ ok: true, released });
  });

  // `id` is the loop started, or null when it stopped what the pad played.
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
}
