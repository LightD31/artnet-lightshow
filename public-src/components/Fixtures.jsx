import { useState, useEffect } from 'preact/hooks';
import { stateSig, dmxSig, emitOverride, emitFixture } from '../state.js';
import { fixtureOutputColor } from '../utils.js';

const CHANNELS = ['r', 'g', 'b', 'w', 'a', 'uv', 'dim', 'strobe'];
const CHANNEL_LABELS = { r: 'Red', g: 'Green', b: 'Blue', w: 'White', a: 'Amber', uv: 'UV', dim: 'Dim', strobe: 'Strb' };
const DEFAULT_OVERRIDE = { enabled: false, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false };

function FixtureCard({ fix, state, dmx }) {
  const ov = (fix.override && fix.override.enabled) ? fix.override : null;
  const bo = !!(fix.override && fix.override.blackout);
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_OVERRIDE, ...(fix.override || {}) }));
  const [expanded, setExpanded] = useState(false);

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
    if (enabled) setExpanded(true);
  };

  const toggleBlackout = () => {
    emitOverride(fix.id, { ...draft, enabled: true, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, strobe: 0, blackout: !bo });
  };

  const clearOverride = () => {
    emitOverride(fix.id, null);
    setDraft({ ...DEFAULT_OVERRIDE });
    setExpanded(false);
  };

  const showControls = ov && expanded;

  return (
    <div class={`fixture-card ${ov ? 'overridden' : ''}`}>
      <div class="fixture-preview" style={{ background: fixtureOutputColor(fix, state, dmx) }} />
      <div class="fixture-header">
        <span
          class="fixture-name"
          contentEditable
          spellcheck={false}
          onBlur={(e) => emitFixture({ id: fix.id, label: e.target.textContent.trim() })}
        >{fix.label}</span>
        <span class="fixture-addr">DMX <input
          type="number" min="1" max="507"
          value={fix.address}
          onChange={(e) => emitFixture({ id: fix.id, address: parseInt(e.target.value, 10) || fix.address })}
        /></span>
      </div>

      <div class="override-section">
        <div class="override-header">
          <button class={`btn sm ${ov ? 'active' : ''}`} onClick={toggleOverride}>
            {ov ? '● Override on' : 'Override'}
          </button>
          <button class={`btn sm danger ${bo ? 'active' : ''}`} onClick={toggleBlackout}>BO</button>
          {ov && (
            <button
              class="btn sm"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Collapse' : 'Expand'}
            >{expanded ? '▴' : '▾'}</button>
          )}
          <button class="btn sm" onClick={clearOverride} style={{ marginLeft: 'auto' }}>Clear</button>
        </div>
        {showControls && (
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
  const dmx = dmxSig.value;
  const fixtures = s.fixtures || [];
  return (
    <div class="card">
      <div class="card-title">Fixtures</div>
      <div class="fixtures-grid">
        {fixtures.map((f) => <FixtureCard key={f.id} fix={f} state={s} dmx={dmx} />)}
      </div>
    </div>
  );
}
