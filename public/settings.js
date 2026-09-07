'use strict';

const socket = io({ auth: { token: window.LIGHTSHOW_TOKEN || '' } });

let state = {};
let profiles = {};
let pendingGdtf = null; // holds parsed GDTF data before user confirms mode

/**
 * Fetch a JSON API and say so when it refuses.
 *
 * Several call sites here were fire-and-forget, so a server that said no —
 * "Profile is in use by patched fixtures", "Must have at least one fixture",
 * "Patch is full" — produced exactly nothing on screen. Returns the parsed body
 * either way, so callers that branch on it still can.
 */
async function apiJson(path, init) {
  try {
    const res = await fetch(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      Toast.error(body.error || `${(init && init.method) || 'GET'} ${path} failed (${res.status})`);
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return { ok: true, ...body };
  } catch (err) {
    Toast.error(`Could not reach the server: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** JSON body helper — every POST/PUT here sends one. */
const jsonBody = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// The patch table drives fixtures over the socket, which is exactly where the
// server refuses an address past the end of a universe or a move over the
// transmit cap. Without this the input silently reverted on the next broadcast.
socket.on('error-msg', ({ message }) => {
  if (message) Toast.error(message);
});

// ── Socket events ────────────────────────────────────────────────────────────

socket.on('connect', () => {
  document.getElementById('status-dot').classList.add('connected');
});

socket.on('disconnect', () => {
  document.getElementById('status-dot').classList.remove('connected');
});

// MERGE, don't replace. The first push on connect is the full snapshot,
// including the static catalogues (colour presets, patterns, energy effects);
// every later push carries only the fields that change. Replacing would drop
// the catalogues the MIDI mapping editor builds its pickers from.
socket.on('state', (s) => {
  state = { ...state, ...s };
  if (s.profiles) profiles = s.profiles;
  renderProfiles();
  renderPatchTable();
  syncArtnetFields(s);
  if (s.midi) renderMidiStatus(s.midi);
  if (s.cues) renderMidiMap();
});

// ── ArtNet settings ──────────────────────────────────────────────────────────

const ARTNET_FIELDS = ['artnet-enabled', 'artnet-host', 'artnet-port', 'artnet-universe'];

ARTNET_FIELDS.forEach(id => {
  const node = document.getElementById(id);
  node.addEventListener(node.type === 'checkbox' ? 'change' : 'input', function () {
    this.dataset.dirty = 'true';
  });
});

function syncArtnetFields(s) {
  if (!s.artnet) return;
  const e = document.getElementById('artnet-enabled');
  const h = document.getElementById('artnet-host');
  const p = document.getElementById('artnet-port');
  const u = document.getElementById('artnet-universe');
  if (!e.dataset.dirty) e.checked = s.artnet.enabled !== false;
  if (!h.dataset.dirty) h.value = s.artnet.host;
  if (!p.dataset.dirty) p.value = s.artnet.port;
  if (!u.dataset.dirty) u.value = s.artnet.universe;
}

document.getElementById('artnet-save').addEventListener('click', () => {
  socket.emit('set', {
    artnet: {
      enabled: document.getElementById('artnet-enabled').checked,
      host: document.getElementById('artnet-host').value,
      port: parseInt(document.getElementById('artnet-port').value),
      universe: parseInt(document.getElementById('artnet-universe').value),
    }
  });
  ARTNET_FIELDS.forEach(id => {
    delete document.getElementById(id).dataset.dirty;
  });
});

// ── MIDI settings ────────────────────────────────────────────────────────────

socket.on('midi-status', ({ ok, enabled }) => {
  const dot  = document.getElementById('midi-dot');
  const text = document.getElementById('midi-status-text');
  if (dot) dot.classList.toggle('connected', enabled);
  if (text) text.textContent = enabled ? 'Connected' : (ok ? 'Connected' : 'Failed to connect');
});

function renderMidiStatus(midi) {
  const dot  = document.getElementById('midi-dot');
  const text = document.getElementById('midi-status-text');
  if (dot) dot.classList.toggle('connected', midi.enabled);
  if (text) text.textContent = midi.enabled ? 'Connected' : 'Not connected';

  const ports = midi.ports || { inputs: [], outputs: [] };
  ['input', 'output'].forEach(dir => {
    const sel = document.getElementById(`midi-${dir}`);
    if (!sel) return;
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

// ── MIDI mapping and learn ───────────────────────────────────────────────────
// The map used to be a constant describing one controller; anything else was
// unusable without editing source. Pick an action, press Learn, then move the
// control you want it on.

let midiMapData = null;   // { map, customised, actions }

const ACTION_BY_ID = () => new Map((midiMapData.actions || []).map(a => [a.id, a]));

/** The options for an action's parameter, from the live catalogues. */
function paramOptions(kind) {
  switch (kind) {
    case 'pattern':
      return (state.patterns || []).map(p => ({ value: p.id, label: p.name }));
    case 'color':
      return (state.colorPresets || []).map((c, i) => ({ value: i, label: c.name }));
    case 'energy':
      return (state.energyEffects || []).map(e => ({ value: e.id, label: e.name }));
    case 'cue':
      return (state.cues || []).map(c => ({ value: c.id, label: c.name }));
    case 'fixture':
      return (state.fixtures || []).map(f => ({ value: f.id, label: f.label }));
    case 'division':
      return [1, 2, 4, 8, 16].map(d => ({ value: d, label: d === 1 ? '1/1' : `1/${d}` }));
    default:
      return [];
  }
}

/** "CC 12" / "Note 40 ch 3" — what the operator sees in the Control column. */
function controlLabel(kind, number, binding) {
  const base = kind === 'cc' ? `CC ${number}` : `Note ${number}`;
  const chan = binding.channel !== undefined ? ` ch ${binding.channel + 1}` : '';
  const type = kind === 'cc' ? ` (${binding.type === 'relative' ? 'encoder' : 'fader'})` : '';
  return `${base}${chan}${type}`;
}

/** "Select pattern — Chase" */
function actionLabel(binding) {
  const action = ACTION_BY_ID().get(binding.action);
  const label = action ? action.label : binding.action;
  if (!action || !action.param) return label;
  const key = action.param.key;
  const value = binding[key];
  if (value === undefined || value === null) return label;
  const match = paramOptions(action.param.kind).find(o => String(o.value) === String(value));
  return `${label} — ${match ? match.label : value}`;
}

function renderMidiMap() {
  const tbody = document.getElementById('midi-map-tbody');
  if (!tbody || !midiMapData) return;

  document.getElementById('midi-map-source').textContent = midiMapData.customised
    ? 'Using your saved mapping.'
    : 'Using the built-in X-Touch Compact mapping.';
  document.getElementById('midi-map-reset').disabled = !midiMapData.customised;

  const rows = [];
  for (const kind of ['notes', 'cc']) {
    for (const [number, binding] of Object.entries(midiMapData.map[kind] || {})) {
      rows.push({ kind, number: Number(number), binding });
    }
  }
  rows.sort((a, b) => (a.kind === b.kind ? a.number - b.number : a.kind < b.kind ? -1 : 1));

  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'midi-control', controlLabel(row.kind, row.number, row.binding)));
    tr.appendChild(el('td', null, actionLabel(row.binding)));

    const actions = el('td', 'midi-row-actions');
    const relearn = el('button', 'btn btn-small', 'Learn');
    relearn.title = 'Move this action to another control';
    relearn.addEventListener('click', () => startLearn(row.binding));
    actions.appendChild(relearn);

    const clear = el('button', 'btn btn-small remove-btn', '×');
    clear.title = 'Unbind';
    clear.addEventListener('click', () => putBinding(row.kind, row.number, null));
    actions.appendChild(clear);

    tr.appendChild(actions);
    tbody.appendChild(tr);
  }

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = el('td', 'midi-map-empty', 'Nothing is bound.');
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

/** Fill the "add a binding" pickers, and keep the parameter list in step. */
function renderMidiAddRow() {
  const actionSel = document.getElementById('midi-add-action');
  if (!actionSel || !midiMapData) return;

  const previous = actionSel.value;
  actionSel.innerHTML = '';
  let group = null;
  for (const action of midiMapData.actions || []) {
    if (action.input !== group) {
      group = action.input;
      const label = { button: 'Buttons', encoder: 'Encoders', fader: 'Faders' }[group] || group;
      actionSel.appendChild(Object.assign(document.createElement('optgroup'), { label }));
    }
    const opt = el('option', null, action.label);
    opt.value = action.id;
    actionSel.lastChild.appendChild(opt);
  }
  if (previous) actionSel.value = previous;
  syncMidiParam();
}

function syncMidiParam() {
  const actionSel = document.getElementById('midi-add-action');
  const paramSel  = document.getElementById('midi-add-param');
  const action = ACTION_BY_ID().get(actionSel.value);
  const param = action && action.param;

  if (!param) { paramSel.hidden = true; paramSel.innerHTML = ''; return; }

  const options = paramOptions(param.kind);
  paramSel.innerHTML = '';
  if (param.optional) {
    const none = el('option', null, `— any ${param.label.toLowerCase()} —`);
    none.value = '';
    paramSel.appendChild(none);
  }
  for (const o of options) {
    const opt = el('option', null, o.label);
    opt.value = String(o.value);
    paramSel.appendChild(opt);
  }
  paramSel.hidden = false;
}

/** The binding described by the add-row pickers. */
function bindingFromAddRow() {
  const actionSel = document.getElementById('midi-add-action');
  const paramSel  = document.getElementById('midi-add-param');
  const action = ACTION_BY_ID().get(actionSel.value);
  if (!action) return null;

  const binding = { action: action.id };
  if (action.param && !paramSel.hidden && paramSel.value !== '') {
    const raw = paramSel.value;
    const numeric = ['color', 'fixture', 'division'].includes(action.param.kind);
    binding[action.param.key] = numeric ? Number(raw) : raw;
  }
  if (action.input === 'encoder') binding.type = 'relative';
  if (action.input === 'fader') binding.type = 'absolute';
  return binding;
}

function showLearnBanner(text) {
  const banner = document.getElementById('midi-learn-banner');
  document.getElementById('midi-learn-text').textContent = text;
  banner.hidden = false;
}

function hideLearnBanner() {
  document.getElementById('midi-learn-banner').hidden = true;
}

/**
 * Arm learn. The request is held open by the server until a control moves, so
 * there is nothing to poll — the answer arrives when the operator presses
 * something, gives up, or the 30-second timeout fires.
 */
async function startLearn(binding) {
  if (!binding) return;
  showLearnBanner('Press or move the control you want…');
  // Not apiJson(): a learn that times out or is cancelled answers ok:false and
  // is a normal outcome, not something to shout about — the banner says it.
  let res;
  try {
    res = await fetch('/api/midi/learn', jsonBody('POST', binding)).then(r => r.json());
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  if (!res.ok) {
    showLearnBanner(res.error || 'Learn failed');
    setTimeout(hideLearnBanner, 3000);
    return;
  }
  hideLearnBanner();
  midiMapData = { ...midiMapData, map: res.map, customised: res.customised };
  renderMidiMap();
}

async function putBinding(kind, number, binding) {
  const res = await apiJson('/api/midi/map/binding', jsonBody('PUT', { kind, number, binding }));
  if (res.ok) {
    midiMapData = { ...midiMapData, map: res.map, customised: res.customised };
    renderMidiMap();
  }
}

async function loadMidiMap() {
  const res = await fetch('/api/midi/map').then(r => r.json()).catch(() => null);
  if (!res || !res.ok) return;
  midiMapData = res;
  renderMidiAddRow();
  renderMidiMap();
}

// Learn is a whole-server mode, so another page arming or completing one has to
// show up here too rather than leaving this one displaying a stale map.
socket.on('midi-map', ({ map, customised }) => {
  if (!midiMapData) return;
  midiMapData = { ...midiMapData, map, customised };
  renderMidiMap();
});

socket.on('midi-learn', (event) => {
  if (event.status === 'armed') showLearnBanner('Press or move the control you want…');
  else hideLearnBanner();
});

document.getElementById('midi-add-action').addEventListener('change', syncMidiParam);
document.getElementById('midi-add-learn').addEventListener('click', () => startLearn(bindingFromAddRow()));
document.getElementById('midi-learn-cancel').addEventListener('click', () => {
  fetch('/api/midi/learn/cancel', { method: 'POST' });
  hideLearnBanner();
});
document.getElementById('midi-map-reset').addEventListener('click', async () => {
  const res = await apiJson('/api/midi/map/reset', { method: 'POST' });
  if (res.ok) {
    midiMapData = { ...midiMapData, map: res.map, customised: res.customised };
    renderMidiMap();
  }
});

// ── GDTF Import ──────────────────────────────────────────────────────────────

document.getElementById('gdtf-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('gdtf-status');
  statusEl.textContent = 'Parsing...';
  statusEl.className = 'import-status';

  const formData = new FormData();
  formData.append('gdtf', file);

  try {
    const res = await fetch('/api/gdtf/parse', { method: 'POST', body: formData });
    const data = await res.json();

    if (!data.ok) {
      statusEl.textContent = data.error || 'Failed to parse GDTF';
      statusEl.className = 'import-status error';
      return;
    }

    statusEl.textContent = `Parsed: ${data.fixture.name} by ${data.fixture.manufacturer}`;
    statusEl.className = 'import-status success';

    pendingGdtf = data.fixture;
    showModeSelector(data.fixture);
  } catch (err) {
    statusEl.textContent = 'Upload failed';
    statusEl.className = 'import-status error';
  }

  // Reset file input
  e.target.value = '';
});

function showModeSelector(fixture) {
  const container = document.getElementById('gdtf-mode-select');
  container.style.display = '';

  document.getElementById('gdtf-fixture-name').textContent =
    `${fixture.manufacturer} ${fixture.name}`;

  const modeSelect = document.getElementById('gdtf-mode');
  modeSelect.innerHTML = '';
  fixture.modes.forEach((mode, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${mode.modeName} (${mode.channelCount}ch)`;
    modeSelect.appendChild(opt);
  });

  renderChannelPreview(fixture.modes[0]);

  modeSelect.addEventListener('change', () => {
    renderChannelPreview(fixture.modes[parseInt(modeSelect.value)]);
  });
}

// Build an element with text content set safely. Every value rendered by this
// page can originate from an uploaded GDTF file or an unauthenticated API call,
// so it must never reach innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function renderChannelPreview(mode) {
  const container = document.getElementById('gdtf-channel-preview');
  container.innerHTML = '';
  mode.channelList.forEach(ch => {
    const isMapped = ch.attribute && ch.attribute !== 'unknown';
    const tag = el('span', 'ch-tag' + (isMapped ? ' mapped' : ''));
    tag.appendChild(el('span', 'ch-num', ch.offset + 1));
    tag.appendChild(el('span', 'ch-name', ch.name));
    container.appendChild(tag);
  });
}

document.getElementById('gdtf-confirm').addEventListener('click', async () => {
  if (!pendingGdtf) return;

  const modeIdx = parseInt(document.getElementById('gdtf-mode').value);
  const mode = pendingGdtf.modes[modeIdx];

  const profileId = slugify(`${pendingGdtf.manufacturer}-${pendingGdtf.name}-${mode.modeName}`);

  const profile = {
    id: profileId,
    name: pendingGdtf.name,
    manufacturer: pendingGdtf.manufacturer,
    modeName: mode.modeName,
    channelCount: mode.channelCount,
    channelMap: mode.channelMap,
    channelList: mode.channelList,
  };

  const data = await apiJson('/api/profiles', jsonBody('POST', profile));
  const status = document.getElementById('gdtf-status');
  if (data.ok) {
    status.textContent = `Profile "${profile.name} - ${profile.modeName}" added!`;
    status.className = 'import-status success';
    document.getElementById('gdtf-mode-select').style.display = 'none';
    pendingGdtf = null;
  } else {
    // apiJson already said what went wrong; leave it beside the control too.
    status.textContent = data.error;
    status.className = 'import-status error';
  }
});

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── Profiles list ────────────────────────────────────────────────────────────

function renderProfiles() {
  const container = document.getElementById('profiles-list');
  container.innerHTML = '';

  Object.values(profiles).forEach(p => {
    const card = document.createElement('div');
    const isBuiltin = p.id === 'cameo-root-par-6-12ch';
    card.className = 'profile-card' + (isBuiltin ? ' builtin' : '');

    const mappedChannels = Object.keys(p.channelMap || {}).join(', ');
    card.appendChild(el('span', 'profile-name', p.name));
    card.appendChild(el('span', 'profile-manufacturer', p.manufacturer));
    card.appendChild(el('span', 'profile-mode', `${p.modeName} — ${p.channelCount}ch`));
    card.appendChild(el('span', 'profile-channels', `Mapped: ${mappedChannels || 'none'}`));

    const actions = el('div', 'profile-actions');
    if (isBuiltin) {
      const badge = el('span', null, 'Built-in');
      badge.style.fontSize = '10px';
      badge.style.color = 'var(--accent)';
      actions.appendChild(badge);
    } else {
      const btn = el('button', 'btn sm remove-profile-btn', 'Remove');
      btn.dataset.id = p.id;
      actions.appendChild(btn);
    }
    card.appendChild(actions);
    container.appendChild(card);
  });

  // Remove profile handlers
  container.querySelectorAll('.remove-profile-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await fetch(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    });
  });
}

// ── Patch table ──────────────────────────────────────────────────────────────

function renderPatchTable() {
  const tbody = document.getElementById('patch-tbody');
  if (!state.fixtures) return;

  // Detect address conflicts
  const conflicts = detectConflicts(state.fixtures);

  tbody.innerHTML = '';
  state.fixtures.forEach((fix) => {
    const profile = profiles[fix.profileId] || {};
    const chCount = profile.channelCount || 12;
    const endAddr = fix.address + chCount - 1;
    const hasConflict = conflicts.has(fix.id);

    const tr = document.createElement('tr');

    const idCell = el('td', null, fix.id + 1);
    idCell.style.color = 'var(--muted)';
    idCell.style.fontFamily = 'monospace';
    tr.appendChild(idCell);

    const labelCell = el('td');
    const labelInput = el('input');
    labelInput.type = 'text';
    labelInput.value = fix.label;            // property assignment, never an HTML attribute
    labelInput.dataset.field = 'label';
    labelInput.dataset.id = fix.id;
    labelCell.appendChild(labelInput);
    tr.appendChild(labelCell);

    const profileCell = el('td');
    const select = el('select');
    select.dataset.field = 'profileId';
    select.dataset.id = fix.id;
    Object.values(profiles).forEach(p => {
      const opt = el('option', null, `${p.manufacturer} ${p.name} - ${p.modeName}`);
      opt.value = p.id;
      if (p.id === fix.profileId) opt.selected = true;
      select.appendChild(opt);
    });
    profileCell.appendChild(select);
    tr.appendChild(profileCell);

    const uniCell = el('td');
    const uniInput = el('input', hasConflict ? 'addr-conflict' : null);
    uniInput.type = 'number';
    uniInput.value = fix.universe ?? 0;
    uniInput.min = '0';
    uniInput.max = '32767';
    uniInput.dataset.field = 'universe';
    uniInput.dataset.id = fix.id;
    uniInput.style.width = '70px';
    uniCell.appendChild(uniInput);
    tr.appendChild(uniCell);

    const addrCell = el('td');
    const addrInput = el('input', hasConflict ? 'addr-conflict' : null);
    addrInput.type = 'number';
    addrInput.value = fix.address;
    addrInput.min = '1';
    addrInput.max = '512';
    addrInput.dataset.field = 'address';
    addrInput.dataset.id = fix.id;
    addrInput.style.width = '70px';
    addrCell.appendChild(addrInput);
    addrCell.appendChild(el('span', 'addr-range', `${fix.address}–${endAddr}`));
    if (hasConflict) addrCell.appendChild(el('span', 'conflict-warning', 'Address overlap!'));
    tr.appendChild(addrCell);

    tr.appendChild(el('td', 'ch-count', chCount));

    const removeCell = el('td');
    const removeBtn = el('button', 'remove-btn', '×');
    removeBtn.dataset.id = fix.id;
    removeBtn.title = 'Remove fixture';
    removeCell.appendChild(removeBtn);
    tr.appendChild(removeCell);

    tbody.appendChild(tr);
  });

  // Bind change handlers
  tbody.querySelectorAll('input, select').forEach(el => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'change';
    el.addEventListener(evt, () => {
      const id = parseInt(el.dataset.id);
      const field = el.dataset.field;
      let value = el.value;
      if (field === 'address') value = parseInt(value) || 1;
      if (field === 'universe') {
        const parsed = parseInt(value, 10);
        value = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
      }

      socket.emit('fixture', { id, [field]: value });
    });
  });

  // Remove fixture handlers
  tbody.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      await fetch(`/api/fixtures/${id}`, { method: 'DELETE' });
    });
  });
}

// Two fixtures only fight over an address when they are on the same universe —
// channel 1 of universe 0 and channel 1 of universe 1 are different wires.
function detectConflicts(fixtures) {
  const conflicts = new Set();
  for (let i = 0; i < fixtures.length; i++) {
    const a = fixtures[i];
    const pa = profiles[a.profileId] || {};
    const aEnd = a.address + (pa.channelCount || 12) - 1;

    for (let j = i + 1; j < fixtures.length; j++) {
      const b = fixtures[j];
      if ((a.universe ?? 0) !== (b.universe ?? 0)) continue;
      const pb = profiles[b.profileId] || {};
      const bEnd = b.address + (pb.channelCount || 12) - 1;

      if (a.address <= bEnd && b.address <= aEnd) {
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
  }
  return conflicts;
}

// ── Add fixture ──────────────────────────────────────────────────────────────

document.getElementById('add-fixture').addEventListener('click', async () => {
  await apiJson('/api/fixtures', { method: 'POST' });
});

// ── Show save/load ───────────────────────────────────────────────────────────

document.getElementById('save-show').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/show');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lightshow-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    document.getElementById('show-status').textContent = 'Show saved!';
    document.getElementById('show-status').className = 'import-status success';
  } catch (err) {
    document.getElementById('show-status').textContent = 'Failed to save';
    document.getElementById('show-status').className = 'import-status error';
  }
});

document.getElementById('load-show-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('show-status');
  try {
    const text = await file.text();
    const showData = JSON.parse(text);

    const res = await fetch('/api/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(showData),
    });
    const data = await res.json();

    if (data.ok) {
      statusEl.textContent = 'Show loaded!';
      statusEl.className = 'import-status success';
    } else {
      statusEl.textContent = data.error || 'Failed to load';
      statusEl.className = 'import-status error';
    }
  } catch (err) {
    statusEl.textContent = 'Invalid show file';
    statusEl.className = 'import-status error';
  }

  e.target.value = '';
});

// ── Configuration sections ───────────────────────────────────────────────────
// Everything that used to live in .env. Rendered from this spec so each field
// gets the same layout, secret handling and restart badge without repeating
// markup fifteen times.
//
// type: 'text' | 'number' | 'toggle' | 'secret'
// A 'secret' is never sent to the browser: the server reports only whether one
// is set, and we send a new value only when the operator actually types one.

const SETTINGS_SPEC = [
  {
    id: 'sources',
    title: 'Playback Sources',
    desc: 'Which sources may drive the auto-show. Takes effect immediately.',
    fields: [
      { path: 'sources.prolink', label: 'PRO DJ LINK', type: 'toggle',
        help: 'Follow CDJs on the network for tempo and track changes.' },
      { path: 'sources.smtc', label: 'Now Playing', type: 'toggle',
        help: 'Read the Windows media session, so any player drives the show. Windows only.' },
    ],
  },
  {
    id: 'sacn',
    title: 'sACN (E1.31)',
    desc: 'What consoles and most modern nodes speak. Runs alongside Art-Net or instead of it '
      + '(turn Art-Net off above). Takes effect immediately.',
    fields: [
      { path: 'sacn.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'sacn.host', label: 'Node IP', type: 'text',
        help: 'Blank multicasts to each universe\'s own group (239.255.x.y), which is how sACN is '
          + 'normally deployed. Name a node to unicast to it instead.' },
      { path: 'sacn.priority', label: 'Priority', type: 'number', min: 0, max: 200,
        help: 'Higher wins when two sources drive the same universe. 100 is the E1.31 default.' },
      { path: 'sacn.sourceName', label: 'Source Name', type: 'text',
        help: 'What the receiving console lists this server as.' },
      { path: 'sacn.universeOffset', label: 'Universe Offset', type: 'number', min: -32767, max: 63999,
        help: 'Art-Net counts universes from 0 and sACN from 1, so +1 lines them up: a fixture on '
          + 'universe 0 goes out as sACN universe 1.' },
      { path: 'sacn.cid', label: 'Component ID', type: 'text',
        help: 'How a receiver tells sources apart. Generated on first start and stable from then on '
          + '— change it only if two servers on the network ended up sharing one.' },
    ],
  },
  {
    id: 'spotify',
    title: 'Spotify',
    desc: 'Credentials from your Spotify app dashboard. Register the redirect URI shown in the server log.',
    fields: [
      { path: 'spotify.clientId', label: 'Client ID', type: 'text' },
      { path: 'spotify.clientSecret', label: 'Client Secret', type: 'secret' },
      { path: 'spotify.proxyBase', label: 'OAuth Proxy', type: 'text',
        help: 'Relays the Spotify callback back to this machine.' },
      { path: 'spotify.allowUnverifiedState', label: 'Allow Unverified State', type: 'toggle',
        help: 'Only if your proxy strips the state parameter. Disables OAuth CSRF protection.' },
    ],
  },
  {
    id: 'deezer',
    title: 'Deezer',
    desc: 'An ARL cookie enables exact ISRC-matched audio. Without one, analysis falls back to a yt-dlp search.',
    fields: [
      { path: 'deezer.arl', label: 'ARL Cookie', type: 'secret' },
    ],
  },
  {
    id: 'analysis',
    title: 'Analysis',
    desc: 'Limits on the analyzer and the track downloader.',
    fields: [
      { path: 'analysis.analyzerTimeoutMs', label: 'Analysis Timeout', type: 'number',
        unit: 'ms', min: 60000, max: 3600000,
        help: 'How long one track may analyse before the worker is considered wedged and recycled.' },
      { path: 'analysis.downloadTimeoutMs', label: 'Download Timeout', type: 'number',
        unit: 'ms', min: 10000, max: 3600000,
        help: 'How long yt-dlp may run before it is killed.' },
      { path: 'analysis.localRoot', label: 'Library Folder', type: 'text',
        help: 'Confine "analyze a local file" to this folder. Blank allows any path.' },
      { path: 'analysis.pythonPath', label: 'Python', type: 'text',
        help: 'Blank auto-detects, preferring an interpreter that can import the analyzer\'s '
          + 'dependencies. Set a full path when pip installed into a different Python than the '
          + 'one that gets picked.',
        note: pythonNote },
    ],
  },
];

const SERVER_SPEC = {
  id: 'server',
  title: 'Server & Access',
  desc: 'Read before the server starts listening, so these apply on the next restart.',
  fields: [
    { path: 'server.host', label: 'Bind Address', type: 'text',
      help: '127.0.0.1 keeps the rig on this machine. 0.0.0.0 exposes it to the network — which requires an access token.' },
    { path: 'server.port', label: 'Port', type: 'number', min: 1, max: 65535 },
    { path: 'server.token', label: 'Access Token', type: 'secret', generate: true,
      help: 'Required whenever the bind address is not loopback. Open the UI once at /?token=… to store it in the browser.' },
    { path: 'server.publicUrl', label: 'Public URL', type: 'text',
      help: 'Only needed behind a reverse proxy, or when the OAuth callback must use a hostname.' },
  ],
};

let settingsData = null;   // { settings, secrets, restartKeys, pendingRestart, running, python }

/**
 * What the server actually resolved, rather than what the box says. "I ran pip
 * install" and "the analyzer can import librosa" are different claims, and on a
 * machine with several Pythons they are routinely about different interpreters.
 */
function pythonNote(data) {
  const py = data && data.python;
  if (!py) return null;
  if (!py.ok) return { ok: false, text: `Currently: ${py.exe} — cannot be run.` };
  const where = py.executable || py.exe;
  if (py.missing && py.missing.length) {
    return { ok: false, text: `Currently: ${where} (${py.version}) — missing ${py.missing.join(', ')}. `
      + `Install with: "${where}" -m pip install -r requirements.txt` };
  }
  return { ok: true, text: `Currently: ${where} (${py.version}) — all dependencies present.` };
}

const at = (obj, dotted) => dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);

function fieldInput(field) {
  const isSet = !!(settingsData.secrets && settingsData.secrets[field.path]);
  const value = at(settingsData.settings, field.path);

  if (field.type === 'toggle') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.id = `set-${field.path}`;
    return input;
  }

  const input = document.createElement('input');
  input.id = `set-${field.path}`;
  if (field.type === 'secret') {
    input.type = 'password';
    input.value = '';
    input.placeholder = isSet ? '•••••••• (leave blank to keep)' : 'not set';
    input.autocomplete = 'new-password';
  } else if (field.type === 'number') {
    input.type = 'number';
    input.value = value;
    if (field.min != null) input.min = field.min;
    if (field.max != null) input.max = field.max;
  } else {
    input.type = 'text';
    input.value = value || '';
  }
  return input;
}

function renderSection(spec, host) {
  const section = el('section', 'card settings-section');
  section.dataset.section = spec.id;
  section.appendChild(el('div', 'card-title', spec.title));
  if (spec.desc) section.appendChild(el('p', 'section-desc', spec.desc));

  const form = el('div', 'settings-form');

  for (const field of spec.fields) {
    const row = el('div', 'field setting-field');

    const label = el('label', null, field.label);
    label.setAttribute('for', `set-${field.path}`);
    row.appendChild(label);

    const control = el('div', 'setting-control');
    control.appendChild(fieldInput(field));

    if (field.unit) control.appendChild(el('span', 'setting-unit', field.unit));

    // A secret already stored can be wiped without knowing its value.
    if (field.type === 'secret') {
      const clear = el('button', 'btn btn-small', 'Clear');
      clear.type = 'button';
      clear.disabled = !(settingsData.secrets && settingsData.secrets[field.path]);
      clear.addEventListener('click', () => saveSettings(spec, { [field.path]: '' }));
      control.appendChild(clear);
    }
    if (field.generate) {
      const gen = el('button', 'btn btn-small', 'Generate');
      gen.type = 'button';
      gen.addEventListener('click', () => generateToken(field));
      control.appendChild(gen);
    }
    row.appendChild(control);

    if ((settingsData.restartKeys || []).includes(field.path)) {
      const badge = el('span', 'setting-badge', 'restart');
      if ((settingsData.pendingRestart || []).includes(field.path)) {
        badge.textContent = 'restart to apply';
        badge.classList.add('pending');
      }
      row.appendChild(badge);
    }

    form.appendChild(row);
    if (field.help) form.appendChild(el('p', 'setting-help', field.help));
    if (field.note) {
      const note = field.note(settingsData);
      if (note) form.appendChild(el('p', `setting-help setting-note${note.ok ? '' : ' warn'}`, note.text));
    }
  }

  const actions = el('div', 'setting-actions');
  const save = el('button', 'btn active', 'Apply');
  save.type = 'button';
  save.addEventListener('click', () => saveSettings(spec));
  actions.appendChild(save);
  actions.appendChild(el('span', 'import-status', ''));
  form.appendChild(actions);

  section.appendChild(form);
  host.appendChild(section);
}

/**
 * The status line of one section. Looked up by id every time rather than held
 * as a reference: a save re-renders the sections, so any node captured before
 * it is detached from the document.
 */
function sectionStatus(spec) {
  return document.querySelector(`[data-section="${spec.id}"] .import-status`);
}

/**
 * Collect a section's fields and PUT them. `overrides` lets a single control
 * (the Clear button) send one explicit value without disturbing the rest.
 */
async function saveSettings(spec, overrides = {}) {
  const patch = {};
  for (const field of spec.fields) {
    const [group, key] = field.path.split('.');
    let value;

    if (Object.prototype.hasOwnProperty.call(overrides, field.path)) {
      value = overrides[field.path];
    } else {
      const input = document.getElementById(`set-${field.path}`);
      if (!input) continue;
      if (field.type === 'toggle') value = input.checked;
      else if (field.type === 'number') value = Number(input.value);
      else if (field.type === 'secret') {
        // Blank means "leave it alone" — the real value was never sent here, so
        // submitting the empty box would otherwise wipe it on every save.
        if (!input.value) continue;
        value = input.value;
      } else value = input.value;
    }

    patch[group] = patch[group] || {};
    patch[group][key] = value;
  }

  const status = sectionStatus(spec);
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Save failed');

    settingsData = { ...settingsData, ...data };
    renderSettings();

    const after = sectionStatus(spec);
    if (after) {
      const restarts = (data.pendingRestart || []).filter((k) => spec.fields.some((f) => f.path === k));
      after.textContent = restarts.length ? 'Saved — restart to apply' : 'Saved';
      after.className = 'import-status success';
    }
  } catch (err) {
    if (status) {
      status.textContent = err.message;
      status.className = 'import-status error';
    }
  }
}

async function generateToken(field) {
  try {
    const res = await fetch('/api/settings/token/suggest', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) return;
    const input = document.getElementById(`set-${field.path}`);
    if (!input) return;
    // Show it in the clear: it has to be copied into Companion and the
    // extension. It is not stored until Apply is pressed.
    input.type = 'text';
    input.value = data.token;
  } catch (_) { /* leave the field alone */ }
}

function renderSettings() {
  if (!settingsData) return;
  const groups = document.getElementById('settings-groups');
  const serverGroup = document.getElementById('settings-server-group');
  groups.textContent = '';
  serverGroup.textContent = '';
  for (const spec of SETTINGS_SPEC) renderSection(spec, groups);
  renderSection(SERVER_SPEC, serverGroup);
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (!data.ok) return;
    settingsData = data;
    renderSettings();
  } catch (_) { /* page still works without the config sections */ }
}

// ── Pre-show check ───────────────────────────────────────────────────────────
// The same checks `npm run preflight` runs, but against the live subsystems, so
// MIDI and the playback sources report what is connected rather than what is
// merely configured.

const PREFLIGHT_GLYPH = { ok: '\u2713', warn: '!', fail: '\u2715', info: '\u00b7' };

function renderPreflight(report) {
  const host = document.getElementById('preflight-results');
  host.textContent = '';

  const summary = el('div', `preflight-summary ${report.ok ? (report.counts.warn ? 'warn' : 'ok') : 'fail'}`);
  summary.textContent = report.ok
    ? (report.counts.warn
      ? `Ready, with warnings — ${report.counts.ok} passed, ${report.counts.warn} to look at.`
      : `Ready. ${report.counts.ok} checks passed.`)
    : `Not ready — ${report.counts.fail} problem${report.counts.fail === 1 ? '' : 's'} to fix.`;
  host.appendChild(summary);

  for (const check of report.checks) {
    const row = el('div', `preflight-row ${check.status}`);
    row.appendChild(el('span', 'preflight-mark', PREFLIGHT_GLYPH[check.status] || '?'));

    const body = el('div', 'preflight-body');
    body.appendChild(el('div', 'preflight-label', check.label));
    body.appendChild(el('div', 'preflight-detail', check.detail));
    if (check.fix && check.status !== 'ok' && check.status !== 'info') {
      body.appendChild(el('div', 'preflight-fix', check.fix));
    }
    row.appendChild(body);
    host.appendChild(row);
  }
}

document.getElementById('preflight-run').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const host = document.getElementById('preflight-results');
  button.disabled = true;
  host.textContent = '';
  // The Art-Net poll waits a second and a half for replies, and the external
  // tool probes each spawn a process — say something rather than looking hung.
  host.appendChild(el('div', 'preflight-summary', 'Checking\u2026'));
  try {
    const res = await apiJson('/api/preflight');
    if (res.ok) renderPreflight(res.report);
    else host.textContent = res.error || 'Preflight failed';
  } catch (err) {
    host.textContent = `Preflight failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

loadSettings();
loadMidiMap();
