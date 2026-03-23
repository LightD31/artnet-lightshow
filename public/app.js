'use strict';

const socket = io();

// ── State mirror ──────────────────────────────────────────────────────────────
let state = {};
let colorSelectMode = 'a'; // which colour slot a click assigns

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('connect', () => {
  document.getElementById('status-dot').classList.add('connected');
  document.getElementById('status-text').textContent = 'Connected';
});

socket.on('disconnect', () => {
  document.getElementById('status-dot').classList.remove('connected');
  document.getElementById('status-text').textContent = 'Disconnected';
});

socket.on('state', (s) => {
  state = s;
  render(s);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(data) { socket.emit('set', data); }

function colorToCss({ r, g, b, w = 0, a = 0, uv = 0 }) {
  // Amber (warm orange) additively: contributes to R and G
  // UV contributes to blue-purple: R slightly, B strongly
  const rr = Math.min(255, r + w + Math.round(a * 1.0) + Math.round(uv * 0.2));
  const gg = Math.min(255, g + w + Math.round(a * 0.5));
  const bb = Math.min(255, b + w + Math.round(uv * 0.9));
  return `rgb(${rr},${gg},${bb})`;
}

function fixtureOutputColor(id) {
  if (!state.fixtures) return '#000';
  const fix = state.fixtures[id];
  if (!fix) return '#000';

  if (state.masterBlackout) return '#000';

  if (fix.override && fix.override.enabled) {
    if (fix.override.blackout) return '#000';
    const ov = fix.override;
    const dim = (ov.dim !== undefined ? ov.dim : 255) / 255;
    const mDim = state.masterDimmer / 255;
    return colorToCss({
      r:  Math.round(ov.r  * dim * mDim),
      g:  Math.round(ov.g  * dim * mDim),
      b:  Math.round(ov.b  * dim * mDim),
      w:  Math.round(ov.w  * dim * mDim),
      a:  Math.round((ov.a  || 0) * dim * mDim),
      uv: Math.round((ov.uv || 0) * dim * mDim),
    });
  }

  // Read from DMX snapshot — 12ch mode: dim@0, strobe@2, R@3, G@4, B@5, W@6, A@7, UV@8
  const base = fix.address - 1;
  const snap = state.dmxSnapshot || [];
  if (base + 8 < snap.length) {
    const dimScale = snap[base] / 255;
    return colorToCss({
      r:  Math.round(snap[base + 3] * dimScale),
      g:  Math.round(snap[base + 4] * dimScale),
      b:  Math.round(snap[base + 5] * dimScale),
      w:  Math.round(snap[base + 6] * dimScale),
      a:  Math.round(snap[base + 7] * dimScale),
      uv: Math.round(snap[base + 8] * dimScale),
    });
  }
  return '#111';
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(s) {
  renderBpm(s);
  renderTransport(s);
  renderColors(s);
  renderEnergy(s);
  renderPatterns(s);
  renderFixtures(s);
  renderDmxMonitor(s);
  renderLink(s);
  renderMidi(s);
}

// ── BPM ───────────────────────────────────────────────────────────────────────
function renderBpm(s) {
  document.getElementById('bpm-display').textContent = s.bpm;
  const bpmInput = document.getElementById('bpm-input');
  if (document.activeElement !== bpmInput) bpmInput.value = s.bpm;

  document.querySelectorAll('[data-div]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.div) === s.beatDivision);
  });
}

// ── Transport ─────────────────────────────────────────────────────────────────
function renderTransport(s) {
  document.getElementById('play-btn').classList.toggle('active', s.running);
  document.getElementById('stop-btn').classList.toggle('active', !s.running);
  document.getElementById('blackout-btn').classList.toggle('active', s.masterBlackout);
  const slider = document.getElementById('master-dimmer');
  if (document.activeElement !== slider) slider.value = s.masterDimmer;
  document.getElementById('master-dimmer-val').textContent = s.masterDimmer;
}

// ── Colours ───────────────────────────────────────────────────────────────────
let colorsRendered = false;
function renderColors(s) {
  const grid = document.getElementById('color-grid');
  if (!s.colorPresets) return;

  if (!colorsRendered) {
    grid.innerHTML = '';
    s.colorPresets.forEach((c, i) => {
      const sw = document.createElement('div');
      sw.className = 'color-swatch';
      sw.title = c.name;
      sw.dataset.idx = i;
      const bg = c.name === 'Blackout' ? '#111' : colorToCss(c);
      sw.style.background = bg;
      if (c.name === 'Blackout') sw.style.border = '2px solid #444';

      sw.addEventListener('click', () => send({ colorA: i }));
      sw.addEventListener('contextmenu', (e) => { e.preventDefault(); send({ colorB: i }); });
      grid.appendChild(sw);
    });
    colorsRendered = true;
  }

  grid.querySelectorAll('.color-swatch').forEach(sw => {
    const i = parseInt(sw.dataset.idx);
    sw.classList.toggle('active-a', i === s.colorA);
    sw.classList.toggle('active-b', i === s.colorB);
  });
}

// ── Energy Overrides ─────────────────────────────────────────────────────────
let energyRendered = false;

function renderEnergy(s) {
  const grid = document.getElementById('energy-grid');
  if (!s.energyEffects) return;

  if (!energyRendered) {
    grid.innerHTML = '';
    s.energyEffects.forEach(e => {
      const btn = document.createElement('button');
      btn.className = 'energy-btn';
      btn.dataset.id = e.id;
      btn.innerHTML = `<span class="name">${e.name}</span><span class="desc">${e.desc}</span>`;
      btn.addEventListener('click', () => {
        // Toggle: click again to deactivate
        send({ energyOverride: state.energyOverride === e.id ? null : e.id });
      });
      grid.appendChild(btn);
    });
    energyRendered = true;
  }

  grid.querySelectorAll('.energy-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === s.energyOverride);
  });
}

// ── Patterns ──────────────────────────────────────────────────────────────────
let patternsRendered = false;
function renderPatterns(s) {
  const grid = document.getElementById('pattern-grid');
  if (!s.patterns) return;

  if (!patternsRendered) {
    grid.innerHTML = '';
    s.patterns.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'pattern-btn';
      btn.dataset.id = p.id;
      btn.innerHTML = `<span class="name">${p.name}</span><span class="desc">${p.desc}</span>`;
      btn.addEventListener('click', () => send({ pattern: p.id }));
      grid.appendChild(btn);
    });
    patternsRendered = true;
  }

  grid.querySelectorAll('.pattern-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === s.pattern);
  });

  // Show/hide strobe card
  const strobeCard = document.getElementById('strobe-card');
  strobeCard.style.display = s.pattern === 'strobe' ? '' : 'none';
  const ssSlider = document.getElementById('strobe-speed');
  if (document.activeElement !== ssSlider) ssSlider.value = s.strobeSpeed;
  document.getElementById('strobe-speed-val').textContent = s.strobeSpeed;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const fixtureElements = {};

function buildFixtureCard(fix, container) {
  const card = document.createElement('div');
  card.className = 'fixture-card';
  card.id = `fixture-${fix.id}`;

  card.innerHTML = `
    <div class="fixture-preview" id="preview-${fix.id}"></div>
    <div class="fixture-header">
      <span class="fixture-name" contenteditable="true" id="fname-${fix.id}">${fix.label}</span>
      <span class="fixture-addr">DMX <input type="number" id="faddr-${fix.id}" value="${fix.address}"
        min="1" max="507" style="width:42px;background:var(--surface);border:1px solid var(--border);
        color:var(--muted);border-radius:4px;padding:2px 4px;font-size:11px;font-family:monospace;" /></span>
    </div>

    <div class="override-section">
      <div class="override-header">
        <label>Override</label>
        <button class="btn sm" id="ov-toggle-${fix.id}">Off</button>
        <button class="btn sm danger" id="ov-blackout-${fix.id}">Blackout</button>
        <button class="btn sm" id="ov-clear-${fix.id}">Clear</button>
      </div>
      <div class="override-controls" id="ov-controls-${fix.id}" style="display:none">
        <div class="override-row">
          <label>Red</label>
          <input type="range" min="0" max="255" value="255" id="ov-r-${fix.id}" />
          <span class="val" id="ov-r-val-${fix.id}">255</span>
        </div>
        <div class="override-row">
          <label>Green</label>
          <input type="range" min="0" max="255" value="0" id="ov-g-${fix.id}" />
          <span class="val" id="ov-g-val-${fix.id}">0</span>
        </div>
        <div class="override-row">
          <label>Blue</label>
          <input type="range" min="0" max="255" value="0" id="ov-b-${fix.id}" />
          <span class="val" id="ov-b-val-${fix.id}">0</span>
        </div>
        <div class="override-row">
          <label>White</label>
          <input type="range" min="0" max="255" value="0" id="ov-w-${fix.id}" />
          <span class="val" id="ov-w-val-${fix.id}">0</span>
        </div>
        <div class="override-row">
          <label>Amber</label>
          <input type="range" min="0" max="255" value="0" id="ov-a-${fix.id}" />
          <span class="val" id="ov-a-val-${fix.id}">0</span>
        </div>
        <div class="override-row">
          <label>UV</label>
          <input type="range" min="0" max="255" value="0" id="ov-uv-${fix.id}" />
          <span class="val" id="ov-uv-val-${fix.id}">0</span>
        </div>
        <div class="override-row">
          <label>Dimmer</label>
          <input type="range" min="0" max="255" value="255" id="ov-dim-${fix.id}" />
          <span class="val" id="ov-dim-val-${fix.id}">255</span>
        </div>
        <div class="override-row">
          <label>Strobe</label>
          <input type="range" min="0" max="255" value="0" id="ov-strobe-${fix.id}" />
          <span class="val" id="ov-strobe-val-${fix.id}">0</span>
        </div>
      </div>
    </div>
  `;

  container.appendChild(card);

  // Event bindings
  const id = fix.id;

  // Fixture label rename
  document.getElementById(`fname-${id}`).addEventListener('blur', (e) => {
    socket.emit('fixture', { id, label: e.target.textContent.trim() });
  });

  // Fixture address
  document.getElementById(`faddr-${id}`).addEventListener('change', (e) => {
    socket.emit('fixture', { id, address: parseInt(e.target.value) || fix.address });
  });

  // Override toggle
  document.getElementById(`ov-toggle-${id}`).addEventListener('click', () => {
    const cur = state.fixtures && state.fixtures[id] && state.fixtures[id].override;
    const enabled = !(cur && cur.enabled);
    const r = parseInt(document.getElementById(`ov-r-${id}`).value);
    const g = parseInt(document.getElementById(`ov-g-${id}`).value);
    const b = parseInt(document.getElementById(`ov-b-${id}`).value);
    const w = parseInt(document.getElementById(`ov-w-${id}`).value);
    const a = parseInt(document.getElementById(`ov-a-${id}`).value);
    const uv = parseInt(document.getElementById(`ov-uv-${id}`).value);
    const dim = parseInt(document.getElementById(`ov-dim-${id}`).value);
    const strobe = parseInt(document.getElementById(`ov-strobe-${id}`).value);
    socket.emit('override', { id, override: { enabled, r, g, b, w, a, uv, dim, strobe, blackout: false } });
  });

  // Override blackout
  document.getElementById(`ov-blackout-${id}`).addEventListener('click', () => {
    const cur = state.fixtures && state.fixtures[id] && state.fixtures[id].override;
    const newBlackout = !(cur && cur.blackout);
    socket.emit('override', { id, override: { enabled: true, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: newBlackout } });
  });

  // Override clear
  document.getElementById(`ov-clear-${id}`).addEventListener('click', () => {
    socket.emit('override', { id, override: null });
  });

  // RGBWAUV/Dim/Strobe sliders
  ['r','g','b','w','a','uv','dim','strobe'].forEach(ch => {
    const slider = document.getElementById(`ov-${ch}-${id}`);
    slider.addEventListener('input', () => {
      document.getElementById(`ov-${ch}-val-${id}`).textContent = slider.value;
      emitOverride(id);
    });
  });
}

function emitOverride(id) {
  const r      = parseInt(document.getElementById(`ov-r-${id}`).value);
  const g      = parseInt(document.getElementById(`ov-g-${id}`).value);
  const b      = parseInt(document.getElementById(`ov-b-${id}`).value);
  const w      = parseInt(document.getElementById(`ov-w-${id}`).value);
  const a      = parseInt(document.getElementById(`ov-a-${id}`).value);
  const uv     = parseInt(document.getElementById(`ov-uv-${id}`).value);
  const dim    = parseInt(document.getElementById(`ov-dim-${id}`).value);
  const strobe = parseInt(document.getElementById(`ov-strobe-${id}`).value);
  const cur    = state.fixtures && state.fixtures[id] && state.fixtures[id].override;
  const enabled = cur ? cur.enabled : true;
  socket.emit('override', { id, override: { enabled, r, g, b, w, a, uv, dim, strobe, blackout: false } });
}

function renderFixtures(s) {
  const grid = document.getElementById('fixtures-grid');
  if (!s.fixtures) return;

  // Build cards on first render
  s.fixtures.forEach(fix => {
    if (!fixtureElements[fix.id]) {
      buildFixtureCard(fix, grid);
      fixtureElements[fix.id] = true;
    }
  });

  // Update dynamic parts
  s.fixtures.forEach(fix => {
    const card = document.getElementById(`fixture-${fix.id}`);
    if (!card) return;

    const ov = fix.override;
    const hasOverride = ov && ov.enabled;

    card.classList.toggle('overridden', hasOverride);

    // Preview colour
    document.getElementById(`preview-${fix.id}`).style.background = fixtureOutputColor(fix.id);

    // Override toggle label
    const toggleBtn = document.getElementById(`ov-toggle-${fix.id}`);
    toggleBtn.textContent = hasOverride ? 'On' : 'Off';
    toggleBtn.classList.toggle('active', hasOverride);

    // Blackout btn
    const boBtn = document.getElementById(`ov-blackout-${fix.id}`);
    boBtn.classList.toggle('active', ov && ov.blackout);

    // Show/hide controls
    const controls = document.getElementById(`ov-controls-${fix.id}`);
    controls.style.display = hasOverride ? '' : 'none';

    // Sync sliders only if not actively dragged
    if (ov) {
      ['r','g','b','w','a','uv','dim','strobe'].forEach(ch => {
        const slider = document.getElementById(`ov-${ch}-${fix.id}`);
        const valEl  = document.getElementById(`ov-${ch}-val-${fix.id}`);
        if (document.activeElement !== slider && ov[ch] !== undefined) {
          slider.value = ov[ch];
          valEl.textContent = ov[ch];
        }
      });
    }
  });
}

// ── DMX Monitor ───────────────────────────────────────────────────────────────
const CH_LABELS = ['Dim', 'Fine', 'Str', 'R', 'G', 'B', 'W', 'A', 'UV', 'Mac', 'Snd', 'Dly'];

function renderDmxMonitor(s) {
  const mon = document.getElementById('dmx-monitor');
  const snap = s.dmxSnapshot || [];

  if (mon.children.length !== snap.length) {
    mon.innerHTML = '';
    snap.forEach((_, i) => {
      const cell = document.createElement('div');
      cell.className = 'dmx-cell';
      cell.id = `dmx-${i}`;
      const chLabel = CH_LABELS[i % 12] || String(i % 12);
      cell.innerHTML = `<span class="ch">${i + 1} ${chLabel}</span><span class="val" id="dmxv-${i}">0</span>`;
      mon.appendChild(cell);
    });
  }

  snap.forEach((v, i) => {
    const valEl = document.getElementById(`dmxv-${i}`);
    if (valEl) valEl.textContent = v;
    const cell = document.getElementById(`dmx-${i}`);
    if (cell) cell.classList.toggle('active', v > 0);
  });
}

// ── Controls ──────────────────────────────────────────────────────────────────

// BPM
document.getElementById('bpm-up').addEventListener('click',   () => send({ bpm: (state.bpm || 120) + 1 }));
document.getElementById('bpm-down').addEventListener('click', () => send({ bpm: (state.bpm || 120) - 1 }));

document.getElementById('bpm-input').addEventListener('change', (e) => {
  const v = parseInt(e.target.value);
  if (v >= 20 && v <= 300) send({ bpm: v });
});

// Beat division
document.querySelectorAll('[data-div]').forEach(btn => {
  btn.addEventListener('click', () => send({ beatDivision: parseInt(btn.dataset.div) }));
});

// Tap tempo
document.getElementById('tap-btn').addEventListener('click', () => socket.emit('tap'));
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target.tagName !== 'INPUT' && !e.target.isContentEditable) { e.preventDefault(); socket.emit('tap'); } });

// Transport
document.getElementById('play-btn').addEventListener('click', () => send({ running: true }));
document.getElementById('stop-btn').addEventListener('click', () => send({ running: false }));
document.getElementById('blackout-btn').addEventListener('click', () => send({ masterBlackout: !state.masterBlackout }));

// Master dimmer
const masterSlider = document.getElementById('master-dimmer');
masterSlider.addEventListener('input', () => {
  document.getElementById('master-dimmer-val').textContent = masterSlider.value;
  send({ masterDimmer: parseInt(masterSlider.value) });
});

// Strobe speed
document.getElementById('strobe-speed').addEventListener('input', (e) => {
  document.getElementById('strobe-speed-val').textContent = e.target.value;
  send({ strobeSpeed: parseInt(e.target.value) });
});

// ArtNet settings
document.getElementById('artnet-save').addEventListener('click', () => {
  send({
    artnet: {
      host: document.getElementById('artnet-host').value,
      port: parseInt(document.getElementById('artnet-port').value),
      universe: parseInt(document.getElementById('artnet-universe').value),
    }
  });
});

// Sync artnet fields from state on first load
socket.on('state', (s) => {
  if (!s.artnet) return;
  const hostEl = document.getElementById('artnet-host');
  const portEl = document.getElementById('artnet-port');
  const univEl = document.getElementById('artnet-universe');
  if (document.activeElement !== hostEl) hostEl.value = s.artnet.host;
  if (document.activeElement !== portEl) portEl.value = s.artnet.port;
  if (document.activeElement !== univEl) univEl.value = s.artnet.universe;
});

// ── Ableton Link UI ──────────────────────────────────────────────────────────

function renderLink(s) {
  if (!s.link) return;
  const dot  = document.getElementById('link-dot');
  const text = document.getElementById('link-status-text');
  const btn  = document.getElementById('link-toggle');
  const peers = document.getElementById('link-peers');

  dot.classList.toggle('connected', s.link.enabled);
  text.textContent = s.link.enabled ? 'Enabled' : 'Disabled';
  btn.textContent = s.link.enabled ? 'Disable' : 'Enable';
  btn.classList.toggle('active', s.link.enabled);
  peers.textContent = `${s.link.peers} peer${s.link.peers !== 1 ? 's' : ''}`;
}

document.getElementById('link-toggle').addEventListener('click', () => {
  const enabled = state.link ? state.link.enabled : false;
  send({ linkEnabled: !enabled });
});

// ── MIDI UI ───────────────────────────────────────────────────────────────────

function renderMidi(s) {
  if (!s.midi) return;
  const dot  = document.getElementById('midi-dot');
  const text = document.getElementById('midi-status-text');
  dot.classList.toggle('connected', s.midi.enabled);
  text.textContent = s.midi.enabled ? 'Connected' : 'Not connected';

  // Populate port selects
  const ports = s.midi.ports || { inputs: [], outputs: [] };
  ['input', 'output'].forEach(dir => {
    const sel = document.getElementById(`midi-${dir}`);
    const list = dir === 'input' ? ports.inputs : ports.outputs;
    const cur  = sel.value;
    sel.innerHTML = '<option value="">— auto-detect —</option>';
    list.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      if (name === cur) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}

document.getElementById('midi-connect').addEventListener('click', () => {
  const input  = document.getElementById('midi-input').value  || null;
  const output = document.getElementById('midi-output').value || null;
  socket.emit('midi-connect', { input, output });
});

socket.on('midi-status', ({ ok, ports, enabled }) => {
  const dot  = document.getElementById('midi-dot');
  const text = document.getElementById('midi-status-text');
  dot.classList.toggle('connected', enabled);
  text.textContent = enabled ? 'Connected' : (ok ? 'Connected' : 'Failed to connect');
});
