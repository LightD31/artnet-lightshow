import { z } from 'zod';
import { FAMILIES } from '../../shared/effects/index.ts';
import { toHex } from '../../shared/effects/palette.ts';
import { effectCommand } from '../engine.ts';
import { applyPatch } from '../patch.ts';
import { safety } from '../safety.ts';
import { state } from '../state.ts';
import { ALL_PALETTES } from '../palette-catalogue.ts';
import { paletteBodySchema } from '../../shared/palette-model.ts';
import { validate } from '../validation.ts';
import { asyncHandler } from './common.ts';
import type { Express } from 'express';
import type { CommandStatus } from '../renderer.ts';
import type { RouteContext } from './common.ts';

const commandSchema = z.object({ cmd: z.string().min(1).max(64), arg: z.unknown().optional() }).strict();

// Colours, or a palette by id: one or the other, never both.
const overrideSchema = z.union([
  paletteBodySchema,
  z.object({ paletteId: z.string().min(1).max(64) }).strict(),
], { error: 'expected { colours: hex[] } (1 to 8) or { paletteId }' });

// What the renderer decided, as the HTTP answer. A base look that is no
// effect, or one that takes no commands, conflicts with what is on stage
// (409), as does one that changed under the command or cannot play it now; a
// command the effects do not know is the caller's mistake (400).
const REFUSALS: Record<Exclude<CommandStatus, 'applied'>, [number, string]> = {
  unsupported: [409, 'The look on stage is not an effect that takes commands'],
  stale: [409, 'The look on stage changed before the command reached it'],
  unavailable: [409, 'The effect on stage cannot take a command now: the engine is not running, or the effect is not playing'],
  duplicate: [409, 'That command was already decided'],
  invalid: [400, 'Not a command the effects know, or not its argument'],
};

/**
 * The effect library: the built-in catalogue, the presets and palettes saved
 * on this server, commands to the effect playing as the base look, the
 * palette played over every effect, and the photosensitivity gate.
 *
 * Errors fall through to the error handler: a refusal answers with its own
 * status, and a disk that will not take a write is a 500, not the client's
 * fault. The look palettes keep their routes (GET /api/palettes, POST
 * /api/palette/:id); these are the effect palettes beside them.
 */
export function attachEffectRoutes(app: Express, ctx: RouteContext): void {
  // Read when a request comes, as the other domains read theirs: a test that
  // stands in for the integrations with only what it needs still mounts these.
  const effects = () => ctx.integrations.library.effects;
  const palettes = () => ctx.integrations.library.palettes;

  app.get('/api/effects', (_req, res) => {
    const { builtin, user } = effects().list();
    res.json({ ok: true, families: FAMILIES, builtin, user, palettes: { builtin: ALL_PALETTES, user: palettes().list() } });
  });

  // Answers once the renderer has decided it, wherever it renders: applied on
  // a frame of the effect it was meant for, or why not.
  app.post('/api/effects/command', asyncHandler(async (req, res) => {
    const { cmd, arg } = validate(commandSchema, req.body ?? {}, 'command');
    const result = await effectCommand(cmd, arg);
    if (result.status === 'applied') return res.json({ ok: true, ...result });
    const [status, error] = REFUSALS[result.status];
    res.status(status).json({ ok: false, error, ...result });
  }));

  app.get('/api/effects/:id', (req, res) => {
    const entry = effects().get(req.params.id);
    if (!entry) return res.status(404).json({ ok: false, error: 'No such effect' });
    res.json({ ok: true, ...entry });
  });

  app.post('/api/effects', (req, res) => {
    res.status(201).json({ ok: true, preset: effects().create(req.body ?? {}) });
  });

  /** The 404 for an id that is no saved preset: a built-in says how to make it one's own. */
  const noPreset = (id: string) => (effects().get(id)
    ? 'A built-in preset cannot be changed: save a copy as a preset of your own'
    : 'No such preset');

  app.put('/api/effects/:id', (req, res) => {
    const preset = effects().update(req.params.id, req.body ?? {});
    if (!preset) return res.status(404).json({ ok: false, error: noPreset(req.params.id) });
    res.json({ ok: true, preset });
  });

  app.delete('/api/effects/:id', (req, res) => {
    if (!effects().remove(req.params.id)) return res.status(404).json({ ok: false, error: noPreset(req.params.id) });
    res.json({ ok: true });
  });

  // The list is GET /api/effects; GET /api/palettes stays the look palettes'.
  app.get('/api/palettes/:id', (req, res) => {
    const entry = palettes().get(req.params.id);
    if (!entry) return res.status(404).json({ ok: false, error: 'No such palette' });
    res.json({ ok: true, ...entry });
  });

  app.post('/api/palettes', (req, res) => {
    res.status(201).json({ ok: true, palette: palettes().create(req.body ?? {}) });
  });

  app.put('/api/palettes/:id', (req, res) => {
    const palette = palettes().update(req.params.id, req.body ?? {});
    if (!palette) return res.status(404).json({ ok: false, error: 'No such palette of your own' });
    res.json({ ok: true, palette });
  });

  app.delete('/api/palettes/:id', (req, res) => {
    if (!palettes().remove(req.params.id)) return res.status(404).json({ ok: false, error: 'No such palette of your own' });
    res.json({ ok: true });
  });

  // ─── The palette override ─────────────────────────────────────────────────
  // Light DJ's active palette: every effect plays these colours instead of its
  // own. A palette by id goes on as the colours it has now, its random ones
  // rolled once; a later edit to the palette leaves what is on stage.
  const overrideNow = () => (state.paletteOverride ? state.paletteOverride.map(toHex) : null);

  app.put('/api/palette-override', (req, res) => {
    const body = validate(overrideSchema, req.body ?? {}, 'palette-override');
    const palette = 'paletteId' in body ? palettes().materializeBody(body.paletteId) : body;
    if (!palette) return res.status(404).json({ ok: false, error: 'No such palette' });
    applyPatch({ overridePalette: palette }, { paletteOverrideId: 'paletteId' in body ? body.paletteId : null });
    res.json({ ok: true, paletteOverride: overrideNow() });
  });

  app.delete('/api/palette-override', (_req, res) => {
    applyPatch({ paletteOverride: null });
    res.json({ ok: true, paletteOverride: null });
  });

  // ─── Safety ───────────────────────────────────────────────────────────────
  app.get('/api/safety', (_req, res) => res.json({ ok: true, ...safety.status() }));

  // Given once, and saved: from then on the strobes and the fast effects play.
  app.post('/api/safety/acknowledge', (_req, res) => {
    safety.acknowledge();
    ctx.integrations.broadcast();
    res.json({ ok: true, ...safety.status() });
  });
}
