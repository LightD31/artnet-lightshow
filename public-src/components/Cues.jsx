import { useState } from 'preact/hooks';
import { stateSig } from '../state.js';
import { colorToCss } from '../utils.js';

// The cue list rides the state broadcast as summaries — id, name, and enough to
// draw a swatch. Recall, save and edit all go through the REST endpoints, which
// broadcast the new list back.
const api = (path, init) => fetch(`/api/cues${path}`, {
  headers: { 'Content-Type': 'application/json' },
  ...init,
});

function Swatches({ colors, presets }) {
  return (
    <span class="cue-swatches">
      {(colors || []).map((idx, i) => {
        const preset = presets[idx];
        const bg = preset ? (preset.name === 'Blackout' ? '#111' : colorToCss(preset)) : '#333';
        return <span key={i} class="cue-swatch" style={{ background: bg }} />;
      })}
    </span>
  );
}

function CueRow({ cue, presets, editing, setEditing }) {
  const [draft, setDraft] = useState(cue.name);

  const commitRename = () => {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === cue.name) return;
    api(`/${cue.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
  };

  if (editing) {
    return (
      <div class="cue-row editing">
        <input
          class="cue-name-input"
          value={draft}
          autoFocus
          onInput={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') { setDraft(cue.name); setEditing(null); }
          }}
          onBlur={commitRename}
        />
      </div>
    );
  }

  return (
    <div class="cue-row">
      <button
        class={`cue-recall ${cue.blackout ? 'blackout' : ''}`}
        onClick={() => api(`/${cue.id}/recall`, { method: 'POST' })}
        title={`Recall "${cue.name}" — ${cue.pattern} at ${cue.bpm} BPM`}
      >
        <Swatches colors={cue.colors} presets={presets} />
        <span class="cue-name">{cue.name}</span>
        <span class="cue-meta">{cue.pattern} · {cue.bpm}</span>
      </button>
      <button
        class="btn icon sm"
        title="Rename"
        onClick={() => { setDraft(cue.name); setEditing(cue.id); }}
      >✎</button>
      <button
        class="btn icon sm"
        title="Overwrite this cue with what's on stage now"
        onClick={() => api(`/${cue.id}`, { method: 'PUT', body: JSON.stringify({ recapture: true }) })}
      >⟳</button>
      <button
        class="btn icon sm danger"
        title="Delete"
        onClick={() => api(`/${cue.id}`, { method: 'DELETE' })}
      >×</button>
    </div>
  );
}

export function Cues() {
  const s = stateSig.value;
  const cues = s.cues || [];
  const presets = s.colorPresets || [];
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    const res = await api('', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() || undefined }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok) { setError(res.error || 'Could not save the cue'); return; }
    setName('');
    setSaving(false);
  };

  return (
    <div class="card">
      <div class="card-title">Cues</div>

      {saving ? (
        <div class="cue-save-row">
          <input
            class="cue-name-input"
            placeholder="Name this look"
            value={name}
            autoFocus
            onInput={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { setName(''); setSaving(false); }
            }}
          />
          <button class="btn active sm" onClick={save}>Save</button>
          <button class="btn sm" onClick={() => { setName(''); setSaving(false); }}>Cancel</button>
        </div>
      ) : (
        <button class="btn active cue-capture" onClick={() => setSaving(true)}>
          + Save current look
        </button>
      )}

      {error && <div class="cue-error">{error}</div>}

      {cues.length === 0
        ? <div class="cue-empty">No cues yet. Build a look, then save it here to get back to it in one press.</div>
        : (
          <div class="cue-list">
            {cues.map((cue) => (
              <CueRow
                key={cue.id}
                cue={cue}
                presets={presets}
                editing={editing === cue.id}
                setEditing={setEditing}
              />
            ))}
          </div>
        )}
    </div>
  );
}
