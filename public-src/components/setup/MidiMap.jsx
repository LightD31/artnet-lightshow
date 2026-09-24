import { useEffect, useState } from 'preact/hooks';
import { pick, socket, toast } from '../../state.js';
import { post } from '../../setup-state.js';

/**
 * Which MIDI message does what. Defaults to a Behringer X-Touch Compact in
 * Standard mode (layer A): pick an action, press Learn, then move the control
 * it should be on. Learn is a whole-server mode, so another page arming or
 * finishing one shows up here too.
 */

const DIVISIONS = [1, 2, 4, 8, 16];
const GROUPS = { button: 'Buttons', encoder: 'Encoders', fader: 'Faders' };

/** The options for an action's parameter, from the live catalogues. */
function paramOptions(kind, s) {
  switch (kind) {
    case 'pattern': return (s.patterns || []).map((p) => ({ value: p.id, label: p.name }));
    case 'color': return (s.colorPresets || []).map((c, i) => ({ value: i, label: c.name }));
    case 'energy': return (s.energyEffects || []).map((e) => ({ value: e.id, label: e.name }));
    case 'cue': return (s.cues || []).map((c) => ({ value: c.id, label: c.name }));
    case 'palette': return (s.palettes || []).map((p) => ({ value: p.id, label: p.name }));
    case 'fixture': return (s.fixtures || []).map((f) => ({ value: f.id, label: f.label }));
    case 'division': return DIVISIONS.map((d) => ({ value: d, label: d === 1 ? '1/1' : `1/${d}` }));
    default: return [];
  }
}

/** "CC 12 (fader)" / "Note 40 ch 3". */
function controlLabel(kind, number, binding) {
  const base = kind === 'cc' ? `CC ${number}` : `Note ${number}`;
  const chan = binding.channel !== undefined ? ` ch ${binding.channel + 1}` : '';
  const type = kind === 'cc' ? ` (${binding.type === 'relative' ? 'encoder' : 'fader'})` : '';
  return `${base}${chan}${type}`;
}

export function MidiMap() {
  const s = pick(['patterns', 'colorPresets', 'energyEffects', 'cues', 'palettes', 'fixtures']);
  const [data, setData] = useState(null);      // { map, customised, actions }
  const [learning, setLearning] = useState(null);   // banner text
  const [actionId, setActionId] = useState('');
  const [param, setParam] = useState('');

  useEffect(() => {
    let live = true;
    fetch('/api/midi/map').then((r) => r.json()).then((res) => { if (live && res.ok) setData(res); }).catch(() => {});
    const onMap = ({ map, customised }) => setData((d) => (d ? { ...d, map, customised } : d));
    const onLearn = (event) => setLearning(event.status === 'armed' ? 'Press or move the control you want…' : null);
    socket.on('midi-map', onMap);
    socket.on('midi-learn', onLearn);
    return () => { live = false; socket.off('midi-map', onMap); socket.off('midi-learn', onLearn); };
  }, []);

  if (!data) return <section class="panel"><p class="panel-empty">Loading the MIDI mapping…</p></section>;
  const actions = data.actions || [];
  const byId = new Map(actions.map((a) => [a.id, a]));
  const chosen = byId.get(actionId) || actions[0];

  const actionLabel = (binding) => {
    const action = byId.get(binding.action);
    const label = action ? action.label : binding.action;
    if (!action || !action.param) return label;
    const value = binding[action.param.key];
    if (value === undefined || value === null) return label;
    const match = paramOptions(action.param.kind, s).find((o) => String(o.value) === String(value));
    return `${label} — ${match ? match.label : value}`;
  };

  const learn = async (binding) => {
    setLearning('Press or move the control you want…');
    // Held open by the server until a control moves: a learn that times out or
    // is called off answers ok:false, and that is an outcome, not an error.
    let res;
    try {
      res = await (await fetch('/api/midi/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(binding) })).json();
    } catch (err) {
      res = { ok: false, error: err.message };
    }
    if (!res.ok) {
      setLearning(res.error || 'Learn failed');
      setTimeout(() => setLearning(null), 3000);
      return;
    }
    setLearning(null);
    setData((d) => ({ ...d, map: res.map, customised: res.customised }));
  };

  const fromAddRow = () => {
    if (!chosen) return null;
    const binding = { action: chosen.id };
    if (chosen.param) {
      const options = paramOptions(chosen.param.kind, s);
      const raw = param !== '' ? param : chosen.param.optional ? '' : String(options[0] ? options[0].value : '');
      if (raw !== '') binding[chosen.param.key] = ['color', 'fixture', 'division'].includes(chosen.param.kind) ? Number(raw) : raw;
    }
    if (chosen.input === 'encoder') binding.type = 'relative';
    if (chosen.input === 'fader') binding.type = 'absolute';
    return binding;
  };

  const putBinding = async (kind, number, binding) => {
    const res = await post('/api/midi/map/binding', { kind, number, binding }, 'PUT');
    if (res.ok) setData((d) => ({ ...d, map: res.map, customised: res.customised }));
    return res;
  };
  const unbind = async (row) => {
    const res = await putBinding(row.kind, row.number, null);
    if (!res.ok) return;
    toast.push({ message: `Unbound ${controlLabel(row.kind, row.number, row.binding)}`, action: { label: 'Undo', onClick: () => putBinding(row.kind, row.number, row.binding) } });
  };
  const reset = async () => {
    // A mapping built one control at a time is worth an undo, and the whole
    // map it replaces is right here.
    const before = data.map;
    const res = await post('/api/midi/map/reset', {});
    if (!res.ok) return;
    setData((d) => ({ ...d, map: res.map, customised: res.customised }));
    toast.push({
      message: 'Reset to the built-in X-Touch mapping',
      action: { label: 'Undo', onClick: async () => { const back = await post('/api/midi/map', before, 'PUT'); if (back.ok) setData((d) => ({ ...d, map: back.map, customised: back.customised })); } },
    });
  };

  const rows = [];
  for (const kind of ['notes', 'cc']) {
    for (const [number, binding] of Object.entries((data.map && data.map[kind]) || {})) rows.push({ kind: kind === 'notes' ? 'note' : 'cc', key: kind, number: Number(number), binding });
  }
  rows.sort((a, b) => (a.key === b.key ? a.number - b.number : a.key < b.key ? -1 : 1));
  const groups = [];
  for (const action of actions) {
    const last = groups[groups.length - 1];
    if (last && last.input === action.input) last.actions.push(action);
    else groups.push({ input: action.input, actions: [action] });
  }
  const paramList = chosen && chosen.param ? paramOptions(chosen.param.kind, s) : [];

  return (
    <section class="panel" aria-labelledby="midimap-title">
      <header class="panel-head">
        <h2 class="panel-title" id="midimap-title">MIDI mapping</h2>
        <span class="panel-tag">{data.customised ? 'Your mapping' : 'Built-in X-Touch Compact'}</span>
      </header>
      <p class="section-desc">Which message does what. Pick an action, press <strong>Learn</strong>, then move the control you want it on.</p>
      {learning && (
        <div class="midi-learn-banner" role="status">
          <span>{learning}</span>
          <button type="button" class="btn sm" onClick={() => { post('/api/midi/learn/cancel', {}); setLearning(null); }}>Cancel</button>
        </div>
      )}
      <div class="midi-add-row">
        <select aria-label="Action" value={chosen ? chosen.id : ''} onChange={(e) => { setActionId(e.target.value); setParam(''); }}>
          {groups.map((g, i) => (
            <optgroup key={`${g.input}-${i}`} label={GROUPS[g.input] || g.input}>
              {g.actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </optgroup>
          ))}
        </select>
        {chosen && chosen.param && (
          <select aria-label={chosen.param.label} value={param} onChange={(e) => setParam(e.target.value)}>
            {chosen.param.optional && <option value="">— any {chosen.param.label.toLowerCase()} —</option>}
            {paramList.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
          </select>
        )}
        <button type="button" class="btn sm active" onClick={() => learn(fromAddRow())}>Learn</button>
        <button type="button" class="btn sm" disabled={!data.customised} onClick={reset}>Reset to default</button>
      </div>
      <div class="table-scroll midi-map-scroll">
        <table class="patch-table midi-map-table">
          <thead><tr><th scope="col">Control</th><th scope="col">Action</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.key}-${row.number}`}>
                <td class="midi-control">{controlLabel(row.kind, row.number, row.binding)}</td>
                <td>{actionLabel(row.binding)}</td>
                <td class="patch-actions-cell">
                  <button type="button" class="btn sm" title="Move this action to another control" onClick={() => learn(row.binding)}>Learn</button>
                  <button type="button" class="remove-btn" aria-label={`Unbind ${controlLabel(row.kind, row.number, row.binding)}`}
                    onClick={() => unbind({ ...row, kind: row.key === 'notes' ? 'notes' : 'cc' })}>×</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={3} class="midi-map-empty">Nothing is bound.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
