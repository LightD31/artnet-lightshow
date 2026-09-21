import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { stateSig, dmxSig, autoTimelineSig, connectedSig, emitFixture, stagePreviewSig } from '../state.js';
import { colorToCss, fixtureOutputColor, fmtTime } from '../utils.js';
import { timelineKey } from '../timeline-state.js';
import { createPreviewSampler } from '../../src/shared/preview.js';
import { stagePositions } from '../../src/shared/stage.js';

const clamp = (n) => Math.max(0, Math.min(100, n));

// The lamp's footprint, and the strips kept clear at the top and bottom for the
// two edge labels. A stored position is a percentage of the *travel* rather
// than of the surface, so a lamp at 0 or 100 sits fully inside the box instead
// of half outside it — which is why every offset below is expressed as an inset
// from an edge and the span subtracts both.
//
// style.css needs the same footprint to size the lamp, and placing a lamp and
// hit-testing a drag on it have to agree or a fixture jumps under the pointer.
// So this is the only copy: the surface publishes LAMP_W/LAMP_H as custom
// properties for the stylesheet, and `move()` below is the exact inverse of the
// `left`/`top` expressions.
const LAMP_W = 56;
const LAMP_H = 72;
const HEAD = 14;   // "BACK OF STAGE"
const FOOT = 14;   // "AUDIENCE"

const INSET_X = LAMP_W / 2;
const INSET_Y = HEAD + LAMP_H / 2;
const SPAN_X = LAMP_W;
const SPAN_Y = LAMP_H + HEAD + FOOT;

export function StagePreview() {
  const s = stateSig.value;
  const fixtures = s.fixtures || [];
  // Stored or default, from the same module the engine orders patterns by, so
  // where a lamp is drawn is where the chase will find it.
  const positions = stagePositions(fixtures);
  const connected = connectedSig.value;
  const stored = autoTimelineSig.value;
  const data = stored.key === timelineKey(s) ? stored.data : null;
  const { edit, playing, position } = stagePreviewSig.value;
  const setUi = (patch) => { stagePreviewSig.value = { ...stagePreviewSig.value, ...patch }; };
  const [draft, setDraft] = useState(null);
  const drag = useRef(null);
  const duration = (data?.duration || 0) * 1000;
  // Rehearsal needs a timeline to rehearse. Deriving it rather than clearing the
  // flag in an effect keeps the panel honest the moment the analysis goes away,
  // and means losing it does not cost the operator their scrub position.
  const rehearsal = stagePreviewSig.value.rehearsal && !!data;
  const sample = useMemo(() => createPreviewSampler(data?.timeline), [data]);
  const preview = rehearsal ? sample(position, fixtures, s.colorPresets) : null;
  // Read inside the branch that uses it: a signal subscribes on read, so while
  // rehearsing this panel is driven by its own scrub position and has no reason
  // to wake — and re-sample the whole timeline — on every live DMX frame.
  const dmx = rehearsal ? null : dmxSig.value;

  // Follows the *track*, not the timeline. A replan — an intensity nudge, a
  // palette change — re-mints timelineRevision and hands us a new `data` for the
  // same music; resetting on that ejected the operator from rehearsal and rewound
  // to 0:00 at exactly the moment they were rehearsing for.
  const t = s.autoShow?.track;
  const trackId = t ? `${t.id ?? ''}|${t.name ?? ''}|${t.artist ?? ''}` : null;
  useEffect(() => { setUi({ playing: false, position: 0, rehearsal: false }); }, [trackId]);

  useEffect(() => { if (!connected) { drag.current = null; setDraft(null); setUi({ edit: false }); } }, [connected]);
  useEffect(() => {
    if (!playing || !rehearsal || !duration) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const delta = Math.min(250, now - last);
      last = now;
      // Read the signal rather than closing over `position`: the effect is not
      // re-run on every tick, so a captured value would be stale after the first.
      const current = stagePreviewSig.value;
      stagePreviewSig.value = { ...current, position: Math.min(duration, current.position + delta) };
    }, 50);
    return () => clearInterval(timer);
  }, [playing, rehearsal, duration]);
  useEffect(() => { if (duration && position >= duration) setUi({ playing: false }); }, [position, duration]);

  const move = (event) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    active.position = {
      x: clamp((event.clientX - rect.left - INSET_X) / Math.max(1, rect.width - SPAN_X) * 100),
      y: clamp((event.clientY - rect.top - INSET_Y) / Math.max(1, rect.height - SPAN_Y) * 100),
    };
    setDraft({ id: active.id, position: active.position });
  };
  const finish = (event, save) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (save && active.position) emitFixture({ id: active.id, position: active.position });
    setDraft(null);
  };

  return <section class="panel stage-panel">
    <header class="panel-head">
      <h3 class="panel-title">Stage preview</h3>
      <span class="panel-tag">{rehearsal ? 'Rehearsal' : connected ? 'Live output' : 'Offline'}</span>
      <button class={`btn sm ${edit ? 'active' : ''}`} disabled={!connected} aria-pressed={edit}
        onClick={() => { setUi({ edit: !edit }); drag.current = null; setDraft(null); }}> {edit ? 'Done positioning' : 'Position fixtures'}</button>
    </header>
    <div class={`stage-surface ${edit ? 'editing' : ''}`} role="group"
      aria-label="Stage layout, viewed from the audience"
      style={{ '--stage-lamp-w': `${LAMP_W}px`, '--stage-lamp-h': `${LAMP_H}px` }}>
      <span class="stage-back">BACK OF STAGE</span>
      {fixtures.map((fix, i) => {
        const point = draft?.id === fix.id ? draft.position : positions[i];
        const color = preview ? colorToCss(preview[i]) : connected ? fixtureOutputColor(fix, s, dmx) : '#222';
        return <button key={fix.id} type="button" class="stage-fixture"
          style={{
            left: `calc(${INSET_X}px + (100% - ${SPAN_X}px) * ${point.x / 100})`,
            top: `calc(${INSET_Y}px + (100% - ${SPAN_Y}px) * ${point.y / 100})`,
            '--light': color,
          }}
          aria-label={`${fix.label}, position ${Math.round(point.x)}, ${Math.round(point.y)}${edit ? '. Arrow keys move, Shift moves faster.' : ''}`}
          title={`${fix.label} · Universe ${fix.universe ?? 0} / ${fix.address}`}
          onPointerDown={(event) => {
            if (!edit || event.button !== 0) return;
            event.preventDefault(); event.currentTarget.focus();
            drag.current = { id: fix.id, pointerId: event.pointerId };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={move} onPointerUp={(event) => finish(event, true)}
          onPointerCancel={(event) => finish(event, false)} onLostPointerCapture={(event) => finish(event, false)}
          onKeyDown={(event) => {
            if (!edit || !event.key.startsWith('Arrow')) return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : 2;
            const next = { x: clamp(point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)),
              y: clamp(point.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)) };
            emitFixture({ id: fix.id, position: next });
          }}><i class="stage-glow" /><span class="stage-lamp">{i + 1}</span><span class="stage-label">{fix.label}</span></button>;
      })}
      {!fixtures.length && <p class="panel-empty">Add fixtures in Settings to build your stage.</p>}
      <span class="stage-audience">AUDIENCE</span>
    </div>
    <p class="look-note">{edit ? 'Drag fixtures or use arrow keys. Positions are saved with the show.' : 'Numbers are patch order. Patterns travel across the stage as placed here, left to right. Colours approximate the output; strobe timing is not simulated.'}</p>
    {data && <div class="stage-rehearsal">
      <button class={`btn sm ${rehearsal ? 'active' : ''}`} aria-pressed={rehearsal}
        onClick={() => setUi({ rehearsal: !rehearsal, playing: false })}>{rehearsal ? 'Return to live' : 'Rehearse track'}</button>
      {rehearsal && <>
        <button class="btn sm" onClick={() => setUi({ position: position >= duration ? 0 : position, playing: !playing })}>{playing ? 'Pause preview' : 'Play preview'}</button>
        <input type="range" min="0" max={duration} step="100" value={position} aria-label="Rehearsal position"
          aria-valuetext={fmtTime(position)} onInput={(event) => setUi({ position: Number(event.target.value) })} />
        <span>{fmtTime(position)} / {fmtTime(duration)}</span>
        <p class="look-note">Browser rehearsal only. Live playback and fixture output continue independently.</p>
      </>}
    </div>}
  </section>;
}
