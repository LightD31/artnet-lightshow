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

  // ── Row layout ─────────────────────────────────────────────
  //  0-16px  : segments
  //  16-96px : energy + bass curves
  //  96-108  : beat ticks
  //  108-128 : buildups + drops
  //  128-160 : timeline events
  const ROW_SEG    = { y: 0,   h: 16 };
  const ROW_CURVE  = { y: 18,  h: 78 };
  const ROW_BEATS  = { y: 98,  h: 10 };
  const ROW_EVENTS = { y: 110, h: 18 };
  const ROW_TIMELN = { y: 132, h: 28 };

  // ── Segments ────────────────────────────────────────────────
  const segColors = {
    low:  '#1e3a5f',
    mid:  '#3a7099',
    high: '#ff6584',
  };
  (data.segments || []).forEach(seg => {
    const x0 = xForSec(seg.start);
    const x1 = xForSec(seg.end);
    ctx.fillStyle = segColors[seg.level] || '#333';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x0, ROW_SEG.y, Math.max(1, x1 - x0), ROW_SEG.h);
  });
  ctx.globalAlpha = 1;

  // ── Energy curve (filled) ───────────────────────────────────
  const curve = data.energyCurve || [];
  if (curve.length > 1) {
    ctx.beginPath();
    ctx.moveTo(xForSec(curve[0].t), ROW_CURVE.y + ROW_CURVE.h);
    for (const pt of curve) {
      const x = xForSec(pt.t);
      const y = ROW_CURVE.y + ROW_CURVE.h - Math.max(0, Math.min(1, pt.v)) * ROW_CURVE.h;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(xForSec(curve[curve.length - 1].t), ROW_CURVE.y + ROW_CURVE.h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, ROW_CURVE.y, 0, ROW_CURVE.y + ROW_CURVE.h);
    grad.addColorStop(0, 'rgba(108, 99, 255, .75)');
    grad.addColorStop(1, 'rgba(108, 99, 255, .08)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ── Bass curve (outline) ───────────────────────────────────
  const bass = data.bassCurve || [];
  if (bass.length > 1) {
    ctx.beginPath();
    for (let i = 0; i < bass.length; i++) {
      const pt = bass[i];
      const x = xForSec(pt.t);
      const y = ROW_CURVE.y + ROW_CURVE.h - Math.max(0, Math.min(1, pt.v)) * ROW_CURVE.h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(255, 101, 132, .8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // ── Beat ticks ──────────────────────────────────────────────
  const beats = data.beats || [];
  if (beats.length) {
    ctx.strokeStyle = 'rgba(200, 200, 240, .25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // If there are lots of beats, subsample so we don't saturate pixels
    const step = beats.length > W ? Math.ceil(beats.length / W) : 1;
    for (let i = 0; i < beats.length; i += step) {
      const x = xForSec(beats[i]);
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

  // ── Drops (triangular flag markers) ─────────────────────────
  (data.drops || []).forEach(d => {
    const x = xForSec(d.t);
    const strength = Math.max(0.3, Math.min(1, d.strength || 0.5));
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(x, ROW_EVENTS.y);
    ctx.lineTo(x - 5, ROW_EVENTS.y + ROW_EVENTS.h);
    ctx.lineTo(x + 5, ROW_EVENTS.y + ROW_EVENTS.h);
    ctx.closePath();
    ctx.fill();
    // Vertical streak through the curve row for visual emphasis
    ctx.strokeStyle = `rgba(255, 68, 68, ${0.25 + strength * 0.35})`;
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
  [ROW_CURVE.y, ROW_BEATS.y, ROW_EVENTS.y, ROW_TIMELN.y].forEach(y => {
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
    const dropCount    = as.analysis.dropCount    != null ? as.analysis.dropCount    : 0;
    const buildupCount = as.analysis.buildupCount != null ? as.analysis.buildupCount : 0;
    statsEl.innerHTML = `
      <span>BPM: <strong>${as.analysis.bpm}</strong></span>
      <span>Key: <strong>${as.analysis.key} ${as.analysis.scale}</strong></span>
      <span>Segments: <strong>${as.analysis.segmentCount}</strong></span>
      <span>Beats: <strong>${as.analysis.beatCount}</strong></span>
      <span>Drops: <strong>${dropCount}</strong></span>
      <span>Builds: <strong>${buildupCount}</strong></span>
      <span>Duration: <strong>${Math.round(as.analysis.duration)}s</strong></span>
      <span>Events: <strong>${as.timelineLength}</strong></span>
    `;
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
