import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { dmxSig, emitOverride, emitFixture, pick } from '../state.js';
import { fixtureOutputColor, fixtureCellColors } from '../utils.js';
import { useDmxFeed } from '../use-dmx.js';
import { useDraft, createFrameThrottle, SETTLE_MS } from '../draft.js';
import { FIXTURE_GROUPS } from '../../src/shared/stage.ts';
import { hasNoAddress } from '../../src/shared/placement.ts';

const GROUP_LABELS = { front: 'Front', back: 'Back', room: 'Room', floor: 'Floor' };

const CHANNELS = ['r', 'g', 'b', 'w', 'a', 'uv', 'dim', 'strobe'];
const CHANNEL_LABELS = { r: 'Red', g: 'Green', b: 'Blue', w: 'White', a: 'Amber', uv: 'UV', dim: 'Dim', strobe: 'Strb' };
const DEFAULT_OVERRIDE = { enabled: false, r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0, blackout: false };

/**
 * The lit swatch, and the only part of a card that follows the DMX stream.
 *
 * It reads dmxSig itself so the DMX feed wakes one `<div>` per fixture
 * instead of every card — with the read in Fixtures() the whole grid, its
 * address inputs and its override sliders re-rendered on every frame.
 */
function FixturePreview({ fix, state }) {
  // An LED bar shows every cell, left to right, in hard steps rather than a
  // blend: that is what the bar itself looks like.
  const cells = fixtureCellColors(fix, state, dmxSig.value);
  const background = cells
    ? `linear-gradient(90deg, ${cells.map((c, i) => `${c} ${(i / cells.length) * 100}% ${((i + 1) / cells.length) * 100}%`).join(', ')})`
    : fixtureOutputColor(fix, state, dmxSig.value);
  return <div class="fixture-preview" style={{ background }} title={cells ? `${cells.length} cells` : undefined} />;
}

function FixtureCard({ fix, state }) {
  const ov = (fix.override && fix.override.enabled) ? fix.override : null;
  const bo = !!(fix.override && fix.override.blackout);
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_OVERRIDE, ...(fix.override || {}) }));
  const [expanded, setExpanded] = useState(false);

  // Dragged locally so the slider doesn't stutter against the 10 Hz broadcast,
  // then handed back to the server value once the two agree again.
  const [maxDraft, onMax, commitMax] = useDraft(fix.maxBrightness ?? 255, (v) => emitFixture({ id: fix.id, maxBrightness: v }));

  // The override's channels are drafts too: sent once a frame at most while a
  // slider moves, and the server's echo of an older value ignored until the
  // hand has been still for a moment (draft.js).
  const overrideThrottle = useMemo(() => createFrameThrottle((next) => {
    emitOverride(fix.id, next);
  }), [fix.id]);
  const movingUntil = useRef(0);

  // A value the effect can compare, built from the fields the override actually
  // has. JSON.stringify would do, but its key order is whatever the sender used
  // and it re-parses the whole object on every render of the card.
  const ovKey = fix.override
    ? `${!!fix.override.enabled}|${!!fix.override.blackout}|${CHANNELS.map((c) => fix.override[c] ?? 0).join(',')}`
    : 'none';
  useEffect(() => {
    if (performance.now() < movingUntil.current) return;
    setDraft((d) => ({ ...d, ...(fix.override || { enabled: false, blackout: false }) }));
  }, [ovKey]);

  const sendOverride = (next, { final = false } = {}) => {
    setDraft(next);
    movingUntil.current = performance.now() + SETTLE_MS;
    overrideThrottle.push({ ...next, enabled: ov ? true : next.enabled, blackout: false });
    if (final) overrideThrottle.flush();
  };

  const toggleOverride = () => {
    const enabled = !ov;
    emitOverride(fix.id, { ...draft, enabled, blackout: false });
    if (enabled) setExpanded(true);
  };

  const toggleBlackout = () => {
    // Blackout is a gate; keep the underlying override so releasing it restores
    // the look instead of leaving an enabled override with every channel zero.
    if (bo && !ov) emitOverride(fix.id, null);
    else emitOverride(fix.id, { ...draft, enabled: !!ov, blackout: !bo });
  };

  const clearOverride = () => {
    emitOverride(fix.id, null);
    setDraft({ ...DEFAULT_OVERRIDE });
    setExpanded(false);
  };

  const showControls = ov && expanded;

  return (
    <div class={`fixture-card ${ov ? 'overridden' : ''}`}>
      <FixturePreview fix={fix} state={state} />
      <div class="fixture-header">
        <span
          class="fixture-name"
          contentEditable
          role="textbox"
          aria-label={`Fixture name: ${fix.label}`}
          spellcheck={false}
          // Committing only on blur left no way to finish, or to abandon, an
          // edit from the keyboard.
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            else if (e.key === 'Escape') {
              e.preventDefault();
              e.currentTarget.textContent = fix.label;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => emitFixture({ id: fix.id, label: e.target.textContent.trim() })}
        >{fix.label}</span>
        {hasNoAddress(fix) ? <span class="fixture-addr fixture-hue" title="Driven by the Hue bridge, never on DMX">Hue</span> : (
        <span class="fixture-addr" title="Universe / DMX address">
          <input
            class="fixture-universe"
            aria-label={`${fix.label}: universe`}
            type="number" min="0" max="32767"
            value={fix.universe ?? 0}
            onChange={(e) => emitFixture({
              id: fix.id,
              universe: Number.isInteger(parseInt(e.target.value, 10))
                ? parseInt(e.target.value, 10) : (fix.universe ?? 0),
            })}
          />
          <span class="fixture-addr-sep">/</span>
          <input
            aria-label={`${fix.label}: DMX address`}
            type="number" min="1" max="512"
            value={fix.address}
            onChange={(e) => emitFixture({ id: fix.id, address: parseInt(e.target.value, 10) || fix.address })}
          />
        </span>
        )}
      </div>

      {/* A trim, not a look: it scales everything the fixture puts out — the
          pattern engine, an override, or an energy override — proportionally at
          every level, and does not put the fixture into override mode. */}
      <div class={`fixture-max ${maxDraft < 255 ? 'trimmed' : ''}`}>
        <label for={`fix-max-${fix.id}`}>Max</label>
        <input
          id={`fix-max-${fix.id}`}
          type="range" min="0" max="255"
          value={maxDraft}
          title="Scales this fixture's output — the pattern, any override, and energy overrides — under the grand master"
          onInput={(e) => onMax(parseInt(e.target.value, 10))}
          onChange={(e) => commitMax(parseInt(e.target.value, 10))}
        />
        <span class="val">{Math.round((maxDraft / 255) * 100)}%</span>
      </div>

      {/* Where the lamp hangs. In a driving passage the auto show can split the
          look: one group holds a wash while the rest run the pattern. Needs
          two groups in use to do anything. */}
      <div class="fixture-max fixture-group">
        <label for={`fix-group-${fix.id}`}>Group</label>
        <select
          id={`fix-group-${fix.id}`}
          value={fix.group || ''}
          title="In busy passages the auto show can hold one group on a wash while the others run the pattern"
          onChange={(e) => emitFixture({ id: fix.id, group: e.target.value || null })}
        >
          <option value="">None</option>
          {FIXTURE_GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
        </select>
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
                <label for={`fix-${fix.id}-${ch}`}>{CHANNEL_LABELS[ch]}</label>
                <input
                  id={`fix-${fix.id}-${ch}`}
                  type="range" min="0" max="255"
                  value={draft[ch] ?? 0}
                  onInput={(e) => sendOverride({ ...draft, [ch]: parseInt(e.target.value, 10) })}
                  onChange={(e) => sendOverride({ ...draft, [ch]: parseInt(e.target.value, 10) }, { final: true })}
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
  useDmxFeed();
  const s = pick(['fixtures', 'profiles', 'masterDimmer', 'masterBlackout']);
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
