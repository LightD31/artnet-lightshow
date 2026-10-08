import { useEffect, useState } from 'preact/hooks';
import { api, pick, send } from '../state.js';
import { beatsPerBar, positionText, presetNameOf } from '../preview-inputs.js';
import { chooseDriver, driverOf, transportButtons } from '../transport-model.js';

export { beatsPerBar, positionText };

/** The loaded region with `on` flipped; null when the sequence has none to flip. */
export function loopBody(status) {
  const loop = status && status.loop;
  return loop ? { on: !loop.on, startBeat: loop.startBeat, endBeat: loop.endBeat } : null;
}

/** Each lane and what plays on it: the clip's preset by name, 'Effect' for one of its own, its id before the sequence arrives. */
export function laneRows(status, sequence, nameOf = (id) => id) {
  const lanes = (sequence && sequence.lanes) || [];
  const clips = (sequence && sequence.clips) || [];
  const label = (clip) => {
    const c = clips.find((x) => x.id === clip);
    return !c ? clip : c.presetId ? nameOf(c.presetId) : 'Effect';
  };
  return ((status && status.lanes) || []).map(({ id, clip }) => {
    const lane = lanes.find((l) => l.id === id);
    return { id, lane: (lane && lane.name) || id, clip: clip ? label(clip) : null };
  });
}

const GLYPHS = { play: '▶', pause: '❚❚', stop: '■', next: '⏭', shuffle: '⤨', loop: '↻', cancel: '×' };

export async function runTransport(requests) {
  for (const request of requests) {
    if (request.set) { send(request.set); continue; }
    const result = await api(request.path, { method: request.method,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
    if (!result?.ok) return false;
  }
  return true;
}

export function Transport({ initial, compact = false, prefer = null } = {}) {
  const s = pick(['sequence', 'sequences', 'effects', 'running', 'showOn', 'autoShow', 'autoSource', 'activeSource']);
  const [chosen, setChosen] = useState(prefer);
  const driver = driverOf(s, chosen);
  const status = s.sequence || null;
  const sequences = s.sequences || [];
  const [sequence, setSequence] = useState(initial?.sequence || null);
  const loadedId = status?.loaded?.id || '';
  const revision = status?.revision || 0;
  useEffect(() => {
    // Only a sequence handed in stands in for the fetch: the Sequence view
    // passes its `initial`, which is {} in use, and its lanes need names.
    if (initial?.sequence || compact || driver !== 'sequence') return;
    if (!loadedId) { setSequence(null); return; }
    let live = true;
    api('/api/sequence').then((res) => { if (live && res.ok) setSequence(res.sequence || null); });
    return () => { live = false; };
  }, [loadedId, revision, driver]);

  const perBar = beatsPerBar(sequence?.timeSignature);
  const lanes = driver === 'sequence' ? laneRows(status, sequence, presetNameOf(s.effects)) : [];
  const buttons = transportButtons(driver, s);
  const value = driver === 'sequence' ? `sequence:${loadedId}` : driver;
  const change = async (next) => {
    if (await runTransport(chooseDriver(next, s))) setChosen(next === 'auto' ? 'auto' : null);
  };
  return (
    <section class={`perform-transport${compact ? ' transport-compact' : ''}`} aria-label="Transport">
      {!compact && <div class="transport-row">
        <select class="transport-picker" aria-label="Transport source" value={value} onChange={(e) => change(e.target.value)}>
          <option value="look" selected={value === 'look'}>Look by hand</option>
          <option value="auto" selected={value === 'auto'}>Auto show</option>
          {driver === 'sequence' && !loadedId && <option value="sequence:" disabled selected>Pick a sequence</option>}
          {loadedId && !sequences.some((q) => q.id === loadedId) && (
            <option value={`sequence:${loadedId}`} selected>{status?.loaded?.name || 'Unsaved sequence'} (not saved)</option>
          )}
          <optgroup label="Sequences">
            {sequences.map((q) => <option key={q.id} value={`sequence:${q.id}`} selected={q.id === loadedId}>{q.name || q.id}</option>)}
          </optgroup>
        </select>
        {driver === 'sequence' && <span class="transport-position" aria-label="Position, bars and beats">{loadedId ? positionText(status, perBar) : '–'}</span>}
      </div>}
      <div class="transport-buttons">
        {buttons.filter((b) => !compact || ['play', 'pause', 'stop', 'cancel'].includes(b.id)).map((b) => (
          <button key={b.id} type="button" class="transport-btn" aria-label={b.label} aria-pressed={b.pressed}
            disabled={!b.enabled} onClick={() => runTransport([b.request])}>
            <span aria-hidden="true">{GLYPHS[b.id]}</span><span>{b.label}</span>
          </button>
        ))}
      </div>
      {!compact && lanes.length > 0 && <ul class="transport-lanes">
        {lanes.map((l) => <li key={l.id}><span class="lane-name">{l.lane}</span> <span class="lane-clip">{l.clip || '—'}</span></li>)}
      </ul>}
      {!compact && driver === 'sequence' && status?.error && <p class="transport-error" role="status">{status.error.message || String(status.error)}</p>}
    </section>
  );
}
