import { Transport } from './Transport.jsx';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { field, api, librarySig } from '../state.js';
import { drawRuler, drawClips } from '../timeline-renderer.js';
import { beatsPerBar as barLength, positionText, presetNameOf } from '../preview-inputs.js';
import { pacesOwnFlashes } from '../../src/shared/effects/registry.ts';
import { sequenceEnd } from '../../src/shared/effects/sequence.ts';
import { contentRows } from './Pads.jsx';
import { readFavourites } from './Effects.jsx';

// The sequencer as an instrument first: what plays and the transport stay
// on top, saved sequences and patterns are one tap; lanes, clips, commands
// and automation open behind Edit.

const AUTOMATION_MODES = ['none', 'target', 'triangle', 'sawtooth', 'sine'];
const COMMAND_TYPES = ['palette', 'tempo', 'brightness', 'goto'];
const QUANTISE = [[0, 'Off'], [0.25, '1/16'], [0.5, '1/8'], [1, '1 beat'], [4, '1 bar']];
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Shared lanes in the order they stack (the last wins), then the fixtures' tracks. */
export function laneStack(lanes) {
  return [...lanes.filter((l) => l.kind === 'shared'), ...lanes.filter((l) => l.kind === 'track')];
}

/** Show the edit at once; refused (400, 409), show the sequence the server kept. */
export async function putSequence(request, next, setSeq) {
  setSeq(next);
  const r = await request('/api/sequence', json('PUT', next));
  if (!r.ok) {
    const kept = await request('/api/sequence');
    if (kept.ok) setSeq(kept.sequence || null);
  }
  return r;
}

/**
 * The page's copy of the sequence against GET /api/sequence: the latest load
 * or edit wins, a GET sent before a local edit does not land, and a revision
 * this page caused (its PUT answers with status.revision) is not fetched
 * again. A revision seen while an edit is in flight waits for its answer.
 */
export function createSequenceSync(request, setSeq) {
  let loads = 0;
  let pending = 0;
  let want = null;
  let fetched = null;
  const own = new Set();
  const get = () => {
    const n = ++loads;
    return request('/api/sequence').then((r) => { if (n === loads && r && r.ok) setSeq(r.sequence || null); });
  };
  const mine = (r) => {
    if (!r || !r.ok || !r.status) return;
    own.add(r.status.revision);
    if (own.size > 32) own.delete(own.values().next().value);
  };
  const settle = () => {
    if (pending || want == null || own.has(want) || want === fetched) return;
    fetched = want;
    get();
  };
  const edit = async (send, show) => {
    pending++;
    const n = ++loads;
    let r;
    try { r = await send((v) => { if (n === loads) show(v); }); } finally { pending--; }
    mine(r);
    settle();
    return r;
  };
  return {
    reload(revision) {
      want = revision;
      if (pending || (revision != null && (own.has(revision) || revision === fetched))) return;
      fetched = revision;
      get();
    },
    commit: (next) => edit((show) => putSequence(request, next, show), setSeq),
    load: (id) => edit(async (show) => {
      const r = await request('/api/sequence', json('PUT', { id }));
      if (r.ok) show(r.sequence);
      return r;
    }, setSeq),
    // Nothing loaded: a stopped sequence lets go of its picture and the look comes back.
    unload: () => edit(async (show) => {
      const r = await request('/api/sequence', { method: 'DELETE' });
      if (r.ok) show(null);
      return r;
    }, setSeq),
  };
}

/** A sequence to start from: one shared lane in 4/4, at whatever tempo the rig plays, named apart from the saved ones. */
export function blankSequence(shelf = []) {
  const names = new Set(shelf.map((q) => q.name));
  let name = 'New sequence';
  for (let n = 2; names.has(name); n++) name = `New sequence ${n}`;
  return {
    id: newId('s'), name, mode: 'arrangement', bpm: null, timeSignature: { beats: 4, unit: 4 }, musicMode: null, loop: null, snap: 1,
    lanes: [{ id: newId('l'), kind: 'shared', name: 'Lane 1', mute: false, solo: false }], clips: [], commands: [],
    automation: { tempo: null, brightness: null },
    options: { autoplay: true, shuffle: false, randomPaletteOnLoop: false, initialPalette: null },
  };
}

// What the server refuses in a clip (400): a legacy row, which has no effect,
// and one that paces its own flashes (the strobe, Disco's automatic strobe).
const clipHolds = (p) => !!p && !p.legacy && !!p.spec && !pacesOwnFlashes(p.spec);

/** The presets a clip can play, in the pad editor's order: favourites, saved ones, party ones, the rest. */
export function clipPresetRows(library, favourites = []) {
  const user = (library.user || []).filter(clipHolds).map((p) => ({ id: p.id, name: p.name || p.id, user: true }));
  const builtin = (library.builtin || []).filter(clipHolds).map((p) => ({ id: p.id, name: p.name || p.id, party: !!p.party }));
  return contentRows([...user, ...builtin], favourites);
}

// The server's units: tempo in BPM 20 to 300, the master 0 to 255, whole periods 1 to 512.
const AUTOMATION_RANGE = { tempo: { lo: 20, hi: 300, min: 120, max: 130 }, brightness: { lo: 0, hi: 255, min: 0, max: 255 } };

export function automationStart(name, mode) {
  const r = AUTOMATION_RANGE[name];
  const a = { mode, period: 8, min: r.min, max: r.max, growing: true };
  if (mode === 'target') a.target = r.max;
  return a;
}

/**
 * A clip plays exactly one preset: the selected clip's, the last clip's, or the
 * library's first that plays now; none, no clip. The server refuses a legacy
 * row or a strobe, Disco's automatic one included, in a clip (400), and play
 * answers 409 while a clip is a rapid flash (`rows`, the live state's preset
 * rows) before the acknowledgement.
 */
export function newClip(seq, { laneId, startBeat, beatsPerBar, selected, library = [], rows = [], acknowledged = false }) {
  const from = seq.clips.find((c) => c.id === selected && c.presetId) || [...seq.clips].reverse().find((c) => c.presetId);
  const rapid = new Set(rows.filter((r) => r.rapidFlash).map((r) => r.id));
  const plays = (p) => !p.legacy && !(p.spec && pacesOwnFlashes(p.spec)) && (acknowledged || !rapid.has(p.id));
  const presetId = from ? from.presetId : (library.find(plays) || {}).id;
  if (!presetId) return null;
  return { id: newId('c'), laneId, startBeat, lengthBeats: beatsPerBar, loopBeats: beatsPerBar, presetId, targets: 'lane', mute: false };
}

const COMMAND_START = { tempo: 128, brightness: 255, goto: 0 };

/** Another type takes a value of its own: a palette id, BPM 20 to 300, 0 to 255, a beat. */
export function commandAs(k, type, paletteIds = []) {
  return { ...k, type, value: type === 'palette' ? (paletteIds[0] || '') : COMMAND_START[type] };
}

const toGrid = (beat, snap) => (snap > 0 ? Math.round(beat / snap) * snap : beat);

export function moveClip(clip, deltaBeats, snap) {
  return { ...clip, startBeat: Math.max(0, toGrid(clip.startBeat + deltaBeats, snap)) };
}

export function resizeClip(clip, deltaBeats, snap) {
  return { ...clip, lengthBeats: Math.max(snap || 0.25, toGrid(clip.lengthBeats + deltaBeats, snap)) };
}

/** After a kept take: the removed clips that reached outside it, or null when there are none. */
export function beyondRangeNotice(beyond, lanes, beatsPerBar) {
  if (!Array.isArray(beyond) || !beyond.length) return null;
  const at = (b) => `${Math.floor(b / beatsPerBar) + 1}.${Math.floor(b % beatsPerBar) + 1}`;
  const parts = beyond.map((c) => {
    const lane = (lanes.find((l) => l.id === c.laneId) || {}).name || c.laneId;
    const sides = [c.beforeBeats > 0 && `${c.beforeBeats} beats before`, c.afterBeats > 0 && `${c.afterBeats} beats after`].filter(Boolean).join(' / ');
    return `${lane} from ${at(c.startBeat)}, ${sides}`;
  });
  return `Replaced ${beyond.length} clip${beyond.length > 1 ? 's' : ''} that reached beyond the take: ${parts.join('; ')}`;
}

function stateText(status) {
  if (!status || !status.loaded) return 'Nothing loaded';
  if (status.error) return `Stopped: ${status.error.message}`;
  if (status.playing) return 'Playing';
  if (status.paused) return 'Paused';
  if (status.ended) return 'Ended';
  return status.stopped ? 'Stopped' : 'Ready';
}

/** A number typed in, or undefined for text that is none (an empty field included). */
export function parseNumber(text) {
  const v = Number(text);
  return String(text).trim() !== '' && Number.isFinite(v) ? v : undefined;
}

/** A typed field's text: its own while focused, the stored value otherwise. */
export function createTextDraft() {
  let text = null;
  return {
    shown: (stored) => (text === null ? String(stored ?? '') : text),
    focus(stored) { text = String(stored ?? ''); },
    input(t) { text = t; },
    commit(parse, onCommit) {
      const t = text;
      text = null;
      if (t === null) return;
      const v = parse(t);
      if (v !== undefined) onCommit(v);
    },
  };
}

// The live status redraws this view many times a second; the text being typed
// stays until blur or Enter commits it.
function Field({ value, parse = (t) => t, onCommit, ...rest }) {
  const draft = useMemo(createTextDraft, []);
  const [, redraw] = useState(0);
  const done = () => { draft.commit(parse, onCommit); redraw((n) => n + 1); };
  return (
    <input {...rest} value={draft.shown(value)}
      onFocus={() => draft.focus(value)}
      onInput={(e) => { draft.input(e.currentTarget.value); redraw((n) => n + 1); }}
      onBlur={done}
      onKeyDown={(e) => { if (e.key === 'Enter') done(); }} />
  );
}

function NumberField({ label, value, step = 1, min, onChange }) {
  return (
    <label class="seq-field">
      <span>{label}</span>
      <Field type="number" value={value} step={step} min={min} parse={parseNumber} onCommit={onChange} />
    </label>
  );
}

function Ruler({ seq, total, beatsPerBar }) {
  const ruler = useRef(null);
  const overview = useRef(null);
  useEffect(() => {
    for (const [canvas, draw] of [[ruler.current, 'ruler'], [overview.current, 'clips']]) {
      if (!canvas) continue;
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 20;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr; canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const laneIds = laneStack(seq.lanes).map((l) => l.id);
      if (draw === 'ruler') drawRuler(ctx, { fromBeat: 0, toBeat: total, beatsPerBar, width, height });
      else drawClips(ctx, seq.clips, { laneIds, fromBeat: 0, toBeat: total, width, rowHeight: height / Math.max(1, laneIds.length) });
    }
  }, [seq, total, beatsPerBar]);
  return (
    <div class="seq-ruler-wrap">
      <canvas ref={ruler} class="seq-ruler" aria-hidden="true" />
      <canvas ref={overview} class="seq-overview" aria-hidden="true" />
    </div>
  );
}

function ClipBlock({ clip, label, total, snap, editing, playing, selected, onSelect, onChange }) {
  const drag = useRef(null);
  const [delta, setDelta] = useState(null);
  const start = (e, kind) => {
    if (!editing) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const row = e.currentTarget.closest('.seq-lane-row');
    drag.current = { kind, x: e.clientX, beatsPerPx: total / ((row && row.clientWidth) || 1) };
    onSelect(clip.id);
  };
  const move = (e) => {
    if (!drag.current) return;
    const beats = (e.clientX - drag.current.x) * drag.current.beatsPerPx;
    setDelta({ kind: drag.current.kind, beats });
  };
  const end = () => {
    if (!drag.current) return;
    if (delta) onChange(delta.kind === 'move' ? moveClip(clip, delta.beats, snap) : resizeClip(clip, delta.beats, snap));
    drag.current = null;
    setDelta(null);
  };
  const shown = !delta ? clip : delta.kind === 'move' ? moveClip(clip, delta.beats, snap) : resizeClip(clip, delta.beats, snap);
  const cls = ['seq-block', playing && 'playing', clip.mute && 'muted', selected && 'selected'].filter(Boolean).join(' ');
  return (
    <div
      class={cls}
      role="button"
      tabIndex={0}
      aria-label={`${label}, beats ${clip.startBeat} to ${clip.startBeat + clip.lengthBeats}`}
      style={{ left: `${(shown.startBeat / total) * 100}%`, width: `${(shown.lengthBeats / total) * 100}%` }}
      onClick={() => editing && onSelect(clip.id)}
      onKeyDown={(e) => clipKeySelects(e, editing, () => onSelect(clip.id))}
      onPointerDown={(e) => start(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span class="seq-clip-label">{label}</span>
      {editing && <span class="seq-handle" aria-hidden="true" onPointerDown={(e) => start(e, 'resize')} />}
    </div>
  );
}

/** A beat as "bar.beat", both from 1. */
export function barBeatText(beat, perBar) {
  return `${Math.floor(beat / perBar) + 1}.${Math.floor(beat % perBar) + 1}`;
}

function parseBarBeat(text, perBar) {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(String(text));
  if (!m) return undefined;
  const bar = Number(m[1]);
  const beat = m[2] === undefined ? 1 : Number(m[2]);
  if (bar < 1 || beat < 1 || beat > Math.ceil(perBar)) return undefined;
  return (bar - 1) * perBar + (beat - 1);
}

/**
 * The loop the server takes ({ on, startBeat, endBeat }) from bars.beats, or
 * an error: the end after the start, both inside the sequence's last bar.
 */
export function loopRegion(seq, { on, start, end }) {
  const perBar = barLength(seq.timeSignature);
  const startBeat = parseBarBeat(start, perBar);
  const endBeat = parseBarBeat(end, perBar);
  if (startBeat === undefined || endBeat === undefined) return { error: 'Write the loop as bars.beats, such as 2.1' };
  if (!(endBeat > startBeat)) return { error: 'The loop ends after it starts' };
  const last = Math.max(perBar, ...(seq.clips || []).map((c) => c.startBeat + c.lengthBeats));
  if (endBeat > Math.ceil(last / perBar) * perBar) return { error: `The loop stays inside the sequence, up to ${barBeatText(Math.ceil(last / perBar) * perBar, perBar)}` };
  return { loop: { on: !!on, startBeat, endBeat } };
}

function LoopControl({ seq, onCommit }) {
  const perBar = barLength(seq.timeSignature);
  const loop = seq.loop;
  const [on, setOn] = useState(loop ? loop.on : true);
  const [start, setStart] = useState(barBeatText(loop ? loop.startBeat : 0, perBar));
  const [end, setEnd] = useState(barBeatText(loop ? loop.endBeat : perBar * 4, perBar));
  const [error, setError] = useState(null);
  const save = () => {
    const r = loopRegion(seq, { on, start, end });
    setError(r.error || null);
    if (r.loop) onCommit({ ...seq, loop: r.loop });
  };
  return (
    <div class="seq-loop" role="group" aria-label="Loop region">
      <label><input type="checkbox" checked={on} onChange={(e) => setOn(e.currentTarget.checked)} /> Loop</label>
      <input type="text" size="5" aria-label="Loop start, bars.beats" value={start} onInput={(e) => setStart(e.currentTarget.value)} />
      <input type="text" size="5" aria-label="Loop end, bars.beats" value={end} onInput={(e) => setEnd(e.currentTarget.value)} />
      <button type="button" class="seq-mini" onClick={save}>Set loop</button>
      {loop && <button type="button" class="seq-mini" onClick={() => { setError(null); onCommit({ ...seq, loop: null }); }}>Clear loop</button>}
      {error && <span class="seq-loop-error" role="alert">{error}</span>}
    </div>
  );
}

/** Enter or Space selects a clip block in edit mode. */
export function clipKeySelects(e, editing, select) {
  if (!editing || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  select();
}

/** A clip with another preset: it plays exactly one, so an effect of its own goes. */
function withPreset(clip, presetId) {
  const { effect: _effect, ...rest } = clip;
  return { ...rest, presetId };
}

/** The clip's preset from the library by name; one the library has not got stays, under its id. */
function PresetSelect({ clip, rows, onChange, ...rest }) {
  const current = clip.presetId || '';
  return (
    <select {...rest} value={current} onChange={(e) => { if (e.currentTarget.value) onChange(withPreset(clip, e.currentTarget.value)); }}>
      {!current && <option value="" selected>An effect of its own</option>}
      {current && !rows.some((r) => r.id === current) && <option value={current} selected>{current}</option>}
      {rows.map((r) => <option key={r.id} value={r.id} selected={r.id === current}>{r.name}</option>)}
    </select>
  );
}

function Inspector({ clip, lanes, rows, onChange, onDelete }) {
  const set = (patch) => onChange({ ...clip, ...patch });
  return (
    <div class="seq-inspector">
      <label class="seq-field"><span>Preset</span>
        <PresetSelect clip={clip} rows={rows} onChange={onChange} /></label>
      <label class="seq-field"><span>Lane</span>
        <select value={clip.laneId} onChange={(e) => set({ laneId: e.currentTarget.value })}>
          {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select></label>
      <NumberField label="Start beat" value={clip.startBeat} step={0.25} min={0} onChange={(v) => set({ startBeat: Math.max(0, v) })} />
      <NumberField label="Length" value={clip.lengthBeats} step={0.25} min={0.25} onChange={(v) => set({ lengthBeats: Math.max(0.25, v) })} />
      <NumberField label="Loop every" value={clip.loopBeats} step={0.25} min={0.25} onChange={(v) => set({ loopBeats: Math.max(0.25, v) })} />
      <label class="seq-field"><span>Targets</span>
        <Field type="text" placeholder="lane, or fixture ids 1,2"
          value={clip.targets === 'lane' ? 'lane' : clip.targets.join(',')}
          onCommit={(text) => {
            const ids = text.split(',').filter((t) => t.trim() !== '').map(Number).filter((n) => Number.isInteger(n));
            set({ targets: ids.length ? ids : 'lane' });
          }} /></label>
      <label class="seq-field seq-check"><span>Mute</span>
        <input type="checkbox" checked={clip.mute} onChange={(e) => set({ mute: e.currentTarget.checked })} /></label>
      <button type="button" class="seq-danger" onClick={onDelete}>Remove clip</button>
    </div>
  );
}

function AutomationEditor({ name, kind, unit, value, onChange }) {
  const a = value || automationStart(kind, 'none');
  const set = (patch) => {
    const next = { ...a, ...patch };
    if (next.mode === 'target' && !Number.isFinite(next.target)) next.target = next.max;
    if (next.mode !== 'target') delete next.target;
    onChange(next.mode === 'none' ? null : next);
  };
  return (
    <div class="seq-automation">
      <label class="seq-field"><span>{name}</span>
        <select aria-label={`${name} automation mode`} value={a.mode} onChange={(e) => set({ mode: e.currentTarget.value })}>
          {AUTOMATION_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select></label>
      <NumberField label={`period in ${unit}`} value={a.period} step={1} min={1} onChange={(v) => set({ period: Math.min(512, Math.max(1, Math.round(v))) })} />
      <NumberField label="min" value={a.min} step={1} onChange={(v) => set({ min: v })} />
      <NumberField label="max" value={a.max} step={1} onChange={(v) => set({ max: v })} />
      {a.mode === 'target' && <NumberField label="target" value={a.target} step={1} onChange={(v) => set({ target: v })} />}
    </div>
  );
}

export function Sequence({ initial = {} }) {
  const status = field('sequence').value;
  const fixtures = field('fixtures').value || [];
  const presetRows = field('patterns').value || [];
  // The shelf of saved sequences and patterns, as every page hears of them.
  const shelf = field('sequences').value || [];
  const patterns = field('sequencePatterns').value || [];
  const nameOf = presetNameOf(field('effects').value);
  const acknowledged = !!(field('safety').value || {}).photosensitivityAcknowledged;
  const [seq, setSeq] = useState(initial.sequence || null);
  const [editing, setEditing] = useState(!!initial.editing);
  const [selected, setSelected] = useState(initial.selected || null);
  // The lane a new clip goes on, picked by hand; the selected clip's lane comes first.
  const [lanePicked, setLanePicked] = useState(initial.lane || null);
  // The id of the saved sequence the view asks about deleting.
  const [asking, setAsking] = useState(initial.deleting && initial.sequence ? initial.sequence.id : null);
  const [beyond, setBeyond] = useState(null);
  // The live status carries `recording` only while a take runs.
  const recording = !!(status && status.recording);
  const [rec, setRec] = useState({ countInBeats: 4, mode: 'overdub', quantise: 1 });
  const [capture, setCapture] = useState({ fromBeat: 0, toBeat: 16, name: '' });
  const revision = status ? status.revision : null;

  // The live state carries the status only; the sequence itself is fetched when its revision moves.
  const sync = useMemo(() => createSequenceSync(api, setSeq), []);
  useEffect(() => { sync.reload(revision); }, [revision]);

  const commit = (next) => sync.commit(next);
  const load = (id) => sync.load(id);
  const create = () => {
    setSelected(null);
    setLanePicked(null);
    setEditing(true);
    return sync.commit(blankSequence(shelf));
  };
  const beat = status && Number.isFinite(status.beat) ? status.beat : 0;

  const shelfList = (
    <div class="seq-shelf" role="group" aria-label="Saved sequences">
      {shelf.map((s) => (
        <button key={s.id} type="button" class={`seq-shelf-item${seq && seq.id === s.id ? ' active' : ''}`}
          aria-label={`Load ${s.name}`} onClick={() => load(s.id)}>{s.name}</button>
      ))}
      <button type="button" class="seq-shelf-item" onClick={create}>New sequence</button>
    </div>
  );
  if (!seq) {
    return (
      <section class="sequence-view" aria-label="Sequence">
        <div class="seq-now" aria-live="polite">No sequence loaded — pick one to load it, or start a new one</div>
        {shelfList}
      </section>
    );
  }

  const lanes = laneStack(seq.lanes);
  const beatsPerBar = barLength(seq.timeSignature);
  // Where it ends when nothing brings it round; the ruler reaches past it.
  const stop = sequenceEnd(seq);
  const end = Math.max(32, stop, seq.loop ? seq.loop.endBeat : 0);
  const total = Math.ceil(end / beatsPerBar) * beatsPerBar + beatsPerBar;
  const onTop = new Set(((status && status.lanes) || []).map((l) => l.clip).filter(Boolean));
  const clip = seq.clips.find((c) => c.id === selected);
  const label = (c) => (c.presetId ? nameOf(c.presetId) : 'Effect');
  const setClip = (next) => commit({ ...seq, clips: seq.clips.map((c) => (c.id === next.id ? next : c)) });
  const setCommand = (next) => commit({ ...seq, commands: seq.commands.map((c) => (c.id === next.id ? next : c)) });
  const setLane = (id, patch) => commit({ ...seq, lanes: seq.lanes.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const library = librarySig.value;
  const rows = clipPresetRows(library, readFavourites());
  const paletteIds = [...(library.palettes.builtin || []), ...(library.palettes.user || [])].map((p) => p.id).filter(Boolean);
  const clipFrom = { selected, library: library.builtin, rows: presetRows, acknowledged };
  const addable = lanes.length > 0 && !!newClip(seq, { ...clipFrom, laneId: '', startBeat: 0, beatsPerBar });
  const target = lanes.find((l) => l.id === (clip ? clip.laneId : lanePicked)) || lanes[0];
  const untracked = fixtures.filter((f) => !seq.lanes.some((l) => l.kind === 'track' && l.fixtureId === f.id));
  const saved = shelf.some((s) => s.id === seq.id);
  // The shelf follows by broadcast; a refused save, copy or delete shows as a toast.
  const save = () => (saved
    ? api(`/api/sequences/${encodeURIComponent(seq.id)}`, json('PUT', seq))
    : api('/api/sequences', json('POST', seq)));
  const duplicate = () => {
    const copy = { ...seq, name: `${seq.name} copy` };
    delete copy.id;
    api('/api/sequences', json('POST', copy));
  };
  const remove = (id) => {
    setAsking(null);
    return api(`/api/sequences/${encodeURIComponent(id)}`, json('DELETE', {}));
  };
  const startRecord = () => api('/api/sequence/record', json('POST', rec));
  const stopRecord = (keep) => api('/api/sequence/record/stop', json('POST', { keep }))
    .then((r) => setBeyond(r && r.ok ? beyondRangeNotice(r.beyondRange, seq.lanes, beatsPerBar) : null));

  return (
    <section class="sequence-view" aria-label="Sequence">
      <div class="seq-top">
        <div class="seq-now" aria-live="polite">
          <strong>{seq.name}</strong> · {stateText(status)} · Bar {status ? status.bar : 1}
          <span class="seq-beat"> beat {status ? positionText({ ...status, beat }, beatsPerBar).split('.')[1] : 1}</span>
        </div>
        <Transport prefer="sequence" initial={initial} />
        <button type="button" class="seq-mini" title="Back to the look" onClick={() => sync.unload()}>Unload</button>
        <button type="button" class={`seq-edit-toggle${editing ? ' active' : ''}`} aria-pressed={editing}
          onClick={() => setEditing(!editing)}>Edit</button>
      </div>
      {shelfList}

      {beyond && <p class="seq-beyond" role="status">{beyond} <button type="button" class="btn sm" onClick={() => setBeyond(null)}>Dismiss</button></p>}
      <div class="seq-record" role="group" aria-label="Record">
        <select aria-label="Count-in beats" value={rec.countInBeats} onChange={(e) => setRec({ ...rec, countInBeats: Number(e.currentTarget.value) })}>
          {[0, 1, 2, 4, 8].map((n) => <option key={n} value={n}>{n ? `${n} beat count-in` : 'No count-in'}</option>)}
        </select>
        <select aria-label="Record mode" value={rec.mode} onChange={(e) => setRec({ ...rec, mode: e.currentTarget.value })}>
          <option value="overdub">Overdub</option><option value="replace">Replace</option>
        </select>
        <select aria-label="Quantise" value={rec.quantise} onChange={(e) => setRec({ ...rec, quantise: Number(e.currentTarget.value) })}>
          {QUANTISE.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
        </select>
        {recording
          ? [<button key="k" type="button" class="seq-big" onClick={() => stopRecord(true)}>Keep take</button>,
            <button key="d" type="button" class="seq-danger" onClick={() => stopRecord(false)}>Discard</button>]
          : <button type="button" class="seq-big seq-rec" aria-label="Record" onClick={startRecord}>●</button>}
      </div>

      {editing && patterns.length > 0 && (
        <div class="seq-patterns" role="group" aria-label="Patterns">
          {patterns.map((p) => (
            <button key={p.id} type="button" class="seq-pattern" aria-label={`Insert ${p.name} at beat ${Math.floor(beat)}`}
              onClick={() => api('/api/sequence/insert-pattern', json('POST', { id: p.id, atBeat: Math.floor(beat) }))}>{p.name}</button>
          ))}
        </div>
      )}

      <p class="seq-note">Shared lanes stack top to bottom: where clips overlap, the last shared lane wins. A track plays on its one fixture.</p>
      <div class="seq-arrangement">
        <div class="seq-lanes">
          {lanes.map((l) => (
            <div key={l.id} class={`seq-lane ${l.kind}`}>
              {editing
                ? <button type="button" class="seq-lane-pick" aria-pressed={l.id === target.id} title="New clips go on this lane"
                  onClick={() => { setSelected(null); setLanePicked(l.id); }}>{l.name}</button>
                : <span class="seq-lane-name">{l.name}</span>}
              {editing && (
                <button type="button" class={`seq-mini${l.mute ? ' active' : ''}`} aria-pressed={l.mute} aria-label={`Mute ${l.name}`}
                  onClick={() => setLane(l.id, { mute: !l.mute })}>M</button>
              )}
              {editing && (
                <button type="button" class={`seq-mini${l.solo ? ' active' : ''}`} aria-pressed={!!l.solo} aria-label={`Solo ${l.name}`}
                  onClick={() => setLane(l.id, { solo: !l.solo })}>S</button>
              )}
            </div>
          ))}
        </div>
        <div class="seq-rows">
          <Ruler seq={seq} total={total} beatsPerBar={beatsPerBar} />
          {lanes.map((l) => (
            <div key={l.id} class="seq-lane-row">
              {seq.clips.filter((c) => c.laneId === l.id).map((c) => (
                <ClipBlock key={c.id} clip={c} label={label(c)} total={total} snap={seq.snap} editing={editing} playing={onTop.has(c.id)}
                  selected={c.id === selected} onSelect={setSelected} onChange={setClip} />
              ))}
              <div class="seq-end" style={{ left: `${(stop / total) * 100}%` }} aria-hidden="true" />
              <div class="seq-cursor" style={{ left: `${(beat / total) * 100}%` }} aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <div class="seq-editor">
          <LoopControl key={`${seq.id}:${JSON.stringify(seq.loop)}`} seq={seq} onCommit={commit} />
          <div class="seq-toolbar">
            <label class="seq-field"><span>Name</span>
              <Field type="text" aria-label="Sequence name" maxLength={80} value={seq.name}
                parse={(t) => (t.trim() ? t.trim() : undefined)} onCommit={(name) => commit({ ...seq, name })} /></label>
            <button type="button" role="switch" aria-checked={seq.mode === 'playlist'} class="seq-mini"
              onClick={() => commit({ ...seq, mode: seq.mode === 'playlist' ? 'arrangement' : 'playlist' })}>Playlist mode</button>
            <button type="button" onClick={() => commit({ ...seq, lanes: [...seq.lanes, { id: newId('l'), kind: 'shared', name: `Lane ${lanes.length + 1}`, mute: false, solo: false }] })}>Add shared lane</button>
            <select aria-label="Add a track for a fixture" value="" onChange={(e) => {
              const f = fixtures.find((x) => String(x.id) === e.currentTarget.value);
              if (f) commit({ ...seq, lanes: [...seq.lanes, { id: newId('t'), kind: 'track', fixtureId: f.id, name: f.label || `Fixture ${f.id}`, mute: false, solo: false }] });
            }}>
              <option value="">Add a track for…</option>
              {untracked.map((f) => <option key={f.id} value={f.id}>{f.label || `Fixture ${f.id}`}</option>)}
            </select>
            <button type="button" disabled={!addable} title={addable ? undefined : 'No preset to play yet'} onClick={() => {
              const c = addable && newClip(seq, { ...clipFrom, laneId: target.id, startBeat: toGrid(beat, seq.snap), beatsPerBar });
              if (!c) return;
              commit({ ...seq, clips: [...seq.clips, c] });
              setSelected(c.id);
            }}>Add clip{target ? ` to ${target.name || target.id}` : ''}</button>
            <button type="button" onClick={save}>Save</button>
            <button type="button" onClick={duplicate}>Duplicate</button>
            {saved && (asking === seq.id
              ? [<span key="q" class="seq-confirm" role="alert">Delete “{seq.name}” from the saved sequences? The one loaded stays until it is unloaded.</span>,
                <button key="y" type="button" class="seq-danger" onClick={() => remove(seq.id)}>Delete it</button>,
                <button key="n" type="button" onClick={() => setAsking(null)}>Keep</button>]
              : <button type="button" class="seq-danger" onClick={() => setAsking(seq.id)}>Delete</button>)}
          </div>

          <div class="seq-cliplist">
            {seq.clips.map((c) => (
              <div key={c.id} class={`seq-clip-row${c.id === selected ? ' selected' : ''}`} onClick={() => setSelected(c.id)}>
                <span>{(seq.lanes.find((l) => l.id === c.laneId) || {}).name}</span>
                <PresetSelect aria-label="Preset" clip={c} rows={rows} onChange={setClip} />
                <Field type="number" aria-label="Start beat" value={c.startBeat} step={0.25} parse={parseNumber} onCommit={(v) => setClip({ ...c, startBeat: Math.max(0, v) })} />
                <Field type="number" aria-label="Length" value={c.lengthBeats} step={0.25} parse={parseNumber} onCommit={(v) => setClip({ ...c, lengthBeats: Math.max(0.25, v) })} />
              </div>
            ))}
          </div>
          {clip && <Inspector clip={clip} lanes={lanes} rows={rows} onChange={setClip}
            onDelete={() => { commit({ ...seq, clips: seq.clips.filter((c) => c.id !== clip.id) }); setSelected(null); }} />}

          <div class="seq-commands">
            {seq.commands.map((k) => (
              <div key={k.id} class="seq-command-row">
                <Field type="number" aria-label="At beat" value={k.atBeat} step={0.25} parse={parseNumber} onCommit={(v) => setCommand({ ...k, atBeat: Math.max(0, v) })} />
                <select aria-label="Command" value={k.type} onChange={(e) => setCommand(commandAs(k, e.currentTarget.value, paletteIds))}>
                  {COMMAND_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <Field type={k.type === 'palette' ? 'text' : 'number'} aria-label="Value" value={k.value}
                  parse={k.type === 'palette' ? (t) => t : parseNumber}
                  onCommit={(v) => setCommand({ ...k, value: k.type === 'brightness' ? Math.round(v) : v })} />
                <button type="button" class="seq-mini" aria-label="Remove command" onClick={() => commit({ ...seq, commands: seq.commands.filter((x) => x.id !== k.id) })}>×</button>
              </div>
            ))}
            <button type="button" onClick={() => commit({ ...seq, commands: [...seq.commands, { id: newId('k'), atBeat: Math.floor(beat), type: 'tempo', value: 128 }] })}>Add command</button>
          </div>

          <AutomationEditor name="Tempo" kind="tempo" unit="seconds" value={seq.automation.tempo} onChange={(a) => commit({ ...seq, automation: { ...seq.automation, tempo: a } })} />
          <AutomationEditor name="Brightness" kind="brightness" unit="beats" value={seq.automation.brightness} onChange={(a) => commit({ ...seq, automation: { ...seq.automation, brightness: a } })} />

          <div class="seq-capture">
            <span>Capture beats</span>
            <Field type="number" aria-label="From beat" value={capture.fromBeat} parse={parseNumber} onCommit={(v) => setCapture({ ...capture, fromBeat: v })} />
            <Field type="number" aria-label="To beat" value={capture.toBeat} parse={parseNumber} onCommit={(v) => setCapture({ ...capture, toBeat: v })} />
            <input type="text" aria-label="Pattern name" placeholder="Pattern name" value={capture.name} onInput={(e) => setCapture({ ...capture, name: e.currentTarget.value })} />
            <button type="button" disabled={!capture.name || capture.toBeat <= capture.fromBeat}
              onClick={() => api('/api/sequence/capture-pattern', json('POST', { ...capture, laneIds: seq.lanes.map((l) => l.id) }))}>Capture</button>
          </div>
        </div>
      )}
    </section>
  );
}
