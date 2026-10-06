// What a party frame costs on the main thread: forty placed fixtures, a
// two-lane sequence playing, two pad loops on top and the strobe latched,
// all through the engine's own frame path. A frame must stay under 5 ms.
//
// Load is handled as in pixel-budget.test.js: the frames are judged on the
// CPU time the process spent, and the budget is scaled by how much slower a
// fixed piece of arithmetic ran than on a quiet machine, so busy neighbours
// on a CI runner do not fail it. The figures printed are the measured ones.

import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';

import { state, voices, strobe } from '../../src/server/state.ts';
import { renderFrame, renderInput, resizeFixtureBuffers, setSequenceSource } from '../../src/server/engine.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch } from '../../src/server/patch.ts';
import { settings } from '../../src/server/settings.ts';
import * as universes from '../../src/server/universes.ts';
import { getProfile, BUILTIN_PROFILE_ID } from '../../src/server/profiles.ts';
import { Sequencer } from '../../src/server/sequencer.ts';
import { Pads, PadStore, patternPlayer } from '../../src/server/pads.ts';
import { builtinPresets } from '../../src/server/voices.ts';
import { STROBE_VOICE_ID } from '../../src/server/strobe.ts';
import { STROBE_DEFAULTS } from '../../src/shared/effects/strobe.ts';
import { presetById } from '../../src/shared/effects/index.ts';

const FIXTURES = 40;
const WARM_UP = 50;
const FRAMES = 200;

// Same calibration as pixel-budget.test.js: about 2 ms of CPU on a quiet
// 2024 desktop core. A slower or busier machine scales the budget up; a
// faster one never scales it below the 5 ms it is written for.
const QUIET_CALIBRATION_MS = 2;
const FRAME_BUDGET_MS = 5;
// Longer than the strobe's flash and the black after it together (0.2 s), several times over.
const DARK_GAP_MS = 1000;

/** CPU ms for a fixed piece of arithmetic, the cheapest of a few tries. */
function calibrate(tries = 5) {
  let best = Infinity;
  let sink = 0;
  for (let t = 0; t < tries; t++) {
    const cpu0 = process.cpuUsage();
    for (let i = 0; i < 1_000_000; i++) sink += Math.sqrt(i) * 1e-9;
    const used = process.cpuUsage(cpu0);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  if (sink < 0) throw new Error('unreachable');
  return best;
}

const lane = (id) => ({ id, kind: 'shared', name: id, mute: false, solo: false });
const clip = (id, laneId, preset) => ({
  id, laneId, startBeat: 0, lengthBeats: 1e6, loopBeats: 1e6, effect: presetById(preset).spec, targets: 'lane', mute: false,
});

test('a party frame on forty placed fixtures renders inside 5 ms', () => {
  const before = { fixtures: state.fixtures, artnet: state.artnet.enabled, values: settings._values };
  const ownSave = Object.hasOwn(settings, 'save') ? settings.save : null;
  let beat = 0;
  conductor.setProlinkSource(() => ({ beatPos: beat, bpm: 128 }));
  state.artnet.enabled = false;
  // The strobe waits for the photosensitivity acknowledgement; settings stay in memory.
  settings._values = {
    ...before.values,
    safety: { ...before.values.safety, photosensitivityAcknowledged: true, strobeMaxLatchSec: 60 },
    strobe: { ...STROBE_DEFAULTS },
  };
  settings.save = () => {};
  try {
    const width = getProfile({ profileId: BUILTIN_PROFILE_ID }).channelCount;
    const perUniverse = Math.floor(512 / width);
    state.fixtures = Array.from({ length: FIXTURES }, (_, i) => ({
      id: i, label: `PAR ${i + 1}`, profileId: BUILTIN_PROFILE_ID, maxBrightness: 255, override: null,
      universe: Math.floor(i / perUniverse), address: 1 + (i % perUniverse) * width,
      position: { x: 5 + (i % 10) * 10, y: 10 + Math.floor(i / 10) * 25 },
    }));
    resizeFixtureBuffers();
    applyPatch({ running: true, pattern: 'wave', masterDimmer: 255, masterBlackout: false, colorA: 1, colorB: 5 });

    // Wired as integrations.ts wires it: the engine reads the sequencer's frame each render.
    const sequencer = new Sequencer({ resolve: () => null });
    sequencer.load({
      id: 'party', name: 'Party', lanes: [lane('a'), lane('b')],
      clips: [clip('wave', 'a', 'ldj.GrooveWave'), clip('domino', 'b', 'hd.neonDomino')],
    });
    sequencer.play();
    setSequenceSource((reading) => sequencer.frame(reading));

    // Two loop pads from the default layout, on the live voice manager.
    const pads = new Pads({
      voices, store: new PadStore(path.join(os.tmpdir(), 'perf-party-none', 'pads.json')),
      lookup: () => builtinPresets, fixtureIds: () => state.fixtures.map((f) => f.id), beat: () => beat,
      // No pattern is on the shelf here: the pads under test are preset loops.
      patternVoice: patternPlayer({
        voices, pattern: () => null, fixtureIds: () => state.fixtures.map((f) => f.id), resolve: (id) => presetById(id)?.spec ?? null,
      }),
    });
    const padVoices = [pads.toggle(1, 0), pads.toggle(1, 4)];
    assert.ok(padVoices.every(Boolean), 'both pads launched');
    strobe.on('latched');

    const frame = () => { beat += 0.1; renderFrame(); };
    for (let f = 0; f < WARM_UP; f++) frame();

    // The setup took effect: the engine is handed all three voices and a playing sequence.
    const input = renderInput();
    const playing = input.voices.map((v) => v.id);
    for (const id of [STROBE_VOICE_ID, ...padVoices.map((v) => v.id)]) assert.ok(playing.includes(id), `voice ${id} plays`);
    assert.ok(input.sequenceTransport, 'the sequence plays');
    assert.equal(input.sequenceRevision, sequencer.table().revision);

    const calibration = calibrate();
    // Cheapest of a few batches, as pixel-budget.test.js does.
    let cpu = Infinity;
    const ms = [];
    for (let b = 0; b < 5; b++) {
      const cpu0 = process.cpuUsage();
      for (let f = 0; f < FRAMES; f++) {
        const t0 = performance.now();
        frame();
        ms.push(performance.now() - t0);
      }
      const used = process.cpuUsage(cpu0);
      cpu = Math.min(cpu, (used.user + used.system) / 1000 / FRAMES);
    }
    ms.sort((a, b) => a - b);
    const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    const p95 = ms[Math.floor(ms.length * 0.95)];

    // Not an empty engine: some channel on the rig is lit. The strobe holds
    // the whole rig black for a tenth of a second after each flash, on the
    // wall clock, and these frames run far faster than that: so look, untimed,
    // for as long as that gap can last and a little more.
    const lit = () => state.fixtures.some((fix) => universes.getBuffer(fix.universe)
      .subarray(fix.address - 1, fix.address - 1 + width).some((v) => v > 0));
    let shown = lit();
    for (const until = performance.now() + DARK_GAP_MS; !shown && performance.now() < until;) { frame(); shown = lit(); }
    assert.ok(shown, 'the rig shows something');

    const slowdown = Math.max(1, calibration / QUIET_CALIBRATION_MS);
    const budget = FRAME_BUDGET_MS * slowdown;
    console.log(`[perf-party] ${FIXTURES} fixtures, 2 lanes, 2 pads, strobe; calibration ${calibration.toFixed(2)} ms, budget ${budget.toFixed(1)} ms`);
    console.log(`[perf-party]   cpu ${cpu.toFixed(3)} ms  wall mean ${mean.toFixed(3)} ms  p95 ${p95.toFixed(3)} ms  min ${ms[0].toFixed(3)}  max ${ms.at(-1).toFixed(3)}`);
    assert.ok(cpu < budget, `a party frame takes ${cpu.toFixed(2)} ms of CPU on average, over ${budget.toFixed(1)} ms (machine ${slowdown.toFixed(1)}× slower than quiet)`);
  } finally {
    voices.stopAll();
    setSequenceSource(null);
    conductor.setProlinkSource(null);
    settings._values = before.values;
    if (ownSave) settings.save = ownSave;
    else delete settings.save;
    state.fixtures = before.fixtures;
    state.artnet.enabled = before.artnet;
    resizeFixtureBuffers();
  }
});
