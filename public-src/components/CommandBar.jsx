import { useEffect, useRef } from 'preact/hooks';
import { stateSig, send, emitTap, energyHold } from '../state.js';
import { formatBpm, clockSource } from '../utils.js';

const DIVISIONS = [1, 2, 4, 8];

export function CommandBar() {
  const pressRef = useRef(null);
  const s = stateSig.value;
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
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      // Space belongs to whatever is focused, and only falls through to tap
      // tempo when that is nothing. Tested on focusability rather than on a list
      // of tag names: the timeline canvas is a tabIndex="0" element that no list
      // would have named, and pressing Space on it changed the BPM mid-set.
      if (e.target !== document.body && e.target.tabIndex >= 0) return;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName) || e.target.isContentEditable) return;
      e.preventDefault();
      emitTap();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const dim = s.masterDimmer ?? 255;
  const masterPct = Math.round((dim / 255) * 100);
  const effects = s.energyEffects || [];

  const release = () => {
    pressRef.current = null;
    energyHold.release();
  };
  useEffect(() => {
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      release();
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  const activate = (id) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (energyHold.press(id)) {
      pressRef.current = { id, pointer: e.pointerId };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const deactivate = (id) => (e) => {
    if (pressRef.current?.id === id && pressRef.current.pointer === e.pointerId) release();
  };
  const keyDown = (id) => (e) => {
    if (![' ', 'Enter'].includes(e.key)) return;
    e.preventDefault();
    if (!e.repeat && energyHold.press(id)) pressRef.current = { id, key: e.key };
  };
  const keyUp = (id) => (e) => {
    if (pressRef.current?.id === id && pressRef.current.key === e.key) {
      e.preventDefault();
      release();
    }
  };

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
            value={dim}
            onInput={(e) => send({ masterDimmer: parseInt(e.target.value, 10) })}
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
              onPointerDown={activate(eff.id)}
              onPointerUp={deactivate(eff.id)}
              onPointerCancel={deactivate(eff.id)}
              onLostPointerCapture={deactivate(eff.id)}
              onKeyDown={keyDown(eff.id)}
              onKeyUp={keyUp(eff.id)}
              onBlur={() => { if (pressRef.current?.id === eff.id) release(); }}
              style={{ touchAction: 'none' }}
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
