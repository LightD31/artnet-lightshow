import { useEffect, useRef, useState } from 'preact/hooks';
import { pick, send, connectedSig, toast } from '../../state.js';
import { settingsSig, loadSettings, saveSettings, networkInterfaces, post, at } from '../../setup-state.js';
import { footprintOf } from '../../../src/shared/placement.ts';
import { identify } from '../../rig-ui.js';
import { SettingsSection } from './Section.jsx';
import { ARTNET, SACN, HUE } from './specs.js';

/**
 * Where the rig's DMX goes, and what is out there to send it to: Art-Net
 * nodes that answer a poll, other sACN sources on the network, WLEDs that
 * announce themselves and the Hue bridge. Each can be made to show itself —
 * a node's locate LEDs and the fixtures on its universes, a WLED's pixels, a
 * Hue lamp — so a device on a list is a device on the truss.
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function getJson(path) {
  try {
    const data = await (await fetch(path)).json();
    return data.ok ? data : { ok: false, error: data.error || 'The request failed' };
  } catch (err) {
    return { ok: false, error: `Could not reach the server: ${err.message}` };
  }
}

// ── Art-Net ──────────────────────────────────────────────────────────────────

function ArtnetNodes({ nodes, setNodes }) {
  const s = pick(['artnet']);
  const [status, setStatus] = useState('');
  const load = async (scan) => {
    if (scan) setStatus('Asking the network…');
    const data = await getJson(`/api/artnet/nodes${scan ? '?scan=1' : ''}`);
    if (!data.ok) { setStatus(`Could not ask: ${data.error}`); return; }
    setNodes(data.nodes || []);
    const found = (data.nodes || []).length;
    setStatus(found
      ? `${plural(found, 'node')} answered${data.routing ? ' — each is sent its universes directly.' : '.'}`
      : data.error ? `No answer — ${data.error}`
        : data.routing || scan ? 'No node has answered. Many never reply to polls; if the rig is dark, check the Node IP and the subnet.'
          : 'Find Nodes asks the network which Art-Net nodes are there.');
  };
  useEffect(() => { load(false); }, []);
  const sendTo = (address) => {
    const before = s.artnet && s.artnet.host;
    send({ artnet: { host: address } });
    toast.push({ message: `Art-Net now goes to ${address} only`, action: before ? { label: 'Undo', onClick: () => send({ artnet: { host: before } }) } : undefined });
  };
  const locate = async (node) => {
    const res = await post('/api/artnet/identify', { address: node.address, universes: node.outputs || [] });
    if (!res.ok) return;
    const parts = [];
    parts.push(res.located ? `${node.shortName || node.address} flashes its locate LEDs if it can` : `Could not reach ${node.address}: ${res.locateError}`);
    parts.push(res.fixtures.length ? `${plural(res.fixtures.length, 'fixture')} on its universes flash` : 'nothing patched on its universes');
    toast.info(`${parts.join('; ')}.`);
  };
  return (
    <div class="discovery">
      <div class="discovery-head">
        <button type="button" class="btn sm" onClick={() => load(true)}>Find nodes</button>
        <span class="setting-help" role="status">{status}</span>
      </div>
      {nodes.length > 0 && (
        <div class="table-scroll">
          <table class="patch-table">
            <thead><tr><th scope="col">Node</th><th scope="col">Address</th><th scope="col">Universes</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.address}>
                  <td>{node.shortName || node.longName || 'unnamed'}</td>
                  <td class="mono">{node.address}</td>
                  <td class="mono">{node.outputs && node.outputs.length ? node.outputs.join(', ') : '—'}</td>
                  <td class="patch-actions-cell">
                    <button type="button" class="btn sm" disabled={!connectedSig.value} onClick={() => locate(node)}
                      aria-label={`Identify ${node.shortName || node.address}`}>Identify</button>
                    <button type="button" class="btn sm" disabled={s.artnet && s.artnet.host === node.address}
                      title="Send Art-Net to this node alone, rather than broadcast" onClick={() => sendTo(node.address)}>Send only here</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Artnet({ nodes, setNodes }) {
  const s = pick(['artnet']);
  const live = { artnet: s.artnet || {} };
  // Through the socket, as the patch's own edits go: a new default universe
  // takes the fixtures on the old one with it, and the saved show follows.
  const apply = async (patch) => {
    if (!patch.artnet) return { ok: true };
    if (!send({ artnet: patch.artnet })) return { ok: false, error: 'Disconnected — reconnect and apply again' };
    setTimeout(() => loadSettings(), 400);
    return { ok: true };
  };
  return (
    <SettingsSection {...ARTNET} stored={(path) => at(live, path)} onApply={apply}>
      <ArtnetNodes nodes={nodes} setNodes={setNodes} />
    </SettingsSection>
  );
}

// ── sACN ─────────────────────────────────────────────────────────────────────

function SacnSources() {
  const [data, setData] = useState(null);
  const timer = useRef(null);
  const poll = async (listen) => {
    const res = await getJson(`/api/sacn/sources${listen ? '?listen=1&seconds=12' : ''}`);
    setData(res);
    clearTimeout(timer.current);
    if (res.ok && res.listening) timer.current = setTimeout(() => poll(false), 1500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const listening = data && data.ok && data.listening;
  return (
    <div class="discovery">
      <div class="discovery-head">
        <button type="button" class="btn sm" disabled={listening} onClick={() => poll(true)}>{listening ? 'Listening…' : 'Listen for other sources'}</button>
        <span class="setting-help" role="status">
          {!data ? 'An sACN receiver never announces itself, but every source does: listen to hear any console or server sending sACN, and whether it sends a universe this rig does.'
            : !data.ok ? data.error
              : data.error ? `Could not listen: ${data.error}`
                : listening ? `Listening, ${Math.ceil(data.remainingMs / 1000)} s more — sources announce themselves every ten seconds.`
                  : data.sources.length ? `${plural(data.sources.length, 'other source')} heard.` : 'No other sACN source was heard.'}
        </span>
      </div>
      {data && data.ok && data.conflicts.length > 0 && (
        <div class="setting-note warn discovery-warn" role="alert">
          {data.conflicts.map((c) => (
            <p key={c.universe}>Universe {c.rigUniverse} (sACN {c.universe}) is also sent by {c.sources.join(', ')}.
              {' '}The higher priority wins{data.enabled ? '' : ' once sACN is on'}; this server sends at the priority above.</p>
          ))}
        </div>
      )}
      {data && data.ok && data.sources.length > 0 && (
        <div class="table-scroll">
          <table class="patch-table">
            <thead><tr><th scope="col">Source</th><th scope="col">Address</th><th scope="col">Priority</th><th scope="col">Universes</th></tr></thead>
            <tbody>
              {data.sources.map((src) => (
                <tr key={src.cid}>
                  <td>{src.name || 'unnamed'}</td>
                  <td class="mono">{src.address}</td>
                  <td class="mono">{src.priority ?? '—'}</td>
                  <td class="mono">{[...new Set([...src.universes, ...src.sending])].sort((a, b) => a - b).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Sacn() {
  const ctx = { networkInterfaces: networkInterfaces.use() };
  return (
    <SettingsSection {...SACN} ctx={ctx}>
      <SacnSources />
    </SettingsSection>
  );
}

// ── The universes ────────────────────────────────────────────────────────────

/** Every universe the patch uses: what is on it, where it goes, and identify. */
function Universes({ nodes }) {
  const s = pick(['fixtures', 'profiles', 'universes', 'artnet']);
  const data = settingsSig.value;
  const sacn = data && data.settings && data.settings.sacn;
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const on = new Map();
  for (const fix of fixtures) {
    const profile = profiles[fix.profileId];
    if (!profile) continue;
    for (const part of footprintOf(fix.universe ?? 0, fix.address, profile)) {
      const entry = on.get(part.universe) || { fixtures: [], ddp: null, last: 0 };
      entry.fixtures.push(fix.label);
      entry.last = Math.max(entry.last, part.last);
      if (fix.output && fix.output.protocol === 'ddp') entry.ddp = fix.output.host;
      on.set(part.universe, entry);
    }
  }
  const universes = [...on.keys()].sort((a, b) => a - b);
  if (!universes.length) return null;
  return (
    <section class="panel" aria-labelledby="universes-title">
      <header class="panel-head"><h2 class="panel-title" id="universes-title">Universes</h2></header>
      <p class="section-desc">Every universe the patch uses and where it goes. Identify flashes everything patched on one, so
        a node or a receiver that is not answering polls can still be found by what it lights.</p>
      <div class="table-scroll">
        <table class="patch-table">
          <thead><tr><th scope="col">Universe</th><th scope="col">Fixtures</th><th scope="col">Goes to</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {universes.map((u) => {
              const entry = on.get(u);
              const outputs = nodes.filter((n) => (n.outputs || []).includes(u)).map((n) => n.shortName || n.address);
              const routes = [];
              if (entry.ddp) routes.push(`WLED ${entry.ddp} (DDP)`);
              else {
                if (s.artnet && s.artnet.enabled !== false) routes.push(outputs.length ? `Art-Net: ${outputs.join(', ')}` : `Art-Net: ${s.artnet.host}`);
                if (sacn && sacn.enabled) routes.push(`sACN ${u + (sacn.universeOffset ?? 1)}${sacn.host ? ` to ${sacn.host}` : ''}`);
              }
              return (
                <tr key={u}>
                  <td class="mono">{u}<small class="addr-range">{entry.last} ch</small></td>
                  <td>{entry.fixtures.length > 4 ? `${entry.fixtures.slice(0, 3).join(', ')} and ${entry.fixtures.length - 3} more` : entry.fixtures.join(', ')}</td>
                  <td>{routes.join(' · ') || 'nowhere — every output is off'}</td>
                  <td class="patch-actions-cell">
                    <button type="button" class="btn sm" disabled={!connectedSig.value} aria-label={`Identify universe ${u}`}
                      onClick={() => identify({ universes: [u] })}>Identify</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── WLED ─────────────────────────────────────────────────────────────────────

function Wled() {
  const [devices, setDevices] = useState(null);
  const [status, setStatus] = useState('');
  const [host, setHost] = useState('');
  const find = async () => {
    setStatus('Asking the network…');
    const data = await getJson('/api/wled/discover');
    if (!data.ok) { setStatus(data.error); return; }
    setDevices(data.devices || []);
    setStatus(data.devices.length ? `${plural(data.devices.length, 'WLED')} answered.`
      : 'No WLED answered. mDNS does not cross routers or VLANs: add one by its address below.');
  };
  const add = async (address) => {
    setStatus(`Asking ${address}…`);
    const res = await post('/api/wled/add', { host: address });
    if (!res.ok) { setStatus(res.error); return; }
    setStatus(`Added "${res.fixture.label}": ${res.profile.modeName}, from universe ${res.fixture.universe}.`);
    setDevices((list) => (list || []).map((d) => (d.host === address ? { ...d, patched: res.fixture.label } : d)));
    toast.info(`Added ${res.fixture.label} to the patch`);
  };
  const flash = async (address) => {
    const res = await post('/api/wled/identify', { host: address });
    if (res.ok) toast.info(res.via === 'patch' ? 'It flashes through the patch: its first LED green, its last red' : `Its ${res.leds} LEDs flash: the first green, the last red`);
  };
  return (
    <section class="panel" aria-labelledby="wled-title">
      <header class="panel-head"><h2 class="panel-title" id="wled-title">WLED</h2></header>
      <p class="section-desc">WLED strips and panels, sent their pixels over DDP rather than Art-Net. Adding one reads its LED
        count (and its grid, set up as a panel) from the device and patches it on universes of its own.</p>
      <div class="discovery">
        <div class="discovery-head">
          <button type="button" class="btn sm" onClick={find}>Find WLEDs</button>
          <span class="setting-help" role="status">{status}</span>
        </div>
        {devices && devices.length > 0 && (
          <div class="table-scroll">
            <table class="patch-table">
              <thead><tr><th scope="col">WLED</th><th scope="col">Address</th><th scope="col">LEDs</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.host}>
                    <td>{d.name}</td>
                    <td class="mono">{d.host}</td>
                    <td>{d.error ? d.error : `${d.leds}${d.rgbw ? ' RGBW' : ' RGB'}${d.matrix ? `, ${d.matrix.w} × ${d.matrix.h}` : ''}`}</td>
                    <td class="patch-actions-cell">
                      {!d.error && <button type="button" class="btn sm" aria-label={`Identify ${d.name}`} onClick={() => flash(d.host)}>Identify</button>}
                      {d.patched ? <span class="setting-help">In the patch as "{d.patched}"</span>
                        : !d.error && <button type="button" class="btn sm active" onClick={() => add(d.host)}>Add to patch</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form class="inline-form" onSubmit={(e) => { e.preventDefault(); if (host.trim()) add(host.trim()); }}>
          <label for="wled-host">Add by address</label>
          <input id="wled-host" type="text" maxLength={253} placeholder="192.168.1.50 or wled-porch.local" value={host}
            onInput={(e) => setHost(e.target.value)} />
          <button type="button" class="btn sm" disabled={!host.trim()} onClick={() => flash(host.trim())}>Identify</button>
          <button type="submit" class="btn sm active" disabled={!host.trim()}>Add</button>
        </form>
      </div>
    </section>
  );
}

// ── Philips Hue ──────────────────────────────────────────────────────────────

function Hue() {
  const s = pick(['fixtures']);
  const data = settingsSig.value;
  const saved = (data && data.settings && data.settings.hue && data.settings.hue.channels) || [];
  const [info, setInfo] = useState(null);           // /api/hue/status
  const [areas, setAreas] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [notice, setNotice] = useState(null);       // { ok, text }
  const [bindings, setBindings] = useState(null);   // Map channel → fixture id, while edited
  const [areaId, setAreaId] = useState(null);
  const paired = !!(info && info.paired);

  const refresh = async () => {
    const status = await getJson('/api/hue/status');
    if (!status.ok) return;
    setInfo(status);
    if (status.paired) {
      const list = await getJson('/api/hue/areas');
      if (list.ok) setAreas(list.areas || []);
    }
  };
  useEffect(() => { refresh(); }, []);

  const find = async () => {
    setNotice({ ok: true, text: 'Looking for bridges…' });
    const res = await getJson('/api/hue/discover');
    if (!res.ok) { setNotice({ ok: false, text: res.error }); return; }
    setBridges(res.bridges || []);
    setNotice(res.bridges.length ? { ok: true, text: `Found ${plural(res.bridges.length, 'bridge')}: ${res.bridges.map((b) => b.host).join(', ')}` }
      : { ok: false, text: res.error ? `No bridges found — ${res.error}. Type the bridge address in above.` : 'No bridges answered. Type the bridge address in above.' });
  };
  const pair = async () => {
    const host = (document.getElementById('set-hue.host') || {}).value || (bridges[0] && bridges[0].host) || '';
    if (!host.trim()) { setNotice({ ok: false, text: 'Enter the bridge address first, or press Find bridges.' }); return; }
    setNotice({ ok: true, text: 'Press the round button on the bridge now…' });
    const res = await post('/api/hue/pair', { host: host.trim() });
    if (!res.ok) { setNotice({ ok: false, text: res.error }); return; }
    setAreas(res.areas || []);
    setNotice(res.areasError ? { ok: false, text: `Paired, but the areas could not be read — ${res.areasError}` }
      : { ok: true, text: `Paired with ${res.host}. Pick an entertainment area.` });
    await loadSettings();
    await refresh();
  };
  const forget = async () => {
    const res = await post('/api/hue/disconnect', {});
    if (!res.ok) return;
    setAreas([]);
    setNotice({ ok: true, text: 'Bridge forgotten. Remove this integration in the Hue app under linked devices.' });
    await loadSettings();
    await refresh();
  };
  const syncTest = async () => {
    const res = await post('/api/hue/sync-test', {});
    if (res.ok) setNotice({ ok: true, text: `Every fixture flashes once a second for ${res.seconds} s. Apply the delay first if you changed it.` });
  };
  const flash = async (channel) => {
    const res = await post('/api/hue/identify', { channel });
    if (res.ok) toast.info(res.via === 'fixture' ? 'The lamp flashes with the fixture it follows' : `The bridge asks ${plural(res.lamps, 'lamp')} to breathe`);
  };

  const areaShown = areaId ?? at(data && data.settings, 'hue.entertainmentId');
  const area = areas.find((a) => a.id === areaShown) || null;
  const current = bindings || new Map(saved.map((c) => [c.channel, c.fixture]));
  const bind = (channel, fixture) => {
    const next = new Map(current);
    if (fixture === '') next.delete(channel); else next.set(channel, Number(fixture));
    setBindings(next);
  };
  const fixtures = s.fixtures || [];
  const collect = () => (bindings ? { 'hue.channels': [...bindings].map(([channel, fixture]) => ({ channel, fixture })) } : {});
  const onApply = async (patch) => {
    const res = await saveSettings(patch);
    if (res.ok) setBindings(null);
    return res;
  };

  return (
    <SettingsSection {...HUE} ctx={{ hueAreas: areas }} collect={collect} dirtyExtra={!!bindings} onApply={onApply} childrenFirst>
      <div class="hue-tools">
        <div class="discovery-head">
          <button type="button" class="btn sm" onClick={find}>Find bridges</button>
          <button type="button" class="btn sm" title="Press the round button on the bridge, then this" onClick={pair}>{paired ? 'Pair again' : 'Pair'}</button>
          {paired && <button type="button" class="btn sm" onClick={syncTest}
            title="Every fixture flashes white once a second, pars and Hue lamps together">Sync test</button>}
          {paired && <button type="button" class="btn sm danger" onClick={forget}>Forget bridge</button>}
        </div>
        {notice && <p class={`setting-help setting-note ${notice.ok ? '' : 'warn'}`} role="status">{notice.text}</p>}
        {info && info.status && (
          <p class={`setting-help setting-note ${info.status.status === 'failed' ? 'warn' : ''}`}>
            Stream: {info.status.status}{info.status.error ? ` — ${info.status.error}` : ''}
          </p>
        )}
        {paired && (
          <label class="inline-form">
            <span>Show channels of</span>
            <select value={areaShown || ''} onChange={(e) => setAreaId(e.target.value)} aria-label="Entertainment area to bind">
              <option value="">—</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        {area && (
          <>
            <p class="section-desc">Each Hue channel shows the colour of the fixture it follows, after the dimmer, trim, master
              and blackout. Lamp names come from the Hue app. Leave a channel unused to let the bridge hold its own colour.</p>
            <div class="table-scroll">
              <table class="patch-table">
                <thead><tr><th scope="col">Channel</th><th scope="col">Lamp</th><th scope="col">Follows fixture</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {area.channels.map((ch) => (
                    <tr key={ch.id}>
                      <td class="mono">#{ch.id}</td>
                      <td>{ch.name || '—'}</td>
                      <td>
                        <select aria-label={`Fixture Hue channel ${ch.id} follows`} value={current.has(ch.id) ? String(current.get(ch.id)) : ''}
                          onChange={(e) => bind(ch.id, e.target.value)}>
                          <option value="">not used</option>
                          {fixtures.map((f) => <option key={f.id} value={String(f.id)}>{f.label}</option>)}
                        </select>
                      </td>
                      <td class="patch-actions-cell">
                        <button type="button" class="btn sm" aria-label={`Identify Hue channel ${ch.id}`} onClick={() => flash(ch.id)}>Identify</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}

// ── The show file ────────────────────────────────────────────────────────────

export function ShowFile() {
  const [status, setStatus] = useState(null);
  const save = async () => {
    try {
      const data = await (await fetch('/api/show')).json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lightshow-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ ok: true, text: 'Saved' });
    } catch {
      setStatus({ ok: false, text: 'Could not save the show' });
    }
  };
  const load = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    // Loading replaces the patch, the profiles and the look on stage, and has
    // no undo — so it asks first.
    if (!window.confirm(`Load "${file.name}"?\n\nIt replaces the patch, the fixture profiles and the look on stage now. `
      + 'Save the current show first if you want to keep it.')) return;
    try {
      const res = await post('/api/show', JSON.parse(await file.text()));
      setStatus(res.ok ? { ok: true, text: 'Loaded' } : { ok: false, text: res.error || 'Could not load it' });
    } catch {
      setStatus({ ok: false, text: 'That is not a show file' });
    }
  };
  return (
    <section class="panel" aria-labelledby="showfile-title">
      <header class="panel-head"><h2 class="panel-title" id="showfile-title">Show file</h2></header>
      <p class="section-desc">The whole rig in one file — patch, profiles, positions and output settings — to keep, move to
        another machine, or go back to.</p>
      <div class="import-row">
        <button type="button" class="btn active" onClick={save}>Save show</button>
        <label class="btn file-upload-btn">Load show<input type="file" accept=".json,application/json" class="sr-only" onChange={load} /></label>
        {status && <span class={`import-status ${status.ok ? 'success' : 'error'}`} role="status">{status.text}</span>}
      </div>
    </section>
  );
}

export function Outputs() {
  const [nodes, setNodes] = useState([]);
  return (
    <div class="setup-columns">
      <div class="setup-col">
        <Artnet nodes={nodes} setNodes={setNodes} />
        <Sacn />
      </div>
      <div class="setup-col">
        <Universes nodes={nodes} />
        <Wled />
        <Hue />
      </div>
    </div>
  );
}
