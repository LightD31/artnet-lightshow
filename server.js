'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const dgram = require('dgram');
const path = require('path');

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
  packet.writeUInt16LE(0x5000, 8);   // OpDmx
  packet.writeUInt16BE(14, 10);       // Protocol ver 14
  packet[12] = 0;                     // Sequence
  packet[13] = 0;                     // Physical
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
// Cameo ROOT PAR 6 – 6-channel mode
//   Ch1: Dimmer   Ch2: Red   Ch3: Green   Ch4: Blue   Ch5: White   Ch6: Strobe

const FIXTURE_COUNT = 4;
const CHANNELS = 6;
const CH = { DIM: 0, RED: 1, GREEN: 2, BLUE: 3, WHITE: 4, STROBE: 5 };

// Default DMX start addresses (1-based, as on the fixture)
const DEFAULT_ADDRESSES = [1, 7, 13, 19];

// ─── State ───────────────────────────────────────────────────────────────────

const COLOR_PRESETS = [
  { name: 'Red',        r: 255, g: 0,   b: 0,   w: 0   },
  { name: 'Orange',     r: 255, g: 80,  b: 0,   w: 0   },
  { name: 'Yellow',     r: 255, g: 200, b: 0,   w: 0   },
  { name: 'Green',      r: 0,   g: 255, b: 0,   w: 0   },
  { name: 'Cyan',       r: 0,   g: 255, b: 255, w: 0   },
  { name: 'Blue',       r: 0,   g: 0,   b: 255, w: 0   },
  { name: 'Purple',     r: 100, g: 0,   b: 255, w: 0   },
  { name: 'Magenta',    r: 255, g: 0,   b: 200, w: 0   },
  { name: 'White',      r: 0,   g: 0,   b: 0,   w: 255 },
  { name: 'Warm White', r: 255, g: 120, b: 20,  w: 200 },
  { name: 'UV',         r: 30,  g: 0,   b: 255, w: 0   },
  { name: 'Blackout',   r: 0,   g: 0,   b: 0,   w: 0   },
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
];

const state = {
  artnet: {
    host: '2.255.255.255',
    port: 6454,
    universe: 0,
  },
  bpm: 120,
  beatDivision: 1,    // beat multiplier: 1=whole, 2=half, 4=quarter
  running: true,
  pattern: 'chase',
  colorA: 0,          // index into COLOR_PRESETS
  colorB: 5,          // secondary colour index
  masterDimmer: 255,
  masterBlackout: false,
  strobeSpeed: 0,     // 0=off, 1-255
  fixtures: Array.from({ length: FIXTURE_COUNT }, (_, i) => ({
    id: i,
    label: `PAR ${i + 1}`,
    address: DEFAULT_ADDRESSES[i],  // 1-based DMX address
    override: null,                  // null = follow engine, or { r,g,b,w,dim,strobe,blackout }
  })),
  // runtime (not sent to clients on every frame, only when changed)
  _step: 0,
  _pingDir: 1,
  _hue: 0,
  _fadePhase: 0,      // 0..1
  _twinkle: new Array(FIXTURE_COUNT).fill(0),
};

const dmx = Buffer.alloc(512, 0);

// ─── Colour helpers ──────────────────────────────────────────────────────────

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
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    w: 0,
  };
}

function applyDimmer(color, dim) {
  const d = dim / 255;
  return { r: Math.round(color.r * d), g: Math.round(color.g * d), b: Math.round(color.b * d), w: Math.round((color.w || 0) * d) };
}

// ─── Engine ──────────────────────────────────────────────────────────────────

// Per-fixture output before master dimmer / blackout
let fixtureColors = Array.from({ length: FIXTURE_COUNT }, () => ({ r: 0, g: 0, b: 0, w: 0, dim: 255, strobe: 0 }));

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
        setFixtureColor(i, i === step % FIXTURE_COUNT ? colA : { r: 0, g: 0, b: 0, w: 0 }, 255, 0);
      break;

    case 'chase-rev':
      for (let i = 0; i < FIXTURE_COUNT; i++)
        setFixtureColor(i, i === (FIXTURE_COUNT - 1 - step % FIXTURE_COUNT) ? colA : { r: 0, g: 0, b: 0, w: 0 }, 255, 0);
      break;

    case 'ping-pong': {
      const pos = step % (FIXTURE_COUNT * 2 - 2);
      const idx = pos < FIXTURE_COUNT ? pos : (FIXTURE_COUNT * 2 - 2 - pos);
      for (let i = 0; i < FIXTURE_COUNT; i++)
        setFixtureColor(i, i === idx ? colA : { r: 0, g: 0, b: 0, w: 0 }, 255, 0);
      break;
    }

    case 'strobe':
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, colA, 255, 0);
      // Strobe handled via CH.STROBE below
      break;

    case 'fade': {
      const bright = Math.round(state._fadePhase * 255);
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, colA, bright, 0);
      break;
    }

    case 'color-cycle': {
      const col = hsvToRgb(state._hue, 1, 1);
      for (let i = 0; i < FIXTURE_COUNT; i++) setFixtureColor(i, col, 255, 0);
      break;
    }

    case 'rainbow': {
      for (let i = 0; i < FIXTURE_COUNT; i++) {
        const offset = (360 / FIXTURE_COUNT) * i;
        const col = hsvToRgb(state._hue + offset, 1, 1);
        setFixtureColor(i, col, 255, 0);
      }
      break;
    }

    case 'twinkle': {
      for (let i = 0; i < FIXTURE_COUNT; i++) {
        if (Math.random() < 0.35) state._twinkle[i] = Math.random() < 0.5 ? 255 : 0;
        setFixtureColor(i, colA, state._twinkle[i], 0);
      }
      break;
    }

    case 'split':
      for (let i = 0; i < FIXTURE_COUNT; i++) {
        const even = (i + step) % 2 === 0;
        setFixtureColor(i, even ? colA : colB, 255, 0);
      }
      break;
  }

  state._step++;
  state._hue = (state._hue + 360 / FIXTURE_COUNT) % 360;
}

function setFixtureColor(idx, color, dim, strobe) {
  fixtureColors[idx] = { r: color.r, g: color.g, b: color.b, w: color.w || 0, dim, strobe };
}

function renderDmx() {
  for (let i = 0; i < FIXTURE_COUNT; i++) {
    const fix = state.fixtures[i];
    const base = fix.address - 1; // 0-indexed

    let col, dim, strobe;

    if (fix.override && fix.override.enabled) {
      const ov = fix.override;
      if (ov.blackout) {
        col = { r: 0, g: 0, b: 0, w: 0 };
        dim = 0; strobe = 0;
      } else {
        col = { r: ov.r, g: ov.g, b: ov.b, w: ov.w };
        dim = ov.dim !== undefined ? ov.dim : 255;
        strobe = ov.strobe !== undefined ? ov.strobe : 0;
      }
    } else {
      const fc = fixtureColors[i];
      col = { r: fc.r, g: fc.g, b: fc.b, w: fc.w };
      dim = fc.dim;
      strobe = fc.strobe;
    }

    // Apply master
    if (state.masterBlackout) {
      dmx[base + CH.DIM]    = 0;
      dmx[base + CH.RED]    = 0;
      dmx[base + CH.GREEN]  = 0;
      dmx[base + CH.BLUE]   = 0;
      dmx[base + CH.WHITE]  = 0;
      dmx[base + CH.STROBE] = 0;
    } else {
      const masterScale = state.masterDimmer / 255;
      const dimScale = dim / 255;
      const totalScale = masterScale * dimScale;

      dmx[base + CH.DIM]    = Math.round(dim * masterScale);
      dmx[base + CH.RED]    = Math.round(col.r * totalScale);
      dmx[base + CH.GREEN]  = Math.round(col.g * totalScale);
      dmx[base + CH.BLUE]   = Math.round(col.b * totalScale);
      dmx[base + CH.WHITE]  = Math.round(col.w * totalScale);
      dmx[base + CH.STROBE] = state.pattern === 'strobe' ? state.strobeSpeed : strobe;
    }
  }

  sendArtNet();
}

// ─── Timing loops ────────────────────────────────────────────────────────────

let beatInterval = null;

function bpmInterval() {
  return (60000 / state.bpm) / state.beatDivision;
}

function restartBeatTimer() {
  if (beatInterval) clearInterval(beatInterval);
  if (state.running) {
    beatInterval = setInterval(() => {
      tickPattern();
      // Advance continuous params
      state._fadePhase = (state._fadePhase + 1 / 8) % 1;
    }, bpmInterval());
  }
}

restartBeatTimer();

// 40 Hz DMX output loop
setInterval(renderDmx, 25);

// Broadcast state snapshot to all clients every 100ms
setInterval(() => {
  io.emit('state', getClientState());
}, 100);

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
    fixtures: state.fixtures,
    colorPresets: COLOR_PRESETS,
    patterns: PATTERNS,
    dmxSnapshot: Array.from(dmx.slice(0, 30)), // first 30 channels for debug
  };
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state', getClientState());

  socket.on('set', (data) => {
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
    if (data.colorA !== undefined) state.colorA = data.colorA;
    if (data.colorB !== undefined) state.colorB = data.colorB;
    if (data.masterDimmer !== undefined) state.masterDimmer = Math.max(0, Math.min(255, data.masterDimmer));
    if (data.masterBlackout !== undefined) state.masterBlackout = data.masterBlackout;
    if (data.strobeSpeed !== undefined) state.strobeSpeed = Math.max(0, Math.min(255, data.strobeSpeed));
    if (data.artnet !== undefined) Object.assign(state.artnet, data.artnet);

    if (restartTimer) restartBeatTimer();
    io.emit('state', getClientState());
  });

  // Per-fixture override
  socket.on('override', ({ id, override }) => {
    if (id >= 0 && id < FIXTURE_COUNT) {
      state.fixtures[id].override = override; // null to clear, or { enabled, r,g,b,w,dim,strobe,blackout }
      io.emit('state', getClientState());
    }
  });

  // Fixture config (address, label)
  socket.on('fixture', ({ id, address, label }) => {
    if (id >= 0 && id < FIXTURE_COUNT) {
      if (address !== undefined) state.fixtures[id].address = address;
      if (label !== undefined) state.fixtures[id].label = label;
      io.emit('state', getClientState());
    }
  });

  // Tap tempo
  const tapTimes = [];
  socket.on('tap', () => {
    const now = Date.now();
    tapTimes.push(now);
    // Keep last 8 taps
    if (tapTimes.length > 8) tapTimes.shift();
    if (tapTimes.length >= 2) {
      const diffs = [];
      for (let i = 1; i < tapTimes.length; i++) diffs.push(tapTimes[i] - tapTimes[i - 1]);
      const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      state.bpm = Math.round(60000 / avg);
      restartBeatTimer();
      io.emit('state', getClientState());
    }
    // Clear taps if no tap within 3 seconds
    setTimeout(() => {
      if (tapTimes.length > 0 && Date.now() - tapTimes[tapTimes.length - 1] > 2500) {
        tapTimes.length = 0;
      }
    }, 3000);
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ─── HTTP API ────────────────────────────────────────────────────────────────

app.get('/state', (_req, res) => res.json(getClientState()));

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  ArtNet Lightshow running at http://localhost:${PORT}`);
  console.log(`  ArtNet → ${state.artnet.host}:${state.artnet.port} universe ${state.artnet.universe}`);
  console.log(`  Fixtures: ${FIXTURE_COUNT}x Cameo ROOT PAR 6 at DMX ${DEFAULT_ADDRESSES.join(', ')}\n`);
});
