'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const MidiController = require('./src/midi');
const ProLink = require('./src/prolink');
const { parseGDTF } = require('./src/gdtf');
const SpotifyClient = require('./src/spotify');
const deezer = require('./src/deezer');
const AutoShow = require('./src/auto-show');
const {
  AnalysisCache,
  keyForSpotify,
  keyForYouTube,
  keyForQuery,
  keyForLocalFile,
  keyForBuffer,
  keyForProlinkTrack,
} = require('./src/analysis-cache');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── ArtNet ──────────────────────────────────────────────────────────────────

const udpSocket = dgram.createSocket('udp4');
udpSocket.bind(() => {
  try { udpSocket.setBroadcast(true); } catch (_) {}
});

function buildArtDmxPacket(universe, dmxData) {
  const packet = Buffer.alloc(18 + 512);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = 0;
  packet[13] = 0;
  packet.writeUInt16LE(universe & 0x7fff, 14);
  packet.writeUInt16BE(512, 16);
  dmxData.copy(packet, 18, 0, 512);
  return packet;
}

function sendArtNet() {
  const packet = buildArtDmxPacket(state.artnet.universe, dmx);
  udpSocket.send(packet, 0, packet.length, state.artnet.port, state.artnet.host);
}

// ─── Fixture Profiles ────────────────────────────────────────────────────────
// Profiles define the channel layout of a fixture type. The built-in profile
// matches the Cameo ROOT PAR 6 in 12-channel mode. Additional profiles can be
// added at runtime via GDTF import.

const BUILTIN_PROFILE_ID = 'cameo-root-par-6-12ch';

// UV LEDs are physically dimmer than RGBW — boost their DMX value so they
// remain visually competitive at lower dimmer settings.
const UV_BOOST = 1.8;

const fixtureProfiles = {
  [BUILTIN_PROFILE_ID]: {
    id: BUILTIN_PROFILE_ID,
    name: 'ROOT PAR 6',
    manufacturer: 'Cameo',
    modeName: '12-channel (D12CH)',
    channelCount: 12,
    channelMap: {
      dimmer: 0, dimmerFine: 1, strobe: 2,
      red: 3, green: 4, blue: 5,
      white: 6, amber: 7, uv: 8,
      macro: 9, sound: 10, delay: 11,
    },
    channelList: [
      { offset: 0,  name: 'Dimmer',      attribute: 'dimmer' },
      { offset: 1,  name: 'Dimmer Fine',  attribute: 'dimmerFine' },
      { offset: 2,  name: 'Strobe',       attribute: 'strobe' },
      { offset: 3,  name: 'Red',          attribute: 'red' },
      { offset: 4,  name: 'Green',        attribute: 'green' },
      { offset: 5,  name: 'Blue',         attribute: 'blue' },
      { offset: 6,  name: 'White',        attribute: 'white' },
      { offset: 7,  name: 'Amber',        attribute: 'amber' },
      { offset: 8,  name: 'UV',           attribute: 'uv' },
      { offset: 9,  name: 'Color Macro',  attribute: 'macro' },
      { offset: 10, name: 'Sound',        attribute: 'sound' },
      { offset: 11, name: 'DMX Delay',    attribute: 'delay' },
    ],
  },
};

// Legacy constants used internally (derived from first profile)
const DEFAULT_ADDRESSES = [1, 13, 25, 37];

function getFixtureCount() { return state.fixtures.length; }
function getProfile(fixture) { return fixtureProfiles[fixture.profileId] || fixtureProfiles[BUILTIN_PROFILE_ID]; }
function getChannelCount(fixture) { return getProfile(fixture).channelCount; }
function getCh(fixture, attr) {
  const map = getProfile(fixture).channelMap;
  return map[attr] !== undefined ? map[attr] : -1;
}

// ─── Strobe functions (Ch3 DMX ranges) ──────────────────────────────────────
// Each entry defines a DMX range on channel 3. Speed-based functions map
// the 0-255 strobeSpeed value into the [lo..hi] range (slow → fast).
const STROBE_FUNCTIONS = [
  { id: 'standard',        name: 'Standard',          desc: 'Strobe slow → fast (1-20 Hz)', lo: 128, hi: 250 },
  { id: 'ramp-up-down',    name: 'Ramp Up/Down',      desc: 'Ramp up/down, slow → fast',    lo: 11,  hi: 22  },
  { id: 'ramp-up-down-rnd',name: 'Ramp Up/Down Rnd',  desc: 'Ramp up/down random',          lo: 23,  hi: 33  },
  { id: 'ramp-up',         name: 'Ramp Up',            desc: 'Ramp up, slow → fast',         lo: 34,  hi: 45  },
  { id: 'ramp-up-rnd',     name: 'Ramp Up Rnd',        desc: 'Ramp up random, slow → fast',  lo: 46,  hi: 56  },
  { id: 'ramp-down',       name: 'Ramp Down',          desc: 'Ramp down, slow → fast',       lo: 57,  hi: 68  },
  { id: 'ramp-down-rnd',   name: 'Ramp Down Rnd',      desc: 'Ramp down random, slow → fast',lo: 69,  hi: 79  },
  { id: 'random',          name: 'Random',             desc: 'Random strobe, slow → fast',   lo: 80,  hi: 102 },
  { id: 'break',           name: 'Break',              desc: 'Burst with break, 5s → 1s',    lo: 103, hi: 127 },
];

// ─── State ───────────────────────────────────────────────────────────────────

// NOTE on ordering: indices 0-11 are frozen because MIDI bindings
// (see src/midi.js) and stored shows reference them directly. New presets
// are appended after index 11. `Blackout` stays last so UI code that treats
// it as a sentinel continues to work (auto-show.js looks it up by name).
const COLOR_PRESETS = [
  { name: 'Red',        r: 255, g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 0
  { name: 'Orange',     r: 200, g: 60,  b: 0,   w: 0,   a: 180, uv: 0   }, // 1
  { name: 'Amber',      r: 0,   g: 0,   b: 0,   w: 0,   a: 255, uv: 0   }, // 2
  { name: 'Yellow',     r: 255, g: 220, b: 0,   w: 0,   a: 100, uv: 0   }, // 3
  { name: 'Green',      r: 0,   g: 255, b: 0,   w: 0,   a: 0,   uv: 0   }, // 4
  { name: 'Cyan',       r: 0,   g: 255, b: 255, w: 0,   a: 0,   uv: 0   }, // 5
  { name: 'Blue',       r: 0,   g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 6
  { name: 'Purple',     r: 100, g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 7
  { name: 'Magenta',    r: 255, g: 0,   b: 200, w: 0,   a: 0,   uv: 0   }, // 8
  { name: 'White',      r: 0,   g: 0,   b: 0,   w: 255, a: 0,   uv: 0   }, // 9
  { name: 'UV',         r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 255 }, // 10
  { name: 'UV (RGB)',   r: 60,  g: 0,   b: 255, w: 0,   a: 0,   uv: 0   }, // 11
  { name: 'Pink',       r: 255, g: 90,  b: 160, w: 0,   a: 0,   uv: 0   }, // 12
  { name: 'Teal',       r: 0,   g: 200, b: 170, w: 0,   a: 0,   uv: 0   }, // 13
  { name: 'Gold',       r: 255, g: 140, b: 0,   w: 0,   a: 200, uv: 0   }, // 14
  { name: 'Warm White', r: 120, g: 40,  b: 0,   w: 255, a: 200, uv: 0   }, // 15
  { name: 'Blackout',   r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   }, // 16
];

const PATTERNS = [
  { id: 'solid',        name: 'Solid',         desc: 'All fixtures same colour' },
  { id: 'chase',        name: 'Chase →',       desc: 'One fixture at a time, forward' },
  { id: 'chase-rev',    name: 'Chase ←',       desc: 'One fixture at a time, reverse' },
  { id: 'ping-pong',    name: 'Ping Pong',     desc: 'Forward then backward' },
  { id: 'strobe',       name: 'Strobe',        desc: 'All fixtures strobe on beat' },
  { id: 'fade',         name: 'Fade',          desc: 'Fade in/out together' },
  { id: 'color-cycle',  name: 'Colour Cycle',  desc: 'Cycle through hues in sync' },
  { id: 'rainbow',      name: 'Rainbow',       desc: 'Each fixture offset in hue' },
  { id: 'twinkle',      name: 'Twinkle',       desc: 'Random fixtures flash' },
  { id: 'split',        name: 'Split',         desc: 'Two colours alternating in pairs' },
  { id: 'sparkle',      name: 'Sparkle',       desc: 'Bright random pulses, instant' },
  { id: 'wave',         name: 'Wave',          desc: 'Sine brightness wave across fixtures' },
  { id: 'stack-up',     name: 'Stack Up',      desc: 'Fill fixtures one-by-one then reset' },
  { id: 'random-flash', name: 'Random Flash',  desc: 'Random fixture pops each beat' },
  { id: 'runner',       name: 'Runner',        desc: 'Chase with a fading trail' },
  { id: 'pairs',        name: 'Pairs',         desc: 'Two adjacent fixtures chase' },
  { id: 'hit',          name: 'Hit',           desc: 'All fixtures punch on beat, decay between' },
  { id: 'alt-halves',   name: 'Alt Halves',    desc: 'Two halves swap colours each beat' },
  { id: 'split-3',      name: 'Split 3',       desc: 'Three colours cycling across fixtures' },
  { id: 'chase-3',      name: 'Chase 3',       desc: 'Chase rotating through three colours' },
  { id: 'alt-thirds',   name: 'Alt Thirds',    desc: 'Three sections swap colours each beat' },
  { id: 'split-4',      name: 'Split 4',       desc: 'Four colours cycling across fixtures' },
  { id: 'chase-4',      name: 'Chase 4',       desc: 'Chase rotating through four colours' },
  { id: 'alt-quarters', name: 'Alt Quarters',  desc: 'Four sections swap colours each beat' },
  { id: 'pairs-4',      name: 'Pairs 4',       desc: 'Adjacent pairs chase with four colours' },
];

// ─── Energy overrides ────────────────────────────────────────────────────────
// Global "panic button" effects that override everything (except master blackout).
// Activated via UI, MIDI, REST, or Companion. Only one can be active at a time.

const ENERGY_EFFECTS = [
  { id: 'white-strobe',  name: 'White Strobe',  desc: 'Full white + fast strobe' },
  { id: 'blinder',       name: 'Blinder',       desc: 'Full white wall of light' },
  { id: 'uv-strobe',     name: 'UV Strobe',     desc: 'Full UV + fast strobe' },
  { id: 'color-strobe',  name: 'Colour Strobe', desc: 'Colour A + fast strobe' },
  { id: 'all-on',        name: 'All On',        desc: 'Every channel maxed out' },
];

const state = {
  artnet: {
    host: process.env.ARTNET_HOST || '2.255.255.255',
    port: Number.parseInt(process.env.ARTNET_PORT, 10) || 6454,
    universe: Number.parseInt(process.env.ARTNET_UNIVERSE, 10) || 0,
  },
  bpm: 120,
  beatDivision: 1,
  running: true,
  pattern: 'chase',
  colorA: 0,    // Red
  colorB: 6,    // Blue
  colorC: 4,    // Green
  colorD: 8,    // Magenta
  masterDimmer: 255,
  masterBlackout: false,
  strobeSpeed: 0,
  strobeFunction: 'standard', // id from STROBE_FUNCTIONS
  energyOverride: null, // null or string id from ENERGY_EFFECTS
  prolinkEnabled: false,
  autoSource: 'auto', // 'auto' | 'spotify' | 'prolink' | 'timer'
  fixtures: Array.from({ length: 4 }, (_, i) => ({
    id: i,
    label: `PAR ${i + 1}`,
    address: DEFAULT_ADDRESSES[i],
    profileId: BUILTIN_PROFILE_ID,
    override: null,
  })),
  _step: 0,
  _pingDir: 1,
  _hue: 0,
  _fadePhase: 0,
  _hitPhase: 1, // 0 = fresh hit (full bright), 1 = fully decayed
  _twinkle: new Array(4).fill(0),
};

const dmx = Buffer.alloc(512, 0);

// ─── Shared state mutation ────────────────────────────────────────────────────
// All sources (web UI, MIDI, REST API) go through these two functions.

let beatInterval = null;

function applyPatch(data) {
  let restartTimer = false;

  if (data.bpm !== undefined) {
    state.bpm = Math.max(20, Math.min(300, data.bpm));
    restartTimer = true;
  }
  if (data.beatDivision !== undefined) {
    state.beatDivision = data.beatDivision;
    restartTimer = true;
  }
  if (data.running !== undefined) {
    state.running = data.running;
    restartTimer = true;
  }
  if (data.pattern !== undefined) {
    state.pattern = data.pattern;
    state._step = 0;
    state._fadePhase = 0;
    state._hitPhase = 1;
  }
  if (data.colorA !== undefined) state.colorA = Math.max(0, Math.min(COLOR_PRESETS.length - 1, data.colorA));
  if (data.colorB !== undefined) state.colorB = Math.max(0, Math.min(COLOR_PRESETS.length - 1, data.colorB));
  if (data.colorC !== undefined) state.colorC = Math.max(0, Math.min(COLOR_PRESETS.length - 1, data.colorC));
  if (data.colorD !== undefined) state.colorD = Math.max(0, Math.min(COLOR_PRESETS.length - 1, data.colorD));
  if (data.masterDimmer !== undefined) state.masterDimmer = Math.max(0, Math.min(255, data.masterDimmer));
  if (data.masterBlackout !== undefined) state.masterBlackout = data.masterBlackout;
  if (data.strobeSpeed !== undefined) state.strobeSpeed = Math.max(0, Math.min(255, data.strobeSpeed));
  if (data.strobeFunction !== undefined) {
    state.strobeFunction = STROBE_FUNCTIONS.find(f => f.id === data.strobeFunction) ? data.strobeFunction : 'standard';
  }
  if (data.energyOverride !== undefined) {
    // null to clear, or a valid effect id
    state.energyOverride = data.energyOverride && ENERGY_EFFECTS.find(e => e.id === data.energyOverride) ? data.energyOverride : null;
  }
  if (data.artnet !== undefined) Object.assign(state.artnet, data.artnet);
  if (data.prolinkEnabled !== undefined) {
    if (data.prolinkEnabled && !state.prolinkEnabled) {
      state.prolinkEnabled = true;
      prolink.enable().catch((err) => {
        console.error('PRO DJ LINK enable failed:', err.message);
        state.prolinkEnabled = false;
        broadcast();
      });
    } else if (!data.prolinkEnabled && state.prolinkEnabled) {
      state.prolinkEnabled = false;
      prolink.disable().catch(() => {});
    }
  }
  if (data.autoSource !== undefined) {
    const allowed = ['auto', 'spotify', 'prolink', 'timer'];
    if (allowed.includes(data.autoSource)) state.autoSource = data.autoSource;
  }
  if (data.autoPaletteSize !== undefined) {
    // Live-swap the palette size for the current auto-show. Rebuilds the
    // timeline in place so the next tick applies the new colours.
    autoShow.setPaletteSize(Number(data.autoPaletteSize));
  }
  if (data.autoIntensity !== undefined) {
    autoShow.setIntensity(Number(data.autoIntensity));
  }

  if (restartTimer) restartBeatTimer();
  broadcast();
}

function applyOverride(id, override) {
  if (id >= 0 && id < getFixtureCount()) {
    state.fixtures[id].override = override;
    broadcast();
  }
}

// Tap tempo — shared tap buffer (keyed by source to avoid cross-contamination)
const tapTimes = [];

function processTap() {
  const now = Date.now();
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const diffs = [];
    for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    state.bpm = Math.max(20, Math.min(300, Math.round(60000 / avg)));
  }
  // A tap *is* a beat: advance the pattern immediately and phase-align the
  // next tick to the tap. Without this, rapid taps would clear and re-arm
  // the beat interval faster than it could ever fire, freezing patterns.
  restartBeatTimer({ tickNow: true });
  broadcast();
  setTimeout(() => {
    if (tapTimes.length > 0 && Date.now() - tapTimes[tapTimes.length - 1] > 2500) tapTimes.length = 0;
  }, 3000);
}

function broadcast() {
  io.emit('state', getClientState());
  midi.sendFeedback();
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255), w: 0 };
}

// ─── Engine ──────────────────────────────────────────────────────────────────

let fixtureColors = Array.from({ length: 4 }, () => ({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }));

function resizeFixtureColors() {
  while (fixtureColors.length < state.fixtures.length) {
    fixtureColors.push({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 });
  }
  if (fixtureColors.length > state.fixtures.length) fixtureColors.length = state.fixtures.length;
}

function tickPattern() {
  if (!state.running) return;
  const colA = COLOR_PRESETS[state.colorA];
  const colB = COLOR_PRESETS[state.colorB];
  const colC = COLOR_PRESETS[state.colorC];
  const colD = COLOR_PRESETS[state.colorD];
  const step = state._step;

  switch (state.pattern) {
    case 'solid':
      for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, 255, 0);
      break;
    case 'chase':
      for (let i = 0; i < getFixtureCount(); i++)
        setFixtureColor(i, i === step % getFixtureCount() ? colA : colB, i === step % getFixtureCount() ? 255 : 80, 0);
      break;
    case 'chase-rev':
      for (let i = 0; i < getFixtureCount(); i++) {
        const active = i === (getFixtureCount() - 1 - step % getFixtureCount());
        setFixtureColor(i, active ? colA : colB, active ? 255 : 80, 0);
      }
      break;
    case 'ping-pong': {
      const pos = step % (Math.max(2, getFixtureCount()) * 2 - 2);
      const idx = pos < getFixtureCount() ? pos : (Math.max(2, getFixtureCount()) * 2 - 2 - pos);
      for (let i = 0; i < getFixtureCount(); i++)
        setFixtureColor(i, i === idx ? colA : colB, i === idx ? 255 : 80, 0);
      break;
    }
    case 'strobe':
      for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, 255, 0);
      break;
    case 'fade':
      // Brightness is computed continuously in renderDmx for smoothness.
      // Here we just make sure the colour is set; brightness will be overwritten.
      for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, 255, 0);
      break;
    case 'color-cycle': {
      const col = hsvToRgb(state._hue, 1, 1);
      for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, col, 255, 0);
      break;
    }
    case 'rainbow':
      for (let i = 0; i < getFixtureCount(); i++) {
        const col = hsvToRgb(state._hue + (360 / Math.max(1, getFixtureCount())) * i, 1, 1);
        setFixtureColor(i, col, 255, 0);
      }
      break;
    case 'twinkle':
      for (let i = 0; i < getFixtureCount(); i++) {
        if (Math.random() < 0.4) state._twinkle[i] = Math.random() < 0.7 ? 255 : 60;
        setFixtureColor(i, colA, state._twinkle[i], 0);
      }
      break;
    case 'split':
      for (let i = 0; i < getFixtureCount(); i++)
        setFixtureColor(i, (i + step) % 2 === 0 ? colA : colB, 255, 0);
      break;
    case 'sparkle':
      // Instant random pulses — unlike twinkle this has no memory, so it reads
      // as sharper sparks rather than a slow scintillation.
      for (let i = 0; i < getFixtureCount(); i++) {
        const on = Math.random() < 0.35;
        setFixtureColor(i, colA, on ? 255 : 0, 0);
      }
      break;
    case 'wave': {
      // Travelling sinusoidal brightness wave using colA.
      const N = Math.max(1, getFixtureCount());
      for (let i = 0; i < N; i++) {
        const phase = (step * 0.25) - (i * (Math.PI * 2 / N));
        const b = Math.round(((Math.sin(phase) + 1) / 2) * 215 + 40);
        setFixtureColor(i, colA, b, 0);
      }
      break;
    }
    case 'stack-up': {
      // Fills fixtures with colA one step at a time, then clears to colB.
      const N = getFixtureCount();
      const cycle = N + 1;
      const pos = step % cycle;
      for (let i = 0; i < N; i++) {
        const lit = i < pos;
        setFixtureColor(i, lit ? colA : colB, lit ? 255 : 60, 0);
      }
      break;
    }
    case 'random-flash': {
      // Each beat, one random fixture slams to colA, the rest go dark.
      const N = getFixtureCount();
      const target = Math.floor(Math.random() * Math.max(1, N));
      for (let i = 0; i < N; i++)
        setFixtureColor(i, i === target ? colA : colB, i === target ? 255 : 0, 0);
      break;
    }
    case 'runner': {
      // Chase with a short fading tail behind the lead fixture.
      const N = Math.max(1, getFixtureCount());
      const lead = step % N;
      for (let i = 0; i < N; i++) {
        const dist = (lead - i + N) % N;
        const b = dist === 0 ? 255 : dist === 1 ? 150 : dist === 2 ? 70 : 0;
        setFixtureColor(i, colA, b, 0);
      }
      break;
    }
    case 'pairs': {
      // Two adjacent fixtures lit at once, chasing the group forward.
      const N = Math.max(1, getFixtureCount());
      const pos = step % N;
      for (let i = 0; i < N; i++) {
        const on = (i === pos || i === (pos + 1) % N);
        setFixtureColor(i, on ? colA : colB, on ? 255 : 50, 0);
      }
      break;
    }
    case 'hit': {
      // Per-beat punch: reset decay phase; renderDmx does the smooth fade.
      state._hitPhase = 0;
      for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, 255, 0);
      break;
    }
    case 'alt-halves': {
      // Two halves of the rig swap colA/colB on each beat. Different look
      // from 'split' (which alternates every other fixture).
      const N = Math.max(1, getFixtureCount());
      const half = Math.max(1, Math.floor(N / 2));
      const flipped = (step % 2) === 1;
      for (let i = 0; i < N; i++) {
        const firstHalf = i < half;
        const useA = flipped ? !firstHalf : firstHalf;
        setFixtureColor(i, useA ? colA : colB, 255, 0);
      }
      break;
    }
    // ── 3-colour patterns ──────────────────────────────────────────────────
    case 'split-3': {
      const cols3 = [colA, colB, colC];
      for (let i = 0; i < getFixtureCount(); i++)
        setFixtureColor(i, cols3[(i + step) % 3], 255, 0);
      break;
    }
    case 'chase-3': {
      const N = getFixtureCount();
      const cols3 = [colA, colB, colC];
      for (let i = 0; i < N; i++) {
        const active = i === step % N;
        setFixtureColor(i, active ? cols3[step % 3] : cols3[i % 3], active ? 255 : 60, 0);
      }
      break;
    }
    case 'alt-thirds': {
      const N = Math.max(1, getFixtureCount());
      const cols3 = [colA, colB, colC];
      const third = Math.max(1, Math.ceil(N / 3));
      const rot = step % 3;
      for (let i = 0; i < N; i++) {
        const section = Math.min(2, Math.floor(i / third));
        setFixtureColor(i, cols3[(section + rot) % 3], 255, 0);
      }
      break;
    }
    // ── 4-colour patterns ──────────────────────────────────────────────────
    case 'split-4': {
      const cols4 = [colA, colB, colC, colD];
      for (let i = 0; i < getFixtureCount(); i++)
        setFixtureColor(i, cols4[(i + step) % 4], 255, 0);
      break;
    }
    case 'chase-4': {
      const N = getFixtureCount();
      const cols4 = [colA, colB, colC, colD];
      for (let i = 0; i < N; i++) {
        const active = i === step % N;
        setFixtureColor(i, active ? cols4[step % 4] : cols4[i % 4], active ? 255 : 60, 0);
      }
      break;
    }
    case 'alt-quarters': {
      const N = Math.max(1, getFixtureCount());
      const cols4 = [colA, colB, colC, colD];
      const quarter = Math.max(1, Math.ceil(N / 4));
      const rot = step % 4;
      for (let i = 0; i < N; i++) {
        const section = Math.min(3, Math.floor(i / quarter));
        setFixtureColor(i, cols4[(section + rot) % 4], 255, 0);
      }
      break;
    }
    case 'pairs-4': {
      const N = Math.max(1, getFixtureCount());
      const cols4 = [colA, colB, colC, colD];
      const pos = step % N;
      for (let i = 0; i < N; i++) {
        const on = (i === pos || i === (pos + 1) % N);
        setFixtureColor(i, on ? cols4[step % 4] : cols4[i % 4], on ? 255 : 50, 0);
      }
      break;
    }
  }

  state._step++;
  state._hue = (state._hue + 360 / Math.max(1, getFixtureCount())) % 360;
}

function setFixtureColor(idx, color, dim, strobe) {
  fixtureColors[idx] = { r: color.r, g: color.g, b: color.b, w: color.w || 0, a: color.a || 0, uv: color.uv || 0, dim, strobe };
}

function resolveEnergyOverride() {
  const colA = COLOR_PRESETS[state.colorA];
  switch (state.energyOverride) {
    case 'white-strobe':  return { col: { r: 255, g: 255, b: 255, w: 255, a: 0,   uv: 0   }, dim: 255, strobe: 255 };
    case 'blinder':       return { col: { r: 255, g: 255, b: 255, w: 255, a: 0,   uv: 0   }, dim: 255, strobe: 0   };
    case 'uv-strobe':     return { col: { r: 60,  g: 0,   b: 200, w: 0,   a: 0,   uv: 255 }, dim: 255, strobe: 255 };
    case 'color-strobe':  return { col: { r: colA.r, g: colA.g, b: colA.b, w: colA.w || 0, a: colA.a || 0, uv: colA.uv || 0 }, dim: 255, strobe: 255 };
    case 'all-on':        return { col: { r: 255, g: 255, b: 255, w: 255, a: 255, uv: 255 }, dim: 255, strobe: 0   };
    default:              return null;
  }
}

let _lastRenderTs = Date.now();
function renderDmx() {
  const now = Date.now();
  const dt = Math.max(0, Math.min(0.25, (now - _lastRenderTs) / 1000));
  _lastRenderTs = now;

  // Advance the fade phase continuously so the fade pattern updates at the
  // full DMX rate (40 Hz) instead of stepping once per beat. Full fade cycle
  // spans 8 beats, matching the previous beat-stepped behaviour.
  if (state.running && state.pattern === 'fade') {
    const cycleSeconds = (60 / Math.max(1, state.bpm)) * 8;
    state._fadePhase = (state._fadePhase + dt / cycleSeconds) % 1;
    const bright = Math.round(((Math.sin(state._fadePhase * Math.PI * 2 - Math.PI / 2) + 1) / 2) * 230 + 25);
    const colA = COLOR_PRESETS[state.colorA];
    for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, bright, 0);
  }

  // 'hit' pattern: decay brightness from 255 → 35 over one beat-interval.
  // tickPattern resets _hitPhase to 0 on every beat; between beats we advance
  // it at the DMX rate so the punch feels responsive at any beat division.
  if (state.running && state.pattern === 'hit') {
    const beatSec = Math.max(0.05, (60 / Math.max(1, state.bpm)) / Math.max(1, state.beatDivision));
    state._hitPhase = Math.min(1, (state._hitPhase ?? 1) + dt / beatSec);
    // Exponential-ish decay feels punchier than linear.
    const decay = Math.pow(1 - state._hitPhase, 1.8);
    const bright = Math.round(35 + decay * 220);
    const colA = COLOR_PRESETS[state.colorA];
    for (let i = 0; i < getFixtureCount(); i++) setFixtureColor(i, colA, bright, 0);
  }

  const energy = state.energyOverride ? resolveEnergyOverride() : null;

  for (let i = 0; i < getFixtureCount(); i++) {
    const fix = state.fixtures[i];
    const base = fix.address - 1;
    let col, dim, strobe;

    if (energy) {
      // Energy override trumps everything (except master blackout)
      col = energy.col; dim = energy.dim; strobe = energy.strobe;
    } else if (fix.override && fix.override.enabled) {
      const ov = fix.override;
      if (ov.blackout) {
        col = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }; dim = 0; strobe = 0;
      } else {
        col = { r: ov.r, g: ov.g, b: ov.b, w: ov.w, a: ov.a || 0, uv: ov.uv || 0 };
        dim = ov.dim !== undefined ? ov.dim : 255;
        strobe = ov.strobe !== undefined ? ov.strobe : 0;
      }
    } else {
      const fc = fixtureColors[i];
      col = { r: fc.r, g: fc.g, b: fc.b, w: fc.w, a: fc.a || 0, uv: fc.uv || 0 };
      dim = fc.dim; strobe = fc.strobe;
    }

    const profile = getProfile(fix);
    const chCount = profile.channelCount;
    const ch = profile.channelMap;

    if (state.masterBlackout) {
      for (let c = 0; c < chCount; c++) dmx[base + c] = 0;
    } else {
      // Zero out all channels first, then write the mapped ones
      for (let c = 0; c < chCount; c++) dmx[base + c] = 0;

      // Energy overrides bypass master dimmer — always full output
      const ms = energy ? 1 : state.masterDimmer / 255;
      const ds = dim / 255;
      const ts = ms * ds;

      if (ch.dimmer !== undefined)     dmx[base + ch.dimmer] = Math.round(dim * ms);
      if (ch.dimmerFine !== undefined)  dmx[base + ch.dimmerFine] = 0;

      // Strobe: map rawStrobe (0-255) into the selected strobe function's DMX range.
      // Energy overrides force the 'standard' function (1-20 Hz) so a colour-strobe
      // burst never inherits a slow sequenced strobeFunction (ramp-*, break, …) left
      // over from the prior segment. Without this, a burst landing on a section with
      // strobeFunction:'break' visibly flashes slower than the pattern underneath at
      // beatDivision 2/4.
      if (ch.strobe !== undefined) {
        const rawStrobe = energy ? strobe : (state.pattern === 'strobe' ? state.strobeSpeed : strobe);
        if (rawStrobe > 0) {
          const fnId = energy ? 'standard' : state.strobeFunction;
          const fn = STROBE_FUNCTIONS.find(f => f.id === fnId) || STROBE_FUNCTIONS[0];
          dmx[base + ch.strobe] = fn.lo + Math.round((rawStrobe / 255) * (fn.hi - fn.lo));
        }
      }

      // Color channels — write all that exist in the profile
      if (ch.red !== undefined)   dmx[base + ch.red]   = Math.round(col.r  * ts);
      if (ch.green !== undefined) dmx[base + ch.green] = Math.round(col.g  * ts);
      if (ch.blue !== undefined)  dmx[base + ch.blue]  = Math.round(col.b  * ts);
      if (ch.white !== undefined) dmx[base + ch.white] = Math.round(col.w  * ts);
      if (ch.amber !== undefined) dmx[base + ch.amber] = Math.round(col.a  * ts);
      if (ch.uv !== undefined)    dmx[base + ch.uv]    = Math.min(255, Math.round(col.uv * ts * UV_BOOST));
    }
  }
  sendArtNet();
}

// ─── Timing ───────────────────────────────────────────────────────────────────

function bpmInterval() { return (60000 / state.bpm) / state.beatDivision; }

function restartBeatTimer({ tickNow = false } = {}) {
  if (beatInterval) clearInterval(beatInterval);
  if (state.running) {
    if (tickNow) tickPattern();
    beatInterval = setInterval(() => {
      tickPattern();
    }, bpmInterval());
  }
}

restartBeatTimer();
setInterval(renderDmx, 25);
setInterval(() => io.emit('state', getClientState()), 100);

function getDmxSnapshotSize() {
  let maxEnd = 0;
  for (const fix of state.fixtures) {
    const profile = getProfile(fix);
    const end = fix.address - 1 + profile.channelCount;
    if (end > maxEnd) maxEnd = end;
  }
  return Math.min(512, maxEnd);
}

function getClientState() {
  return {
    artnet: state.artnet,
    bpm: state.bpm,
    beatDivision: state.beatDivision,
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    colorC: state.colorC,
    colorD: state.colorD,
    masterDimmer: state.masterDimmer,
    masterBlackout: state.masterBlackout,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    energyOverride: state.energyOverride,
    fixtures: state.fixtures,
    profiles: fixtureProfiles,
    colorPresets: COLOR_PRESETS,
    patterns: PATTERNS,
    energyEffects: ENERGY_EFFECTS,
    strobeFunctions: STROBE_FUNCTIONS,
    dmxSnapshot: Array.from(dmx.slice(0, getDmxSnapshotSize())),
    midi: { enabled: midi.enabled, ports: midi.listPorts() },
    prolink: {
      enabled: state.prolinkEnabled,
      connected: prolink.connected,
      peers: prolink.getNumPeers(),
      master: prolink.getMaster(),
      track: prolink.getTrack(),
      bpm: prolink.getTempo(),
      stale: prolink.stale,
      lastError: prolink.lastError,
    },
    autoSource: state.autoSource,
    spotify: spotify.getStatus(),
    autoShow: autoShow.getClientState(),
  };
}

// ─── MIDI ─────────────────────────────────────────────────────────────────────

const midi = new MidiController(state, applyPatch, processTap);
midi.overrideFixture = applyOverride;

// Auto-connect if MIDI_INPUT env var is set, or try auto-detection
const midiInput  = process.env.MIDI_INPUT  || null;
const midiOutput = process.env.MIDI_OUTPUT || null;
midi.connect(midiInput, midiOutput);

// ─── PRO DJ LINK ─────────────────────────────────────────────────────────────

const prolink = new ProLink();

function getProlinkPositionMs() { return prolink.getPositionMs(); }

// Tempo from the master CDJ → state.bpm. Same shape as the old Link callback.
prolink.onTempoChange((bpm) => {
  if (!state.prolinkEnabled) return;
  const rounded = Math.round(bpm);
  if (rounded >= 20 && rounded <= 300 && rounded !== state.bpm) {
    state.bpm = rounded;
    restartBeatTimer();
    broadcast();
  }
});

prolink.onPeersChange((peers) => {
  console.log(`PRO DJ LINK devices: ${peers}`);
  io.emit('state', getClientState());
});

prolink.onMasterChange(() => broadcast());

prolink.onTrackChange(async (track) => {
  console.log(`PRO DJ LINK track changed: ${track.artist || '?'} — ${track.title || '?'}`);
  broadcast();
  if (!autoShow.running) return;
  if (resolveAutoSource() !== 'prolink') return;

  autoShow.stop();
  autoShow.track = {
    name: track.title || `Track ${track.trackId}`,
    artist: track.artist || 'PRO DJ LINK',
    album: track.album || '',
    albumArt: null,
    durationMs: track.durationMs || 0,
  };
  broadcast();
  try {
    if (!track.title || !track.artist) {
      throw new Error('Track has no rekordbox metadata — cannot search');
    }
    const query = `${track.artist} - ${track.title}`;
    const cacheKey = keyForProlinkTrack(track);
    const { audioPath } = await autoShow.downloadAndAnalyze(
      query, (track.durationMs || 0) / 1000, cacheKey
    );
    if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) {} }
    autoShow.start(getProlinkPositionMs);
    console.log('Auto show restarted for new CDJ track');
  } catch (err) {
    console.error('PRO DJ LINK auto analysis failed:', err.message);
  }
  broadcast();
});

// Pick the active source for auto-show playback. Explicit user choice wins,
// then 'auto' falls through to: prolink > spotify > timer.
function resolveAutoSource() {
  if (state.autoSource === 'prolink' && prolink.connected) return 'prolink';
  if (state.autoSource === 'spotify' && spotify.authenticated) return 'spotify';
  if (state.autoSource === 'timer') return 'timer';
  if (prolink.connected && prolink.getMaster()) return 'prolink';
  if (spotify.authenticated) return 'spotify';
  return 'timer';
}

// Enable by default if PROLINK=1 env var is set
if (process.env.PROLINK === '1') {
  state.prolinkEnabled = true;
  prolink.enable().catch((err) => {
    console.error('PRO DJ LINK enable failed:', err.message);
    state.prolinkEnabled = false;
  });
}

// ─── Spotify + Auto Show ─────────────────────────────────────────────────────

const spotify = new SpotifyClient();
const analysisCache = new AnalysisCache(path.join(__dirname, 'cache', 'analysis'));
const autoShow = new AutoShow(applyPatch, COLOR_PRESETS, PATTERNS, analysisCache);

// Initialize Deezer if an ARL token is configured
if (process.env.DEEZER_ARL) {
  deezer.init(process.env.DEEZER_ARL).catch((err) => {
    console.warn(`[deezer] Init failed: ${err.message} — will fall back to yt-dlp`);
  });
}

// Track playback position locally (updated by Spotify polling)
let autoPlayback = { progressMs: 0, isPlaying: false, updatedAt: 0 };

function getAutoPositionMs() {
  if (!autoPlayback.isPlaying) return autoPlayback.progressMs;
  return autoPlayback.progressMs + (Date.now() - autoPlayback.updatedAt);
}

// Throttle state for the queue-lookahead poll that re-peeks Spotify's queue
// while a track is playing so that queue edits made mid-play (reorder, add)
// are still picked up and prefetched.
let lastQueuePeekAt = 0;
const QUEUE_PEEK_INTERVAL_MS = 15000;

spotify.onPlaybackUpdate((playing) => {
  autoPlayback.progressMs = playing.progressMs;
  autoPlayback.isPlaying = playing.isPlaying;
  autoPlayback.updatedAt = Date.now();

  // While the auto show is running, re-peek the queue on a slow interval so
  // mid-play queue edits are picked up. prefetchNextFromQueue() is cheap when
  // the head is unchanged or already cached — it no-ops in those cases.
  if (autoShow.running && Date.now() - lastQueuePeekAt >= QUEUE_PEEK_INTERVAL_MS) {
    lastQueuePeekAt = Date.now();
    prefetchNextFromQueue();
  }
});

/**
 * Peek the Spotify user queue and kick off a background prefetch of the next
 * upcoming track so its analysis is already in the cache when it starts
 * playing. Safe to call while a show is running — the prefetch path does not
 * touch the running show's state.
 */
async function prefetchNextFromQueue() {
  if (!spotify.authenticated) return;
  // Stamp the throttle so the onPlaybackUpdate poll doesn't immediately
  // re-fire right after an explicit call from the track-change path.
  lastQueuePeekAt = Date.now();
  try {
    const queue = await spotify.getQueue();
    if (!queue || !queue.length) return;
    const next = queue[0];
    if (!next || !next.trackId) return;

    const query = `${next.artist} - ${next.name}`;
    const cacheKey = keyForSpotify(next.trackId) || keyForQuery(query);
    const meta = {
      track: {
        name: next.name,
        artist: next.artist,
        album: next.album,
        albumArt: next.albumArt,
        durationMs: next.durationMs,
      },
    };
    // Fire-and-forget: never block the caller on prefetch.
    autoShow.prefetch(query, (next.durationMs || 0) / 1000, cacheKey, meta, next.isrc)
      .then((r) => {
        if (r.skipped && r.reason === 'already-cached') {
          console.log(`[prefetch] next queued track already cached: ${next.artist} — ${next.name}`);
        } else if (!r.skipped && !r.error) {
          console.log(`[prefetch] ready for next queued track: ${next.artist} — ${next.name}`);
        }
      })
      .catch((err) => console.warn(`[prefetch] unexpected error: ${err.message}`));
  } catch (err) {
    console.warn(`[prefetch] queue lookup failed: ${err.message}`);
  }
}

spotify.onTrackChange(async (playing) => {
  console.log(`Spotify track changed: ${playing.artist} — ${playing.name}`);
  // Only drive auto-show from Spotify when it's the active source.
  if (resolveAutoSource() !== 'spotify') return;
  // If auto mode is playing, re-analyze the new track via yt-dlp
  if (autoShow.running) {
    autoShow.stop();
    autoShow.track = { name: playing.name, artist: playing.artist, album: playing.album, albumArt: playing.albumArt, durationMs: playing.durationMs };
    broadcast();
    try {
      const query = `${playing.artist} - ${playing.name}`;
      const cacheKey = keyForSpotify(playing.trackId) || keyForQuery(query);
      await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);
      autoShow.start(getAutoPositionMs);
      console.log('Auto show restarted for new track');
    } catch (err) {
      console.error('Auto show analysis failed for new track:', err.message);
    }
    broadcast();

    // Now that the current track is playing, warm the cache for the NEXT
    // queued track so the upcoming change flips instantly to a cache hit.
    prefetchNextFromQueue();
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state', getClientState());

  socket.on('set', applyPatch);

  socket.on('override', ({ id, override }) => applyOverride(id, override));

  socket.on('fixture', ({ id, address, label, profileId }) => {
    if (id >= 0 && id < getFixtureCount()) {
      if (address !== undefined) state.fixtures[id].address = address;
      if (label !== undefined) state.fixtures[id].label = label;
      if (profileId !== undefined && fixtureProfiles[profileId]) state.fixtures[id].profileId = profileId;
      broadcast();
    }
  });

  socket.on('tap', processTap);

  // MIDI reconnect from UI
  socket.on('midi-connect', ({ input, output }) => {
    midi.close();
    const ok = midi.connect(input || null, output || null);
    socket.emit('midi-status', { ok, ports: midi.listPorts(), enabled: midi.enabled });
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ─── REST API ─────────────────────────────────────────────────────────────────
// Used by Bitfocus Companion (Generic HTTP module) and other integrations.

app.get('/api/state', (_req, res) => res.json(getClientState()));

// POST /api/set  body: { bpm, pattern, colorA, colorB, colorC, colorD, masterDimmer, masterBlackout, running, ... }
app.post('/api/set', (req, res) => {
  applyPatch(req.body);
  res.json({ ok: true, state: getClientState() });
});

// POST /api/tap
app.post('/api/tap', (_req, res) => {
  processTap();
  res.json({ ok: true, bpm: state.bpm });
});

// POST /api/blackout/toggle
app.post('/api/blackout/toggle', (_req, res) => {
  applyPatch({ masterBlackout: !state.masterBlackout });
  res.json({ ok: true, masterBlackout: state.masterBlackout });
});

// POST /api/blackout/:state  (on|off)
app.post('/api/blackout/:onoff', (req, res) => {
  applyPatch({ masterBlackout: req.params.onoff !== 'off' });
  res.json({ ok: true, masterBlackout: state.masterBlackout });
});

// POST /api/pattern/:id
app.post('/api/pattern/:id', (req, res) => {
  applyPatch({ pattern: req.params.id });
  res.json({ ok: true, pattern: state.pattern });
});

// POST /api/color/a/:index   POST /api/color/b/:index  etc.
app.post('/api/color/:slot/:index', (req, res) => {
  const slotMap = { a: 'colorA', b: 'colorB', c: 'colorC', d: 'colorD' };
  const slot = slotMap[req.params.slot] || 'colorA';
  applyPatch({ [slot]: parseInt(req.params.index) });
  res.json({ ok: true, colorA: state.colorA, colorB: state.colorB, colorC: state.colorC, colorD: state.colorD });
});

// POST /api/bpm/:value
app.post('/api/bpm/:value', (req, res) => {
  applyPatch({ bpm: parseInt(req.params.value) });
  res.json({ ok: true, bpm: state.bpm });
});

// POST /api/bpm/adjust/:delta  (e.g. +5 or -5)
app.post('/api/bpm/adjust/:delta', (req, res) => {
  applyPatch({ bpm: state.bpm + parseInt(req.params.delta) });
  res.json({ ok: true, bpm: state.bpm });
});

// POST /api/play  POST /api/stop
app.post('/api/play',  (_req, res) => { applyPatch({ running: true  }); res.json({ ok: true }); });
app.post('/api/stop',  (_req, res) => { applyPatch({ running: false }); res.json({ ok: true }); });

// POST /api/master/:value  (0-255)
app.post('/api/master/:value', (req, res) => {
  applyPatch({ masterDimmer: parseInt(req.params.value) });
  res.json({ ok: true, masterDimmer: state.masterDimmer });
});

// POST /api/energy/off  — clear energy override (must be before :id route)
app.post('/api/energy/off', (_req, res) => {
  applyPatch({ energyOverride: null });
  res.json({ ok: true, energyOverride: null });
});

// POST /api/energy/:id  — activate an energy override (white-strobe, blinder, uv-strobe, color-strobe, all-on)
app.post('/api/energy/:id', (req, res) => {
  applyPatch({ energyOverride: req.params.id });
  res.json({ ok: true, energyOverride: state.energyOverride });
});

// POST /api/fixture/:id/override  body: { r,g,b,w,dim,strobe,blackout,enabled }
app.post('/api/fixture/:id/override', (req, res) => {
  const id = parseInt(req.params.id);
  applyOverride(id, req.body);
  res.json({ ok: true });
});

// POST /api/fixture/:id/blackout/toggle
app.post('/api/fixture/:id/blackout/toggle', (req, res) => {
  const id = parseInt(req.params.id);
  const cur = state.fixtures[id] && state.fixtures[id].override;
  applyOverride(id, { ...(cur || { r:0, g:0, b:0, w:0, dim:0, strobe:0 }), enabled: true, blackout: !(cur && cur.blackout) });
  res.json({ ok: true });
});

// POST /api/fixture/:id/clear
app.post('/api/fixture/:id/clear', (req, res) => {
  applyOverride(parseInt(req.params.id), null);
  res.json({ ok: true });
});

// GET /api/midi/ports
app.get('/api/midi/ports', (_req, res) => res.json(midi.listPorts()));

// POST /api/midi/connect  body: { input, output }
app.post('/api/midi/connect', (req, res) => {
  midi.close();
  const ok = midi.connect(req.body.input || null, req.body.output || null);
  res.json({ ok, enabled: midi.enabled, ports: midi.listPorts() });
});

// POST /api/prolink/enable   POST /api/prolink/disable   POST /api/prolink/toggle
app.post('/api/prolink/enable',  (_req, res) => { applyPatch({ prolinkEnabled: true  }); res.json({ ok: true, prolink: getClientState().prolink }); });
app.post('/api/prolink/disable', (_req, res) => { applyPatch({ prolinkEnabled: false }); res.json({ ok: true, prolink: getClientState().prolink }); });
app.post('/api/prolink/toggle',  (_req, res) => { applyPatch({ prolinkEnabled: !state.prolinkEnabled }); res.json({ ok: true, prolink: getClientState().prolink }); });

// ─── GDTF / Profiles / Fixtures / Show API ──────────────────────────────────

// POST /api/gdtf/parse — upload a .gdtf file and parse it
app.post('/api/gdtf/parse', upload.single('gdtf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const result = await parseGDTF(req.file.buffer);
    res.json({ ok: true, fixture: result });
  } catch (err) {
    console.error('GDTF parse error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/profiles — add a fixture profile
app.post('/api/profiles', (req, res) => {
  const profile = req.body;
  if (!profile.id || !profile.name || !profile.channelCount) {
    return res.status(400).json({ ok: false, error: 'Invalid profile' });
  }
  fixtureProfiles[profile.id] = profile;
  broadcast();
  res.json({ ok: true });
});

// DELETE /api/profiles/:id — remove a fixture profile (cannot remove built-in)
app.delete('/api/profiles/:id', (req, res) => {
  const id = req.params.id;
  if (id === BUILTIN_PROFILE_ID) return res.status(400).json({ ok: false, error: 'Cannot remove built-in profile' });
  // Check if any fixture uses this profile
  const inUse = state.fixtures.some(f => f.profileId === id);
  if (inUse) return res.status(400).json({ ok: false, error: 'Profile is in use by patched fixtures' });
  delete fixtureProfiles[id];
  broadcast();
  res.json({ ok: true });
});

// POST /api/fixtures — add a new fixture
app.post('/api/fixtures', (_req, res) => {
  // Calculate next available address
  let maxEnd = 0;
  for (const fix of state.fixtures) {
    const profile = getProfile(fix);
    const end = fix.address + profile.channelCount;
    if (end > maxEnd) maxEnd = end;
  }
  const newId = state.fixtures.length;
  state.fixtures.push({
    id: newId,
    label: `Fixture ${newId + 1}`,
    address: Math.min(maxEnd, 501),
    profileId: BUILTIN_PROFILE_ID,
    override: null,
  });
  resizeFixtureColors();
  while (state._twinkle.length < state.fixtures.length) state._twinkle.push(0);
  broadcast();
  res.json({ ok: true });
});

// DELETE /api/fixtures/:id — remove a fixture (must have at least 1)
app.delete('/api/fixtures/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (state.fixtures.length <= 1) return res.status(400).json({ ok: false, error: 'Must have at least one fixture' });
  state.fixtures = state.fixtures.filter(f => f.id !== id);
  // Re-index fixture ids
  state.fixtures.forEach((f, i) => { f.id = i; });
  resizeFixtureColors();
  state._twinkle.length = state.fixtures.length;
  broadcast();
  res.json({ ok: true });
});

// GET /api/show — export show configuration
app.get('/api/show', (_req, res) => {
  res.json({
    artnet: state.artnet,
    profiles: Object.values(fixtureProfiles).filter(p => p.id !== BUILTIN_PROFILE_ID),
    fixtures: state.fixtures.map(f => ({
      label: f.label,
      address: f.address,
      profileId: f.profileId,
    })),
  });
});

// POST /api/show — load show configuration
app.post('/api/show', (req, res) => {
  try {
    const show = req.body;

    // Load profiles
    if (Array.isArray(show.profiles)) {
      // Remove non-builtin profiles
      Object.keys(fixtureProfiles).forEach(id => {
        if (id !== BUILTIN_PROFILE_ID) delete fixtureProfiles[id];
      });
      show.profiles.forEach(p => { if (p.id) fixtureProfiles[p.id] = p; });
    }

    // Load ArtNet settings
    if (show.artnet) Object.assign(state.artnet, show.artnet);

    // Load fixtures
    if (Array.isArray(show.fixtures) && show.fixtures.length > 0) {
      state.fixtures = show.fixtures.map((f, i) => ({
        id: i,
        label: f.label || `Fixture ${i + 1}`,
        address: f.address || 1,
        profileId: fixtureProfiles[f.profileId] ? f.profileId : BUILTIN_PROFILE_ID,
        override: null,
      }));
      resizeFixtureColors();
      state._twinkle = new Array(state.fixtures.length).fill(0);
    }

    broadcast();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Spotify Auth Routes ─────────────────────────────────────────────────────

// GET /auth/spotify — redirect user to Spotify authorization page
app.get('/auth/spotify', (req, res) => {
  if (!spotify.configured) {
    return res.status(400).json({ ok: false, error: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars' });
  }
  res.redirect(spotify.getAuthorizeUrl());
});

// GET /auth/spotify/callback — exchange code for tokens
app.get('/auth/spotify/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    await spotify.exchangeCode(code);
    spotify.startPolling();
    console.log('Spotify authenticated successfully');
    broadcast();
    res.send('<html><body style="background:#0d0d0f;color:#e8e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2 style="color:#44ff88">Spotify Connected</h2><p>You can close this window and return to the lightshow.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>');
  } catch (err) {
    console.error('Spotify auth error:', err.message);
    res.status(500).send(`Spotify auth failed: ${err.message}`);
  }
});

// POST /api/spotify/disconnect
app.post('/api/spotify/disconnect', (_req, res) => {
  spotify.disconnect();
  broadcast();
  res.json({ ok: true });
});

// GET /api/spotify/now-playing
app.get('/api/spotify/now-playing', async (_req, res) => {
  try {
    const playing = await spotify.getCurrentlyPlaying();
    res.json({ ok: true, playing });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Auto Show Routes ────────────────────────────────────────────────────────

// POST /api/auto/analyze — analyze audio from file path, direct URL, or YouTube
app.post('/api/auto/analyze', async (req, res) => {
  const { source } = req.body; // file path, audio URL, YouTube URL, or search query
  if (!source) return res.status(400).json({ ok: false, error: 'Provide a source (file path, URL, or YouTube search)' });

  // Detect if this needs yt-dlp (YouTube URL or not a local file / direct audio URL)
  const isYouTube = /(?:youtube\.com|youtu\.be|music\.youtube)/.test(source);
  const isLocalFile = /^[a-zA-Z]:[\\/]|^\//.test(source);
  const isDirectAudio = /\.(mp3|wav|ogg|flac|m4a|aac|wma)(\?|$)/i.test(source);

  try {
    if (isLocalFile || isDirectAudio) {
      autoShow.track = { name: path.basename(source), artist: 'Local file', album: '', albumArt: null };
      const cacheKey = isLocalFile ? keyForLocalFile(source) : `url:${source}`;
      await autoShow.analyze(source, cacheKey);
    } else {
      // Use yt-dlp for YouTube URLs or search queries
      autoShow.track = { name: source, artist: '', album: '', albumArt: null };
      broadcast();
      const cacheKey = keyForYouTube(source) || keyForQuery(source);
      await autoShow.downloadAndAnalyze(source, null, cacheKey);
    }
    broadcast();
    res.json({ ok: true, analysis: autoShow.getClientState().analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auto/analyze-spotify — download audio (Deezer via ISRC, yt-dlp fallback) and analyze
app.post('/api/auto/analyze-spotify', async (_req, res) => {
  if (!spotify.authenticated) {
    return res.status(400).json({ ok: false, error: 'Spotify not connected' });
  }
  try {
    const playing = await spotify.getCurrentlyPlaying();
    if (!playing) return res.status(400).json({ ok: false, error: 'No track currently playing on Spotify' });

    autoShow.track = { name: playing.name, artist: playing.artist, album: playing.album, albumArt: playing.albumArt, durationMs: playing.durationMs };
    broadcast(); // show track info immediately

    const query = `${playing.artist} - ${playing.name}`;
    const cacheKey = keyForSpotify(playing.trackId) || keyForQuery(query);
    await autoShow.downloadAndAnalyze(query, playing.durationMs / 1000, cacheKey, playing.isrc);

    broadcast();
    res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });

    // Warm the cache for whatever is next in the user's Spotify queue so
    // the upcoming track change is instant.
    prefetchNextFromQueue();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auto/download-analyze — download via yt-dlp (YouTube URL or search) and analyze
app.post('/api/auto/download-analyze', async (req, res) => {
  const { query } = req.body; // YouTube URL or search query
  if (!query) return res.status(400).json({ ok: false, error: 'Provide a query (YouTube URL or search terms)' });
  try {
    autoShow.track = { name: query, artist: '', album: '', albumArt: null };
    broadcast();

    const cacheKey = keyForYouTube(query) || keyForQuery(query);
    await autoShow.downloadAndAnalyze(query, null, cacheKey);

    broadcast();
    res.json({ ok: true, analysis: autoShow.getClientState().analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auto/analyze-upload — analyze uploaded audio file
app.post('/api/auto/analyze-upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No audio file uploaded' });
  const tmpPath = path.join(require('os').tmpdir(), `auto-analyze-${Date.now()}${path.extname(req.file.originalname) || '.mp3'}`);
  try {
    fs.writeFileSync(tmpPath, req.file.buffer);
    autoShow.track = { name: req.file.originalname, artist: 'Local file', album: '', albumArt: null };
    const cacheKey = keyForBuffer(req.file.buffer);
    await autoShow.analyze(tmpPath, cacheKey);
    broadcast();
    res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
});

// POST /api/auto/analyze-prolink — analyze the track currently loaded on the master CDJ
app.post('/api/auto/analyze-prolink', async (_req, res) => {
  if (!prolink.connected) {
    return res.status(400).json({ ok: false, error: 'PRO DJ LINK not connected' });
  }
  const track = prolink.getTrack();
  if (!track) {
    return res.status(400).json({ ok: false, error: 'No track loaded on the master CDJ' });
  }
  if (!track.title || !track.artist) {
    return res.status(400).json({ ok: false, error: 'Track has no rekordbox metadata — cannot search' });
  }

  try {
    autoShow.track = {
      name: track.title,
      artist: track.artist,
      album: track.album || '',
      albumArt: null,
      durationMs: track.durationMs || 0,
    };
    broadcast();

    const query = `${track.artist} - ${track.title}`;
    const cacheKey = keyForProlinkTrack(track);
    const { audioPath } = await autoShow.downloadAndAnalyze(
      query, (track.durationMs || 0) / 1000, cacheKey
    );
    if (audioPath) { try { fs.unlinkSync(audioPath); } catch (_) {} }

    broadcast();
    res.json({ ok: true, track: autoShow.track, analysis: autoShow.getClientState().analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auto/start — start the auto show playback
app.post('/api/auto/start', (_req, res) => {
  if (!autoShow.analysis) return res.status(400).json({ ok: false, error: 'No analysis loaded. Analyze a track first.' });

  const source = resolveAutoSource();
  if (source === 'prolink') {
    autoShow.start(getProlinkPositionMs);
  } else if (source === 'spotify') {
    spotify.startPolling(1000); // poll more frequently during auto mode
    autoShow.start(getAutoPositionMs);
  } else {
    // Standalone timer (starts from 0)
    const startTime = Date.now();
    autoShow.start(() => Date.now() - startTime);
  }

  broadcast();
  res.json({ ok: true, source });
});

// POST /api/auto/stop — stop the auto show
app.post('/api/auto/stop', (_req, res) => {
  autoShow.stop();
  broadcast();
  res.json({ ok: true });
});

// POST /api/auto/reset — reset auto show state
app.post('/api/auto/reset', (_req, res) => {
  autoShow.reset();
  broadcast();
  res.json({ ok: true });
});

// GET /api/auto/state
app.get('/api/auto/state', (_req, res) => {
  res.json({ ok: true, ...autoShow.getClientState(), spotify: spotify.getStatus() });
});

// GET /api/auto/timeline — full data payload for the UI visualizer
app.get('/api/auto/timeline', (_req, res) => {
  const data = autoShow.getTimelineData();
  if (!data) return res.status(404).json({ ok: false, error: 'No analysis loaded' });
  res.json({ ok: true, data });
});

// GET /api/auto/cache — list cached analysis entries
app.get('/api/auto/cache', (_req, res) => {
  res.json({ ok: true, entries: analysisCache.list() });
});

// DELETE /api/auto/cache — wipe the whole cache
app.delete('/api/auto/cache', (_req, res) => {
  const removed = analysisCache.clear();
  res.json({ ok: true, removed });
});

// DELETE /api/auto/cache/entry  body: { key }
app.delete('/api/auto/cache/entry', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
  const ok = analysisCache.delete(key);
  res.json({ ok });
});

// Broadcast the auto-show playback position to connected clients at ~10 Hz
// so the visualizer playhead stays smooth. Only runs while actually playing.
setInterval(() => {
  if (!autoShow.running) return;
  io.emit('auto-position', { positionMs: autoShow.getPositionMs(), running: true });
}, 100);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  // Proxy forwards the authorization code to this local URL
  spotify.localCallbackUrl = `http://localhost:${PORT}/auth/spotify/callback`;

  console.log(`\n  ArtNet Lightshow  →  http://localhost:${PORT}`);
  console.log(`  ArtNet            →  ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures          →  ${state.fixtures.length}x at DMX ${state.fixtures.map(f => f.address).join(', ')}`);
  console.log(`  MIDI              →  ${midi.enabled ? 'connected' : 'not connected (set MIDI_INPUT env var or use /api/midi/connect)'}`);
  console.log(`  PRO DJ LINK       →  ${state.prolinkEnabled ? 'enabled' : 'disabled (set PROLINK=1 env var or use web UI)'}`);
  console.log(`  Spotify           →  ${spotify.configured ? 'configured (visit /auth/spotify to connect)' : 'not configured (set SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET in .env)'}`);
  if (spotify.configured) {
    console.log(`  Spotify redirect  →  register this URL in your Spotify dashboard:`);
    console.log(`                       ${spotify.redirectUri}`);
  }
  console.log(`  Deezer            →  ${process.env.DEEZER_ARL ? 'configured (ISRC-based downloads)' : 'not configured (set DEEZER_ARL in .env for exact audio — falls back to yt-dlp)'}`);
  console.log(`  Auto Show         →  Essentia + Spotify integration\n`);
});

// Clean shutdown
process.on('SIGINT',  () => { autoShow.stop(); spotify.disconnect(); prolink.destroy(); process.exit(0); });
process.on('SIGTERM', () => { autoShow.stop(); spotify.disconnect(); prolink.destroy(); process.exit(0); });
