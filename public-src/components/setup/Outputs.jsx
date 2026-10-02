import { useEffect, useRef, useState } from 'preact/hooks';
import { pick, send, connectedSig, toast } from '../../state.js';
import { settingsSig, loadSettings, saveSettings, networkInterfaces, post, at } from '../../setup-state.js';
import { footprintOf, hasNoAddress } from '../../../src/shared/placement.ts';
import { identify } from '../../rig-ui.js';
import { SettingsSection } from './Section.jsx';
import { ARTNET, SACN, HUE } from './specs.js';

/**
 * Where the rig's DMX goes, and what is out there to send it to: Art-Net
 * nodes that answer a poll, other sACN sources on the network, WLEDs that
 * announce themselves and the Hue bridges. Each can be made to show itself —
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
    if (!profile || hasNoAddress(fix)) continue;
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

// What a WLED is patched as (server/wled.ts), as a DMX bar has a 3-channel
// mode and a pixel one.
const WLED_MODES = [
  { id: 'wash', label: 'Wash', help: 'One light, every LED the same colour: it washes, chases, strobes and blinds with the pars.' },
  { id: 'zones', label: 'Zones', help: 'A few cells along it, like an LED bar: chases and stacks run across them.' },
  { id: 'pixels', label: 'Pixels', help: 'Every LED its own cell, and a panel a picture: for a screen or a matrix.' },
  { id: 'strobe', label: 'Strobe panel', help: 'A matrix as a strobe panel: a line of white segments across its middle, lit only by strobes and blinders, with square colour zones above and below.' },
];

function Wled() {
  const [devices, setDevices] = useState(null);
  const [status, setStatus] = useState('');
  const [host, setHost] = useState('');
  const [mode, setMode] = useState('zones');
  const [zones, setZones] = useState(8);
  const find = async () => {
    setStatus('Asking the network…');
    const data = await getJson('/api/wled/discover');
    if (!data.ok) { setStatus(data.error); return; }
    setDevices(data.devices || []);
    setStatus(data.devices.length ? `${plural(data.devices.length, 'WLED')} answered.`
      : 'No WLED answered. mDNS does not cross routers or VLANs: add one by its address below.');
  };
  const add = async (address, segments = false) => {
    setStatus(`Asking ${address}…`);
    const look = mode === 'zones' || mode === 'strobe' ? { mode, zones } : { mode };
    const res = await post('/api/wled/add', { host: address, ...(segments ? { segments: true } : {}), ...look });
    if (!res.ok) { setStatus(res.error); return; }
    const added = segments ? res.fixtures : [res.fixture];
    const labels = added.map((f) => f.label).join(', ');
    setStatus(segments
      ? `Added ${plural(added.length, 'segment')} of ${res.info.name}, each a fixture of its own: ${labels}. Place them on the plan.`
      : `Added "${res.fixture.label}": ${res.profile.modeName}, from universe ${res.fixture.universe}.`);
    setDevices((list) => (list || []).map((d) => (d.host === address ? { ...d, patched: labels } : d)));
    toast.info(segments ? `Added ${plural(added.length, 'segment')} of ${res.info.name} to the patch` : `Added ${res.fixture.label} to the patch`);
  };
  const flash = async (address) => {
    const res = await post('/api/wled/identify', { host: address });
    if (res.ok) toast.info(res.via === 'patch' ? 'It shows itself through the patch: a wash blinks white, zones and pixels light green to red' : `Its ${res.leds} LEDs flash: the first green, the last red`);
  };
  return (
    <section class="panel" aria-labelledby="wled-title">
      <header class="panel-head"><h2 class="panel-title" id="wled-title">WLED</h2></header>
      <p class="section-desc">WLED strips and panels, sent their pixels over DDP rather than Art-Net. Adding one reads its LED
        count (and its grid, set up as a panel) from the device and patches it on universes of its own, as a wash, in zones
        or pixel by pixel. <em>Add each segment</em> makes every segment set up in WLED a fixture of its own — the front of
        the booth and its sides, or a panel's halves — to be placed on the plan one by one.</p>
      <div class="inline-form wled-mode">
        <label for="wled-mode">Patch as</label>
        <select id="wled-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          {WLED_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {(mode === 'zones' || mode === 'strobe') && <>
          <label for="wled-zones">{mode === 'strobe' ? 'Zones across' : 'Zones'}</label>
          <input id="wled-zones" type="number" min="2" max="64" value={zones}
            onChange={(e) => setZones(Math.max(2, Math.min(64, Math.round(Number(e.target.value)) || 8)))} />
        </>}
        <p class="setting-help">{WLED_MODES.find((m) => m.id === mode).help}</p>
      </div>
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
                        : !d.error && <>
                          <button type="button" class="btn sm active" onClick={() => add(d.host)}>Add to patch</button>
                          {d.segments > 1 && <button type="button" class="btn sm" aria-label={`Add each of ${d.name}'s ${d.segments} segments`}
                            onClick={() => add(d.host, true)}>Add each segment ({d.segments})</button>}
                        </>}
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
          <button type="button" class="btn sm" disabled={!host.trim()} onClick={() => add(host.trim(), true)}>Add each segment</button>
        </form>
      </div>
    </section>
  );
}

// ── Philips Hue ──────────────────────────────────────────────────────────────

/** What a lamp can show, as the bridge reports it (server/hue.ts). */
const LAMP_KIND = { color: 'Colour', ambiance: 'White ambiance', white: 'White' };

/**
 * Change one bridge's entry: the list is saved back through the settings as
 * any setting is. The keys come to the page blank and go back blank, which
 * the server reads as "keep them"; the list is read again first, so a bridge
 * paired from another page is not dropped by this one's copy.
 */
async function saveBridge(id, patch) {
  const data = await loadSettings();
  const bridges = (at(data && data.settings, 'hue.bridges') || []).map((b) => (b.id === id ? { ...b, ...patch } : b));
  return saveSettings({ hue: { bridges } });
}

/**
 * One bridge: its name, whether it is on, the area it streams, and the
 * area's lamps with Add and Identify. `patched` is channel → fixture label
 * for the lamps of this bridge already in the patch.
 */
function HueBridge({ bridge, patched, onChanged, onPair, notify }) {
  const [areas, setAreas] = useState(null);         // /api/hue/:bridge/areas: the list, or { error }
  const [lamps, setLamps] = useState(null);         // /api/hue/:bridge/lamps: { area, lamps } or { error }
  const [area, setArea] = useState(bridge.area);
  const [label, setLabel] = useState(bridge.label);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setArea(bridge.area); }, [bridge.area]);
  useEffect(() => { setLabel(bridge.label); }, [bridge.label]);
  useEffect(() => {
    if (!bridge.paired) { setAreas(null); return; }
    getJson(`/api/hue/${bridge.id}/areas`).then((res) => setAreas(res.ok ? res.areas || [] : { error: res.error }));
  }, [bridge.id, bridge.paired]);
  // The lamps of the area being streamed to: read again when another is picked.
  useEffect(() => {
    if (!bridge.paired || !bridge.area) { setLamps(null); return; }
    getJson(`/api/hue/${bridge.id}/lamps`).then((res) => setLamps(res.ok ? res : { error: res.error }));
  }, [bridge.id, bridge.paired, bridge.area]);

  const save = async (patch) => {
    setBusy(true);
    const res = await saveBridge(bridge.id, patch);
    setBusy(false);
    if (res.ok) await onChanged();
    return res;
  };
  const dirty = area !== bridge.area || label.trim() !== bridge.label;
  const forget = async () => {
    const mine = [...patched.values()];
    if (mine.length && !window.confirm(`Forget "${bridge.label}" and remove its ${plural(mine.length, 'lamp')} from the patch?\n\n${mine.join(', ')}`)) return;
    const res = await post(`/api/hue/${bridge.id}/disconnect`, mine.length ? { removeFixtures: true } : {});
    if (!res.ok) return;
    notify({ ok: true, text: `"${bridge.label}" forgotten. Remove this integration in the Hue app under linked devices.` });
    await onChanged();
  };
  const flash = async (channel) => {
    const res = await post(`/api/hue/${bridge.id}/identify`, { channel });
    if (res.ok) toast.info(res.via === 'fixture' ? 'The lamp flashes through the patch' : `The bridge asks ${plural(res.lamps, 'lamp')} to breathe`);
  };
  // A lamp is added as a WLED is: a fixture of its own, on the profile for
  // what the bridge says it can show, with no DMX address.
  const add = async (channels) => {
    const res = await post(`/api/hue/${bridge.id}/add`, channels ? { channels } : {});
    if (!res.ok) { notify({ ok: false, text: res.error }); return; }
    const labels = res.fixtures.map((f) => f.label).join(', ');
    notify({ ok: true, text: `Added ${labels} from "${bridge.label}". Place ${res.fixtures.length === 1 ? 'it' : 'them'} on the plan.` });
    toast.info(`Added ${plural(res.fixtures.length, 'Hue lamp')} to the patch`);
  };

  const list = lamps && lamps.lamps ? lamps.lamps : [];
  const missing = list.filter((l) => !patched.has(l.id));
  const options = Array.isArray(areas) ? areas : [];
  const known = options.some((a) => a.id === area);
  const areaId = `hue-area-${bridge.id}`;
  return (
    <div class="hue-bridge" data-bridge={bridge.id}>
      <div class="discovery-head hue-bridge-head">
        <input class="hue-bridge-label" type="text" maxLength={64} value={label} aria-label={`Name of the bridge at ${bridge.host}`}
          onInput={(e) => setLabel(e.target.value)} />
        <span class="mono">{bridge.host}</span>
        <span class={`setting-help ${bridge.stream === 'failed' ? 'setting-note warn' : ''}`}>
          {bridge.paired ? 'paired' : 'not paired'} · stream: {bridge.stream}{bridge.lastError ? ` — ${bridge.lastError}` : ''}
        </span>
        <label class="hue-bridge-enabled">
          <input type="checkbox" checked={!!bridge.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} /> Enabled
        </label>
        <button type="button" class="btn sm" title="Press the round button on the bridge, then this" onClick={() => onPair(bridge.host)}>Pair again</button>
        <button type="button" class="btn sm danger" onClick={forget}>Forget</button>
      </div>
      <div class="inline-form">
        <label for={areaId}>Entertainment area</label>
        <select id={areaId} value={area} disabled={!bridge.paired} onChange={(e) => setArea(e.target.value)}>
          {(!options.length || !known) && (
            <option value={area}>
              {options.length ? `${area} (not on the bridge)` : area || (bridge.paired ? 'none picked' : 'pair with the bridge first')}
            </option>
          )}
          {options.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.channels.length} channels)</option>)}
        </select>
        <button type="button" class="btn sm active" disabled={busy || !dirty}
          onClick={() => save({ label: label.trim() || bridge.host, entertainmentId: area })}>Apply</button>
        {areas && areas.error && <span class="setting-help setting-note warn">{areas.error}</span>}
      </div>
      {lamps && lamps.error && <p class="setting-help setting-note warn">{lamps.error}</p>}
      {lamps && lamps.area && (
        <>
          <div class="discovery-head">
            <span class="setting-help">Lamps of "{lamps.area.name}", as the Hue app names them.</span>
            {missing.length > 0 && <button type="button" class="btn sm active" disabled={!connectedSig.value}
              onClick={() => add(null)}>Add {missing.length === list.length ? 'all' : `the other ${missing.length}`}</button>}
          </div>
          <div class="table-scroll">
            <table class="patch-table">
              <thead><tr><th scope="col">Channel</th><th scope="col">Lamp</th><th scope="col">Shows</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((ch) => (
                  <tr key={ch.id}>
                    <td class="mono">#{ch.id}</td>
                    <td>{ch.name || '—'}{ch.product && <span class="setting-help"> · {ch.product}</span>}</td>
                    <td>{ch.kind ? LAMP_KIND[ch.kind] : 'unknown'}</td>
                    <td class="patch-actions-cell">
                      <button type="button" class="btn sm" aria-label={`Identify channel ${ch.id} of ${bridge.label}`} onClick={() => flash(ch.id)}>Identify</button>
                      {patched.has(ch.id) ? <span class="setting-help">In the patch as "{patched.get(ch.id)}"</span>
                        : <button type="button" class="btn sm active" disabled={!connectedSig.value || !ch.kind}
                          aria-label={`Add channel ${ch.id} of ${bridge.label} to the patch`} onClick={() => add([ch.id])}>Add to patch</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Hue() {
  const s = pick(['fixtures']);
  const [info, setInfo] = useState(null);           // /api/hue/status
  const [found, setFound] = useState([]);           // /api/hue/discover
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [notice, setNotice] = useState(null);       // { ok, text }

  const refresh = async () => {
    const status = await getJson('/api/hue/status');
    if (status.ok) setInfo(status);
  };
  useEffect(() => { refresh(); }, []);
  const changed = async () => { await loadSettings(); await refresh(); };

  const find = async () => {
    setNotice({ ok: true, text: 'Looking for bridges…' });
    const res = await getJson('/api/hue/discover');
    if (!res.ok) { setNotice({ ok: false, text: res.error }); return; }
    setFound(res.bridges || []);
    setNotice(res.bridges.length ? { ok: true, text: `Found ${plural(res.bridges.length, 'bridge')}: ${res.bridges.map((b) => b.host).join(', ')}` }
      : { ok: false, text: res.error ? `No bridges found — ${res.error}. Type the bridge address in.` : 'No bridges answered. Type the bridge address in.' });
  };
  // A bridge is paired by its address: a new one is added to the list, one
  // already there gets fresh keys.
  const pair = async (address) => {
    const target = (address || host).trim();
    if (!target) { setNotice({ ok: false, text: 'Enter the bridge address first, or press Find bridges.' }); return; }
    setNotice({ ok: true, text: `Press the round button on the bridge at ${target} now…` });
    const res = await post('/api/hue/pair', { host: target, ...(label.trim() ? { label: label.trim() } : {}) });
    if (!res.ok) { setNotice({ ok: false, text: res.error }); return; }
    setNotice(res.areasError ? { ok: false, text: `Paired "${res.bridge.label}", but its areas could not be read — ${res.areasError}` }
      : { ok: true, text: `Paired "${res.bridge.label}". Pick its entertainment area and apply, then add its lamps.` });
    setHost('');
    setLabel('');
    await changed();
  };
  const syncTest = async () => {
    const res = await post('/api/hue/sync-test', {});
    if (res.ok) setNotice({ ok: true, text: `Every fixture flashes once a second for ${res.seconds} s. Apply the delay first if you changed it.` });
  };

  const bridges = (info && info.bridges) || [];
  // Which fixture each channel of each bridge is, from the live patch.
  const patched = new Map();
  for (const f of s.fixtures || []) {
    if (!f.output || f.output.protocol !== 'hue') continue;
    const mine = patched.get(f.output.bridge) || new Map();
    if (!mine.has(f.output.channel)) mine.set(f.output.channel, f.label);
    patched.set(f.output.bridge, mine);
  }

  return (
    <SettingsSection {...HUE} onApply={async (patch) => {
      const res = await saveSettings(patch);
      if (res.ok) await refresh();
      return res;
    }}>
      <div class="hue-tools">
        <form class="inline-form" onSubmit={(e) => { e.preventDefault(); pair(); }}>
          <label for="hue-host">Add bridge</label>
          <input id="hue-host" type="text" maxLength={253} placeholder="192.168.1.40" value={host} onInput={(e) => setHost(e.target.value)} />
          <input id="hue-label" type="text" maxLength={64} placeholder="Name (optional)" aria-label="Name for the bridge" value={label}
            onInput={(e) => setLabel(e.target.value)} />
          <button type="button" class="btn sm" onClick={find}>Find bridges</button>
          <button type="submit" class="btn sm active" disabled={!host.trim()} title="Press the round button on the bridge, then this">Pair</button>
          {bridges.length > 0 && <button type="button" class="btn sm" onClick={syncTest}
            title="Every fixture flashes white once a second, pars and Hue lamps together">Flash for 10 s</button>}
        </form>
        {notice && <p class={`setting-help setting-note ${notice.ok ? '' : 'warn'}`} role="status">{notice.text}</p>}
        {found.length > 0 && (
          <div class="table-scroll">
            <table class="patch-table">
              <thead><tr><th scope="col">Bridge</th><th scope="col">Address</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {found.map((b) => (
                  <tr key={b.host}>
                    <td class="mono">{b.id || '—'}</td>
                    <td class="mono">{b.host}</td>
                    <td class="patch-actions-cell">
                      {bridges.some((x) => x.host === b.host) ? <span class="setting-help">Paired</span>
                        : <button type="button" class="btn sm active" title="Press the round button on the bridge, then this" onClick={() => pair(b.host)}>Pair</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {info && !bridges.length && <p class="setting-help">No bridge paired yet: find one or type its address, press its round button, then Pair.</p>}
        {bridges.map((b) => (
          <HueBridge key={b.id} bridge={b} patched={patched.get(b.id) || new Map()} onChanged={changed} onPair={pair} notify={setNotice} />
        ))}
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
