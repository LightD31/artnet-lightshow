import { midiMap, ACTIONS, defaultTypeFor, mapSchema, learnSchema, bindingWriteSchema } from '../midi-map.ts';
import { validate } from '../validation.ts';
import { connectMidi } from '../midi-connect.ts';
import { messageOf, statusOf } from '../../errors.ts';
import type { Express } from 'express';
import { asyncHandler } from './common.ts';
import type { RouteContext } from './common.ts';

export function attachMidiRoutes(app: Express, ctx: RouteContext): void {
  const { midi } = ctx;

  app.get('/api/midi/ports', (_req, res) => res.json(midi.listPorts()));

  app.post('/api/midi/connect', (req, res) => {
    try {
      res.json(connectMidi(midi, req.body));
    } catch (err) { res.status(400).json({ ok: false, error: messageOf(err) }); }
  });

  app.get('/api/midi/map', (_req, res) => {
    res.json({
      ok: true,
      ...midiMap.snapshot(),
      actions: ACTIONS,
      learning: midi.learning,
    });
  });

  app.put('/api/midi/map', (req, res) => {
    try {
      midiMap.replace(validate(mapSchema, req.body || {}, 'midi-map'));
      res.json({ ok: true, ...midiMap.snapshot() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  app.post('/api/midi/map/reset', (_req, res) => {
    midiMap.reset();
    res.json({ ok: true, ...midiMap.snapshot() });
  });

  app.put('/api/midi/map/binding', (req, res) => {
    try {
      const { kind, number, binding } = validate(bindingWriteSchema, req.body || {}, 'midi-binding');
      midiMap.setBinding(kind, number, binding);
      res.json({ ok: true, ...midiMap.snapshot() });
    } catch (err) { res.status(statusOf(err) || 400).json({ ok: false, error: messageOf(err) }); }
  });

  // Keep learn ownership with its request so disconnecting one caller cannot cancel another’s session.
  app.post('/api/midi/learn', asyncHandler(async (req, res) => {
    if (!midi.enabled) {
      return res.status(400).json({ ok: false, error: 'No MIDI input connected — pick a port first' });
    }
    let binding;
    try {
      binding = validate(learnSchema, req.body || {}, 'midi-learn');
    } catch (err) {
      return res.status(400).json({ ok: false, error: messageOf(err) });
    }

    const captured = await midi.startLearn(binding);
    if (!captured) {
      return res.json({ ok: false, error: 'Learn cancelled or timed out', learned: null });
    }

    const stored = { ...captured.binding };
    if (captured.kind === 'cc' && !stored.type) stored.type = defaultTypeFor(stored.action);
    if (captured.kind === 'notes') delete stored.type;

    try {
      midiMap.setBinding(captured.kind, captured.number, stored);
    } catch (err) {
      return res.status(statusOf(err) || 500).json({ ok: false, error: messageOf(err) });
    }

    res.json({
      ok: true,
      learned: { kind: captured.kind, number: captured.number, channel: captured.channel, binding: stored },
      ...midiMap.snapshot(),
    });
  }));

  app.post('/api/midi/learn/cancel', (_req, res) => {
    res.json({ ok: true, cancelled: midi.cancelLearn('cancelled') });
  });
}
