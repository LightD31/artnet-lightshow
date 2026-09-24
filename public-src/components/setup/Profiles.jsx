import { useEffect, useRef, useState } from 'preact/hooks';
import { pick, api, toast } from '../../state.js';
import { post, slugify } from '../../setup-state.js';

/**
 * The fixture library: import a GDTF or Open Fixture Library file, find a
 * fixture in the Open Fixture Library online, make an LED bar from the
 * numbers in its manual, and the profiles there are.
 *
 * Every way in answers with the same `{ name, manufacturer, modes }` fixture,
 * so they all end in the same mode picker.
 */

// The attributes the show writes. A channel is highlighted in the preview only
// when one of these maps it: a profile can name its gobo, but nothing moves it.
const DRIVEN = new Set(['dimmer', 'dimmerFine', 'strobe', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coolWhite']);

function drivenOffsets(mode) {
  const driven = new Set();
  const add = (map) => Object.entries(map || {}).forEach(([attr, offset]) => { if (DRIVEN.has(attr)) driven.add(offset); });
  add(mode.channelMap);
  (mode.cells || []).forEach((cell) => add(cell.channelMap));
  return driven;
}

/** A mode's channels, the ones the show drives highlighted, and what the import had to say. */
export function ChannelPreview({ mode, warnings = [] }) {
  if (!mode) return null;
  const driven = drivenOffsets(mode);
  const held = new Map((mode.defaults || []).map((d) => [d.offset, d.value]));
  const drives = `${driven.size} of ${mode.channelCount} channels driven by the show (highlighted)`;
  const panel = mode.grid ? ` in a ${mode.grid.columns} × ${mode.grid.rows} grid` : '';
  return (
    <div class="channel-preview">
      <div class="ch-summary">{mode.cells ? `${mode.cells.length} cells${panel}, each driven on its own · ${drives}` : drives}</div>
      {[...warnings, ...(mode.warnings || [])].map((w, i) => <div key={i} class="ch-warning">{w}</div>)}
      {(mode.channelList || []).map((ch) => (
        <span key={ch.offset} class={`ch-tag ${driven.has(ch.offset) ? 'mapped' : ''}`}
          title={held.has(ch.offset) ? `The show does not drive this channel; it is held at ${held.get(ch.offset)}` : undefined}>
          <span class="ch-num">{ch.offset + 1}</span>
          <span class="ch-name">{ch.name}</span>
          {held.has(ch.offset) && <span class="ch-held">={held.get(ch.offset)}</span>}
        </span>
      ))}
    </div>
  );
}

/** Pick one of an imported fixture's modes and add it as a profile. */
function ModePicker({ fixture, onDone }) {
  const [modeIndex, setModeIndex] = useState(0);
  // An OFL file does not say who makes the fixture, so the maker can be typed in.
  const [maker, setMaker] = useState(fixture.manufacturer === 'Unknown' ? '' : fixture.manufacturer);
  const [status, setStatus] = useState(null);
  const mode = fixture.modes[modeIndex];
  const add = async () => {
    const manufacturer = maker.trim() || fixture.manufacturer;
    const profile = {
      id: slugify(`${manufacturer}-${fixture.name}-${mode.modeName}`),
      name: fixture.name,
      manufacturer,
      modeName: mode.modeName,
      channelCount: mode.channelCount,
      channelMap: mode.channelMap,
      channelList: mode.channelList.map(({ offset, name, attribute, cell }) => ({ offset, name, attribute, ...(cell !== undefined ? { cell } : {}) })),
      ...(mode.cells ? { cells: mode.cells } : {}),
      ...(mode.grid ? { grid: mode.grid } : {}),
      ...(mode.defaults ? { defaults: mode.defaults } : {}),
    };
    const res = await post('/api/profiles', profile);
    if (res.ok) {
      toast.info(`Added "${profile.name} — ${profile.modeName}": pick it for a fixture in the patch`);
      onDone();
    } else {
      setStatus(res.error);
    }
  };
  return (
    <div class="mode-picker" role="group" aria-label={`Add ${fixture.name}`}>
      <div class="mode-field"><span class="mode-key">Fixture</span><strong>{fixture.name}</strong></div>
      <label class="mode-field"><span class="mode-key">Manufacturer</span>
        <input type="text" maxLength={128} placeholder="Who makes it" value={maker} onInput={(e) => setMaker(e.target.value)} /></label>
      <label class="mode-field"><span class="mode-key">DMX mode</span>
        <select value={modeIndex} onChange={(e) => setModeIndex(parseInt(e.target.value, 10))}>
          {fixture.modes.map((m, i) => (
            <option key={i} value={i}>{`${m.modeName} (${m.channelCount}ch${m.cells ? `, ${m.cells.length} cells` : ''})`}</option>
          ))}
        </select>
      </label>
      <ChannelPreview mode={mode} warnings={fixture.warnings} />
      <div class="setting-actions">
        <button type="button" class="btn active" onClick={add}>Add profile</button>
        <button type="button" class="btn" onClick={onDone}>Cancel</button>
        {status && <span class="import-status error" role="alert">{status}</span>}
      </div>
    </div>
  );
}

/** For a bar with no GDTF file: from its cell count and channel order (server/bar-profile.ts). */
function BarMaker() {
  const [spec, setSpec] = useState({ name: '', cells: '16', first: '3', order: 'RGB', stride: '', dimmer: '1', strobe: '2' });
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const num = (v) => (String(v).trim() === '' ? undefined : Number(v));
  const body = () => {
    const name = spec.name.trim() || 'LED Bar';
    const order = spec.order.trim().toUpperCase();
    return {
      id: slugify(`custom-${name}-${spec.cells}-${order}`),
      name, cells: num(spec.cells), firstChannel: num(spec.first), order,
      stride: num(spec.stride), dimmer: num(spec.dimmer), strobe: num(spec.strobe),
    };
  };
  // The server builds it, so the preview and the profile added are the same thing.
  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/profiles/bar?dryRun=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
        const data = await res.json();
        if (data.ok) { setPreview(data.profile); setStatus({ ok: true, text: `${data.profile.channelCount} channels` }); }
        else { setPreview(null); setStatus({ ok: false, text: data.error }); }
      } catch {
        setStatus({ ok: false, text: 'No answer from the server' });
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [open, spec]);
  const set = (key) => (e) => setSpec({ ...spec, [key]: e.target.value });
  const add = async () => {
    const res = await post('/api/profiles/bar', body());
    if (res.ok) setStatus({ ok: true, text: `Added "${res.profile.name}" — pick it for a fixture in the patch.` });
    else setStatus({ ok: false, text: res.error });
  };
  const field = (key, label, props) => (
    <label class="mode-field"><span class="mode-key">{label}</span><input {...props} value={spec[key]} onInput={set(key)} /></label>
  );
  return (
    <details class="bar-maker" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Make an LED bar profile</summary>
      <p class="section-desc">For a bar with no GDTF file: how many cells it has, where the first cell starts, and the order of
        each cell's channels (R G B W A U, and D for a cell's own dimmer).</p>
      <div class="mode-picker">
        {field('name', 'Name', { type: 'text', maxLength: 128, placeholder: 'LED Bar 16' })}
        {field('cells', 'Cells', { type: 'number', min: 2, max: 1024 })}
        {field('first', 'First cell at', { type: 'number', min: 1, max: 512 })}
        {field('order', 'Cell channels', { type: 'text', maxLength: 8 })}
        {field('stride', 'Cell spacing', { type: 'number', min: 1, max: 64, placeholder: 'same as channels' })}
        {field('dimmer', 'Bar dimmer', { type: 'number', min: 1, max: 512, placeholder: 'none' })}
        {field('strobe', 'Bar strobe', { type: 'number', min: 1, max: 512, placeholder: 'none' })}
        {preview && <ChannelPreview mode={preview} />}
        <div class="setting-actions">
          <button type="button" class="btn active" onClick={add}>Add bar profile</button>
          {status && <span class={`import-status ${status.ok ? '' : 'error'}`} role="status">{status.text}</span>}
        </div>
      </div>
    </details>
  );
}

/** The Open Fixture Library, searched online. */
function OflSearch({ onPick }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);   // { note, error, hits }
  const search = async (e) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) { setResult({ note: 'Type at least two letters' }); return; }
    setResult({ note: 'Searching…' });
    try {
      const data = await (await fetch(`/api/ofl/search?q=${encodeURIComponent(q)}`)).json();
      if (!data.ok) setResult({ error: data.error || 'The search failed' });
      else if (!data.results.length) setResult({ note: `Nothing in the Open Fixture Library matches "${q}"` });
      else setResult({ hits: data.results });
    } catch {
      setResult({ error: 'Could not reach the server' });
    }
  };
  return (
    <>
      <form class="ofl-search" role="search" onSubmit={search}>
        <input type="search" maxLength={100} value={query} onInput={(e) => setQuery(e.target.value)}
          placeholder="Search the Open Fixture Library: pixel bar, root par…" aria-label="Search the Open Fixture Library" />
        <button class="btn" type="submit">Search</button>
      </form>
      {result && (
        <div class="ofl-results" aria-live="polite">
          {result.note && <div class="ofl-note">{result.note}</div>}
          {result.error && <div class="ofl-note error">{result.error}</div>}
          {(result.hits || []).map((hit) => (
            <button key={`${hit.manufacturerKey}/${hit.fixtureKey}`} type="button" class="ofl-hit"
              onClick={() => onPick(`Fetching ${hit.name}…`, () => fetch(`/api/ofl/fixture/${encodeURIComponent(hit.manufacturerKey)}/${encodeURIComponent(hit.fixtureKey)}`))}>
              <span class="ofl-hit-name">{hit.name}</span>
              <span class="ofl-hit-maker">{[hit.manufacturer, ...(hit.categories || [])].join(' · ')}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function ProfileList() {
  const s = pick(['profiles', 'builtinProfileIds', 'fixtures']);
  const profiles = Object.values(s.profiles || {});
  const builtin = new Set(s.builtinProfileIds || []);
  const inUse = new Set((s.fixtures || []).map((f) => f.profileId));
  const remove = async (profile) => {
    const res = await api(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
    if (!res.ok) return;
    // An import is a file someone had to go and find: undo is re-posting it.
    toast.push({ message: `Removed "${profile.name}"`, action: { label: 'Undo', onClick: () => post('/api/profiles', profile) } });
  };
  return (
    <div class="profiles-list">
      {profiles.map((p) => {
        const cells = Array.isArray(p.cells) && p.cells.length >= 2 ? `, ${p.cells.length} cells` : '';
        return (
          <div key={p.id} class={`profile-card ${builtin.has(p.id) ? 'builtin' : ''}`}>
            <span class="profile-name">{p.name}</span>
            <span class="profile-manufacturer">{p.manufacturer}</span>
            <span class="profile-mode">{p.modeName} — {p.channelCount}ch{cells}</span>
            <span class="profile-channels">Drives: {Object.keys(p.channelMap || {}).filter((k) => DRIVEN.has(k)).join(', ') || (cells ? 'its cells' : 'nothing')}</span>
            <div class="profile-actions">
              {builtin.has(p.id)
                ? <span class="profile-badge">Built-in</span>
                : <button type="button" class="btn sm" disabled={inUse.has(p.id)}
                  title={inUse.has(p.id) ? 'Fixtures in the patch use it' : undefined}
                  aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>Remove</button>}
              {inUse.has(p.id) && <span class="profile-badge">In use</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Profiles() {
  const [pending, setPending] = useState(null);   // an imported fixture, until its mode is picked
  const [status, setStatus] = useState(null);
  const importFixture = async (message, load) => {
    setStatus({ ok: true, text: message });
    let data;
    try {
      data = await (await load()).json();
    } catch {
      data = { ok: false, error: 'Could not reach the server' };
    }
    if (!data.ok) { setStatus({ ok: false, text: data.error || 'Import failed' }); return; }
    setStatus({ ok: true, text: `Read: ${data.fixture.name} by ${data.fixture.manufacturer}` });
    setPending(data.fixture);
  };
  const fileImport = (url, field) => async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append(field, file);
    await importFixture('Reading…', () => fetch(url, { method: 'POST', body: form }));
    e.target.value = '';
  };
  return (
    <section class="panel" aria-labelledby="profiles-title">
      <header class="panel-head"><h2 class="panel-title" id="profiles-title">Fixture profiles</h2></header>
      <p class="section-desc">What each kind of fixture is, channel by channel. Import a GDTF or Open Fixture Library file,
        find a fixture in the Open Fixture Library, or make an LED bar from its manual.</p>
      <div class="import-row">
        <label class="btn active file-upload-btn">Import GDTF file
          <input type="file" accept=".gdtf" class="sr-only" onChange={fileImport('/api/gdtf/parse', 'gdtf')} /></label>
        <label class="btn active file-upload-btn" title="A fixture's .json file, downloaded from open-fixture-library.org">Import OFL file
          <input type="file" accept=".json,application/json" class="sr-only" onChange={fileImport('/api/ofl/parse', 'ofl')} /></label>
        {status && <span class={`import-status ${status.ok ? '' : 'error'}`} role="status">{status.text}</span>}
      </div>
      <OflSearch onPick={importFixture} />
      {pending && <ModePicker key={`${pending.manufacturer}/${pending.name}`} fixture={pending} onDone={() => { setPending(null); setStatus(null); }} />}
      <BarMaker />
      <ProfileList />
    </section>
  );
}
