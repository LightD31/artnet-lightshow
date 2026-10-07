import { useEffect, useState } from 'preact/hooks';
import { api, pick } from '../state.js';
import { beatsPerBar, positionText, presetNameOf } from '../preview-inputs.js';

/**
 * The sequence transport: pick a saved sequence, then play, pause, stop,
 * next, shuffle and loop it. The position reads bars.beats, and each lane
 * names the clip it plays now. Status and the shelf come from the live
 * `sequence` and `sequences` keys; the loaded sequence (for names and the
 * bar length) from REST.
 */

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

const post = (path, body) => api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });

export function Transport({ initial } = {}) {
  const s = pick(['sequence', 'sequences', 'effects']);
  const status = s.sequence || null;
  const sequences = s.sequences || [];
  const [sequence, setSequence] = useState(initial ? initial.sequence : null);
  const loadedId = status && status.loaded ? status.loaded.id : '';
  const revision = status ? status.revision : 0;
  // The loaded sequence again whenever another is loaded or it is edited.
  useEffect(() => {
    if (initial) return;
    if (!loadedId) { setSequence(null); return; }
    // Only the latest of overlapping loads lands.
    let live = true;
    api('/api/sequence').then((res) => { if (live && res.ok) setSequence(res.sequence || null); });
    return () => { live = false; };
  }, [loadedId, revision]);

  const loaded = !!loadedId;
  const playing = !!(status && status.playing && !status.paused);
  const loop = loopBody(status);
  const perBar = beatsPerBar(sequence && sequence.timeSignature);
  const lanes = laneRows(status, sequence, presetNameOf(s.effects));
  // The first entry unloads: a stopped sequence holds its picture, and this gives the rig back to the look.
  const pick_ = (id) => (id ? api('/api/sequence', { method: 'PUT', body: JSON.stringify({ id }) }) : api('/api/sequence', { method: 'DELETE' }));

  return (
    <section class="perform-transport" aria-label="Transport">
      <div class="transport-row">
        <select class="transport-picker" aria-label="Sequence" value={loadedId} onChange={(e) => pick_(e.target.value)}>
          <option value="" selected={!loadedId}>{loadedId ? 'No sequence (back to the look)' : 'Pick a sequence'}</option>
          {sequences.map((q) => <option key={q.id} value={q.id} selected={q.id === loadedId}>{q.name || q.id}</option>)}
        </select>
        <span class="transport-position" aria-label="Position, bars and beats">{loaded ? positionText(status, perBar) : '–'}</span>
      </div>
      <div class="transport-buttons">
        {playing
          ? <button type="button" class="transport-btn" aria-label="Pause" onClick={() => post('/api/sequence/pause')}>❚❚</button>
          : <button type="button" class="transport-btn" aria-label="Play" disabled={!loaded} onClick={() => post('/api/sequence/play')}>▶</button>}
        <button type="button" class="transport-btn" aria-label="Stop" disabled={!loaded} onClick={() => post('/api/sequence/stop')}>■</button>
        <button type="button" class="transport-btn" aria-label="Next" disabled={!loaded} onClick={() => post('/api/sequence/next')}><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M5 4v16l11-8zM17 4h3v16h-3z" /></svg></button>
        <button type="button" class="transport-btn" aria-label="Shuffle" disabled={!loaded} onClick={() => post('/api/sequence/shuffle')}><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 4-4m4-4c1-2 2-4 4-4h3m-4-4 4 4-4 4" /></svg></button>
        <button type="button" class="transport-btn" aria-label="Loop" aria-pressed={!!(status && status.loop && status.loop.on)}
          disabled={!loop} title={loop ? 'Loop the region' : 'Set a loop region in the Sequence editor'}
          onClick={() => post('/api/sequence/loop', loop)}>↻</button>
      </div>
      {lanes.length > 0 && (
        <ul class="transport-lanes">
          {lanes.map((l) => <li key={l.id}><span class="lane-name">{l.lane}</span> <span class="lane-clip">{l.clip || '—'}</span></li>)}
        </ul>
      )}
      {status && status.error && <p class="transport-error" role="status">{status.error.message || String(status.error)}</p>}
    </section>
  );
}
