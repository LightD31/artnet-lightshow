import { useState } from 'preact/hooks';
import { pick, connectedSig, emitFixture, api, toast } from '../../state.js';
import { post } from '../../setup-state.js';
import { footprintOf, overlaps, hasNoAddress } from '../../../src/shared/placement.ts';
import { rigSelectionSig, selectOnly, toggleSelected, identifyFixtures } from '../../rig-ui.js';
import { FieldInput } from './FieldInput.jsx';

/**
 * The patch as a table: each fixture's label, profile, universe and address,
 * the channels it takes, and whether it collides with another. Selecting a
 * row selects the fixture on the plan and in the inspector.
 */

const profileLabel = (p) => `${p.manufacturer ? `${p.manufacturer} ` : ''}${p.name}${p.modeName ? ` — ${p.modeName}` : ''}`;
const cellCount = (p) => (p && Array.isArray(p.cells) && p.cells.length >= 2 ? p.cells.length : 0);

/** The fixtures that share a channel with another, by id. Hue lamps have no channels to share. */
export function conflictsOf(fixtures, profiles) {
  fixtures = fixtures.filter((f) => !hasNoAddress(f));
  const parts = fixtures.map((f) => footprintOf(f.universe ?? 0, f.address, profiles[f.profileId] || { channelCount: 1, channelMap: {} }));
  const out = new Set();
  for (let i = 0; i < fixtures.length; i++) {
    for (let j = i + 1; j < fixtures.length; j++) {
      if (overlaps(parts[i], parts[j])) { out.add(fixtures[i].id); out.add(fixtures[j].id); }
    }
  }
  return out;
}

/** "1–12", or "1–150 on 3" for a strip that runs on into later universes. */
function rangeOf(fix, profile) {
  const parts = footprintOf(fix.universe ?? 0, fix.address, profile || { channelCount: 1, channelMap: {} });
  const last = parts[parts.length - 1];
  return parts.length > 1 ? `${fix.address}–${last.last} on ${last.universe}` : `${fix.address}–${last.last}`;
}

async function removeFixture(fix) {
  const res = await api(`/api/fixtures/${fix.id}`, { method: 'DELETE' });
  if (!res.ok) return;
  rigSelectionSig.value = rigSelectionSig.value.filter((id) => id !== fix.id);
  // The server answers with what it removed and where, so undo puts it back
  // in the same row with its address, universe and override.
  toast.push({
    message: `Removed "${res.fixture.label}"`,
    action: { label: 'Undo', onClick: () => post('/api/fixtures/restore', { index: res.index, fixture: res.fixture }) },
  });
}

/**
 * Add fixtures: one of a profile, or a run of them from an address. A Hue lamp
 * has no DMX address, so on a Hue lamp profile there is none to ask for.
 */
export function AddFixtures({ onAdded }) {
  const s = pick(['profiles', 'artnet', 'builtinProfileIds', 'hueProfileIds']);
  const profiles = Object.values(s.profiles || {});
  const [profileId, setProfileId] = useState('');
  const [count, setCount] = useState('1');
  const [universe, setUniverse] = useState('');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = profileId || (profiles[0] && profiles[0].id) || '';
  const hue = (s.hueProfileIds || []).includes(chosen);
  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = { profileId: chosen, count: Math.max(1, Math.min(64, parseInt(count, 10) || 1)) };
    if (!hue && universe !== '') body.universe = parseInt(universe, 10);
    if (!hue && address !== '') body.address = parseInt(address, 10);
    if (label.trim()) body.label = label.trim();
    const res = await post('/api/fixtures', body);
    setBusy(false);
    if (!res.ok) return;
    const n = res.fixtures.length;
    if (res.addressless) toast.info(`Added ${n} Hue lamp${n === 1 ? '' : 's'}, with no DMX address — pick ${n === 1 ? 'its' : 'their'} Hue channel${n === 1 ? '' : 's'} in Outputs`);
    else toast.info(`Added ${n} fixture${n === 1 ? '' : 's'}, from universe ${res.placed[0].universe} / ${res.placed[0].address}`);
    rigSelectionSig.value = res.fixtures;
    if (onAdded) onAdded(res);
  };
  return (
    <form class="add-fixtures" onSubmit={add} aria-label="Add fixtures">
      <label class="add-field add-profile">
        <span>Profile</span>
        <select value={chosen} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
        </select>
      </label>
      <label class="add-field"><span>How many</span>
        <input type="number" min="1" max="64" value={count} onInput={(e) => setCount(e.target.value)} /></label>
      {hue ? (
        <p class="add-field add-note setting-help">No DMX address: a Hue lamp is driven by the bridge, and shows the colour
          of this fixture through the Hue channel that follows it.</p>
      ) : <>
        <label class="add-field"><span>Universe</span>
          <input type="number" min="0" max="32767" placeholder={String((s.artnet && s.artnet.universe) ?? 0)} value={universe}
            onInput={(e) => setUniverse(e.target.value)} /></label>
        <label class="add-field"><span>From address</span>
          <input type="number" min="1" max="512" placeholder="next free" value={address} onInput={(e) => setAddress(e.target.value)} /></label>
      </>}
      <label class="add-field"><span>Name</span>
        <input type="text" maxLength={56} placeholder="Fixture" value={label} onInput={(e) => setLabel(e.target.value)} /></label>
      <button type="submit" class="btn active" disabled={busy || !chosen || !connectedSig.value}>Add</button>
    </form>
  );
}

export function PatchTable() {
  const s = pick(['fixtures', 'profiles', 'identify']);
  const connected = connectedSig.value;
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const selected = rigSelectionSig.value;
  const identifying = new Set((s.identify && s.identify.ids) || []);
  const conflicts = conflictsOf(fixtures, profiles);
  const allProfiles = Object.values(profiles);
  const send = (payload) => {
    if (!connected) { toast.error('Disconnected — reconnect before editing the patch.'); return; }
    emitFixture(payload);
  };

  return (
    <section class="panel patch-panel" aria-labelledby="patch-title">
      <header class="panel-head">
        <h2 class="panel-title" id="patch-title">Patch</h2>
        {conflicts.size > 0 && <span class="panel-tag warn">{conflicts.size} overlapping</span>}
      </header>
      <p class="section-desc">Each fixture's profile, universe and first DMX address. Addresses only collide within the same
        universe. A Hue lamp has none: the bridge drives it.</p>
      <div class="table-scroll">
        <table class="patch-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Label</th>
              <th scope="col">Profile</th>
              <th scope="col">Universe</th>
              <th scope="col">Address</th>
              <th scope="col">Channels</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {fixtures.map((fix, index) => {
              const profile = profiles[fix.profileId];
              const cells = cellCount(profile);
              const clash = conflicts.has(fix.id);
              const isSelected = selected.includes(fix.id);
              return (
                <tr key={fix.id} class={`${isSelected ? 'selected' : ''} ${identifying.has(fix.id) ? 'identifying' : ''}`}
                  onClick={(e) => {
                    if (e.target.closest('input, select, button')) return;
                    if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelected(fix.id); else selectOnly(fix.id);
                  }}>
                  <td class="patch-num">
                    {/* The fixture's place in the patch, as the plan numbers it. */}
                    <input type="checkbox" checked={isSelected} aria-label={`Select ${fix.label}`}
                      onChange={() => toggleSelected(fix.id)} />
                    <span>{index + 1}</span>
                  </td>
                  <td><FieldInput value={fix.label} maxLength={64} aria-label={`Label of fixture ${index + 1}`}
                    onCommit={(label) => send({ id: fix.id, label })} /></td>
                  <td>
                    <select value={fix.profileId} aria-label={`Profile of ${fix.label}`} onChange={(e) => send({ id: fix.id, profileId: e.target.value })}>
                      {!profile && <option value={fix.profileId}>{fix.profileId} (missing)</option>}
                      {allProfiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
                    </select>
                  </td>
                  {hasNoAddress(fix) ? (
                    <td colSpan={2}>
                      <span class="patch-hue" title="Driven by the Hue bridge: shown through the Hue channel that follows it, never on DMX">
                        Hue lamp · no DMX address</span>
                      <button type="button" class="btn sm" disabled={!connected} aria-label={`Put ${fix.label} on DMX`}
                        title="Give it a DMX address after the last fixture on the rig's universe"
                        onClick={() => send({ id: fix.id, output: null })}>Put on DMX</button>
                    </td>
                  ) : <>
                  <td>
                    <FieldInput type="number" min="0" max="32767" class={clash ? 'addr-conflict' : ''} value={fix.universe ?? 0}
                      aria-label={`Universe of ${fix.label}`}
                      onCommit={(v) => send({ id: fix.id, universe: Number.isInteger(v) && v >= 0 ? v : 0 })} />
                    {fix.output && fix.output.protocol === 'ddp' && (
                      <span class="patch-wled">
                        <span class="addr-range">WLED</span>
                        <FieldInput value={fix.output.host} class="wled-host" aria-label={`WLED address of ${fix.label}`}
                          title="Sent to this WLED over DDP. Empty it to send on Art-Net and sACN instead."
                          onCommit={(host) => send({ id: fix.id, output: host.trim() ? { protocol: 'ddp', host: host.trim() } : null })} />
                      </span>
                    )}
                  </td>
                  <td>
                    <FieldInput type="number" min="1" max="512" class={clash ? 'addr-conflict' : ''} value={fix.address}
                      aria-label={`DMX address of ${fix.label}`} aria-invalid={clash}
                      onCommit={(v) => send({ id: fix.id, address: Number.isInteger(v) && v >= 1 ? v : 1 })} />
                    <span class="addr-range">{rangeOf(fix, profile)}</span>
                    {clash && <span class="conflict-warning">Overlaps another fixture</span>}
                  </td>
                  </>}
                  <td class="ch-count">{profile ? profile.channelCount : '?'}{cells ? ` (${cells} cells)` : ''}</td>
                  <td class="patch-actions-cell">
                    <button type="button" class={`btn sm ${identifying.has(fix.id) ? 'active' : ''}`} disabled={!connected}
                      aria-label={`Identify ${fix.label}`} onClick={() => identifyFixtures([fix.id])}>Identify</button>
                    <button type="button" class="remove-btn" aria-label={`Remove ${fix.label}`} title="Remove fixture"
                      disabled={fixtures.length <= 1} onClick={() => removeFixture(fix)}>×</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <AddFixtures />
    </section>
  );
}
