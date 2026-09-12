'use strict';

const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const multer = require('multer');

const {
  state, getClientState, universeOf, maxBrightnessOf, countUniverses,
} = require('./state');
const { applyPatch, applyOverride, setFixtureMaxBrightness, processTap } = require('./patch');
const { PALETTES } = require('./palettes');
const { resizeFixtureBuffers } = require('./engine');
const { parseGDTF } = require('../gdtf');
const {
  BUILTIN_PROFILE_ID,
  isBuiltinProfile,
  MAX_FIXTURES,
  UNIVERSE_SIZE,
  endChannel,
  fitsInUniverse,
  registerProfile,
  unregisterProfile,
  listProfiles,
} = require('./profiles');
const { MAX_UNIVERSES } = require('./universes');
const { cues, cueWriteSchema, cueRestoreSchema, reorderSchema } = require('./cues');
const { showStore, snapshotShow, applyShow } = require('./show-store');
const {
  midiMap, ACTIONS, defaultTypeFor, mapSchema, learnSchema, bindingWriteSchema,
} = require('./midi-map');
const {
  profileSchema, midiConnectSchema, deezerStateSchema,
  fixtureRestoreSchema, dmxUniverse, huePairSchema, validate,
} = require('./validation');
const output = require('./output');
const { discoverBridges, pair: pairBridge, listEntertainmentConfigs } = require('./hue');
const { settings, RESTART_PATHS, CONFIG_FILE } = require('./settings');
const { generateToken } = require('./auth');
const { runPreflight } = require('./preflight');
const {
  warmRequestSchema, warmPlaylistSchema, parseSetList, fromSpotifyTracks,
  MAX_TRACKS: MAX_WARM_TRACKS,
} = require('./warm');
const pythonEnv = require('../python-env');

// Audio uploads genuinely need headroom; GDTF files do not. Separate limits so
// the fixture importer isn't handed a 50 MB budget it has no use for — a real
// GDTF is a few hundred KB.
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const uploadGdtf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Local-file analysis reads an arbitrary path off the filesystem. When a
// library folder is set in the settings page, confine it to that subtree;
// blank keeps the old behaviour (fine on a loopback-only bind, less so once the
// server is exposed). Read per request so a change applies without a restart.
function assertLocalPathAllowed(source) {
  const configured = settings.get('analysis.localRoot');
  if (!configured) return;
  const root = path.resolve(configured);
  const resolved = path.resolve(source);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    const err = new Error(`Local file analysis is restricted to ${root}`);
    err.status = 403;
    throw err;
  }
}

/** Remember the chosen MIDI ports so the pick survives a restart. */
function persistMidi({ input, output }) {
  try {
    settings.update({ midi: { input: input || '', output: output || '' } });
  } catch (err) {
    console.warn(`[settings] could not persist MIDI ports: ${err.message}`);
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function attachRoutes(app, deps) {
  const { midi, autoShow, spotify, nowPlaying, deezerSource, prolink, analysisCache, integrations, applier } = deps;

  // ─── State ────────────────────────────────────────────────────────────────
  app.get('/api/state', (_req, res) => res.json(getClientState()));

  app.post('/api/set', (req, res) => {
    try {
      applyPatch(req.body);
      res.json({ ok: true, state: getClientState() });
    } catch (err) {
      res.status(err.status || 400).json({ ok: false, error: err.message });
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
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/color/:slot/:index', (req, res) => {
    const slotMap = { a: 'colorA', b: 'colorB', c: 'colorC', d: 'colorD' };
    const slot = slotMap[req.params.slot] || 'colorA';
    try {
      applyPatch({ [slot]: parseInt(req.params.index, 10) });
      res.json({ ok: true, colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
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
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/bpm/:value', (req, res) => {
    try {
      applyPatch({ bpm: parseInt(req.params.value, 10) });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/bpm/adjust/:delta', (req, res) => {
    try {
      applyPatch({ bpm: state.bpm + parseInt(req.params.delta, 10) });
      res.json({ ok: true, bpm: state.bpm });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/play', (_req, res) => { applyPatch({ running: true });  res.json({ ok: true }); });
  app.post('/api/stop', (_req, res) => { applyPatch({ running: false }); res.json({ ok: true }); });

  app.post('/api/master/:value', (req, res) => {
    try {
      applyPatch({ masterDimmer: parseInt(req.params.value, 10) });
      res.json({ ok: true, masterDimmer: state.masterDimmer });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
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
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ─── Per-fixture overrides ────────────────────────────────────────────────
  app.post('/api/fixture/:id/override', (req, res) => {
    try {
      applyOverride(parseInt(req.params.id, 10), req.body);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/fixture/:id/blackout/toggle', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const cur = state.fixtures[id] && state.fixtures[id].override;
      applyOverride(id, {
        ...(cur || { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0 }),
        enabled: true,
        blackout: !(cur && cur.blackout),
      });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
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
    if (!Number.isInteger(id) || id < 0 || id >= state.fixtures.length) {
      return res.status(404).json({ ok: false, error: 'No such fixture' });
    }
    setFixtureMaxBrightness(id, value);
    res.json({ ok: true, id, maxBrightness: maxBrightnessOf(state.fixtures[id]) });
  });

  app.post('/api/fixture/:id/clear', (req, res) => {
    applyOverride(parseInt(req.params.id, 10), null);
    res.json({ ok: true });
  });

  // ─── MIDI ─────────────────────────────────────────────────────────────────
  app.get('/api/midi/ports', (_req, res) => res.json(midi.listPorts()));

  app.post('/api/midi/connect', (req, res) => {
    try {
      const body = validate(midiConnectSchema, req.body || {}, 'midi-connect');
      midi.close();
      const ok = midi.connect(body.input || null, body.output || null);
      persistMidi(body);
      res.json({ ok, enabled: midi.enabled, ports: midi.listPorts() });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  // ─── MIDI mapping and learn ───────────────────────────────────────────────
  // The map used to be a constant describing one controller. It is now stored,
  // editable, and relearnable by pressing the control you want.
  app.get('/api/midi/map', (_req, res) => {
    res.json({
      ok: true,
      ...midiMap.snapshot(),
      // The catalogue the settings page renders its picker from, so the list of
      // bindable actions lives in one place rather than two.
      actions: ACTIONS,
      learning: midi.learning,
    });
  });

  app.put('/api/midi/map', (req, res) => {
    try {
      midiMap.replace(validate(mapSchema, req.body || {}, 'midi-map'));
      res.json({ ok: true, ...midiMap.snapshot() });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/midi/map/reset', (_req, res) => {
    midiMap.reset();
    res.json({ ok: true, ...midiMap.snapshot() });
  });

  /** Bind or clear one message by hand, for when the controller isn't to hand. */
  app.put('/api/midi/map/binding', (req, res) => {
    try {
      const { kind, number, binding } = validate(bindingWriteSchema, req.body || {}, 'midi-binding');
      midiMap.setBinding(kind, number, binding);
      res.json({ ok: true, ...midiMap.snapshot() });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  /**
   * Arm learn and answer when a control is pressed.
   *
   * The request is held open until the controller sends something, learn is
   * cancelled, or it times out — so the page gets its answer without polling,
   * and a client that navigates away disarms nothing it did not arm.
   */
  app.post('/api/midi/learn', asyncHandler(async (req, res) => {
    if (!midi.enabled) {
      return res.status(400).json({ ok: false, error: 'No MIDI input connected — pick a port first' });
    }
    let binding;
    try {
      binding = validate(learnSchema, req.body || {}, 'midi-learn');
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    // A CC binding needs to know whether the control is an encoder or a fader.
    // The action says which by default; an explicit type in the request wins,
    // for the controller whose faders send relative or whose encoders don't.
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
      return res.status(err.status || 500).json({ ok: false, error: err.message });
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

  // ─── PRO DJ LINK ──────────────────────────────────────────────────────────
  app.post('/api/prolink/enable',  (_req, res) => { applyPatch({ prolinkEnabled: true });  res.json({ ok: true, prolink: getClientState().prolink }); });
  app.post('/api/prolink/disable', (_req, res) => { applyPatch({ prolinkEnabled: false }); res.json({ ok: true, prolink: getClientState().prolink }); });
  app.post('/api/prolink/toggle',  (_req, res) => { applyPatch({ prolinkEnabled: !state.prolinkEnabled }); res.json({ ok: true, prolink: getClientState().prolink }); });

  // ─── GDTF / Profiles / Fixtures / Show ────────────────────────────────────
  app.post('/api/gdtf/parse', uploadGdtf.single('gdtf'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    try {
      const result = await parseGDTF(req.file.buffer);
      res.json({ ok: true, fixture: result });
    } catch (err) {
      console.error('GDTF parse error:', err.message);
      res.status(400).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/profiles', (req, res) => {
    try {
      const profile = validate(profileSchema, req.body, 'profile');
      if (!registerProfile(profile)) return res.status(400).json({ ok: false, error: 'Invalid profile' });
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.delete('/api/profiles/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltinProfile(id)) return res.status(400).json({ ok: false, error: 'Cannot remove built-in profile' });
    const inUse = state.fixtures.some((f) => f.profileId === id);
    if (inUse) return res.status(400).json({ ok: false, error: 'Profile is in use by patched fixtures' });
    unregisterProfile(id);
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.post('/api/fixtures', (req, res) => {
    if (state.fixtures.length >= MAX_FIXTURES) {
      return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
    }
    // New fixtures land on the rig's default universe unless the caller names
    // another one, and auto-address behind whatever is already on *that*
    // universe — addressing behind the whole patch would leave a hole at the
    // front of every universe but the first.
    let universe = state.artnet.universe;
    if (req.body && req.body.universe !== undefined) {
      const parsed = dmxUniverse.safeParse(req.body.universe);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'universe must be an integer from 0 to 32767' });
      }
      universe = parsed.data;
    }

    let maxEnd = 0;
    const profiles = listProfiles();
    for (const fix of state.fixtures) {
      if (universeOf(fix) !== universe) continue;
      const profile = profiles[fix.profileId] || profiles[BUILTIN_PROFILE_ID];
      const end = fix.address + profile.channelCount;
      if (end > maxEnd) maxEnd = end;
    }
    const chCount = profiles[BUILTIN_PROFILE_ID].channelCount;
    // Auto-address after the last patched fixture. Clamping to a fixed 501 used
    // to hand out an address the new fixture does not actually fit at, so the
    // tail of a full universe silently produced dead channels.
    const address = Math.max(1, maxEnd);
    if (!fitsInUniverse(address, chCount)) {
      return res.status(400).json({
        ok: false,
        error: `No room left in universe ${universe}: a ${chCount}-channel fixture at ${address} `
          + `would end at ${endChannel(address, chCount)}, past the ${UNIVERSE_SIZE}-channel universe`,
      });
    }
    const newId = state.fixtures.length;
    const next = [...state.fixtures, { universe }];
    if (countUniverses(next) > MAX_UNIVERSES) {
      return res.status(400).json({
        ok: false,
        error: `Universe ${universe} would put the patch on more than the ${MAX_UNIVERSES} `
          + 'universes this server transmits',
      });
    }
    state.fixtures.push({
      id: newId,
      label: `Fixture ${newId + 1}`,
      address,
      universe,
      profileId: BUILTIN_PROFILE_ID,
      maxBrightness: 255,
      override: null,
    });
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // Answers with the fixture that was removed and its position, so the client
  // can offer an undo. Fixture ids are positional and get reindexed on delete,
  // so "put it back" needs the index as well as the fixture.
  app.delete('/api/fixtures/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (state.fixtures.length <= 1) return res.status(400).json({ ok: false, error: 'Must have at least one fixture' });
    const index = state.fixtures.findIndex((f) => f.id === id);
    if (index < 0) return res.status(404).json({ ok: false, error: 'No such fixture' });

    const [removed] = state.fixtures.splice(index, 1);
    state.fixtures.forEach((f, i) => { f.id = i; });
    resizeFixtureBuffers();
    showStore.scheduleSave();
    integrations.broadcast();
    res.json({
      ok: true,
      index,
      fixture: {
        label: removed.label,
        address: removed.address,
        universe: universeOf(removed),
        profileId: removed.profileId,
        maxBrightness: maxBrightnessOf(removed),
        override: removed.override,
      },
    });
  });

  /**
   * Put a deleted fixture back at its old index.
   *
   * Held to exactly the same rules as adding one — the patch may have changed
   * in the seconds the undo was on screen, and an undo that reintroduces an
   * overlap or overflows a universe is worse than no undo at all.
   */
  app.post('/api/fixtures/restore', (req, res) => {
    try {
      const { index, fixture } = validate(fixtureRestoreSchema, req.body || {}, 'fixture-restore');
      if (state.fixtures.length >= MAX_FIXTURES) {
        return res.status(400).json({ ok: false, error: `Patch is full (${MAX_FIXTURES} fixtures)` });
      }

      const profiles = listProfiles();
      const profileId = profiles[fixture.profileId] ? fixture.profileId : BUILTIN_PROFILE_ID;
      const chCount = profiles[profileId].channelCount;
      if (!fitsInUniverse(fixture.address, chCount)) {
        return res.status(400).json({
          ok: false,
          error: `"${fixture.label}" at address ${fixture.address} needs ${chCount} channels and would end at `
            + `${endChannel(fixture.address, chCount)}, past the ${UNIVERSE_SIZE}-channel universe`,
        });
      }

      const restored = {
        id: 0,                          // reassigned by the reindex below
        label: fixture.label,
        address: fixture.address,
        universe: fixture.universe !== undefined ? fixture.universe : state.artnet.universe,
        profileId,
        maxBrightness: fixture.maxBrightness !== undefined ? fixture.maxBrightness : 255,
        override: fixture.override || null,
      };

      if (countUniverses([...state.fixtures, restored]) > MAX_UNIVERSES) {
        return res.status(400).json({
          ok: false,
          error: `Universe ${restored.universe} would put the patch on more than the ${MAX_UNIVERSES} `
            + 'universes this server transmits',
        });
      }

      const at = Math.max(0, Math.min(state.fixtures.length, index));
      state.fixtures.splice(at, 0, restored);
      state.fixtures.forEach((f, i) => { f.id = i; });
      resizeFixtureBuffers();
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true, id: at });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  // The show file: the patch as a portable document. The server saves it for
  // the operator on every change (see show-store.js), so this is for moving a
  // rig between machines or keeping a copy, not for not losing your work.
  app.get('/api/show', (_req, res) => res.json(snapshotShow()));

  app.post('/api/show', (req, res) => {
    try {
      applyShow(req.body);
      // The uploaded show is the rig now, so it is also what a restart restores.
      showStore.scheduleSave();
      integrations.broadcast();
      res.json({ ok: true });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

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
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  // Note: /api/cues/reorder must come before :id
  app.post('/api/cues/reorder', (req, res) => {
    try {
      const { ids } = validate(reorderSchema, req.body || {}, 'cue-reorder');
      cues.reorder(ids);
      integrations.broadcast();
      res.json({ ok: true, cues: cues.summaries() });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  app.put('/api/cues/:id', (req, res) => {
    try {
      const body = validate(cueWriteSchema, req.body || {}, 'cue');
      const cue = cues.update(req.params.id, body);
      if (!cue) return res.status(404).json({ ok: false, error: 'No such cue' });
      integrations.broadcast();
      res.json({ ok: true, cue });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
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
    } catch (err) { res.status(err.status || 500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/cues/restore', (req, res) => {
    try {
      const { cue, index } = validate(cueRestoreSchema, req.body || {}, 'cue-restore');
      const restored = cues.insert(cue, index);
      if (!restored) return res.status(409).json({ ok: false, error: 'That cue is already in the stack' });
      integrations.broadcast();
      res.json({ ok: true, cue: restored });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/cues/:id/recall', (req, res) => {
    try {
      if (!cues.recall(req.params.id)) return res.status(404).json({ ok: false, error: 'No such cue' });
      // recallLook goes through applyPatch, which broadcasts on its own.
      res.json({ ok: true, state: getClientState() });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  // ─── Spotify ──────────────────────────────────────────────────────────────
  app.get('/auth/spotify', (_req, res) => {
    if (!spotify.configured) {
      // Not env vars: settings.js deliberately never reads process.env, so
      // pointing the operator at one would send them somewhere that cannot work.
      return res.status(400).json({
        ok: false,
        error: 'Add a Spotify client ID and secret in the settings page first',
      });
    }
    res.redirect(spotify.getAuthorizeUrl());
  });

  app.get('/auth/spotify/callback', asyncHandler(async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing authorization code');

    // Bind this callback to a flow this server started. Without it, any page
    // could navigate the operator's browser here with an attacker's code and
    // silently bind the show to the attacker's account.
    if (!spotify.consumeState(req.query.state)) {
      if (settings.get('spotify.allowUnverifiedState')) {
        console.warn(
          '[spotify] callback state missing or unrecognised — accepted because '
          + '"accept unverified state" is enabled. This disables OAuth CSRF protection.'
        );
      } else {
        console.warn('[spotify] rejected callback: missing or unrecognised state parameter');
        return res.status(400).send(
          'Spotify auth failed: missing or unrecognised state parameter. '
          + 'Start the flow from /auth/spotify in this browser.'
          + (spotify.usingProxy
            ? ' If your OAuth proxy does not forward the state parameter, either clear '
              + 'the proxy (Spotify accepts a 127.0.0.1 redirect directly, and the state '
              + 'then round-trips intact) or enable "accept unverified state" in the '
              + 'settings page — the latter disables OAuth CSRF protection.'
            : '')
        );
      }
    }

    try {
      await spotify.exchangeCode(code);
      spotify.startPolling();
      console.log('Spotify authenticated successfully');
      integrations.broadcast();
      res.send('<html><body style="background:#0d0d0f;color:#e8e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#44ff88">Spotify Connected</h2><p>You can close this window and return to the lightshow.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>');
    } catch (err) {
      console.error('Spotify auth error:', err.message);
      res.status(500).send(`Spotify auth failed: ${err.message}`);
    }
  }));

  app.post('/api/spotify/disconnect', (_req, res) => {
    // The operator asked to disconnect, so drop the saved session too —
    // otherwise the next restart would silently sign back in.
    spotify.disconnect({ forget: true });
    integrations.clearSpotifyNext();
    integrations.broadcast();
    res.json({ ok: true });
  });

  /**
   * The connected account's playlists, so warming can offer a picker instead of
   * demanding a pasted link. Private ones need the playlist scope — a
   * connection older than it gets the public subset, and `canReadPlaylists`
   * on the Spotify status tells the UI to offer a reconnect.
   */
  app.get('/api/spotify/playlists', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    try {
      const playlists = await spotify.getMyPlaylists();
      res.json({ ok: true, playlists, canReadPlaylists: spotify.canReadPlaylists });
    } catch (err) {
      res.status(err.status === 401 ? 400 : 502).json({ ok: false, error: err.message });
    }
  }));

  app.get('/api/spotify/now-playing', asyncHandler(async (_req, res) => {
    try {
      const playing = await spotify.getCurrentlyPlaying();
      res.json({ ok: true, playing });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  // ─── Now playing (OS media session) ─────────────────────────────────────────
  app.post('/api/nowplaying/disconnect', (_req, res) => {
    nowPlaying.disconnect();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // ─── Deezer (browser extension) ─────────────────────────────────────────────
  // No CORS headers here on purpose. The extension POSTs from its background
  // script (see browser-extension/background.js), which holds a host permission
  // and is therefore not subject to page CORS at all. A wildcard
  // Access-Control-Allow-Origin used to sit here and let any website on the
  // internet push fake now-playing state into the show.

  // The Firefox extension POSTs the Deezer web player's state here: the current
  // track (with ISRC + position) and the upcoming queue (for prefetch).
  app.post('/api/deezer/state', (req, res) => {
    try {
      integrations.onDeezerState(validate(deezerStateSchema, req.body || {}, 'deezer-state'));
      res.json({ ok: true, status: deezerSource.getStatus() });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/deezer/disconnect', (_req, res) => {
    integrations.onDeezerDisconnect();
    res.json({ ok: true });
  });

  // ─── Auto-show ────────────────────────────────────────────────────────────
  const { keyForSpotify, keyForYouTube, keyForQuery, keyForLocalFile, keyForBuffer, keyForProlinkTrack } =
    require('../analysis-cache');

  app.post('/api/auto/analyze', asyncHandler(async (req, res) => {
    const { source } = req.body || {};
    if (!source) return res.status(400).json({ ok: false, error: 'Provide a source (file path, URL, or YouTube search)' });

    const isLocalFile = /^[a-zA-Z]:[\\/]|^\//.test(source);
    const isDirectAudio = /\.(mp3|wav|ogg|flac|m4a|aac|wma)(\?|$)/i.test(source);

    try {
      if (isLocalFile || isDirectAudio) {
        if (isLocalFile) assertLocalPathAllowed(source);
        autoShow.track = { name: path.basename(source), artist: 'Local file', album: '', albumArt: null };
        const cacheKey = isLocalFile ? keyForLocalFile(source) : `url:${source}`;
        await autoShow.analyze(source, cacheKey);
      } else {
        autoShow.track = { name: source, artist: '', album: '', albumArt: null };
        integrations.broadcast();
        const cacheKey = keyForYouTube(source) || keyForQuery(source);
        await autoShow.downloadAndAnalyze(source, null, cacheKey);
      }
      integrations.broadcast();
      res.json({ ok: true, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/analyze-spotify', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    try {
      const playing = await spotify.getCurrentlyPlaying();
      if (!playing) return res.status(400).json({ ok: false, error: 'No track currently playing on Spotify' });

      autoShow.track = {
        name: playing.name, artist: playing.artist, album: playing.album,
        albumArt: playing.albumArt, durationMs: playing.durationMs,
      };
      integrations.broadcast();

      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForSpotify(playing.trackId) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
      integrations.prefetchNextFromQueue();
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/analyze-nowplaying', asyncHandler(async (_req, res) => {
    if (!nowPlaying.authenticated) return res.status(400).json({ ok: false, error: 'Nothing is currently playing' });
    try {
      const playing = await nowPlaying.getCurrentlyPlaying();
      if (!playing) return res.status(400).json({ ok: false, error: 'Nothing is currently playing' });

      autoShow.track = {
        name: playing.name, artist: playing.artist, album: playing.album,
        albumArt: playing.albumArt, durationMs: playing.durationMs,
      };
      integrations.broadcast();

      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/analyze-deezer', asyncHandler(async (_req, res) => {
    if (!deezerSource.authenticated) return res.status(400).json({ ok: false, error: 'Deezer extension not connected' });
    try {
      const playing = await deezerSource.getCurrentlyPlaying();
      if (!playing) return res.status(400).json({ ok: false, error: 'No track currently playing on Deezer' });

      autoShow.track = {
        name: playing.name, artist: playing.artist, album: playing.album,
        albumArt: playing.albumArt, durationMs: playing.durationMs,
      };
      integrations.broadcast();

      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/download-analyze', asyncHandler(async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'Provide a query (YouTube URL or search terms)' });
    try {
      autoShow.track = { name: query, artist: '', album: '', albumArt: null };
      integrations.broadcast();
      const cacheKey = keyForYouTube(query) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, null, cacheKey);
      integrations.broadcast();
      res.json({ ok: true, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/analyze-upload', uploadAudio.single('audio'), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded' });
    const tmpPath = path.join(os.tmpdir(), `auto-analyze-${Date.now()}${path.extname(req.file.originalname) || '.mp3'}`);
    try {
      // Async on purpose: this buffer can be 50 MB, and a synchronous write of
      // that size stalls the event loop — which here means the 40 Hz Art-Net
      // render loop stops sending frames and the rig visibly freezes mid-show.
      await fsp.writeFile(tmpPath, req.file.buffer);
      autoShow.track = { name: req.file.originalname, artist: 'Local file', album: '', albumArt: null };
      const cacheKey = keyForBuffer(req.file.buffer);
      await autoShow.analyze(tmpPath, cacheKey);
      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      await fsp.unlink(tmpPath).catch(() => { /* already gone */ });
    }
  }));

  app.post('/api/auto/analyze-prolink', asyncHandler(async (_req, res) => {
    if (!prolink.connected) return res.status(400).json({ ok: false, error: 'PRO DJ LINK not connected' });
    const track = prolink.getTrack();
    if (!track) return res.status(400).json({ ok: false, error: 'No track loaded on the master CDJ' });
    if (!track.title || !track.artist) return res.status(400).json({ ok: false, error: 'Track has no rekordbox metadata — cannot search' });

    try {
      autoShow.track = {
        name: track.title, artist: track.artist, album: track.album || '',
        albumArt: null, durationMs: track.durationMs || 0,
      };
      integrations.broadcast();

      const query = `${track.artist} - ${track.title}`;
      const cacheKey = keyForProlinkTrack(track);
      // The downloaded WAV is unlinked by auto-show's own finally block.
      await autoShow.downloadAndAnalyze(query, (track.durationMs || 0) / 1000, cacheKey);

      integrations.broadcast();
      res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/auto/start', (_req, res) => {
    if (!autoShow.analysis) return res.status(400).json({ ok: false, error: 'No analysis loaded. Analyze a track first.' });
    const source = integrations.startAutoShow();
    integrations.broadcast();
    res.json({ ok: true, source });
  });

  app.post('/api/auto/stop', (_req, res) => {
    autoShow.stop();
    integrations.broadcast();
    res.json({ ok: true });
  });

  app.post('/api/auto/reset', (_req, res) => {
    autoShow.reset();
    integrations.broadcast();
    res.json({ ok: true });
  });

  // The energy slider, on its own endpoint so a Stream Deck button or a script
  // can reach it without composing a state patch.
  app.post('/api/auto/intensity/:value', (req, res) => {
    try {
      applyPatch({ autoIntensity: parseInt(req.params.value, 10) });
      res.json({ ok: true, intensity: state.autoIntensity });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  // Nudging this mid-set is normal — an operator hears the lights lagging and
  // corrects — so it gets its own endpoint alongside intensity rather than
  // living only in the settings page.
  app.post('/api/auto/sync-offset/:value', (req, res) => {
    try {
      applyPatch({ autoSyncOffsetMs: parseInt(req.params.value, 10) });
      res.json({ ok: true, syncOffsetMs: state.autoSyncOffsetMs });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  app.post('/api/auto/palette-size/:value', (req, res) => {
    try {
      const raw = req.params.value;
      applyPatch({ autoPaletteSize: raw === 'auto' ? 'auto' : parseInt(raw, 10) });
      res.json({ ok: true, paletteSize: autoShow.paletteSize });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  app.get('/api/auto/state', (_req, res) => {
    res.json({
      ok: true,
      ...autoShow.getClientState(),
      spotify: spotify.getStatus(),
      nowPlaying: nowPlaying.getStatus(),
      deezer: deezerSource.getStatus(),
    });
  });

  app.get('/api/auto/timeline', (_req, res) => {
    const data = autoShow.getTimelineData();
    if (!data) return res.status(404).json({ ok: false, error: 'No analysis loaded' });
    res.json({ ok: true, data });
  });

  app.get('/api/auto/cache', (_req, res) => {
    res.json({ ok: true, entries: analysisCache.list() });
  });

  app.delete('/api/auto/cache', (_req, res) => {
    const removed = analysisCache.clear();
    res.json({ ok: true, removed });
  });

  app.delete('/api/auto/cache/entry', (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
    const ok = analysisCache.delete(key);
    res.json({ ok });
  });

  // ─── Set-list warming ─────────────────────────────────────────────────────
  // Analyse a whole night up front. Live prefetch only sees one to five tracks
  // ahead, and only once something is playing.
  app.get('/api/warm', (_req, res) => res.json({ ok: true, warm: integrations.warmer.status() }));

  app.post('/api/warm', (req, res) => {
    try {
      const body = validate(warmRequestSchema, req.body || {}, 'warm');
      const inputs = [...(body.tracks || []), ...parseSetList(body.text)];
      if (!inputs.length) {
        return res.status(400).json({ ok: false, error: 'Provide a set list as `text` or `tracks`' });
      }
      res.json({ ok: true, warm: integrations.warmer.start(inputs) });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  });

  /** Warm everything Spotify has queued, rather than only the next few. */
  app.post('/api/warm/spotify-queue', asyncHandler(async (_req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });
    const queue = await spotify.getQueue();
    if (!queue || !queue.length) return res.status(400).json({ ok: false, error: 'Spotify queue is empty' });

    try {
      res.json({ ok: true, warm: integrations.warmer.start(fromSpotifyTracks(queue)) });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  }));

  /**
   * Warm a Spotify playlist.
   *
   * The queue only exists once something is playing and rarely holds a whole
   * night; a playlist is the set list most people already have. Takes a share
   * link, a Spotify URI or a bare id.
   */
  app.post('/api/warm/spotify-playlist', asyncHandler(async (req, res) => {
    if (!spotify.authenticated) return res.status(400).json({ ok: false, error: 'Spotify not connected' });

    let body;
    try {
      body = validate(warmPlaylistSchema, req.body || {}, 'warm playlist');
    } catch (err) { return res.status(err.status || 400).json({ ok: false, error: err.message }); }

    let playlist;
    try {
      playlist = await spotify.getPlaylist(body.playlist, { limit: MAX_WARM_TRACKS });
    } catch (err) {
      // Spotify answers 404 for a playlist you cannot see, which is also what a
      // private playlist looks like without the scope. Say which it probably is
      // rather than leaving the operator to guess at a bare "not found".
      if (err.status === 404 && !spotify.canReadPlaylists) {
        return res.status(400).json({
          ok: false,
          error: 'Playlist not found. If it is private or collaborative, reconnect '
            + 'Spotify — this connection predates the playlist permission.',
        });
      }
      // A bad reference or a lapsed connection is the caller's to fix; a real
      // 404 is the playlist's; anything else is Spotify failing on our behalf.
      const status = err.status === 400 || err.status === 401 ? 400
        : err.status === 404 ? 404
          : 502;
      return res.status(status).json({ ok: false, error: err.message });
    }

    const inputs = fromSpotifyTracks(playlist.tracks);
    if (!inputs.length) {
      return res.status(400).json({
        ok: false,
        error: `"${playlist.name}" has no tracks to warm`,
      });
    }

    try {
      res.json({
        ok: true,
        playlist: {
          id: playlist.id, name: playlist.name, owner: playlist.owner,
          total: playlist.total, truncated: playlist.truncated,
        },
        warm: integrations.warmer.start(inputs),
      });
    } catch (err) { res.status(err.status || 400).json({ ok: false, error: err.message }); }
  }));

  app.delete('/api/warm', (_req, res) => {
    const cancelled = integrations.warmer.cancel();
    if (!cancelled) integrations.warmer.clear();
    res.json({ ok: true, cancelled, warm: integrations.warmer.status() });
  });

  // ─── Preflight ────────────────────────────────────────────────────────────
  // The same checks `npm run preflight` runs, with the live subsystems wired in
  // so MIDI and the playback sources report what is actually connected rather
  // than what is merely configured.
  app.get('/api/preflight', asyncHandler(async (_req, res) => {
    const report = await runPreflight({ midi, spotify, prolink, analysisCache, downloadModels: true });
    res.json({ ok: true, report });
  }));

  // ─── Settings ─────────────────────────────────────────────────────────────
  // Everything the operator can configure. Secrets are never sent back: the
  // client gets a per-secret "is one set?" flag and may replace or clear a
  // value, but cannot read it.
  // ─── Philips Hue ──────────────────────────────────────────────────────────
  // Pairing and area selection cannot be plain settings fields: the bridge
  // issues the credentials itself, and the list of areas only exists on the
  // bridge. These are the calls the settings page drives that with.

  app.get('/api/hue/status', (_req, res) => {
    const config = output.getHueConfig();
    res.json({
      ok: true,
      status: output.getHueStatus(),
      // Never the credentials — only whether we have them.
      paired: !!(config.username && config.clientKey),
      host: config.host,
      entertainmentId: config.entertainmentId,
      channels: config.channels,
    });
  });

  app.get('/api/hue/discover', asyncHandler(async (_req, res) => {
    const { bridges, error } = await discoverBridges();
    // Not an error status: discovery needs internet access the show network may
    // well not have, and typing the IP in is a perfectly normal path.
    res.json({ ok: true, bridges, error });
  }));

  /**
   * Pair with a bridge and store what it issues.
   *
   * The link button has to have been pressed in the last 30 seconds, so the
   * "press it and try again" answer is an ordinary outcome rather than a
   * failure — the page reports it and lets the operator retry.
   */
  app.post('/api/hue/pair', asyncHandler(async (req, res) => {
    const { host } = validate(huePairSchema, req.body || {}, 'hue pair');
    const result = await pairBridge(host, { label: os.hostname() });
    if (!result.ok) {
      return res.status(result.pressLink ? 409 : 502)
        .json({ ok: false, error: result.error, pressLink: !!result.pressLink });
    }

    const changed = settings.update({
      hue: {
        host,
        username: result.username,
        clientKey: result.clientKey,
        applicationId: result.applicationId || '',
      },
    });
    applier.applyChanged(changed);

    // Hand back the areas straight away: pairing is only ever done in order to
    // pick one, and a second round trip here just adds a step to the setup.
    let areas = [];
    let areasError = null;
    try {
      areas = await listEntertainmentConfigs(host, result.username);
    } catch (err) {
      areasError = err.message;
    }
    res.json({ ok: true, host, areas, areasError });
  }));

  /** The entertainment areas on the paired bridge, with their channel ids. */
  app.get('/api/hue/areas', asyncHandler(async (_req, res) => {
    const config = output.getHueConfig();
    if (!config.host || !config.username) {
      return res.status(409).json({ ok: false, error: 'Pair with a bridge first.' });
    }
    try {
      const areas = await listEntertainmentConfigs(config.host, config.username);
      res.json({ ok: true, areas });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  }));

  /**
   * Forget the bridge.
   *
   * Clears the credentials and turns the output off, because leaving it enabled
   * with nothing to connect to would have the render loop retrying a bridge the
   * operator has just said they are done with. The application key stays
   * registered on the bridge itself — Hue offers no way to revoke it from here,
   * so that is done in the Hue app under linked devices.
   */
  app.post('/api/hue/disconnect', (_req, res) => {
    try {
      const changed = settings.update({
        hue: {
          enabled: false, host: '', username: '', clientKey: '', applicationId: '',
          entertainmentId: '', channels: [],
        },
      });
      applier.applyChanged(changed);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

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
      const detail = err.issues
        ? err.issues.map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')
        : err.message;
      res.status(400).json({ ok: false, error: detail });
    }
  });

  // A token the operator can actually use, rather than asking them to run a
  // node one-liner. Returned once, in the clear, because it has to be copied
  // into Companion and the browser extension — it is not stored until saved.
  app.post('/api/settings/token/suggest', (_req, res) => {
    res.json({ ok: true, token: generateToken() });
  });

  // ─── Error handler ────────────────────────────────────────────────────────
  // Must be registered last. Without it, anything that reaches next(err) — an
  // upload over the size limit, a malformed JSON body, a throw inside an
  // asyncHandler — fell through to Express's default handler, which answers
  // with an HTML page carrying the stack trace (it only hides it when NODE_ENV
  // is 'production', which a locally-run show tool never sets). Every other
  // route here answers JSON; this makes the failure paths agree.
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return;

    // Multer signals "too big" with a code rather than a status.
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'Uploaded file is too large' });
    }
    if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ ok: false, error: `Unexpected file field "${err.field}"` });
    }

    const status = err && (err.status || err.statusCode);
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: err.message });
    }

    // Genuine server-side faults: log the detail, return only the message.
    console.error('[api] unhandled error:', err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: (err && err.message) || 'Internal error' });
  });
}

module.exports = { attachRoutes };
