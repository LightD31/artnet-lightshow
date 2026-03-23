'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');
const MidiController = require('./src/midi');
const AbletonLink = require('./src/link');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Cameo ROOT PAR 6 – 12-channel mode (D12CH)
//   Ch1: Dimmer (coarse)   Ch2: Dimmer fine   Ch3: Strobe functions
//   Ch4: Red   Ch5: Green  Ch6: Blue  Ch7: White  Ch8: Amber  Ch9: UV
//   Ch10: Color macros (keep 0 for RGBWA+UV control)
//   Ch11: Sound   Ch12: DMX Delay

const FIXTURE_COUNT = 4;
const CHANNELS = 12;
const CH = { DIM: 0, DIM_FINE: 1, STROBE: 2, RED: 3, GREEN: 4, BLUE: 5, WHITE: 6, AMBER: 7, UV: 8, MACRO: 9, SOUND: 10, DELAY: 11 };
const DEFAULT_ADDRESSES = [1, 13, 25, 37];

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

const COLOR_PRESETS = [
  { name: 'Red',        r: 255, g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   },
  { name: 'Orange',     r: 200, g: 60,  b: 0,   w: 0,   a: 180, uv: 0   },
  { name: 'Amber',      r: 0,   g: 0,   b: 0,   w: 0,   a: 255, uv: 0   },
  { name: 'Yellow',     r: 255, g: 220, b: 0,   w: 0,   a: 100, uv: 0   },
  { name: 'Green',      r: 0,   g: 255, b: 0,   w: 0,   a: 0,   uv: 0   },
  { name: 'Cyan',       r: 0,   g: 255, b: 255, w: 0,   a: 0,   uv: 0   },
  { name: 'Blue',       r: 0,   g: 0,   b: 255, w: 0,   a: 0,   uv: 0   },
  { name: 'Purple',     r: 100, g: 0,   b: 255, w: 0,   a: 0,   uv: 0   },
  { name: 'Magenta',    r: 255, g: 0,   b: 200, w: 0,   a: 0,   uv: 0   },
  { name: 'White',      r: 0,   g: 0,   b: 0,   w: 255, a: 0,   uv: 0   },
  { name: 'Warm White', r: 180, g: 80,  b: 0,   w: 150, a: 200, uv: 0   },
  { name: 'UV',         r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 255 },
  { name: 'Blackout',   r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 0   },
];

const PATTERNS = [
  { id: 'solid',       name: 'Solid',        desc: 'All fixtures same colour' },
  { id: 'chase',       name: 'Chase →',      desc: 'One fixture at a time, forward' },
  { id: 'chase-rev',   name: 'Chase ←',      desc: 'One fixture at a time, reverse' },
  { id: 'ping-pong',   name: 'Ping Pong',    desc: 'Forward then backward' },
  { id: 'strobe',      name: 'Strobe',       desc: 'All fixtures strobe on beat' },
  { id: 'fade',        name: 'Fade',         desc: 'Fade in/out together' },
  { id: 'color-cycle', name: 'Colour Cycle', desc: 'Cycle through hues in sync' },
  { id: 'rainbow',     name: 'Rainbow',      desc: 'Each fixture offset in hue' },
  { id: 'twinkle',     name: 'Twinkle',      desc: 'Random fixtures flash' },
  { id: 'split',       name: 'Split',        desc: 'Two colours alternating in pairs' },
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
    host: '2.255.255.255',
    port: 6454,
    universe: 0,
  },
  bpm: 120,
  beatDivision: 1,
  running: true,
  pattern: 'chase',
  colorA: 0,    // Red
  colorB: 6,    // Blue
  masterDimmer: 255,
  masterBlackout: false,
  strobeSpeed: 0,
  strobeFunction: 'standard', // id from STROBE_FUNCTIONS
  energyOverride: null, // null or string id from ENERGY_EFFECTS
  linkEnabled: false,
  fixtures: Array.from({ length: FIXTURE_COUNT }, (_, i) => ({
    id: i,
    label: `PAR ${i + 1}`,
    address: DEFAULT_ADDRESSES[i],
    override: null,
  })),
  _step: 0,
  _pingDir: 1,
  _hue: 0,
  _fadePhase: 0,
  _twinkle: new Array(FIXTURE_COUNT).fill(0),
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
  }
  if (data.colorA !== undefined) state.colorA = Math.max(0, Math.min(COLOR_PRESETS.length - 1, data.colorA));
  if (data.colorB !== undefined) state.colorB = Math.max(0, Math.min(COLOR_PRESETS.length - 1, data.colorB));
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
  if (data.linkEnabled !== undefined) {
    if (data.linkEnabled && !state.linkEnabled) enableLink();
    else if (!data.linkEnabled && state.linkEnabled) disableLink();
  }

  // Sync BPM changes back to Link when it's active
  if (restartTimer && state.linkEnabled && data.bpm !== undefined) {
    link.setTempo(state.bpm);
  }

  if (restartTimer) restartBeatTimer();
  broadcast();
}

function applyOverride(id, override) {
  if (id >= 0 && id < FIXTURE_COUNT) {
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
    restartBeatTimer();
    broadcast();
  }
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

let fixtureColors = Array.from({ length: FIXTURE_COUNT }, () => ({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }));

function tickPattern() {
  if (!state.running) return;
  const colA = COLOR_PRESETS[state.colorA];
  const colB = COLOR_PRESETS[state.colorB];
  const step = state._step;

  switch (state.pattern) {
    case 'solid':
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, colA, 255, 0);
      break;
    case 'chase':
      for (let i = 0; i < FIXTURE_COUNT; i++)
        setFixtureColor(i, i === step % FIXTURE_COUNT ? colA : colB, i === step % FIXTURE_COUNT ? 255 : 80, 0);
      break;
    case 'chase-rev':
      for (let i = 0; i < FIXTURE_COUNT; i++) {
        const active = i === (FIXTURE_COUNT - 1 - step % FIXTURE_COUNT);
        setFixtureColor(i, active ? colA : colB, active ? 255 : 80, 0);
      }
      break;
    case 'ping-pong': {
      const pos = step % (FIXTURE_COUNT * 2 - 2);
      const idx = pos < FIXTURE_COUNT ? pos : (FIXTURE_COUNT * 2 - 2 - pos);
      for (let i = 0; i < FIXTURE_COUNT; i++)
        setFixtureColor(i, i === idx ? colA : colB, i === idx ? 255 : 80, 0);
      break;
    }
    case 'strobe':
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, colA, 255, 0);
      break;
    case 'fade': {
      const bright = Math.round(((Math.sin(state._fadePhase * Math.PI * 2 - Math.PI / 2) + 1) / 2) * 230 + 25);
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, colA, bright, 0);
      break;
    }
    case 'color-cycle': {
      const col = hsvToRgb(state._hue, 1, 1);
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, col, 255, 0);
      break;
    }
    case 'rainbow':
      for (let i = 0; i < FIXTURE_COUNT; i++) {
        const col = hsvToRgb(state._hue + (360 / FIXTURE_COUNT) * i, 1, 1);
        setFixtureColor(i, col, 255, 0);
      }
      break;
    case 'twinkle':
      for (let i = 0; i < FIXTURE_COUNT; i++) {
        if (Math.random() < 0.4) state._twinkle[i] = Math.random() < 0.7 ? 255 : 60;
        setFixtureColor(i, colA, state._twinkle[i], 0);
      }
      break;
    case 'split':
      for (let i = 0; i < FIXTURE_COUNT; i++)
        setFixtureColor(i, (i + step) % 2 === 0 ? colA : colB, 255, 0);
      break;
  }

  state._step++;
  state._hue = (state._hue + 360 / FIXTURE_COUNT) % 360;
}

function setFixtureColor(idx, color, dim, strobe) {
  fixtureColors[idx] = { r: color.r, g: color.g, b: color.b, w: color.w || 0, a: color.a || 0, uv: color.uv || 0, dim, strobe };
}

function resolveEnergyOverride() {
  const colA = COLOR_PRESETS[state.colorA];
  switch (state.energyOverride) {
    case 'white-strobe':  return { col: { r: 255, g: 255, b: 255, w: 255, a: 0,   uv: 0   }, dim: 255, strobe: 255 };
    case 'blinder':       return { col: { r: 255, g: 255, b: 255, w: 255, a: 0,   uv: 0   }, dim: 255, strobe: 0   };
    case 'uv-strobe':     return { col: { r: 0,   g: 0,   b: 0,   w: 0,   a: 0,   uv: 255 }, dim: 255, strobe: 255 };
    case 'color-strobe':  return { col: { r: colA.r, g: colA.g, b: colA.b, w: colA.w || 0, a: colA.a || 0, uv: colA.uv || 0 }, dim: 255, strobe: 255 };
    case 'all-on':        return { col: { r: 255, g: 255, b: 255, w: 255, a: 255, uv: 255 }, dim: 255, strobe: 0   };
    default:              return null;
  }
}

function renderDmx() {
  const energy = state.energyOverride ? resolveEnergyOverride() : null;

  for (let i = 0; i < FIXTURE_COUNT; i++) {
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

    if (state.masterBlackout) {
      for (let c = 0; c < CHANNELS; c++) dmx[base + c] = 0;
    } else {
      // Energy overrides bypass master dimmer — always full output
      const ms = energy ? 1 : state.masterDimmer / 255;
      const ds = dim / 255;
      const ts = ms * ds;
      dmx[base + CH.DIM]      = Math.round(dim * ms);
      dmx[base + CH.DIM_FINE] = 0;
      // Strobe ch3: map rawStrobe (0-255) into the selected strobe function's DMX range
      const rawStrobe = energy ? strobe : (state.pattern === 'strobe' ? state.strobeSpeed : strobe);
      if (rawStrobe > 0) {
        const fn = STROBE_FUNCTIONS.find(f => f.id === state.strobeFunction) || STROBE_FUNCTIONS[0];
        dmx[base + CH.STROBE] = fn.lo + Math.round((rawStrobe / 255) * (fn.hi - fn.lo));
      } else {
        dmx[base + CH.STROBE] = 0; // shutter open
      }
      dmx[base + CH.RED]      = Math.round(col.r  * ts);
      dmx[base + CH.GREEN]    = Math.round(col.g  * ts);
      dmx[base + CH.BLUE]     = Math.round(col.b  * ts);
      dmx[base + CH.WHITE]    = Math.round(col.w  * ts);
      dmx[base + CH.AMBER]    = Math.round(col.a  * ts);
      dmx[base + CH.UV]       = Math.round(col.uv * ts);
      dmx[base + CH.MACRO]    = 0;   // 0 = colour macro off → RGBWAUV channels in control
      dmx[base + CH.SOUND]    = 0;
      dmx[base + CH.DELAY]    = 0;
    }
  }
  sendArtNet();
}

// ─── Timing ───────────────────────────────────────────────────────────────────

function bpmInterval() { return (60000 / state.bpm) / state.beatDivision; }

function restartBeatTimer() {
  if (beatInterval) clearInterval(beatInterval);
  if (state.running) {
    beatInterval = setInterval(() => {
      tickPattern();
      state._fadePhase = (state._fadePhase + 1 / 8) % 1;
    }, bpmInterval());
  }
}

restartBeatTimer();
setInterval(renderDmx, 25);
setInterval(() => io.emit('state', getClientState()), 100);

function getClientState() {
  return {
    artnet: state.artnet,
    bpm: state.bpm,
    beatDivision: state.beatDivision,
    running: state.running,
    pattern: state.pattern,
    colorA: state.colorA,
    colorB: state.colorB,
    masterDimmer: state.masterDimmer,
    masterBlackout: state.masterBlackout,
    strobeSpeed: state.strobeSpeed,
    strobeFunction: state.strobeFunction,
    energyOverride: state.energyOverride,
    fixtures: state.fixtures,
    colorPresets: COLOR_PRESETS,
    patterns: PATTERNS,
    energyEffects: ENERGY_EFFECTS,
    strobeFunctions: STROBE_FUNCTIONS,
    dmxSnapshot: Array.from(dmx.slice(0, FIXTURE_COUNT * CHANNELS)),
    midi: { enabled: midi.enabled, ports: midi.listPorts() },
    link: { enabled: state.linkEnabled, peers: link.getNumPeers() },
  };
}

// ─── MIDI ─────────────────────────────────────────────────────────────────────

const midi = new MidiController(state, applyPatch, processTap);
midi.overrideFixture = applyOverride;

// Auto-connect if MIDI_INPUT env var is set, or try auto-detection
const midiInput  = process.env.MIDI_INPUT  || null;
const midiOutput = process.env.MIDI_OUTPUT || null;
midi.connect(midiInput, midiOutput);

// ─── Ableton Link (Python bridge via aalink) ─────────────────────────────────

const link = new AbletonLink();

// React to tempo changes pushed from Link peers
link.onTempoChange((bpm) => {
  if (!state.linkEnabled) return;
  const rounded = Math.round(bpm);
  if (rounded >= 20 && rounded <= 300 && rounded !== state.bpm) {
    state.bpm = rounded;
    restartBeatTimer();
    broadcast();
  }
});

link.onPeersChange((peers) => {
  console.log(`Ableton Link peers: ${peers}`);
  io.emit('state', getClientState());
});

function enableLink() {
  link.enable();
  state.linkEnabled = true;
  // Push our current BPM to Link when first enabling
  link.setTempo(state.bpm);
  console.log('Ableton Link enabled');
  broadcast();
}

function disableLink() {
  link.disable();
  state.linkEnabled = false;
  console.log('Ableton Link disabled');
  broadcast();
}

// Enable by default if LINK=1 env var is set
if (process.env.LINK === '1') enableLink();

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state', getClientState());

  socket.on('set', applyPatch);

  socket.on('override', ({ id, override }) => applyOverride(id, override));

  socket.on('fixture', ({ id, address, label }) => {
    if (id >= 0 && id < FIXTURE_COUNT) {
      if (address !== undefined) state.fixtures[id].address = address;
      if (label !== undefined) state.fixtures[id].label = label;
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

// POST /api/set  body: { bpm, pattern, colorA, colorB, masterDimmer, masterBlackout, running, ... }
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

// POST /api/color/a/:index   POST /api/color/b/:index
app.post('/api/color/:slot/:index', (req, res) => {
  const slot = req.params.slot === 'b' ? 'colorB' : 'colorA';
  applyPatch({ [slot]: parseInt(req.params.index) });
  res.json({ ok: true, colorA: state.colorA, colorB: state.colorB });
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

// POST /api/link/enable   POST /api/link/disable   POST /api/link/toggle
app.post('/api/link/enable',  (_req, res) => { applyPatch({ linkEnabled: true  }); res.json({ ok: true, link: { enabled: state.linkEnabled, peers: link.getNumPeers() } }); });
app.post('/api/link/disable', (_req, res) => { applyPatch({ linkEnabled: false }); res.json({ ok: true, link: { enabled: state.linkEnabled, peers: link.getNumPeers() } }); });
app.post('/api/link/toggle',  (_req, res) => { applyPatch({ linkEnabled: !state.linkEnabled }); res.json({ ok: true, link: { enabled: state.linkEnabled, peers: link.getNumPeers() } }); });

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ArtNet Lightshow  →  http://localhost:${PORT}`);
  console.log(`  ArtNet            →  ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures          →  ${FIXTURE_COUNT}x Cameo ROOT PAR 6 at DMX ${DEFAULT_ADDRESSES.join(', ')}`);
  console.log(`  MIDI              →  ${midi.enabled ? 'connected' : 'not connected (set MIDI_INPUT env var or use /api/midi/connect)'}`);
  console.log(`  Ableton Link      →  ${state.linkEnabled ? 'enabled' : 'disabled (set LINK=1 env var or use web UI)'}`);
  console.log(`  Link backend      →  Python aalink bridge\n`);
});

// Clean shutdown
process.on('SIGINT',  () => { link.destroy(); process.exit(0); });
process.on('SIGTERM', () => { link.destroy(); process.exit(0); });
