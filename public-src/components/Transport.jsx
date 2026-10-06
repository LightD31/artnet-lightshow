import { useEffect, useState } from 'preact/hooks';
import { api, pick } from '../state.js';

/**
 * The sequence transport: pick a saved sequence, then play, pause, stop,
 * next, shuffle and loop it. The position reads bars.beats, and each lane
 * names the clip it plays now. Status comes from the live `sequence` key;
 * the shelf and the loaded sequence (for names and the bar length) from REST.
 */

/** Beats in a bar, in quarter notes: 6/8 is three. */
export function beatsPerBar(ts) {
  if (!ts || !(ts.beats > 0) || !(ts.unit > 0)) return 4;
  return (ts.beats * 4) / ts.unit;
}

/** "bar.beat", both counted from 1. The server's `bar` is already 1-based. */
export function positionText(status, perBar) {
  if (!status || !Number.isFinite(status.beat)) return '–';
  const bar = status.bar || Math.floor(status.beat / perBar) + 1;
  const inBar = Math.floor(status.beat - (bar - 1) * perBar + 1e-6) + 1;
  return `${bar}.${Math.min(Math.max(inBar, 1), Math.ceil(perBar))}`;
}

/** The loaded region with `on` flipped; null when the sequence has none to flip. */
export function loopBody(status) {
  const loop = status && status.loop;
  return loop ? { on: !loop.on, startBeat: loop.startBeat, endBeat: loop.endBeat } : null;
}

export function laneRows(status, sequence) {
  const lanes = (sequence && sequence.lanes) || [];
  const clips = (sequence && sequence.clips) || [];
  return ((status && status.lanes) || []).map(({ id, clip }) => {
    const lane = lanes.find((l) => l.id === id);
    const c = clip ? clips.find((x) => x.id === clip) : null;
    return { id, lane: (lane && lane.name) || id, clip: clip ? (c && c.name) || clip : null };
  });
}

const post = (path, body) => api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });

export function Transport({ initial } = {}) {
  const s = pick(['sequence']);
  const status = s.sequence || null;
  const [sequences, setSequences] = useState(initial ? initial.sequences : []);
  const [sequence, setSequence] = useState(initial ? initial.sequence : null);
  const loadedId = status && status.loaded ? status.loaded.id : '';
  const revision = status ? status.revision : 0;

  useEffect(() => {
    if (initial) return;
    api('/api/sequences').then((res) => { if (res.ok) setSequences(res.sequences || []); });
  }, []);
  // The loaded sequence again whenever another is loaded or it is edited.
  useEffect(() => {
    if (initial) return;
    if (!loadedId) { setSequence(null); return; }
    api('/api/sequence').then((res) => { if (res.ok) setSequence(res.sequence || null); });
  }, [loadedId, revision]);

  const loaded = !!loadedId;
  const playing = !!(status && status.playing && !status.paused);
  const loop = loopBody(status);
  const perBar = beatsPerBar(sequence && sequence.timeSignature);
  const lanes = laneRows(status, sequence);
  const pick_ = (id) => { if (id) api('/api/sequence', { method: 'PUT', body: JSON.stringify({ id }) }); };

  return (
    <section class="perform-transport" aria-label="Transport">
      <div class="transport-row">
        <select class="transport-picker" aria-label="Sequence" value={loadedId} onChange={(e) => pick_(e.target.value)}>
          <option value="" selected={!loadedId}>Pick a sequence</option>
          {sequences.map((q) => <option key={q.id} value={q.id} selected={q.id === loadedId}>{q.name || q.id}</option>)}
        </select>
        <span class="transport-position" aria-label="Position, bars and beats">{loaded ? positionText(status, perBar) : '–'}</span>
      </div>
      <div class="transport-buttons">
        {playing
          ? <button type="button" class="transport-btn" aria-label="Pause" onClick={() => post('/api/sequence/pause')}>❚❚</button>
          : <button type="button" class="transport-btn" aria-label="Play" disabled={!loaded} onClick={() => post('/api/sequence/play')}>▶</button>}
        <button type="button" class="transport-btn" aria-label="Stop" disabled={!loaded} onClick={() => post('/api/sequence/stop')}>■</button>
        <button type="button" class="transport-btn" aria-label="Next" disabled={!loaded} onClick={() => post('/api/sequence/next')}>⏭</button>
        <button type="button" class="transport-btn" aria-label="Shuffle" disabled={!loaded} onClick={() => post('/api/sequence/shuffle')}>⤮</button>
        <button type="button" class="transport-btn" aria-label="Loop" aria-pressed={!!(status && status.loop && status.loop.on)}
          disabled={!loop} title={loop ? 'Loop the region' : 'Set a loop region in the Sequence view'}
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
