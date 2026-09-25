import { pick, connectedSig, emitFixture } from '../../state.js';
import { stagePositions } from '../../../src/shared/stage.ts';
import { buildRig, lineOf } from '../../../src/shared/rig.ts';
import { clamp, geometryOf, round1 } from '../../stage-geometry.js';
import { rigSelectionSig, identifyFixtures } from '../../rig-ui.js';
import { FieldInput } from './FieldInput.jsx';
import { hasNoAddress } from '../../../src/shared/placement.ts';

/**
 * The selected fixture, every property of it in one place: what it is, where
 * it is patched, where it stands on the plan and — for a bar — which way it
 * runs. Several selected: what they are, and identifying them together.
 */
export function Inspector() {
  const s = pick(['fixtures', 'profiles', 'identify']);
  const connected = connectedSig.value;
  const fixtures = s.fixtures || [];
  const profiles = s.profiles || {};
  const selected = rigSelectionSig.value.filter((id) => fixtures.some((f) => f.id === id));
  const identifying = new Set((s.identify && s.identify.ids) || []);

  if (!selected.length) {
    return (
      <aside class="panel inspector" aria-labelledby="inspector-title">
        <header class="panel-head"><h2 class="panel-title" id="inspector-title">Fixture</h2></header>
        <p class="panel-empty">Select a fixture on the plan or in the patch to see and change it here. Drag across the
          plan to select several.</p>
      </aside>
    );
  }
  if (selected.length > 1) {
    const chosen = fixtures.filter((f) => selected.includes(f.id));
    return (
      <aside class="panel inspector" aria-labelledby="inspector-title">
        <header class="panel-head"><h2 class="panel-title" id="inspector-title">{chosen.length} fixtures</h2></header>
        <ul class="inspector-list">{chosen.map((f) => <li key={f.id}>{f.label}</li>)}</ul>
        <div class="inspector-actions">
          <button type="button" class="btn sm" disabled={!connected} onClick={() => identifyFixtures(selected)}>Identify all</button>
          <button type="button" class="btn sm" onClick={() => { rigSelectionSig.value = []; }}>Clear selection</button>
        </div>
      </aside>
    );
  }

  const index = fixtures.findIndex((f) => f.id === selected[0]);
  const fix = fixtures[index];
  const profile = profiles[fix.profileId];
  const rig = buildRig(fixtures, (f) => profiles[f.profileId] || null);
  const point = stagePositions(fixtures)[index];
  const bar = !!rig.cellMaps[index];
  const grid = rig.grids[index];
  const unplaced = fixtures.filter((f) => !f.position).length;
  const line = bar ? lineOf(fix, grid ? grid.columns : rig.ranges[index].count, fix.position ? 0 : unplaced) : null;
  const send = (patch) => emitFixture({ id: fix.id, ...patch });
  const place = (patch) => send({ position: { x: clamp(round1(patch.x ?? point.x)), y: clamp(round1(patch.y ?? point.y)) } });
  const trimPct = Math.round(((fix.maxBrightness ?? 255) / 255) * 100);
  const hueOnly = hasNoAddress(fix);
  const wled = !!(fix.output && fix.output.protocol === 'ddp');

  return (
    <aside class="panel inspector" aria-labelledby="inspector-title">
      <header class="panel-head">
        <h2 class="panel-title" id="inspector-title">Fixture {index + 1}</h2>
        {identifying.has(fix.id) && <span class="panel-tag">Identifying</span>}
      </header>
      <div class="inspector-grid">
        <label for="insp-label">Label</label>
        <FieldInput id="insp-label" value={fix.label} maxLength={64} onCommit={(label) => send({ label })} />
        <span class="inspector-key">Profile</span>
        <span class="inspector-value">{profile ? `${profile.name}${profile.modeName ? ` — ${profile.modeName}` : ''}` : fix.profileId}
          {profile && <small> · {profile.channelCount} ch{bar ? `, ${grid ? `${grid.columns} × ${grid.rows}` : rig.ranges[index].count} cells` : ''}</small>}</span>
        <label for="insp-output">Output</label>
        {wled ? <span class="inspector-value">WLED at {fix.output.host}, over DDP</span> : (
          <select id="insp-output" value={hueOnly ? 'hue' : 'dmx'} disabled={!connected} aria-describedby={hueOnly ? 'insp-output-help' : undefined}
            onChange={(e) => send({ output: e.target.value === 'hue' ? { protocol: 'hue' } : null })}>
            <option value="dmx">DMX (Art-Net, sACN)</option>
            <option value="hue">Hue lamp (no DMX)</option>
          </select>
        )}
        {!hueOnly && <>
          <label for="insp-universe">Universe</label>
          <FieldInput id="insp-universe" type="number" min="0" max="32767" value={fix.universe ?? 0} onCommit={(v) => send({ universe: v })} />
          <label for="insp-address">Address</label>
          <FieldInput id="insp-address" type="number" min="1" max="512" value={fix.address} onCommit={(v) => send({ address: v })} />
        </>}
        <label for="insp-x">Across</label>
        <FieldInput id="insp-x" type="number" min="0" max="100" step="0.5" value={round1(point.x)} onCommit={(x) => place({ x })} />
        <label for="insp-y">Depth</label>
        <FieldInput id="insp-y" type="number" min="0" max="100" step="0.5" value={round1(point.y)} onCommit={(y) => place({ y })} />
        {bar && <>
          <label for="insp-length">Length</label>
          <FieldInput id="insp-length" type="number" min="1" max="100" step="0.5" value={round1(line.length)}
            onCommit={(length) => send({ geometry: geometryOf(length, line.angle) })} />
          <label for="insp-angle">Angle</label>
          <FieldInput id="insp-angle" type="number" min="-180" max="180" step="5" value={round1(line.angle)}
            onCommit={(angle) => send({ geometry: geometryOf(line.length, angle) })} />
        </>}
        <label for="insp-trim">Trim</label>
        <span class="inspector-trim">
          <input id="insp-trim" type="range" min="0" max="255" value={fix.maxBrightness ?? 255}
            aria-valuetext={`${trimPct} percent`} onChange={(e) => send({ maxBrightness: parseInt(e.target.value, 10) })} />
          <span>{trimPct}%</span>
        </span>
      </div>
      {hueOnly && <p class="setting-help" id="insp-output-help">The Hue bridge drives it: it takes no DMX channels, and shows
        this fixture's colour through the Hue channel that follows it (Outputs → Philips Hue).</p>}
      <p class="setting-help">{fix.position ? '' : 'Not placed yet: drawn at its default spot. '}
        {bar ? 'At angle 0 its first cell is on the left and its last on the right; 180 is the other way round, and 90 runs from the back of the stage towards the audience.' : ''}</p>
      <div class="inspector-actions">
        <button type="button" class={`btn sm ${identifying.has(fix.id) ? 'active' : ''}`} disabled={!connected}
          onClick={() => identifyFixtures([fix.id])}>Identify</button>
        {bar && <button type="button" class="btn sm" disabled={!connected}
          title="Turn it end for end: for a bar hung the other way round"
          onClick={() => send({ geometry: geometryOf(line.length, line.angle + 180) })}>Reverse</button>}
        {(fix.position || fix.geometry) && <button type="button" class="btn sm" disabled={!connected}
          onClick={() => send({ position: null, geometry: null })}>Reset place</button>}
      </div>
    </aside>
  );
}
