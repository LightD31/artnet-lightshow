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

  // Read from DMX snapshot using the fixture's profile channel map
  const base = fix.address - 1;
  const snap = state.dmxSnapshot || [];
  const profile = state.profiles && state.profiles[fix.profileId];
  if (profile && profile.channelMap) {
    const ch = profile.channelMap;
    const dimCh = ch.dimmer !== undefined ? ch.dimmer : -1;
    const dimScale = dimCh >= 0 && base + dimCh < snap.length ? snap[base + dimCh] / 255 : 1;
    const get = (attr) => ch[attr] !== undefined && base + ch[attr] < snap.length ? snap[base + ch[attr]] : 0;
    return colorToCss({
      r:  Math.round(get('red')   * dimScale),
      g:  Math.round(get('green') * dimScale),
      b:  Math.round(get('blue')  * dimScale),
      w:  Math.round(get('white') * dimScale),
      a:  Math.round(get('amber') * dimScale),
      uv: Math.round(get('uv')    * dimScale),
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
  renderProlink(s);
  renderMidi(s);
  renderAutoMode(s);
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

      sw.addEventListener('click', (e) => { send(e.shiftKey ? { colorC: i } : { colorA: i }); });
      sw.addEventListener('contextmenu', (e) => { e.preventDefault(); send(e.shiftKey ? { colorD: i } : { colorB: i }); });
      grid.appendChild(sw);
    });
    colorsRendered = true;
  }

  grid.querySelectorAll('.color-swatch').forEach(sw => {
    const i = parseInt(sw.dataset.idx);
    sw.classList.toggle('active-a', i === s.colorA);
    sw.classList.toggle('active-b', i === s.colorB);
    sw.classList.toggle('active-c', i === s.colorC);
    sw.classList.toggle('active-d', i === s.colorD);
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
      // Momentary: hold to activate, release to deactivate
      const activate = (ev) => { ev.preventDefault(); send({ energyOverride: e.id }); };
      const deactivate = () => { if (state.energyOverride === e.id) send({ energyOverride: null }); };
      btn.addEventListener('mousedown', activate);
      btn.addEventListener('mouseup', deactivate);
      btn.addEventListener('mouseleave', deactivate);
      btn.addEventListener('touchstart', activate);
      btn.addEventListener('touchend', deactivate);
      btn.addEventListener('touchcancel', deactivate);
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

  // Strobe function selector
  const sfSelect = document.getElementById('strobe-function');
  if (s.strobeFunctions && sfSelect.options.length === 0) {
    s.strobeFunctions.forEach(fn => {
      const opt = document.createElement('option');
      opt.value = fn.id;
      opt.textContent = fn.name;
      opt.title = fn.desc;
      sfSelect.appendChild(opt);
    });
  }
  if (document.activeElement !== sfSelect) sfSelect.value = s.strobeFunction;
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

  // Rebuild cards if fixture count changed
  const currentIds = new Set(s.fixtures.map(f => f.id));
  const renderedIds = new Set(Object.keys(fixtureElements).map(Number));
  const needsRebuild = currentIds.size !== renderedIds.size || [...currentIds].some(id => !renderedIds.has(id));

  if (needsRebuild) {
    grid.innerHTML = '';
    Object.keys(fixtureElements).forEach(k => delete fixtureElements[k]);
  }

  // Build cards on first render or after rebuild
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

function buildChannelLabels(s) {
  // Build a label map from fixture profiles
  const labels = {};
  if (!s.fixtures || !s.profiles) return labels;
  s.fixtures.forEach(fix => {
    const profile = s.profiles[fix.profileId];
    if (!profile) return;
    const base = fix.address - 1;
    (profile.channelList || []).forEach(ch => {
      const shortName = (ch.attribute || ch.name || '').substring(0, 3).toUpperCase();
      labels[base + ch.offset] = shortName || String(ch.offset + 1);
    });
  });
  return labels;
}

function renderDmxMonitor(s) {
  const mon = document.getElementById('dmx-monitor');
  const snap = s.dmxSnapshot || [];
  const labels = buildChannelLabels(s);

  if (mon.children.length !== snap.length) {
    mon.innerHTML = '';
    snap.forEach((_, i) => {
      const cell = document.createElement('div');
      cell.className = 'dmx-cell';
      cell.id = `dmx-${i}`;
      const chLabel = labels[i] || String((i % 12) + 1);
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

// Strobe controls
document.getElementById('strobe-speed').addEventListener('input', (e) => {
  document.getElementById('strobe-speed-val').textContent = e.target.value;
  send({ strobeSpeed: parseInt(e.target.value) });
});
document.getElementById('strobe-function').addEventListener('change', (e) => {
  send({ strobeFunction: e.target.value });
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

// ── PRO DJ LINK UI ───────────────────────────────────────────────────────────

function renderProlink(s) {
  if (!s.prolink) return;
  const dot   = document.getElementById('prolink-dot');
  const text  = document.getElementById('prolink-status-text');
  const btn   = document.getElementById('prolink-toggle');
  const peers = document.getElementById('prolink-peers');
  const masterEl = document.getElementById('prolink-master');
  const trackEl  = document.getElementById('prolink-track');

  const p = s.prolink;
  // Dot: green when fully connected, otherwise off
  dot.classList.toggle('connected', !!p.connected);

  let status;
  if (p.connected && p.stale) status = 'Stale (no packets)';
  else if (p.connected)       status = 'Connected';
  else if (p.enabled)         status = 'Connecting…';
  else if (p.lastError)       status = `Error: ${p.lastError}`;
  else                        status = 'Disabled';
  text.textContent = status;

  btn.textContent = p.enabled ? 'Disable' : 'Enable';
  btn.classList.toggle('active', !!p.enabled);
  peers.textContent = `${p.peers} device${p.peers !== 1 ? 's' : ''}`;

  if (p.master) {
    const bpmStr = p.master.bpm ? p.master.bpm.toFixed(1) : '—';
    const beatStr = p.master.beatInMeasure || '–';
    masterEl.textContent = `Master: CDJ-${p.master.deviceId} · ${bpmStr} BPM · beat ${beatStr}/4`;
  } else {
    masterEl.textContent = 'No master';
  }

  if (p.track && (p.track.title || p.track.artist)) {
    const t = `${p.track.title || '?'} — ${p.track.artist || '?'}`;
    trackEl.textContent = t;
  } else if (p.master && p.master.trackId) {
    trackEl.textContent = 'Loading metadata…';
  } else {
    trackEl.textContent = '—';
  }
}

document.getElementById('prolink-toggle').addEventListener('click', () => {
  const enabled = state.prolink ? state.prolink.enabled : false;
  send({ prolinkEnabled: !enabled });
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

// ── Analysis stats panel ─────────────────────────────────────────────────────
//
// Renders the #auto-analysis-stats block from the autoShow client state.
// Three sub-rows: track-level stats (BPM, key, duration, segments…),
// mood/genre (PANNs label + valence/arousal/loudness/…), structure
// (drops/buildups/downbeats/meter).

// Per-genre display colour. Keyed by the `label` field from the PANNs
// classifier (see GENRE_STYLES in src/auto-show.js for the matching
// palette/pattern map that drives the actual lighting).
const GENRE_COLORS = {
  edm:       '#ff66cc',
  dubstep:   '#ff3366',
  trance:    '#cc66ff',
  disco:     '#ff99cc',
  hiphop:    '#ffaa44',
  pop:       '#ffcc66',
  funk:      '#ff8844',
  rock:      '#ff6644',
  metal:     '#aa4466',
  country:   '#ddbb66',
  reggae:    '#66cc66',
  latin:     '#ff8833',
  jazz:      '#cc88ff',
  classical: '#88ccff',
  folk:      '#bb9966',
  ambient:   '#66ccff',
  unknown:   '#888888',
};

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${Math.round(v * 100)}%`;
}

function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toFixed(digits);
}

function renderAnalysisStats(as, colorPresets) {
  const a = as.analysis;
  const parts = [];

  // Row 0 — Genre badge (most prominent so it can't be missed).
  // Renders even if mood is missing, so the user always sees the style
  // classification when PANNs is available.
  if (a.genre && a.genre.label) {
    const label = a.genre.label;
    const color = GENRE_COLORS[label] || '#888';
    const conf = a.genre.labelConf != null ? ` ${fmtPct(a.genre.labelConf)}` : '';
    const tags = (a.genre.topTags || [])
      .filter(t => !/^Music$/i.test(t.label))
      .slice(0, 3);
    const tagText = tags.length
      ? `<span class="dim">${tags.map(t => `${t.label} ${fmtPct(t.p)}`).join(' · ')}</span>`
      : '';
    parts.push(`<div class="auto-analysis-row tier-row">`);
    parts.push(`<span class="tier-badge" style="background:${color}22;color:${color};border-color:${color}55" title="PANNs AudioSet genre classifier (${label}${conf})">${label.toUpperCase()}${conf}</span>`);
    parts.push(tagText);
    parts.push(`</div>`);
  }

  // Row 0.5 — Palette swatches. The auto-show locks each song to a single
  // 4-colour tetrad from the bank in src/auto-show.js (see TETRADS there)
  // and every pattern/drop/accent stays inside it. Rendering the 4 colours
  // here lets the operator see exactly what palette the song is running in.
  if (Array.isArray(as.palette) && as.palette.length && Array.isArray(colorPresets)) {
    const swatches = as.palette
      .map((idx, i) => {
        const preset = colorPresets[idx];
        if (!preset) return '';
        const css = colorToCss(preset);
        const label = `${preset.name || 'color'} (#${idx})`;
        // Highlight the first slot — that's the tetrad's "anchor" colour.
        const border = i === 0 ? 'box-shadow:0 0 0 1px #fff8 inset;' : '';
        return `<span class="palette-swatch" style="background:${css};${border}" title="${label}"></span>`;
      })
      .join('');
    const nameLabel = as.paletteName
      ? `<span class="dim" title="Tetrad name — the song's locked 4-colour look">${as.paletteName}</span>`
      : '';
    parts.push(`<div class="auto-analysis-row palette-row">`);
    parts.push(`<span class="palette-label" title="The 4-colour tetrad the auto-show has locked this song into">Palette</span>`);
    parts.push(`<span class="palette-swatches">${swatches}</span>`);
    parts.push(nameLabel);
    parts.push(`</div>`);
  }

  // Row 1 — track basics
  parts.push(`<div class="auto-analysis-row">`);
  parts.push(`<span>BPM: <strong>${a.bpm}</strong></span>`);
  if (a.tempoStability != null) {
    parts.push(`<span title="Tempo stability — 1.0 = locked, lower = drifting">Stability: <strong>${fmtPct(a.tempoStability)}</strong></span>`);
  }
  if (a.beatSource) {
    parts.push(`<span title="Beat tracking algorithm">Beat: <strong>${a.beatSource}</strong></span>`);
  }
  parts.push(`<span>Key: <strong>${a.key} ${a.scale}</strong>${a.keyStrength != null ? ` <span class="dim">(${fmtNum(a.keyStrength)})</span>` : ''}</span>`);
  parts.push(`<span>Duration: <strong>${Math.round(a.duration)}s</strong></span>`);
  parts.push(`</div>`);

  // Row 2 — mood (valence/arousal/loud/bright/dance/kick)
  if (a.mood) {
    const m = a.mood;
    parts.push(`<div class="auto-analysis-row">`);
    parts.push(`<span title="Valence — happy/bright vs dark/sad">Valence: <strong>${fmtPct(m.valence)}</strong></span>`);
    parts.push(`<span title="Arousal — intense vs calm">Arousal: <strong>${fmtPct(m.arousal)}</strong></span>`);
    if (m.loudness != null)     parts.push(`<span title="Loudness vs reference">Loud: <strong>${fmtPct(m.loudness)}</strong></span>`);
    if (m.brightness != null)   parts.push(`<span title="Spectral brightness">Bright: <strong>${fmtPct(m.brightness)}</strong></span>`);
    if (m.danceability != null) parts.push(`<span title="Danceability — pulse steadiness">Dance: <strong>${fmtPct(m.danceability)}</strong></span>`);
    if (m.kickiness != null)    parts.push(`<span title="Kick-band median energy">Kick: <strong>${fmtPct(m.kickiness)}</strong></span>`);
    parts.push(`</div>`);
  }

  // Row 3 — structure
  parts.push(`<div class="auto-analysis-row">`);
  parts.push(`<span>Segments: <strong>${a.segmentCount}</strong></span>`);
  parts.push(`<span>Beats: <strong>${a.beatCount}</strong></span>`);
  if (a.meter != null) {
    parts.push(`<span title="Time signature">Meter: <strong>${a.meter}/4</strong></span>`);
  }
  if (a.downbeatCount != null) {
    const dbConf = a.downbeatConfidence != null ? ` <span class="dim">(${fmtPct(a.downbeatConfidence)})</span>` : '';
    parts.push(`<span title="Downbeats detected (with detection confidence)">Downbeats: <strong>${a.downbeatCount}</strong>${dbConf}</span>`);
  }
  parts.push(`<span>Drops: <strong>${a.dropCount || 0}</strong></span>`);
  parts.push(`<span>Builds: <strong>${a.buildupCount || 0}</strong></span>`);
  parts.push(`<span>Events: <strong>${as.timelineLength}</strong></span>`);
  parts.push(`</div>`);

  return parts.join('');
}

// ── Auto Timeline Visualizer ─────────────────────────────────────────────────
//
// Fetches the full analysis/timeline payload from /api/auto/timeline when a
// new analysis becomes available, then draws a scrolling view with:
//   - segment bands (coloured by energy level)
//   - energy curve (filled area) + bass curve overlay
//   - beat ticks
//   - build-up gradient bars + drop markers
//   - timeline event dots (patches vs energy bursts)
//   - playhead (updated from socket `auto-position` events)

const autoTimeline = {
  data: null,            // full payload from /api/auto/timeline
  fetchedForTrack: null, // identity key of last analysis we fetched
  positionMs: 0,         // latest known playback position
  posUpdatedAt: 0,       // local time when positionMs was received
  running: false,        // whether playback is active (extrapolate if true)
  rafId: null,
};

socket.on('auto-position', ({ positionMs, running }) => {
  autoTimeline.positionMs = positionMs;
  autoTimeline.posUpdatedAt = performance.now();
  autoTimeline.running = !!running;
});

function autoTimelineIdentityKey(s) {
  // The timeline is keyed by (track + timelineLength) — when either changes
  // we know we should refetch.
  if (!s.autoShow || !s.autoShow.analysis) return null;
  const t = s.autoShow.track || {};
  return `${t.name || ''}|${t.artist || ''}|${s.autoShow.timelineLength || 0}|${s.autoShow.analysis.duration || 0}`;
}

function maybeFetchTimeline(s) {
  const key = autoTimelineIdentityKey(s);
  const hasAnalysis = !!(s.autoShow && s.autoShow.analysis);

  if (!hasAnalysis) {
    autoTimeline.data = null;
    autoTimeline.fetchedForTrack = null;
    return;
  }
  if (key === autoTimeline.fetchedForTrack) return;

  autoTimeline.fetchedForTrack = key;
  fetch('/api/auto/timeline')
    .then(r => r.json())
    .then(d => {
      if (d && d.ok && d.data) {
        autoTimeline.data = d.data;
        drawAutoTimeline();
      }
    })
    .catch(() => { /* silent */ });
}

function currentAutoPositionMs() {
  if (!autoTimeline.running) return autoTimeline.positionMs;
  return autoTimeline.positionMs + (performance.now() - autoTimeline.posUpdatedAt);
}

function formatTime(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

function drawAutoTimeline() {
  const canvas = document.getElementById('auto-timeline-canvas');
  if (!canvas) return;
  const container = document.getElementById('auto-timeline');
  if (!container || container.style.display === 'none') return;

  const data = autoTimeline.data;
  const ctx = canvas.getContext('2d');

  // Resize backing store to match displayed size (HiDPI aware)
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;

  // Clear
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  if (!data || !data.duration) {
    ctx.fillStyle = '#444';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No analysis loaded', W / 2, H / 2);
    return;
  }

  const durMs = data.duration * 1000;
  const xForMs = (ms) => (ms / durMs) * W;
  const xForSec = (s) => (s / data.duration) * W;

  // ── Row layout (200px total) ────────────────────────────────
  //   0- 16 : segments with letter labels
  //  18-106 : multi-band curves (energy filled + bass/kick/high lines)
  //           and tempo-drift overlay if stability < 0.85
  // 108-122 : beat ticks (regular + downbeats with greater height)
  // 124-144 : buildups + drops
  // 146-176 : timeline events (patches + energy bursts in two lanes)
  const ROW_SEG    = { y: 0,   h: 16 };
  const ROW_CURVE  = { y: 18,  h: 88 };
  const ROW_BEATS  = { y: 108, h: 14 };
  const ROW_EVENTS = { y: 124, h: 20 };
  const ROW_TIMELN = { y: 146, h: 30 };

  // ── Segments with letter labels ─────────────────────────────
  const segColors = {
    low:  '#1e3a5f',
    mid:  '#3a7099',
    high: '#ff6584',
  };
  (data.segments || []).forEach(seg => {
    const x0 = xForSec(seg.start);
    const x1 = xForSec(seg.end);
    const w = Math.max(1, x1 - x0);
    ctx.fillStyle = segColors[seg.level] || '#333';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x0, ROW_SEG.y, w, ROW_SEG.h);
    ctx.globalAlpha = 1;
    // Letter label if the segment is wide enough
    if (seg.label && w > 18) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(seg.label, x0 + 4, ROW_SEG.y + ROW_SEG.h / 2);
    }
  });

  // ── Energy curve (filled) ───────────────────────────────────
  const drawCurveLine = (curve, color, width = 1.2, alpha = 0.8) => {
    if (!curve || curve.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const pt = curve[i];
      const x = xForSec(pt.t);
      const y = ROW_CURVE.y + ROW_CURVE.h - Math.max(0, Math.min(1, pt.v)) * ROW_CURVE.h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  const energyCurve = data.energyCurve || [];
  if (energyCurve.length > 1) {
    ctx.beginPath();
    ctx.moveTo(xForSec(energyCurve[0].t), ROW_CURVE.y + ROW_CURVE.h);
    for (const pt of energyCurve) {
      const x = xForSec(pt.t);
      const y = ROW_CURVE.y + ROW_CURVE.h - Math.max(0, Math.min(1, pt.v)) * ROW_CURVE.h;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(xForSec(energyCurve[energyCurve.length - 1].t), ROW_CURVE.y + ROW_CURVE.h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, ROW_CURVE.y, 0, ROW_CURVE.y + ROW_CURVE.h);
    grad.addColorStop(0, 'rgba(108, 99, 255, .75)');
    grad.addColorStop(1, 'rgba(108, 99, 255, .08)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Sub-band curves as overlay lines on the same row
  drawCurveLine(data.bassCurve, 'rgba(255, 101, 132, .85)', 1.2);
  drawCurveLine(data.kickCurve, 'rgba(255, 170, 68, .75)', 1.0, 0.7);
  drawCurveLine(data.highCurve, 'rgba(102, 221, 255, .7)', 1.0, 0.65);

  // ── Tempo curve overlay (only when stability < 0.85) ────────
  // Maps BPM ±15% around the global BPM into the top ~22px of the curve row.
  // A wavy line means the track is genuinely speeding up / slowing down.
  if (data.tempoCurve && data.tempoCurve.length > 2 && data.tempoStability != null && data.tempoStability < 0.85) {
    const bpmMid = data.bpm || 120;
    const bpmLo = bpmMid * 0.85;
    const bpmHi = bpmMid * 1.15;
    const bandTop = ROW_CURVE.y + 2;
    const bandBot = ROW_CURVE.y + 22;
    const bandH = bandBot - bandTop;
    ctx.beginPath();
    let started = false;
    for (const pt of data.tempoCurve) {
      const v = (pt.v - bpmLo) / Math.max(0.001, bpmHi - bpmLo);
      const x = xForSec(pt.t);
      const y = bandBot - Math.max(0, Math.min(1, v)) * bandH;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(153, 255, 153, .85)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // Faint dashed band edges to show the ±15% window
    ctx.strokeStyle = 'rgba(153, 255, 153, .25)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, bandTop); ctx.lineTo(W, bandTop);
    ctx.moveTo(0, bandBot); ctx.lineTo(W, bandBot);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Beat ticks (regular + downbeat highlights) ──────────────
  const beats = data.beats || [];
  const beatStrengths = data.beatStrengths || [];
  if (beats.length) {
    // Subsample if there are more beats than pixels available
    const step = beats.length > W ? Math.ceil(beats.length / W) : 1;
    ctx.strokeStyle = 'rgba(200, 200, 240, .35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < beats.length; i += step) {
      // Vary tick height by beat strength when available
      const strength = beatStrengths[i] != null ? Math.max(0.25, beatStrengths[i]) : 0.5;
      const tickH = Math.max(3, ROW_BEATS.h * strength);
      const x = xForSec(beats[i]);
      ctx.moveTo(x, ROW_BEATS.y + ROW_BEATS.h - tickH);
      ctx.lineTo(x, ROW_BEATS.y + ROW_BEATS.h);
    }
    ctx.stroke();
  }
  // Downbeats — taller, brighter
  const downbeats = data.downbeats || [];
  if (downbeats.length) {
    ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const step = downbeats.length > W / 2 ? Math.ceil(downbeats.length / (W / 2)) : 1;
    for (let i = 0; i < downbeats.length; i += step) {
      const x = xForSec(downbeats[i]);
      ctx.moveTo(x, ROW_BEATS.y);
      ctx.lineTo(x, ROW_BEATS.y + ROW_BEATS.h);
    }
    ctx.stroke();
  }

  // ── Build-ups (gradient bars) ───────────────────────────────
  (data.buildups || []).forEach(b => {
    const x0 = xForSec(b.start);
    const x1 = xForSec(b.end);
    const w = Math.max(2, x1 - x0);
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, 'rgba(255, 170, 68, .1)');
    grad.addColorStop(1, 'rgba(255, 170, 68, .85)');
    ctx.fillStyle = grad;
    ctx.fillRect(x0, ROW_EVENTS.y, w, ROW_EVENTS.h);
  });

  // ── Drops (triangular flag, height scaled by confidence) ────
  (data.drops || []).forEach(d => {
    const x = xForSec(d.t);
    const confidence = Math.max(0.3, Math.min(1, d.confidence || 0.5));
    const triH = ROW_EVENTS.h * (0.5 + confidence * 0.5);
    const isDownbeat = d.snapTo === 'downbeat';
    ctx.fillStyle = isDownbeat ? '#ff2222' : '#ff5555';
    ctx.beginPath();
    ctx.moveTo(x, ROW_EVENTS.y + (ROW_EVENTS.h - triH));
    ctx.lineTo(x - 5, ROW_EVENTS.y + ROW_EVENTS.h);
    ctx.lineTo(x + 5, ROW_EVENTS.y + ROW_EVENTS.h);
    ctx.closePath();
    ctx.fill();
    if (isDownbeat) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Vertical streak through the curve row, alpha scaled by confidence
    ctx.strokeStyle = `rgba(255, 68, 68, ${0.25 + confidence * 0.4})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, ROW_CURVE.y);
    ctx.lineTo(x, ROW_CURVE.y + ROW_CURVE.h);
    ctx.stroke();
  });

  // ── Timeline events (dots in bottom row) ────────────────────
  const events = data.timeline || [];
  // Split events into two lanes: patches (top), energy bursts (bottom)
  const patchY  = ROW_TIMELN.y + 6;
  const energyY = ROW_TIMELN.y + ROW_TIMELN.h - 6;
  events.forEach(ev => {
    const x = xForMs(ev.timeMs);
    if (ev.action === 'patch') {
      ctx.fillStyle = '#6c63ff';
      ctx.beginPath();
      ctx.arc(x, patchY, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (ev.action === 'energy') {
      const w = Math.max(2, xForMs(ev.durationMs || 150) - xForMs(0));
      ctx.fillStyle = '#ffee44';
      ctx.fillRect(x - w / 2, energyY - 3, w, 6);
    }
  });

  // Divider lines between rows
  ctx.strokeStyle = 'rgba(255,255,255,.04)';
  ctx.lineWidth = 1;
  [ROW_SEG.y, ROW_CURVE.y, ROW_BEATS.y, ROW_EVENTS.y, ROW_TIMELN.y].forEach(y => {
    ctx.beginPath();
    ctx.moveTo(0, y - 1);
    ctx.lineTo(W, y - 1);
    ctx.stroke();
  });

  // ── Playhead ────────────────────────────────────────────────
  const posMs = currentAutoPositionMs();
  if (posMs >= 0 && posMs <= durMs) {
    const px = xForMs(posMs);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255,255,255,.7)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Update time text
  const posEl = document.getElementById('auto-timeline-pos');
  const durEl = document.getElementById('auto-timeline-dur');
  if (posEl) posEl.textContent = formatTime(posMs);
  if (durEl) durEl.textContent = formatTime(durMs);
}

function autoTimelineLoop() {
  autoTimeline.rafId = null;
  drawAutoTimeline();
  // Only loop while the visualizer is visible AND either running, or we still
  // have data (so a paused preview keeps refreshing if the user resizes, etc.).
  const container = document.getElementById('auto-timeline');
  if (container && container.style.display !== 'none' && autoTimeline.data) {
    autoTimeline.rafId = requestAnimationFrame(autoTimelineLoop);
  }
}

function startAutoTimelineLoop() {
  if (autoTimeline.rafId != null) return;
  autoTimeline.rafId = requestAnimationFrame(autoTimelineLoop);
}

// Redraw on resize (debounced via rAF loop which already runs every frame)
window.addEventListener('resize', () => {
  if (autoTimeline.data) drawAutoTimeline();
});

// ── Auto Mode UI ─────────────────────────────────────────────────────────────

function renderAutoMode(s) {
  if (!s.spotify || !s.autoShow) return;

  // Spotify status
  const dot = document.getElementById('spotify-dot');
  const text = document.getElementById('spotify-status-text');
  const connectBtn = document.getElementById('spotify-connect-btn');
  const disconnectBtn = document.getElementById('spotify-disconnect-btn');

  if (s.spotify.authenticated) {
    dot.classList.add('connected');
    text.textContent = 'Connected';
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = '';
  } else if (s.spotify.configured) {
    dot.classList.remove('connected');
    text.textContent = 'Not connected';
    connectBtn.style.display = '';
    disconnectBtn.style.display = 'none';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Not configured (set SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET)';
    connectBtn.style.display = '';
    disconnectBtn.style.display = 'none';
  }

  // Auto show status badge
  const badge = document.getElementById('auto-badge');
  const as = s.autoShow;
  badge.textContent = as.status.toUpperCase();
  badge.className = 'auto-badge auto-badge-' + as.status;

  // Now playing
  const npEl = document.getElementById('auto-now-playing');
  if (as.track) {
    npEl.style.display = '';
    document.getElementById('auto-track-name').textContent = as.track.name;
    document.getElementById('auto-track-artist').textContent = as.track.artist;
    const art = document.getElementById('auto-album-art');
    if (as.track.albumArt) { art.src = as.track.albumArt; art.style.display = ''; }
    else art.style.display = 'none';
  } else {
    npEl.style.display = 'none';
  }

  // Analysis info
  const analysisEl = document.getElementById('auto-analysis');
  const statsEl = document.getElementById('auto-analysis-stats');
  if (as.analysis) {
    analysisEl.style.display = '';
    statsEl.innerHTML = renderAnalysisStats(as, s.colorPresets);
  } else {
    analysisEl.style.display = 'none';
  }

  // Timeline visualizer: show when analysis is present, fetch on change
  const timelineEl = document.getElementById('auto-timeline');
  if (as.analysis) {
    timelineEl.style.display = '';
    maybeFetchTimeline(s);
    // Update running state for the playhead extrapolator
    autoTimeline.running = as.running;
    if (!as.running) {
      // When paused, freeze the extrapolator at the last known position
      autoTimeline.posUpdatedAt = performance.now();
    }
    startAutoTimelineLoop();
  } else {
    timelineEl.style.display = 'none';
    autoTimeline.data = null;
    autoTimeline.fetchedForTrack = null;
  }

  // Status message
  const statusMsg = document.getElementById('auto-status-msg');
  if (as.status === 'downloading') statusMsg.textContent = 'Downloading full audio via yt-dlp…';
  else if (as.status === 'analyzing') statusMsg.textContent = 'Analyzing audio with Essentia…';
  else if (as.status === 'playing') statusMsg.textContent = 'Auto show running';
  else if (as.status === 'ready') statusMsg.textContent = 'Analysis complete — ready to start';
  else statusMsg.textContent = '';

  // Transport buttons
  document.getElementById('auto-start-btn').disabled = as.status !== 'ready';
  document.getElementById('auto-stop-btn').disabled = as.status !== 'playing';

  // Source selector
  const srcSel = document.getElementById('auto-source-select');
  if (s.autoSource && document.activeElement !== srcSel && srcSel.value !== s.autoSource) {
    srcSel.value = s.autoSource;
  }

  // Palette size toggle — reflect the server's current paletteSize so a
  // manual change or a /api/auto/state refresh lands on the right button.
  const psize = as.paletteSize || 4;
  document.querySelectorAll('#auto-palette-size .palette-size-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.size) === psize);
  });

  // Intensity slider — sync from server when user isn't dragging
  const intensitySlider = document.getElementById('auto-intensity');
  if (document.activeElement !== intensitySlider && as.intensity != null) {
    intensitySlider.value = as.intensity;
    document.getElementById('auto-intensity-val').textContent = as.intensity;
  }

  // Analyze CDJ button availability
  const analyzeProlinkBtn = document.getElementById('auto-analyze-prolink-btn');
  if (analyzeProlinkBtn) {
    analyzeProlinkBtn.disabled = !(s.prolink && s.prolink.connected && s.prolink.track && s.prolink.track.title);
  }
}

// Connect Spotify
document.getElementById('spotify-connect-btn').addEventListener('click', () => {
  window.open('/auth/spotify', '_blank', 'width=500,height=700');
});

document.getElementById('spotify-disconnect-btn').addEventListener('click', () => {
  fetch('/api/spotify/disconnect', { method: 'POST' });
});

// Analyze from manual input
document.getElementById('auto-analyze-btn').addEventListener('click', () => {
  const source = document.getElementById('auto-source-input').value.trim();
  if (!source) return;
  document.getElementById('auto-status-msg').textContent = 'Analyzing…';
  fetch('/api/auto/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  }).then(r => r.json()).then(d => {
    if (!d.ok) document.getElementById('auto-status-msg').textContent = 'Error: ' + d.error;
  }).catch(e => {
    document.getElementById('auto-status-msg').textContent = 'Error: ' + e.message;
  });
});

// Analyze current Spotify track
document.getElementById('auto-analyze-spotify-btn').addEventListener('click', () => {
  document.getElementById('auto-status-msg').textContent = 'Fetching Spotify track & analyzing…';
  fetch('/api/auto/analyze-spotify', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) document.getElementById('auto-status-msg').textContent = 'Error: ' + d.error;
    }).catch(e => {
      document.getElementById('auto-status-msg').textContent = 'Error: ' + e.message;
    });
});

// Analyze current PRO DJ LINK master track
document.getElementById('auto-analyze-prolink-btn').addEventListener('click', () => {
  document.getElementById('auto-status-msg').textContent = 'Fetching CDJ track & analyzing…';
  fetch('/api/auto/analyze-prolink', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) document.getElementById('auto-status-msg').textContent = 'Error: ' + d.error;
    }).catch(e => {
      document.getElementById('auto-status-msg').textContent = 'Error: ' + e.message;
    });
});

// Source selector
document.getElementById('auto-source-select').addEventListener('change', (e) => {
  send({ autoSource: e.target.value });
});

// Palette size toggle — 2 | 3 | 4. The server hot-swaps the palette on the
// current auto-show by rebuilding the timeline in place.
document.querySelectorAll('#auto-palette-size .palette-size-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const size = Number(btn.dataset.size);
    if (!size) return;
    send({ autoPaletteSize: size });
  });
});

// Intensity slider — rebuilds timeline with new accent density / drop scaling.
document.getElementById('auto-intensity').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  document.getElementById('auto-intensity-val').textContent = val;
  send({ autoIntensity: val });
});

// Upload audio file
document.getElementById('auto-upload-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('auto-status-msg').textContent = 'Uploading & analyzing…';
  const form = new FormData();
  form.append('audio', file);
  fetch('/api/auto/analyze-upload', { method: 'POST', body: form })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) document.getElementById('auto-status-msg').textContent = 'Error: ' + d.error;
    }).catch(e => {
      document.getElementById('auto-status-msg').textContent = 'Error: ' + e.message;
    });
  e.target.value = '';
});

// Auto show transport
document.getElementById('auto-start-btn').addEventListener('click', () => {
  fetch('/api/auto/start', { method: 'POST' });
});

document.getElementById('auto-stop-btn').addEventListener('click', () => {
  fetch('/api/auto/stop', { method: 'POST' });
});

document.getElementById('auto-reset-btn').addEventListener('click', () => {
  fetch('/api/auto/reset', { method: 'POST' });
});
