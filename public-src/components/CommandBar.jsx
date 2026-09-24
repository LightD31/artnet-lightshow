import { useEffect } from 'preact/hooks';
import { send, emitTap, pick } from '../state.js';
import { formatBpm, clockSource } from '../utils.js';
import { useDraft } from '../draft.js';
import { useEnergyPads } from '../energy-pad.js';

const DIVISIONS = [1, 2, 4, 8];

/**
 * Whether Space on this element taps the tempo.
 *
 * Space belongs to whatever is focused, and only falls through to tap tempo
 * when that is nothing — tested on focusability rather than on a list of tag
 * names, since the timeline canvas is a tabIndex="0" element that no list
 * would have named, and pressing Space on it changed the BPM mid-set.
 *
 * With one exception: a button or fader the pointer last touched. A click
 * leaves focus on the button, so after pressing Blackout, Space pressed
 * Blackout again instead of tapping — the tap key stopped working after the
 * first click of the night (A7.26). Such a control keeps Space when the
 * keyboard brought focus to it (:focus-visible), and hands it to the tempo
 * when the pointer did.
 */
function spaceIsTap(target) {
  if (!target || target === document.body || target === document.documentElement) return true;
  if (target.isContentEditable) return false;
  const pointerFocused = typeof target.matches === 'function' && !target.matches(':focus-visible');
  if (target.tagName === 'BUTTON') return pointerFocused;
  if (target.tagName === 'INPUT' && target.type === 'range') return pointerFocused;
  return !(target.tabIndex >= 0 || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export function CommandBar() {
  const [, padProps] = useEnergyPads();
  const s = pick(['bpm', 'beatDivision', 'clock', 'running', 'masterDimmer', 'masterBlackout', 'energyEffects', 'energyOverride']);
  const bpm = s.bpm || 120;
  const division = s.beatDivision || 1;
  const periodMs = (60_000 / bpm) / division;
  const pulse = !!s.running && !s.masterBlackout && bpm > 0;
  const clock = clockSource(s.clock && s.clock.source);
  // From the tempo the rig is running at, to a hundredth, so +1 on 123.7 is
  // 124.7 rather than float noise.
  const nudge = (delta) => send({ bpm: Math.max(20, Math.min(300, Math.round((bpm + delta) * 100) / 100)) });

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      if (!spaceIsTap(e.target)) return;
      e.preventDefault();
      emitTap();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const [dim, onMaster, commitMaster] = useDraft(s.masterDimmer ?? 255, (v) => send({ masterDimmer: v }));
  const masterPct = Math.round((dim / 255) * 100);
  const effects = s.energyEffects || [];

  return (
    <div class="command-bar">
      {/* Tempo block */}
      <div class="cb-block cb-tempo">
        <div
          class={`cb-bpm ${pulse ? 'pulse' : ''}`}
          style={{ '--bpm-period': `${periodMs.toFixed(0)}ms` }}
        >
          <span class="cb-bpm-num">{formatBpm(s.bpm)}</span>
          <span class="cb-bpm-label">BPM</span>
          <span class={`cb-bpm-source ${clock.locked ? 'locked' : ''}`} title={clock.title}>{clock.label}</span>
        </div>
        <button class="cb-tap" onClick={emitTap} title="Tap tempo (Space)">TAP</button>
        <div class="cb-bpm-controls">
          {/* Wrapped: as bare children of the column flex these stretched to
              full width and stacked, which is not what they are for. */}
          <div class="cb-bpm-nudge">
            <button class="btn icon sm" onClick={() => nudge(-1)} title="BPM −1">−</button>
            <button class="btn icon sm" onClick={() => nudge(1)} title="BPM +1">+</button>
          </div>
          <div class="cb-divs">
            {DIVISIONS.map((d) => (
              <button
                key={d}
                class={`btn sm ${s.beatDivision === d ? 'active' : ''}`}
                onClick={() => send({ beatDivision: d })}
                title={`Beat division 1/${d}`}
              >{d === 1 ? '1' : `1/${d}`}</button>
            ))}
          </div>
        </div>
      </div>

      <div class="cb-divider" />

      {/* Transport */}
      <div class="cb-block cb-transport">
        <button
          class={`cb-play ${s.running ? 'active' : ''}`}
          onClick={() => send({ running: !s.running })}
          title={s.running ? 'Stop' : 'Play'}
        >{s.running ? '■' : '▶'}</button>

        <button
          class={`cb-blackout ${s.masterBlackout ? 'active' : ''}`}
          onClick={() => send({ masterBlackout: !s.masterBlackout })}
          title="Master blackout"
        >
          <span class="cb-blackout-dot" />
          <span>BLACKOUT</span>
        </button>

        <div class="cb-master">
          <span class="cb-master-label">MASTER</span>
          <input
            type="range" min="0" max="255"
            aria-label="Master dimmer"
            aria-valuetext={`${masterPct} percent`}
            value={dim}
            onInput={(e) => onMaster(parseInt(e.target.value, 10))}
            onChange={(e) => commitMaster(parseInt(e.target.value, 10))}
          />
          <span class="cb-master-val">{masterPct}%</span>
        </div>
      </div>

      <div class="cb-divider" />

      {/* Energy panic strip */}
      <div class="cb-block cb-energy">
        <span class="cb-energy-label">ENERGY</span>
        <div class="cb-energy-grid">
          {effects.map((eff) => (
            <button
              key={eff.id}
              class={`cb-energy-btn ${s.energyOverride === eff.id ? 'active' : ''}`}
              {...padProps(eff.id)}
              title={`${eff.name} — ${eff.desc} (hold)`}
            >
              <span class="cb-energy-name">{eff.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
