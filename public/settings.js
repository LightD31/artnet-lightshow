'use strict';

// Token comes from public/auth.js, which runs before this file.
const auth = window.LightshowAuth || {
  token: '', connected: () => {}, requireToken: () => {}, onToken: () => {},
};
const socket = io({ auth: { token: auth.token || '' } });

let state = {};
let profiles = {};
let pendingGdtf = null; // an imported fixture (GDTF or OFL) until its mode is picked

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
  auth.connected();                       // clears the token prompt, if it was up
});

socket.on('disconnect', () => {
  document.getElementById('status-dot').classList.remove('connected');
});

// `socket.active` is false only when a middleware rejected the handshake, which
// on this server means the token. Socket.IO does not retry those, so without
// this the page sat on a grey dot forever — on the one page whose whole job is
// to fix configuration like this.
socket.on('connect_error', () => {
  document.getElementById('status-dot').classList.remove('connected');
  if (!socket.active) auth.requireToken();
});

// Retry with whatever the operator typed into that prompt, then load the
// settings the 401s dropped on the way in.
auth.onToken((token) => {
  socket.auth = { token };
  socket.connect();
  loadSettings();
  loadMidiMap();
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

const ARTNET_FIELDS = ['artnet-enabled', 'artnet-host', 'artnet-port', 'artnet-universe', 'artnet-discovery', 'artnet-sync'];

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
  const d = document.getElementById('artnet-discovery');
  const y = document.getElementById('artnet-sync');
  if (!d.dataset.dirty) d.checked = s.artnet.discovery !== false;
  if (!y.dataset.dirty) y.checked = !!s.artnet.sync;
}

document.getElementById('artnet-save').addEventListener('click', () => {
  socket.emit('set', {
    artnet: {
      enabled: document.getElementById('artnet-enabled').checked,
      host: document.getElementById('artnet-host').value,
      port: parseInt(document.getElementById('artnet-port').value),
      universe: parseInt(document.getElementById('artnet-universe').value),
      discovery: document.getElementById('artnet-discovery').checked,
      sync: document.getElementById('artnet-sync').checked,
    }
  });
  ARTNET_FIELDS.forEach(id => {
    delete document.getElementById(id).dataset.dirty;
  });
  // The node list depends on the target: a broadcast is routed, one node is not.
  setTimeout(() => loadArtnetNodes(false), 500);
});

// ── Art-Net nodes ───────────────────────────────────────────────────────────
// Who answered a poll, and which universes each outputs. "Send to this node"
// puts its address in the Node IP field, for a rig that should talk to one
// node and nothing else.

async function loadArtnetNodes(scan) {
  const status = document.getElementById('artnet-nodes-status');
  const box = document.getElementById('artnet-nodes');
  if (!status || !box) return;
  if (scan) status.textContent = 'Asking the network…';
  let data;
  try {
    const res = await fetch(`/api/artnet/nodes${scan ? '?scan=1' : ''}`);
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'request failed');
  } catch (err) {
    status.textContent = `Could not ask: ${err.message}`;
    return;
  }
  const nodes = data.nodes || [];
  status.textContent = nodes.length
    ? `${nodes.length} node${nodes.length === 1 ? '' : 's'} answered`
      + (data.routing ? ' — each is sent its universes directly.' : '.')
    : (data.error
      ? `No answer — ${data.error}`
      : (data.routing || scan
        ? 'No node has answered. Many never reply to polls; if the rig is dark, check the Node IP and the subnet.'
        : 'Press Find Nodes Now to ask the network.'));
  box.replaceChildren();
  if (!nodes.length) return;

  const table = el('table', 'patch-table');
  const head = el('tr');
  for (const h of ['Node', 'Address', 'Universes', '']) head.appendChild(el('th', null, h));
  table.appendChild(head);
  for (const node of nodes) {
    const tr = el('tr');
    tr.appendChild(el('td', null, node.shortName || node.longName || 'unnamed'));
    tr.appendChild(el('td', null, node.address));
    tr.appendChild(el('td', null, node.outputs && node.outputs.length ? node.outputs.join(', ') : '—'));
    const cell = el('td');
    const use = el('button', 'btn btn-small', 'Send to this node');
    use.type = 'button';
    use.title = 'Put this address in Node IP; press Apply to use it';
    use.addEventListener('click', () => {
      const host = document.getElementById('artnet-host');
      host.value = node.address;
      host.dataset.dirty = 'true';
      host.focus();
    });
    cell.appendChild(use);
    tr.appendChild(cell);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

document.getElementById('artnet-scan').addEventListener('click', () => loadArtnetNodes(true));
loadArtnetNodes(false);

// ── WLED ────────────────────────────────────────────────────────────────────
// The WLEDs that answered mDNS, and adding one: the server asks it what it is,
// builds its profile and patches it on universes of its own, sent DDP.

async function findWled() {
  const status = document.getElementById('wled-status');
  const box = document.getElementById('wled-devices');
  status.textContent = 'Asking the network…';
  box.replaceChildren();
  const data = await apiJson('/api/wled/discover');
  if (!data.ok) { status.textContent = data.error; return; }
  const devices = data.devices || [];
  status.textContent = devices.length
    ? `${devices.length} WLED${devices.length === 1 ? '' : 's'} answered`
    : 'No WLED answered. mDNS does not cross routers or VLANs: add one by its address below.';
  if (!devices.length) return;
  const table = el('table', 'patch-table');
  const head = el('tr');
  for (const h of ['WLED', 'Address', 'LEDs', '']) head.appendChild(el('th', null, h));
  table.appendChild(head);
  for (const device of devices) {
    const tr = el('tr');
    tr.appendChild(el('td', null, device.name));
    tr.appendChild(el('td', null, device.host));
    const leds = device.error ? device.error
      : `${device.leds}${device.rgbw ? ' RGBW' : ' RGB'}${device.matrix ? `, ${device.matrix.w} × ${device.matrix.h}` : ''}`;
    tr.appendChild(el('td', null, leds));
    const cell = el('td');
    if (device.patched) cell.appendChild(el('span', 'setting-help', `Patched as "${device.patched}"`));
    else if (!device.error) {
      const add = el('button', 'btn btn-small', 'Add to patch');
      add.type = 'button';
      add.addEventListener('click', () => addWled(device.host, cell));
      cell.appendChild(add);
    }
    tr.appendChild(cell);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

/** Add a WLED; `cell`, from the list of those found, then says it is patched. */
async function addWled(host, cell) {
  const status = document.getElementById('wled-status');
  status.textContent = `Asking ${host}…`;
  const data = await apiJson('/api/wled/add', jsonBody('POST', { host }));
  if (!data.ok) { status.textContent = data.error; return; }
  const where = data.fixture.universe;
  status.textContent = `Added "${data.fixture.label}": ${data.profile.modeName}, from universe ${where}.`;
  if (cell) cell.replaceChildren(el('span', 'setting-help', `Patched as "${data.fixture.label}"`));
  Toast.push({ message: `Added ${data.fixture.label} to the patch` });
}

document.getElementById('wled-scan').addEventListener('click', findWled);
document.getElementById('wled-add').addEventListener('click', () => {
  const host = document.getElementById('wled-host').value.trim();
  if (host) addWled(host);
});
document.getElementById('wled-host').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('wled-add').click();
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

// Motorised faders and encoder rings. Applied on its own so toggling it does
// not drop and reopen the port the way changing a port does.
document.getElementById('midi-control-feedback').addEventListener('change', async (e) => {
  const controlFeedback = e.target.checked;
  const res = await apiJson('/api/settings', jsonBody('PUT', { midi: { controlFeedback } }));
  if (!res.ok) e.target.checked = !controlFeedback;   // put the box back
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
    case 'palette':
      return (state.palettes || []).map(p => ({ value: p.id, label: p.name }));
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
    clear.addEventListener('click', async () => {
      const before = row.binding;
      const res = await putBinding(row.kind, row.number, null);
      if (!res.ok) return;
      Toast.push({
        message: `Unbound ${controlLabel(row.kind, row.number, before)}`,
        action: { label: 'Undo', onClick: () => putBinding(row.kind, row.number, before) },
      });
    });
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
  return res;
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
  // Reset throws away a mapping that may have taken a while to build one
  // control at a time. The map we are about to replace is right here, and
  // PUT /api/midi/map takes a whole one, so undo costs nothing.
  const before = midiMapData && midiMapData.map;
  const res = await apiJson('/api/midi/map/reset', { method: 'POST' });
  if (!res.ok) return;
  midiMapData = { ...midiMapData, map: res.map, customised: res.customised };
  renderMidiMap();
  if (!before) return;
  Toast.push({
    message: 'Reset to the built-in X-Touch mapping',
    action: {
      label: 'Undo',
      onClick: async () => {
        const restored = await apiJson('/api/midi/map', jsonBody('PUT', before));
        if (!restored.ok) return;
        midiMapData = { ...midiMapData, map: restored.map, customised: restored.customised };
        renderMidiMap();
      },
    },
  });
});

// ── Fixture import: GDTF, OFL files, the Open Fixture Library ───────────────
// Every way in answers with the same { name, manufacturer, modes } fixture, so
// they all end in the same mode picker.

/** Run one import (`load` resolves to the server's response) and open its mode picker. */
async function importFixture(pending, load) {
  const statusEl = document.getElementById('gdtf-status');
  statusEl.textContent = pending;
  statusEl.className = 'import-status';
  let data;
  try {
    data = await (await load()).json();
  } catch (err) {
    data = { ok: false, error: 'Could not reach the server' };
  }
  if (!data.ok) {
    statusEl.textContent = data.error || 'Import failed';
    statusEl.className = 'import-status error';
    return;
  }
  statusEl.textContent = `Read: ${data.fixture.name} by ${data.fixture.manufacturer}`;
  statusEl.className = 'import-status success';
  pendingGdtf = data.fixture;
  showModeSelector(data.fixture);
}

/** An <input type=file> whose file is posted to `url` as `field`. */
function fileImport(inputId, url, field) {
  document.getElementById(inputId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append(field, file);
    await importFixture('Reading…', () => fetch(url, { method: 'POST', body: formData }));
    e.target.value = '';
  });
}

fileImport('gdtf-file', '/api/gdtf/parse', 'gdtf');
fileImport('ofl-file', '/api/ofl/parse', 'ofl');

document.getElementById('ofl-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = document.getElementById('ofl-query').value.trim();
  const box = document.getElementById('ofl-results');
  box.hidden = false;
  if (query.length < 2) {
    box.replaceChildren(el('div', 'ofl-note', 'Type at least two letters'));
    return;
  }
  box.replaceChildren(el('div', 'ofl-note', 'Searching…'));
  let data;
  try {
    data = await (await fetch(`/api/ofl/search?q=${encodeURIComponent(query)}`)).json();
  } catch (err) {
    data = { ok: false, error: 'Could not reach the server' };
  }
  box.replaceChildren();
  if (!data.ok) {
    box.appendChild(el('div', 'ofl-note error', data.error || 'The search failed'));
    return;
  }
  if (!data.results.length) {
    box.appendChild(el('div', 'ofl-note', `Nothing in the Open Fixture Library matches "${query}"`));
    return;
  }
  data.results.forEach((hit) => {
    const row = el('button', 'ofl-hit');
    row.type = 'button';
    row.appendChild(el('span', 'ofl-hit-name', hit.name));
    row.appendChild(el('span', 'ofl-hit-maker', [hit.manufacturer, ...hit.categories].join(' · ')));
    row.addEventListener('click', () => importFixture(`Fetching ${hit.name}…`, () =>
      fetch(`/api/ofl/fixture/${encodeURIComponent(hit.manufacturerKey)}/${encodeURIComponent(hit.fixtureKey)}`)));
    box.appendChild(row);
  });
});

function showModeSelector(fixture) {
  const container = document.getElementById('gdtf-mode-select');
  container.style.display = '';

  document.getElementById('gdtf-fixture-name').textContent = fixture.name;
  // An OFL file does not say who makes the fixture, so the maker can be typed in.
  document.getElementById('gdtf-manufacturer').value = fixture.manufacturer === 'Unknown' ? '' : fixture.manufacturer;
  document.getElementById('gdtf-manufacturer').placeholder = 'Who makes it';

  const modeSelect = document.getElementById('gdtf-mode');
  modeSelect.innerHTML = '';
  fixture.modes.forEach((mode, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${mode.modeName} (${mode.channelCount}ch${mode.cells ? `, ${mode.cells.length} cells` : ''})`;
    modeSelect.appendChild(opt);
  });

  renderChannelPreview(fixture.modes[0], 'gdtf-channel-preview', fixture.warnings);

  // Assigned rather than added, so a second import does not leave the first's handler behind.
  modeSelect.onchange = () => {
    renderChannelPreview(fixture.modes[parseInt(modeSelect.value)], 'gdtf-channel-preview', fixture.warnings);
  };
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

// The attributes the show writes. A channel is highlighted in the preview only
// when one of these maps it: a profile can name its gobo, but nothing moves it.
const DRIVEN_ATTRIBUTES = new Set(['dimmer', 'dimmerFine', 'strobe', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coolWhite']);

function drivenOffsets(mode) {
  const driven = new Set();
  const add = (map) => Object.entries(map || {}).forEach(([attr, offset]) => {
    if (DRIVEN_ATTRIBUTES.has(attr)) driven.add(offset);
  });
  add(mode.channelMap);
  (mode.cells || []).forEach((cell) => add(cell.channelMap));
  return driven;
}

function renderChannelPreview(mode, containerId = 'gdtf-channel-preview', fixtureWarnings = []) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const driven = drivenOffsets(mode);
  const held = new Map((mode.defaults || []).map((d) => [d.offset, d.value]));
  // What the mode is before its channels, and anything the import had to
  // leave out or hold says so.
  const drives = `${driven.size} of ${mode.channelCount} channels driven by the show (highlighted)`;
  const panel = mode.grid ? ` in a ${mode.grid.columns} × ${mode.grid.rows} grid` : '';
  container.appendChild(el('div', 'ch-summary', mode.cells ? `${mode.cells.length} cells${panel}, each driven on its own · ${drives}` : drives));
  [...fixtureWarnings, ...(mode.warnings || [])].forEach((warning) => container.appendChild(el('div', 'ch-warning', warning)));
  mode.channelList.forEach(ch => {
    const tag = el('span', 'ch-tag' + (driven.has(ch.offset) ? ' mapped' : ''));
    tag.appendChild(el('span', 'ch-num', ch.offset + 1));
    tag.appendChild(el('span', 'ch-name', ch.name));
    if (held.has(ch.offset)) {
      tag.appendChild(el('span', 'ch-held', `=${held.get(ch.offset)}`));
      tag.title = `The show does not drive this channel; it is held at ${held.get(ch.offset)}`;
    }
    container.appendChild(tag);
  });
}

document.getElementById('gdtf-confirm').addEventListener('click', async () => {
  if (!pendingGdtf) return;

  const modeIdx = parseInt(document.getElementById('gdtf-mode').value);
  const mode = pendingGdtf.modes[modeIdx];
  const manufacturer = document.getElementById('gdtf-manufacturer').value.trim() || pendingGdtf.manufacturer;

  const profileId = slugify(`${manufacturer}-${pendingGdtf.name}-${mode.modeName}`);

  const profile = {
    id: profileId,
    name: pendingGdtf.name,
    manufacturer,
    modeName: mode.modeName,
    channelCount: mode.channelCount,
    channelMap: mode.channelMap,
    channelList: mode.channelList.map(({ offset, name, attribute, cell }) => ({
      offset, name, attribute, ...(cell !== undefined ? { cell } : {}),
    })),
    // An LED bar's cells, each with its own channels. Re-importing a bar that
    // was imported before cells existed replaces it, and every fixture on it
    // becomes a bar of lights on the next frame.
    ...(mode.cells ? { cells: mode.cells } : {}),
    // A panel: its cells in rows and columns.
    ...(mode.grid ? { grid: mode.grid } : {}),
    // Channels the show does not drive and must not leave at 0 (an OFL
    // shutter that is closed at 0, a dimmer the show leaves at full).
    ...(mode.defaults ? { defaults: mode.defaults } : {}),
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

// ── LED bar maker ────────────────────────────────────────────────────────────
// A profile for a bar with no GDTF file, from its cell count and channel order
// (src/server/bar-profile.js). The server builds it, so the preview here and
// the profile that is added are the same thing.

function barSpec() {
  const num = (id) => {
    const raw = document.getElementById(id).value.trim();
    return raw === '' ? undefined : Number(raw);
  };
  const name = document.getElementById('bar-name').value.trim() || 'LED Bar';
  const cells = num('bar-cells');
  const order = document.getElementById('bar-order').value.trim().toUpperCase();
  return {
    id: slugify(`custom-${name}-${cells}-${order}`),
    name,
    cells,
    firstChannel: num('bar-first'),
    order,
    stride: num('bar-stride'),
    dimmer: num('bar-dimmer'),
    strobe: num('bar-strobe'),
  };
}

let barPreviewTimer = null;
async function previewBar() {
  const status = document.getElementById('bar-status');
  const res = await fetch('/api/profiles/bar?dryRun=1', jsonBody('POST', barSpec()));
  const data = await res.json().catch(() => ({ ok: false, error: 'No answer from the server' }));
  const preview = document.getElementById('bar-preview');
  if (!data.ok) {
    preview.innerHTML = '';
    status.textContent = data.error;
    status.className = 'import-status error';
    return;
  }
  status.textContent = `${data.profile.channelCount} channels`;
  status.className = 'import-status';
  renderChannelPreview(data.profile, 'bar-preview');
}

document.getElementById('bar-maker').addEventListener('input', () => {
  clearTimeout(barPreviewTimer);
  barPreviewTimer = setTimeout(previewBar, 250);
});
document.getElementById('bar-maker').addEventListener('toggle', (e) => {
  if (e.target.open) previewBar();
});

document.getElementById('bar-add').addEventListener('click', async () => {
  const status = document.getElementById('bar-status');
  const data = await apiJson('/api/profiles/bar', jsonBody('POST', barSpec()));
  if (data.ok) {
    status.textContent = `Profile "${data.profile.name}" added — pick it for a fixture in the patch below.`;
    status.className = 'import-status success';
  } else {
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
    // From the server's catalogues rather than a hardcoded id, so a profile that
    // ships with the server never offers a Remove button that would be refused.
    const isBuiltin = (state.builtinProfileIds || []).includes(p.id);
    card.className = 'profile-card' + (isBuiltin ? ' builtin' : '');

    const mappedChannels = Object.keys(p.channelMap || {}).join(', ');
    card.appendChild(el('span', 'profile-name', p.name));
    card.appendChild(el('span', 'profile-manufacturer', p.manufacturer));
    const cells = Array.isArray(p.cells) && p.cells.length >= 2 ? `, ${p.cells.length} cells` : '';
    card.appendChild(el('span', 'profile-mode', `${p.modeName} — ${p.channelCount}ch${cells}`));
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

  // Remove profile handlers. A GDTF import is a file the operator had to go
  // and find, so losing one to a stray click is worse than it looks — and the
  // whole profile is already here in `profiles`, so undo is just re-posting it.
  container.querySelectorAll('.remove-profile-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const profile = profiles[id];
      const res = await apiJson(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok || !profile) return;
      Toast.push({
        message: `Removed "${profile.name}"`,
        action: {
          label: 'Undo',
          onClick: () => apiJson('/api/profiles', jsonBody('POST', profile)),
        },
      });
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
    const parts = footprint(fix, profile);
    const last = parts[parts.length - 1];
    // A strip longer than a universe says where it ends: "1–150 on 3" after 2.
    const range = parts.length > 1 ? `${fix.address}–${last.last} on ${last.universe}` : `${fix.address}–${last.last}`;
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
    // A WLED's universes go to it over DDP: its address, editable, and
    // emptied to send the fixture on Art-Net and sACN instead.
    if (fix.output && fix.output.protocol === 'ddp') {
      const hostInput = el('input', 'wled-host');
      hostInput.type = 'text';
      hostInput.value = fix.output.host;
      hostInput.title = 'Sent to this WLED over DDP. Empty it to send on Art-Net and sACN instead.';
      hostInput.dataset.field = 'outputHost';
      hostInput.dataset.id = fix.id;
      uniCell.appendChild(el('span', 'addr-range', 'WLED'));
      uniCell.appendChild(hostInput);
    }
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
    addrCell.appendChild(el('span', 'addr-range', range));
    if (hasConflict) addrCell.appendChild(el('span', 'conflict-warning', 'Address overlap!'));
    tr.appendChild(addrCell);

    const cellCount = Array.isArray(profile.cells) && profile.cells.length >= 2 ? profile.cells.length : 0;
    tr.appendChild(el('td', 'ch-count', cellCount ? `${chCount} (${cellCount} cells)` : chCount));

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

      if (!socket.connected) { Toast.error('Disconnected — reconnect before editing the patch.'); return; }
      if (field === 'outputHost') {
        const host = String(value).trim();
        socket.emit('fixture', { id, output: host ? { protocol: 'ddp', host } : null });
        return;
      }
      socket.emit('fixture', { id, [field]: value });
    });
  });

  // Remove fixture handlers
  // Removing a fixture takes its address, universe and any override with it,
  // and the button is a bare × in a dense table. The server answers with what
  // it removed and from where, so undo puts it back in the same row.
  tbody.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const res = await apiJson(`/api/fixtures/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      Toast.push({
        message: `Removed "${res.fixture.label}"`,
        action: {
          label: 'Undo',
          onClick: () => apiJson('/api/fixtures/restore',
            jsonBody('POST', { index: res.index, fixture: res.fixture })),
        },
      });
    });
  });
}

/**
 * The channels a fixture occupies, per universe: one run from its address, or —
 * for a strip longer than a universe — whole cells to each universe it runs on
 * into, from channel 1. The same rule as src/shared/placement.ts, which this
 * page (a plain script) cannot import.
 */
function footprint(fix, profile) {
  const count = profile.channelCount || 12;
  const universe = fix.universe ?? 0;
  const cells = Array.isArray(profile.cells) ? profile.cells.length : 0;
  if (count <= 512 || cells < 2) return [{ universe, first: fix.address, last: fix.address + count - 1 }];
  const width = count / cells;
  const perUniverse = Math.floor(512 / width);
  const parts = [];
  for (let k = 0; k * perUniverse < cells; k++) {
    parts.push({ universe: universe + k, first: 1, last: Math.min(perUniverse, cells - k * perUniverse) * width });
  }
  return parts;
}

// Two fixtures only fight over an address when they are on the same universe —
// channel 1 of universe 0 and channel 1 of universe 1 are different wires.
function detectConflicts(fixtures) {
  const conflicts = new Set();
  const parts = fixtures.map((f) => footprint(f, profiles[f.profileId] || {}));
  for (let i = 0; i < fixtures.length; i++) {
    for (let j = i + 1; j < fixtures.length; j++) {
      const clash = parts[i].some((x) => parts[j].some((y) => x.universe === y.universe && x.first <= y.last && y.first <= x.last));
      if (clash) {
        conflicts.add(fixtures[i].id);
        conflicts.add(fixtures[j].id);
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

// ── Philips Hue ──────────────────────────────────────────────────────────────
// The one section whose configuration is not simply typed in: the bridge issues
// its own credentials when you press its link button, and the list of
// entertainment areas only exists on the bridge. So the section renders a small
// workflow — find a bridge, pair, pick an area, bind its channels to fixtures —
// on top of the ordinary fields.

let hueAreas = [];        // [{ id, name, channels: [{ id }] }]
let hueBridges = [];      // discovered, or empty
let networkInterfaces = [];   // this machine's IPv4 addresses, for the sACN network

async function loadNetworkInterfaces() {
  try {
    const res = await fetch('/api/network/interfaces');
    const data = await res.json();
    if (data.ok) {
      networkInterfaces = data.interfaces || [];
      if (typeof renderSettings === 'function' && settingsData) renderSettings();
    }
  } catch (_) { /* the select still offers the default */ }
}
loadNetworkInterfaces();
let liveDevices = { outputs: [], inputs: [] };   // audio devices the live input can hear

async function loadLiveDevices() {
  try {
    const res = await fetch('/api/live/devices');
    const data = await res.json();
    if (data.ok) {
      liveDevices = { outputs: data.outputs || [], inputs: data.inputs || [] };
      if (typeof renderSettings === 'function' && settingsData) renderSettings();
    }
  } catch (_) { /* the select still offers the default */ }
}
loadLiveDevices();

// The device list is outputs for loopback and inputs for an input: rebuild it
// when the choice changes, on the default until one is picked.
document.addEventListener('change', (e) => {
  if (!e.target || e.target.id !== 'set-live.source') return;
  const current = document.getElementById('set-live.device');
  const section = SETTINGS_SPEC.find((s) => s.id === 'live');
  const field = section && section.fields.find((f) => f.path === 'live.device');
  if (!current || !field) return;
  const fresh = fieldInput(field);
  fresh.value = '';
  current.replaceWith(fresh);
});
let hueInfo = null;       // { status, paired, host, entertainmentId, channels }
let hueNotice = null;     // transient line under the buttons

/** The area currently selected in the form, falling back to what is saved. */
function selectedHueArea() {
  const select = document.getElementById('set-hue.entertainmentId');
  const id = select ? select.value : at(settingsData.settings, 'hue.entertainmentId');
  return hueAreas.find((a) => a.id === id) || null;
}

/** Bindings read off the table, or the saved ones before it has been drawn. */
function hueBindings() {
  const rows = document.querySelectorAll('[data-hue-channel]');
  if (!rows.length) return at(settingsData.settings, 'hue.channels') || [];
  const out = [];
  for (const row of rows) {
    if (row.value === '') continue;         // "not used" — leave the lamp alone
    out.push({ channel: Number(row.dataset.hueChannel), fixture: Number(row.value) });
  }
  return out;
}

async function hueFetch(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
  if (!data.ok) throw new Error(data.error || 'request failed');
  return data;
}

async function loadHueStatus() {
  try {
    hueInfo = await hueFetch('/api/hue/status');
    // Areas are only readable once paired, and re-reading them keeps the
    // channel table honest when someone edits the area in the Hue app.
    if (hueInfo.paired) {
      const data = await hueFetch('/api/hue/areas');
      hueAreas = data.areas || [];
    }
  } catch (_) {
    // A bridge that is off must not stop the rest of the page rendering.
  }
  renderSettings();
}

async function discoverHueBridges() {
  hueNotice = { text: 'Looking for bridges…', ok: true };
  renderSettings();
  try {
    const data = await hueFetch('/api/hue/discover');
    hueBridges = data.bridges || [];
    hueNotice = hueBridges.length
      ? { text: `Found ${hueBridges.length} bridge${hueBridges.length === 1 ? '' : 's'}.`, ok: true }
      : {
        text: data.error
          ? `No bridges found — ${data.error}. Type the bridge IP in above.`
          : 'No bridges answered. Type the bridge IP in above.',
        ok: false,
      };
    if (hueBridges.length === 1) {
      const input = document.getElementById('set-hue.host');
      if (input && !input.value) input.value = hueBridges[0].host;
    }
  } catch (err) {
    hueNotice = { text: err.message, ok: false };
  }
  renderSettings();
}

async function pairHueBridge() {
  const input = document.getElementById('set-hue.host');
  const host = input ? input.value.trim() : '';
  if (!host) {
    hueNotice = { text: 'Enter the bridge address first, or press Find Bridges.', ok: false };
    renderSettings();
    return;
  }

  hueNotice = { text: 'Press the round button on the bridge now…', ok: true };
  renderSettings();

  try {
    const data = await hueFetch('/api/hue/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host }),
    });
    hueAreas = data.areas || [];
    hueNotice = {
      text: data.areasError
        ? `Paired, but the areas could not be read — ${data.areasError}`
        : `Paired with ${host}. Pick an entertainment area below.`,
      ok: !data.areasError,
    };
    await loadSettings();
    await loadHueStatus();
  } catch (err) {
    hueNotice = { text: err.message, ok: false };
    renderSettings();
  }
}

async function forgetHueBridge() {
  try {
    await hueFetch('/api/hue/disconnect', { method: 'POST' });
    hueAreas = [];
    hueBridges = [];
    hueNotice = { text: 'Bridge forgotten. Remove this integration in the Hue app under linked devices.', ok: true };
    await loadSettings();
    await loadHueStatus();
  } catch (err) {
    hueNotice = { text: err.message, ok: false };
    renderSettings();
  }
}

/** The pairing controls, the live status line, and the channel table. */
function renderHueExtra(form) {
  const paired = !!(hueInfo && hueInfo.paired);

  const row = el('div', 'field setting-field');
  row.appendChild(el('label', null, 'Bridge'));
  const controls = el('div', 'setting-control');

  const find = el('button', 'btn btn-small', 'Find Bridges');
  find.type = 'button';
  find.addEventListener('click', discoverHueBridges);
  controls.appendChild(find);

  const pairBtn = el('button', 'btn btn-small', paired ? 'Pair Again' : 'Pair');
  pairBtn.type = 'button';
  pairBtn.title = 'Press the round button on the bridge, then this';
  pairBtn.addEventListener('click', pairHueBridge);
  controls.appendChild(pairBtn);

  if (paired) {
    const forget = el('button', 'btn btn-small remove-btn', 'Forget');
    forget.type = 'button';
    forget.addEventListener('click', forgetHueBridge);
    controls.appendChild(forget);
  }
  row.appendChild(controls);
  form.appendChild(row);

  if (hueBridges.length) {
    const list = el('p', 'setting-help', `On this network: ${hueBridges.map((b) => b.host).join(', ')}`);
    form.appendChild(list);
  }
  if (hueNotice) {
    form.appendChild(el('p', `setting-help setting-note${hueNotice.ok ? '' : ' warn'}`, hueNotice.text));
  }

  // What the stream is actually doing, which is the question you have when the
  // lamps are dark but everything above looks right.
  if (hueInfo && hueInfo.status) {
    const live = hueInfo.status;
    const text = live.error
      ? `Stream: ${live.status} — ${live.error}`
      : `Stream: ${live.status}`;
    form.appendChild(el('p', `setting-help setting-note${live.status === 'failed' ? ' warn' : ''}`, text));
  }

  if (!paired) return;

  const syncRow = el('div', 'field setting-field');
  syncRow.appendChild(el('label', null, 'Sync Test'));
  const syncControls = el('div', 'setting-control');
  const syncBtn = el('button', 'btn btn-small', 'Flash for 10 s');
  syncBtn.type = 'button';
  syncBtn.title = 'Every fixture flashes white once a second, pars and Hue lamps together';
  syncBtn.addEventListener('click', async () => {
    try {
      await hueFetch('/api/hue/sync-test', { method: 'POST' });
      hueNotice = { text: 'Flashing once a second for 10 s. Save the delay first if you changed it.', ok: true };
    } catch (err) {
      hueNotice = { text: err.message, ok: false };
    }
    renderSettings();
  });
  syncControls.appendChild(syncBtn);
  syncRow.appendChild(syncControls);
  form.appendChild(syncRow);

  const area = selectedHueArea();
  if (!area) {
    form.appendChild(el('p', 'setting-help', 'Pick an entertainment area to bind its channels to fixtures.'));
    return;
  }

  form.appendChild(el('div', 'card-title', 'Channels'));
  form.appendChild(el('p', 'section-desc',
    'Each Hue channel shows the colour of the fixture it follows, after the dimmer, '
    + 'trim, master and blackout — so Hue lamps respond to every pattern and cue the '
    + 'pars do. Lamp names come from the Hue app. Leave a channel unused to let the '
    + 'bridge hold its own colour.'));

  const saved = new Map((at(settingsData.settings, 'hue.channels') || []).map((c) => [c.channel, c.fixture]));
  const fixtures = state.fixtures || [];

  const table = el('table', 'patch-table');
  const head = el('tr');
  head.appendChild(el('th', null, 'Hue channel'));
  head.appendChild(el('th', null, 'Lamp'));
  head.appendChild(el('th', null, 'Follows fixture'));
  table.appendChild(head);

  for (const channel of area.channels) {
    const tr = el('tr');
    tr.appendChild(el('td', null, `#${channel.id}`));
    // The name the lamp has in the Hue app. Binding by channel number alone
    // meant counting round the room to work out which lamp #3 was.
    tr.appendChild(el('td', null, channel.name || '—'));

    const cell = el('td');
    const select = document.createElement('select');
    select.dataset.hueChannel = String(channel.id);

    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'not used';
    select.appendChild(none);

    for (const fix of fixtures) {
      const option = document.createElement('option');
      option.value = String(fix.id);
      option.textContent = fix.label;
      select.appendChild(option);
    }
    const bound = saved.get(channel.id);
    select.value = bound === undefined ? '' : String(bound);

    cell.appendChild(select);
    tr.appendChild(cell);
    table.appendChild(tr);
  }
  form.appendChild(table);

  if (!fixtures.length) {
    form.appendChild(el('p', 'setting-help setting-note warn',
      'No fixtures are patched, so there is nothing for a Hue channel to follow. '
      + 'Patch the rig first — add fixtures for Hue-only lamps if they have no DMX equivalent.'));
  }
}

const SETTINGS_SPEC = [
  {
    id: 'sources',
    group: 'music',
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
    id: 'live',
    group: 'music',
    title: 'Live Input',
    desc: 'Hear the music as it plays. Patterns keep the beat of any track, known or not, and a '
      + 'show made for a known track lines itself up with what the room hears. Needs the Python '
      + 'packages in requirements.txt. Takes effect immediately.',
    fields: [
      { path: 'live.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'live.source', label: 'Listen To', type: 'select',
        options: () => [
          { value: 'loopback', label: 'What this computer plays' },
          { value: 'input', label: 'An input (line-in or microphone)' },
        ],
        help: 'What this computer plays is the easy one: Spotify, a browser, anything, straight from '
          + 'the sound card with no cable. An input takes a line off the booth output — the only '
          + 'way to hear a set played on other equipment.' },
      { path: 'live.device', label: 'Device', type: 'select',
        options: () => {
          const source = document.getElementById('set-live.source');
          const loopback = (source ? source.value : at(settingsData.settings, 'live.source')) !== 'input';
          const names = (loopback ? liveDevices.outputs : liveDevices.inputs) || [];
          return [
            { value: '', label: loopback ? 'The default output' : 'The default input' },
            ...names.map((name) => ({ value: name, label: name })),
          ];
        },
        missing: (value) => `${value} (not found)`,
        help: 'Refreshes when the page loads. A device that is not plugged in now keeps its name '
          + 'and is used when it comes back.' },
      { path: 'live.autoSync', label: 'Auto-Sync', type: 'toggle',
        help: 'Line a known track\'s show up with what is heard, rather than trust where Spotify or the '
          + 'media session says the song is. The Sync slider then only has to cover the lights\' own delay.' },
      { path: 'live.director', label: 'Play By Ear', type: 'toggle',
        help: 'With the auto show on and no analysed track to play — the next one still being analysed, '
          + 'or music nothing can name — answer what is heard: new looks on section changes, bursts on '
          + 'drops, dark in the silences.' },
      { path: 'live.latencyMs', label: 'Room Latency (ms)', type: 'number', min: -500, max: 500,
        help: 'How much later the room hears the music than this computer does. Positive when the '
          + 'PA is behind the sound card; negative for a line-in off the booth, which arrives after '
          + 'the room has heard it. 0 is right for most setups.' },
    ],
  },
  {
    id: 'sacn',
    group: 'output',
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
      { path: 'sacn.interface', label: 'Network', type: 'select',
        options: () => [
          { value: '', label: 'Let the computer choose' },
          ...networkInterfaces.map((i) => ({ value: i.address, label: `${i.name} — ${i.address}` })),
        ],
        missing: (value) => `${value} (not on this machine)`,
        help: 'Which network the multicast groups go out on. Only matters on a machine that is on '
          + 'more than one — pick the one the nodes are on.' },
      { path: 'sacn.cid', label: 'Component ID', type: 'text',
        help: 'How a receiver tells sources apart. Generated on first start and stable from then on '
          + '— change it only if two servers on the network ended up sharing one.' },
    ],
  },
  {
    id: 'engine',
    group: 'output',
    title: 'Engine',
    desc: 'Where frames are rendered. Applies on the next restart.',
    fields: [
      { path: 'engine.thread', label: 'Render On', type: 'select',
        options: () => [
          { value: 'worker', label: 'Its own thread (recommended)' },
          { value: 'main', label: 'The main thread' },
        ],
        help: 'On its own thread the rig keeps time while the server plans the next track, imports '
          + 'a fixture file or serves the UI. The main thread is how it used to run — only worth '
          + 'choosing to rule the thread out when chasing a problem.',
        note: engineNote },
    ],
  },
  {
    id: 'hue',
    group: 'output',
    title: 'Philips Hue',
    desc: 'Drive Hue lamps from the same show as the pars. Unlike Art-Net and sACN this does not '
      + 'carry a universe: each channel of an entertainment area follows one rig fixture. '
      + 'Build the area in the Hue app first, then pair here.',
    fields: [
      { path: 'hue.enabled', label: 'Enabled', type: 'toggle' },
      { path: 'hue.host', label: 'Bridge Address', type: 'text',
        help: 'The bridge IP. Press Find Bridges to look it up, or type it in — a show network '
          + 'with no route to the internet has to be typed in.' },
      { path: 'hue.entertainmentId', label: 'Entertainment Area', type: 'select',
        empty: 'pair with a bridge first',
        options: () => hueAreas.map((a) => ({ value: a.id, label: `${a.name} (${a.channels.length} channels)` })),
        help: 'Areas are built in the Hue app, where the lamps are already placed on a floor plan. '
          + 'A bridge streams one area at a time.' },
      { path: 'hue.latencyMs', label: 'Pars Delay (ms)', type: 'number', min: 0, max: 500,
        help: 'Hue lamps answer later than the pars, so every hit lands on the pars first. This holds '
          + 'the Art-Net and sACN output back to match. Start around 50: run the sync test, film it '
          + 'in slow motion, and raise this until the pars and lamps flash together.' },
    ],
    extra: renderHueExtra,
    collect: () => ({ 'hue.channels': hueBindings() }),
  },
  {
    id: 'spotify',
    group: 'music',
    title: 'Spotify',
    desc: 'Credentials from your Spotify app dashboard. Register the redirect URI shown in the server log — by default that is http://127.0.0.1:<port>/auth/spotify/callback.',
    fields: [
      { path: 'spotify.clientId', label: 'Client ID', type: 'text' },
      { path: 'spotify.clientSecret', label: 'Client Secret', type: 'secret' },
      { path: 'spotify.proxyBase', label: 'OAuth Proxy (optional)', type: 'text',
        help: 'Leave blank to authorise straight against Spotify — it accepts a 127.0.0.1 '
          + 'redirect, so no relay is needed when you connect from this machine. Set one '
          + 'only to connect from a different device.' },
      { path: 'spotify.allowUnverifiedState', label: 'Allow Unverified State', type: 'toggle',
        help: 'Only if a proxy strips the state parameter. Disables OAuth CSRF protection.' },
    ],
  },
  {
    id: 'deezer',
    group: 'music',
    title: 'Deezer',
    desc: 'An ARL cookie enables exact ISRC-matched audio. Without one, analysis falls back to a yt-dlp search.',
    fields: [
      { path: 'deezer.arl', label: 'ARL Cookie', type: 'secret' },
    ],
  },
  {
    id: 'analysis',
    group: 'music',
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
      { path: 'analysis.separator', label: 'Separator', type: 'select',
        options: () => [
          { value: 'demucs', label: 'Demucs (fast)' },
          { value: 'bs-roformer', label: 'BS-RoFormer (slow)' },
        ],
        help: 'Splits each track into drums, bass, vocals and other. Demucs keeps up with a live set; '
          + 'BS-RoFormer takes about seven times as long (around 6 minutes a track on an integrated '
          + 'GPU), so the playing track is rarely ready in time. Changing it restarts the analyzer; '
          + 'tracks already analysed keep their result.' },
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
      help: 'Required whenever the bind address is not loopback. Each browser needs it once: open the UI at /?token=… , or type it into the prompt the page raises when it is refused.' },
    { path: 'server.publicUrl', label: 'Public URL', type: 'text',
      help: 'Only needed behind a reverse proxy, or when the OAuth callback must use a hostname.' },
  ],
};

let settingsData = null;   // { settings, secrets, restartKeys, pendingRestart, running, python }

/** Where the engine is rendering right now, and how its frames have been going. */
function engineNote(data) {
  const e = data && data.engine;
  if (!e || !e.thread) return null;
  const where = e.thread === 'worker' ? 'its own thread' : 'the main thread';
  const timing = e.frames
    ? ` — ${e.rate} frames a second, ${e.renderMs.p95} ms to render (p95), `
      + `${e.lateFrames + e.skippedFrames} late or dropped in the last minute`
    : '';
  if (e.fellBack) return { ok: false, text: `Currently: ${where}, because ${e.fellBack}${timing}.` };
  return { ok: true, text: `Currently: ${where}${timing}.` };
}

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

  if (field.type === 'select') {
    const select = document.createElement('select');
    select.id = `set-${field.path}`;
    const options = field.options ? field.options() : [];
    // A value that is set but no longer in the list still has to be shown, or
    // the control would silently claim the setting is something it isn't.
    const known = options.some((o) => String(o.value) === String(value || ''));
    if (!options.length || !known) {
      const ph = document.createElement('option');
      ph.value = value || '';
      ph.textContent = options.length
        ? (field.missing ? field.missing(value) : `${value} (not on the bridge)`)
        : (field.empty || 'none');
      select.appendChild(ph);
    }
    for (const opt of options) {
      const node = document.createElement('option');
      node.value = opt.value;
      node.textContent = opt.label;
      select.appendChild(node);
    }
    select.value = value || '';
    return select;
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

  // A section whose configuration cannot be expressed as a list of fields —
  // Hue's pairing and channel bindings — renders its own controls here.
  if (spec.extra) spec.extra(form, spec);

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
      else if (field.type === 'select') value = input.value;
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

  // Values that are not a single input — the Hue channel bindings are a table.
  for (const [path, value] of Object.entries(spec.collect ? spec.collect() : {})) {
    const [group, key] = path.split('.');
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
  // Each spec declares the tab it lives in, so the rendered sections land
  // beside the hand-written ones they belong with rather than in one block.
  const hosts = {
    output: document.getElementById('settings-output-group'),
    music: document.getElementById('settings-music-group'),
  };
  const serverGroup = document.getElementById('settings-server-group');
  for (const host of Object.values(hosts)) host.textContent = '';
  serverGroup.textContent = '';

  for (const spec of SETTINGS_SPEC) {
    const host = hosts[spec.group] || hosts.music;
    renderSection(spec, host);
  }
  renderSection(SERVER_SPEC, serverGroup);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
// Eleven sections in one scroll mixed the rig you build once with credentials
// you touch twice a year. Same sections, grouped by when you reach for them.

const TAB_KEY = 'lightshow.settingsTab';
const TABS = ['check', 'rig', 'output', 'control', 'music', 'server'];

function showTab(tab) {
  const active = TABS.includes(tab) ? tab : 'check';
  try { localStorage.setItem(TAB_KEY, active); } catch (_) { /* private mode */ }

  document.querySelectorAll('[data-tab]').forEach((node) => {
    node.hidden = node.dataset.tab !== active;
  });
  document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
    const on = btn.dataset.tabBtn === active;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

document.getElementById('settings-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab-btn]');
  if (btn) showTab(btn.dataset.tabBtn);
});

let savedTab = 'check';
try { savedTab = localStorage.getItem(TAB_KEY) || 'check'; } catch (_) { /* private mode */ }
// A link can name the tab: /settings.html#music opens on the music sources.
const linkedTab = window.location.hash.slice(1);
showTab(TABS.includes(linkedTab) ? linkedTab : savedTab);

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (!data.ok) return;
    settingsData = data;
    renderSettings();
    // Hand-written control, so it is not covered by the spec renderer.
    const feedback = document.getElementById('midi-control-feedback');
    if (feedback && data.settings.midi) {
      feedback.checked = data.settings.midi.controlFeedback !== false;
    }
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
    const res = await apiJson('/api/preflight', { method: 'POST' });
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
// Separate from loadSettings on purpose: this one talks to the bridge, and a
// bridge that is switched off must not hold up the rest of the settings page.
loadHueStatus();
