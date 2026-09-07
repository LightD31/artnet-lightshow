'use strict';

const socket = io({ auth: { token: window.LIGHTSHOW_TOKEN || '' } });

let state = {};
let profiles = {};
let pendingGdtf = null; // holds parsed GDTF data before user confirms mode

// ── Socket events ────────────────────────────────────────────────────────────

socket.on('connect', () => {
  document.getElementById('status-dot').classList.add('connected');
});

socket.on('disconnect', () => {
  document.getElementById('status-dot').classList.remove('connected');
});

socket.on('state', (s) => {
  state = s;
  if (s.profiles) profiles = s.profiles;
  renderProfiles();
  renderPatchTable();
  syncArtnetFields(s);
  if (s.midi) renderMidiStatus(s.midi);
});

// ── ArtNet settings ──────────────────────────────────────────────────────────

['artnet-host', 'artnet-port', 'artnet-universe'].forEach(id => {
  document.getElementById(id).addEventListener('input', function () {
    this.dataset.dirty = 'true';
  });
});

function syncArtnetFields(s) {
  if (!s.artnet) return;
  const h = document.getElementById('artnet-host');
  const p = document.getElementById('artnet-port');
  const u = document.getElementById('artnet-universe');
  if (!h.dataset.dirty) h.value = s.artnet.host;
  if (!p.dataset.dirty) p.value = s.artnet.port;
  if (!u.dataset.dirty) u.value = s.artnet.universe;
}

document.getElementById('artnet-save').addEventListener('click', () => {
  socket.emit('set', {
    artnet: {
      host: document.getElementById('artnet-host').value,
      port: parseInt(document.getElementById('artnet-port').value),
      universe: parseInt(document.getElementById('artnet-universe').value),
    }
  });
  ['artnet-host', 'artnet-port', 'artnet-universe'].forEach(id => {
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
// so it must never reach innerHTML — see AUDIT.md C1.
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

  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    const data = await res.json();

    if (data.ok) {
      document.getElementById('gdtf-status').textContent = `Profile "${profile.name} - ${profile.modeName}" added!`;
      document.getElementById('gdtf-status').className = 'import-status success';
      document.getElementById('gdtf-mode-select').style.display = 'none';
      pendingGdtf = null;
    }
  } catch (err) {
    document.getElementById('gdtf-status').textContent = 'Failed to save profile';
    document.getElementById('gdtf-status').className = 'import-status error';
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

function detectConflicts(fixtures) {
  const conflicts = new Set();
  for (let i = 0; i < fixtures.length; i++) {
    const a = fixtures[i];
    const pa = profiles[a.profileId] || {};
    const aEnd = a.address + (pa.channelCount || 12) - 1;

    for (let j = i + 1; j < fixtures.length; j++) {
      const b = fixtures[j];
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
  await fetch('/api/fixtures', { method: 'POST' });
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
