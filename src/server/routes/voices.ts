import { z } from 'zod';
import { state, voices } from '../state.ts';
import { builtinPresets, launchOf, targetsOf } from '../voices.ts';
import { validate } from '../validation.ts';
import type { Express } from 'express';
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
}
