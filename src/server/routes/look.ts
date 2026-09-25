import { state, getClientState, getFixture, maxBrightnessOf } from '../state.ts';
import { applyPatch, applyOverride, setFixtureMaxBrightness, processTap } from '../patch.ts';
import { PALETTES } from '../palettes.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import type { RouteContext } from './common.ts';

/**
 * The look on stage: the state, the quick controls a Stream Deck or a script
 * presses (tap, blackout, pattern, colour, palette, tempo, master, energy),
 * and the per-fixture overrides.
 */
export function attachLookRoutes(app: Express, _ctx: RouteContext): void {
  // ─── State ────────────────────────────────────────────────────────────────
  app.get('/api/state', (_req, res) => res.json(getClientState()));

  app.post('/api/set', (req, res) => {
    try {
      applyPatch(req.body);
      res.json({ ok: true, state: getClientState() });
    } catch (err) {
      res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) });
    }
  });

  // ─── Quick controls ───────────────────────────────────────────────────────
  app.post('/api/tap', (_req, res) => {
    processTap();
    res.json({ ok: true, bpm: state.bpm });
  });

  app.post('/api/blackout/toggle', (_req, res) => {
    applyPatch({ masterBlackout: !state.masterBlackout });
    res.json({ ok: true, masterBlackout: state.masterBlackout });
  });

  app.post('/api/blackout/:onoff', (req, res) => {
    applyPatch({ masterBlackout: req.params.onoff !== 'off' });
    res.json({ ok: true, masterBlackout: state.masterBlackout });
  });

  app.post('/api/pattern/:id', (req, res) => {
    try {
      applyPatch({ pattern: req.params.id });
      res.json({ ok: true, pattern: state.pattern });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/color/:slot/:index', (req, res) => {
    const slotMap: Record<string, string> = { a: 'colorA', b: 'colorB', c: 'colorC', d: 'colorD' };
    const slot = slotMap[req.params.slot] || 'colorA';
    try {
      applyPatch({ [slot]: parseInt(req.params.index, 10) });
      res.json({ ok: true, colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // The named looks manual mode picks from, and the one on stage.
  app.get('/api/palettes', (_req, res) => {
    res.json({ ok: true, palettes: PALETTES, palette: state.palette });
  });

  // Writes all four colour slots from one look. `size` picks the bank (2, 3 or
  // 4 colours); a smaller palette wraps to fill every slot.
  app.post('/api/palette/:id', (req, res) => {
    try {
      const raw = (req.body && req.body.size) ?? req.query.size;
      const size = raw === undefined ? 4 : parseInt(raw, 10);
      applyPatch({ palette: req.params.id, paletteSize: size });
      res.json({
        ok: true,
        palette: state.palette,
        colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD,
      });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/bpm/:value', (req, res) => {
    try {
      applyPatch({ bpm: Number(req.params.value) });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/bpm/adjust/:delta', (req, res) => {
    try {
      applyPatch({ bpm: Math.round((state.bpm + Number(req.params.delta)) * 100) / 100 });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/play', (_req, res) => { applyPatch({ running: true });  res.json({ ok: true }); });
  app.post('/api/stop', (_req, res) => { applyPatch({ running: false }); res.json({ ok: true }); });

  app.post('/api/master/:value', (req, res) => {
    try {
      applyPatch({ masterDimmer: parseInt(req.params.value, 10) });
      res.json({ ok: true, masterDimmer: state.masterDimmer });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // Note: /api/energy/off must come before :id
  app.post('/api/energy/off', (_req, res) => {
    applyPatch({ energyOverride: null });
    res.json({ ok: true, energyOverride: null });
  });

  app.post('/api/energy/:id', (req, res) => {
    try {
      applyPatch({ energyOverride: req.params.id });
      res.json({ ok: true, energyOverride: state.energyOverride });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // ─── Per-fixture overrides ────────────────────────────────────────────────
  app.post('/api/fixture/:id/override', (req, res) => {
    try {
      applyOverride(parseInt(req.params.id, 10), req.body);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/fixture/:id/blackout/toggle', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const fixture = getFixture(id);
      if (!fixture) return res.status(404).json({ ok: false, error: 'No such fixture' });
      const cur = fixture.override;
      const blackout = !(cur && cur.blackout);
      if (!blackout && cur && cur.blackout && !cur.enabled) {
        applyOverride(id, null);
        return res.json({ ok: true });
      }
      applyOverride(id, {
        ...(cur || { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }),
        blackout,
      });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  // A trim rather than an override: it scales whatever is driving the fixture —
  // the pattern engine, an override, or an energy override — and survives
  // clearing the override.
  app.post('/api/fixture/:id/max/:value', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const value = parseInt(req.params.value, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return res.status(400).json({ ok: false, error: 'maxBrightness must be an integer from 0 to 255' });
    }
    const fixture = getFixture(id);
    if (!fixture) {
      return res.status(404).json({ ok: false, error: 'No such fixture' });
    }
    setFixtureMaxBrightness(id, value);
    res.json({ ok: true, id, maxBrightness: maxBrightnessOf(fixture) });
  });

  app.post('/api/fixture/:id/clear', (req, res) => {
    applyOverride(parseInt(req.params.id, 10), null);
    res.json({ ok: true });
  });
}
