// What a rig of pars puts out, pinned byte for byte.
//
// Pixel support rebuilds the pattern layer, the rehearsal preview and parts of
// the director around cells. A rig with no multi-cell fixture must not notice:
// every frame the engine sends, every colour the preview draws and every scene
// the director plans stays exactly what it was. These hashes were taken before
// that work started; a change to any of them is a change to every existing show.
//
// Everything that would make a frame depend on when it ran is pinned: the
// monotonic clock, the musical clock (a fake master deck), and the dice the
// random patterns roll.

import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { state } from '../../src/server/state.ts';
import * as universes from '../../src/server/universes.ts';
import { renderFrame, resizeFixtureBuffers } from '../../src/server/engine.ts';
import { conductor } from '../../src/server/conductor.ts';
import { applyPatch, applyOverride, setFixtureMaxBrightness } from '../../src/server/patch.ts';
import { PATTERNS, COLOR_PRESETS } from '../../src/server/presets.ts';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import AutoShow from '../../src/auto-show.ts';

// The engine hash changed once, on purpose: the built-in par's dimmer is
// 16-bit, and its fine channel used to be written 0. It now carries the low
// byte of the level (renderer.js writeDimmer), and the coarse byte is that
// level's high byte rather than its rounding. With the fine write taken back
// out, every frame matches the hash taken before the pixel work
// (e2498330…1dad) — nothing else about a rig of pars moved.
const GOLDEN = {
  engine: '1e425b3fafbb63d4b6f79f0e5c0664473c97516dff137a907eb0704683019c97',
  preview: 'd6cfb97766c9ebcb5e646d0749f496c5c6c7213a1f33a07bcb009fa81b70ed2a',
  director: '439b3a2570f5d4ebd40ab199541b9ee5d07a8d71fef8f6f6f97359f0535ec419',
};

/** A seeded stand-in for Math.random, so twinkle rolls the same dice every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withPinnedWorld(fn) {
  const realRandom = Math.random;
  const realNow = performance.now;
  Math.random = seeded(1234);
  let now = 1e9;
  performance.now = () => now;
  try {
    return fn({ advance: (ms) => { now += ms; } });
  } finally {
    Math.random = realRandom;
    performance.now = realNow;
  }
}

const par = (id, address, extra = {}) => ({
  id, label: `PAR ${id + 1}`, address, universe: 0, profileId: 'cameo-root-par-6-12ch',
  maxBrightness: 255, override: null, ...extra,
});

/** Four pars, a Hue colour lamp and a Hue white-ambiance lamp. */
function rig({ placed }) {
  const fixtures = [
    par(0, 1), par(1, 13), par(2, 25), par(3, 37),
    { ...par(4, 49), profileId: 'generic-hue-lamp-7ch' },
    { ...par(5, 56), profileId: 'generic-hue-white-ambiance-3ch' },
  ];
  if (placed) {
    const spots = [[80, 20], [10, 60], [50, 30], [50, 80], [30, 10], [65, 55]];
    const groups = ['front', 'back', 'front', 'back', 'room', 'front'];
    fixtures.forEach((f, i) => { f.position = { x: spots[i][0], y: spots[i][1] }; f.group = groups[i]; });
  }
  return fixtures;
}

const DYNAMICS = { level: 0.7, bass: 0.8, vocal: 0.3, air: 0.5, width: 0.6, motion: 0.5, decay: 0.2 };

// The patterns there were when these hashes were taken. Fixed rather than read
// from PATTERNS, so adding an effect later does not look like changing one.
const PAR_PATTERNS = [
  'solid', 'fade', 'hit', 'strobe', 'color-cycle', 'rainbow', 'chase', 'chase-rev', 'ping-pong', 'runner',
  'pairs', 'wave', 'stack-up', 'split', 'sections', 'twinkle', 'sparkle', 'random-flash', 'ensemble', 'ribbon',
];

function engineHash() {
  const hash = crypto.createHash('sha256');
  state.artnet.enabled = false;
  let beat = 0;
  conductor.setProlinkSource(() => ({ beatPos: beat, bpm: 120 }));
  try {
    withPinnedWorld(({ advance }) => {
      const frames = (n) => {
        for (let f = 0; f < n; f++) {
          advance(25);
          beat += 0.125;
          renderFrame();
          for (const u of universes.list()) hash.update(universes.getBuffer(u));
        }
      };
      const scene = (patch, n = 48) => {
        beat = 0;
        applyPatch(patch);
        frames(n);
      };
      const base = {
        colorA: 1, colorB: 5, colorC: 3, colorD: 8, beatDivision: 2, running: true, split: null,
        masterDimmer: 255, masterBlackout: false, energyOverride: null, showDynamics: null, strobeSpeed: 0,
      };

      for (const placed of [false, true]) {
        state.fixtures = rig({ placed });
        resizeFixtureBuffers();
        for (const id of PAR_PATTERNS) scene({ ...base, pattern: id });
      }

      // The placed rig, through everything that sits around the pattern.
      state.fixtures = rig({ placed: true });
      resizeFixtureBuffers();
      scene({ ...base, pattern: 'chase', split: 0 });
      scene({ ...base, pattern: 'sections', split: 1 });
      for (const pattern of ['ensemble', 'ribbon', 'wave', 'chase', 'twinkle']) {
        scene({ ...base, pattern, showDynamics: DYNAMICS });
      }
      scene({ ...base, pattern: 'strobe', strobeSpeed: 200, strobeFunction: 'standard' });
      for (const burst of ['blinder', 'glow', 'color-strobe', 'uv-wash', 'kill']) {
        scene({ ...base, pattern: 'chase', energyOverride: burst }, 12);
      }
      applyOverride(1, { enabled: true, r: 200, g: 10, b: 30, w: 0, a: 40, uv: 0, dim: 180, strobe: 0, blackout: false });
      applyOverride(2, { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: true });
      setFixtureMaxBrightness(3, 100);
      scene({ ...base, pattern: 'runner', masterDimmer: 128 });
      applyOverride(1, null);
      applyOverride(2, null);
      setFixtureMaxBrightness(3, 255);
      scene({ ...base, pattern: 'wave' }, 16);
      applyPatch({ colorA: 5, fadeMs: 400 });
      frames(24);
      scene({ ...base, pattern: 'solid', showDynamics: { ...DYNAMICS, level: 0 } }, 8);
    });
  } finally {
    conductor.setProlinkSource(null);
  }
  return hash.digest('hex');
}

function previewHash() {
  const hash = crypto.createHash('sha256');
  const beats = Array.from({ length: 400 }, (_, i) => 0.35 + i * (60 / 123.7));
  const at = (b) => Math.round((0.35 + b * (60 / 123.7)) * 1000);
  const timeline = [];
  let b = 0;
  const colours = { colorA: 1, colorB: 5, colorC: 3, colorD: 8 };
  for (const id of PAR_PATTERNS) {
    timeline.push({ timeMs: at(b), action: 'patch', data: { pattern: id, ...colours, beatDivision: 2, split: null, showDynamics: DYNAMICS } });
    b += 6;
  }
  // And without a show's dynamics — all but the two expressive patterns, whose
  // preview without them is a known mismatch with the rig that the pixel work
  // fixes on purpose.
  for (const id of PAR_PATTERNS.filter((p) => p !== 'ensemble' && p !== 'ribbon')) {
    timeline.push({ timeMs: at(b), action: 'patch', data: { pattern: id, ...colours, beatDivision: 1, showDynamics: null } });
    b += 4;
  }
  timeline.push({ timeMs: at(b), action: 'patch', data: { pattern: 'chase', split: 0, showDynamics: DYNAMICS } });
  b += 4;
  timeline.push({ timeMs: at(b), action: 'patch', data: { colorA: 6, fadeMs: 1500, split: null } });
  b += 4;
  timeline.push({ timeMs: at(b), action: 'energy', data: { id: 'blinder', durationMs: 400 } });
  b += 2;
  timeline.push({ timeMs: at(b), action: 'patch', data: { pattern: 'sections', beatDivision: 1, showDynamics: { level: 0.4, air: 0.9 } } });
  b += 6;

  withPinnedWorld(() => {
    for (const placed of [false, true]) {
      const fixtures = rig({ placed });
      fixtures[3].maxBrightness = 120;
      const sample = createPreviewSampler(timeline, { beats });
      for (let t = 0; t < at(b); t += 50) {
        for (const c of sample(t, fixtures, COLOR_PRESETS)) {
          hash.update(`${c.r},${c.g},${c.b},${c.w},${c.a},${c.uv};`);
        }
      }
    }
  });
  return hash.digest('hex');
}

function directorHash() {
  const hash = crypto.createHash('sha256');
  const dir = path.join(import.meta.dirname, '..', 'fixtures', 'tracks');
  for (const file of fs.readdirSync(dir).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const intensity of [25, 50, 90]) {
      for (const paletteSize of [4, 'auto']) {
        const show = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS);
        show._worker.shutdown();
        show.analysis = doc.analysis || doc;
        show.intensity = intensity;
        show.paletteSize = paletteSize;
        show.buildTimeline();
        hash.update(JSON.stringify(show.intents));
        hash.update(JSON.stringify(show.timeline));
      }
    }
  }
  return hash.digest('hex');
}

test('a rig of pars renders exactly the frames it always has', () => {
  assert.strictEqual(engineHash(), GOLDEN.engine);
});

test('the rehearsal preview of a rig of pars is unchanged', () => {
  assert.strictEqual(previewHash(), GOLDEN.preview);
});

test('the director plans a rig of pars exactly as it always has', () => {
  assert.strictEqual(directorHash(), GOLDEN.director);
});
