import { useState, useEffect } from 'preact/hooks';
import { stateSig, emitOverride, emitFixture } from '../state.js';
import { fixtureOutputColor } from '../utils.js';

const CHANNELS = ['r', 'g', 'b', 'w', 'a', 'uv', 'dim', 'strobe'];
const CHANNEL_LABELS = { r: 'Red', g: 'Green', b: 'Blue', w: 'White', a: 'Amber', uv: 'UV', dim: 'Dimmer', strobe: 'Strobe' };
const DEFAULT_OVERRIDE = { enabled: false, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false };

function FixtureCard({ fix, state }) {
  const ov = (fix.override && fix.override.enabled) ? fix.override : null;
  const bo = !!(fix.override && fix.override.blackout);
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_OVERRIDE, ...(fix.override || {}) }));

  // Pull server-side override changes into the draft when the user isn't dragging.
  useEffect(() => {
    if (fix.override) setDraft((d) => ({ ...d, ...fix.override }));
  }, [JSON.stringify(fix.override)]);

  const sendOverride = (next) => {
    setDraft(next);
    emitOverride(fix.id, { ...next, enabled: ov ? true : next.enabled, blackout: false });
  };

  const toggleOverride = () => {
    const enabled = !ov;
    emitOverride(fix.id, { ...draft, enabled, blackout: false });
  };

  const toggleBlackout = () => {
    emitOverride(fix.id, { ...draft, enabled: true, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: !bo });
  };

  const clearOverride = () => {
    emitOverride(fix.id, null);
    setDraft({ ...DEFAULT_OVERRIDE });
  };

  return (
    <div class={`fixture-card ${ov ? 'overridden' : ''}`}>
      <div class="fixture-preview" style={{ background: fixtureOutputColor(fix, state) }} />
      <div class="fixture-header">
        <span
          class="fixture-name"
          contentEditable
          onBlur={(e) => emitFixture({ id: fix.id, label: e.target.textContent.trim() })}
        >{fix.label}</span>
        <span class="fixture-addr">DMX <input
          type="number" min="1" max="507"
          value={fix.address}
          onChange={(e) => emitFixture({ id: fix.id, address: parseInt(e.target.value, 10) || fix.address })}
          style={{ width: '42px', background: 'var(--surface)', border: '1px solid var(--border)',
                   color: 'var(--muted)', borderRadius: '4px', padding: '2px 4px',
                   fontSize: '11px', fontFamily: 'monospace' }}
        /></span>
      </div>

      <div class="override-section">
        <div class="override-header">
          <label>Override</label>
          <button class={`btn sm ${ov ? 'active' : ''}`} onClick={toggleOverride}>{ov ? 'On' : 'Off'}</button>
          <button class={`btn sm danger ${bo ? 'active' : ''}`} onClick={toggleBlackout}>Blackout</button>
          <button class="btn sm" onClick={clearOverride}>Clear</button>
        </div>
        {ov && (
          <div class="override-controls">
            {CHANNELS.map((ch) => (
              <div class="override-row" key={ch}>
                <label>{CHANNEL_LABELS[ch]}</label>
                <input
                  type="range" min="0" max="255"
                  value={draft[ch] ?? 0}
                  onInput={(e) => {
                    const value = parseInt(e.target.value, 10);
                    sendOverride({ ...draft, [ch]: value });
                  }}
                />
                <span class="val">{draft[ch] ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Fixtures() {
  const s = stateSig.value;
  const fixtures = s.fixtures || [];
  return (
    <div class="card">
      <div class="card-title">Fixtures</div>
      <div class="fixtures-grid">
        {fixtures.map((f) => <FixtureCard key={f.id} fix={f} state={s} />)}
      </div>
    </div>
  );
}
