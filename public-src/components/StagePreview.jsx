import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { stateSig, dmxSig, connectedSig, emitFixture, stagePreviewSig } from '../state.js';
import { colorToCss, fixtureOutputColor, fixtureCellColors, meanLight, fmtTime } from '../utils.js';
import { useDmxFeed } from '../use-dmx.js';
import { useRehearsalTrack } from '../rehearsal.js';
import { useTimeline } from '../use-timeline.js';
import { createPreviewSampler } from '../../src/shared/preview.ts';
import { stagePositions } from '../../src/shared/stage.ts';
import { buildRig, lineOf } from '../../src/shared/rig.ts';
import { clamp, geometryOf, placeAt, pointIn, surfaceStyle } from '../stage-geometry.js';

export function StagePreview() {
  const s = stateSig.value;
  const fixtures = s.fixtures || [];
  const connected = connectedSig.value;
  const { data } = useTimeline();
  const { edit, playing, position } = stagePreviewSig.value;
  const setUi = (patch) => { stagePreviewSig.value = { ...stagePreviewSig.value, ...patch }; };
  const [draft, setDraft] = useState(null);
  const drag = useRef(null);
  // The patch as it is being dragged: a lamp moved, or a bar turned, shows
  // where it is going before the server has it.
  const drawn = draft
    ? fixtures.map((f) => (f.id === draft.id ? { ...f, ...draft.patch } : f))
    : fixtures;
  // Stored or default, from the same module the engine orders patterns by, so
  // where a lamp is drawn is where the chase will find it — and every cell of
  // a bar where the engine puts it (shared/rig.js).
  const positions = stagePositions(drawn);
  const rig = buildRig(drawn, (f) => (s.profiles && s.profiles[f.profileId]) || null);
  const unplaced = drawn.filter((f) => !f.position).length;
  const duration = (data?.duration || 0) * 1000;
  // Rehearsal needs a timeline to rehearse. Deriving it rather than clearing the
  // flag in an effect keeps the panel honest the moment the analysis goes away,
  // and means losing it does not cost the operator their scrub position.
  const rehearsal = stagePreviewSig.value.rehearsal && !!data;
  // The timeline data carries the analysed beats, so the chase steps here on
  // the same beats the rig will step on.
  const sample = useMemo(() => createPreviewSampler(data?.timeline, data), [data]);
  // One entry per light: a par, or each cell of a bar.
  const preview = rehearsal ? sample(position, fixtures, s.colorPresets, rig) : null;
  // Read inside the branch that uses it: a signal subscribes on read, so while
  // rehearsing this panel is driven by its own scrub position and has no reason
  // to wake — and re-sample the whole timeline — on every live DMX frame.
  const dmx = rehearsal ? null : dmxSig.value;
  // Live, the plot draws the DMX feed; rehearsing, it draws the timeline.
  useDmxFeed(!rehearsal);

  // Follows the *track*, not the timeline. A replan — an intensity nudge, a
  // palette change — re-mints timelineRevision and hands us a new `data` for the
  // same music; resetting on that ejected the operator from rehearsal and rewound
  // to 0:00 at exactly the moment they were rehearsing for.
  //
  // And only when the track *changes*: the panel is unmounted by a view
  // switch, and an effect that ran on every mount reset the rehearsal each
  // time the operator looked at another view and came back (A7.26). The
  // track it was rehearsing is kept beside the rest of its state.
  useRehearsalTrack(s.autoShow);

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

  /** Where the pointer is on the plot, in the percent space positions use. */
  const pointOf = (event) => pointIn(event.currentTarget.parentElement.getBoundingClientRect(), event.clientX, event.clientY);
  const move = (event) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const at = pointOf(event);
    if (!at) return;
    if (active.turn) {
      // The handle is the bar's far end: the bar points at it and reaches it.
      const dx = at.x - active.centre.x;
      const dy = at.y - active.centre.y;
      active.patch = { geometry: geometryOf(2 * Math.hypot(dx, dy), (Math.atan2(dy, dx) * 180) / Math.PI) };
    } else {
      active.patch = { position: { x: clamp(at.x), y: clamp(at.y) } };
    }
    setDraft({ id: active.id, patch: active.patch });
  };
  const finish = (event, save) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (save && active.patch) emitFixture({ id: active.id, ...active.patch });
    setDraft(null);
  };
  const grab = (event, id, extra = {}) => {
    if (!edit || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    drag.current = { id, pointerId: event.pointerId, ...extra };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return <section class="panel stage-panel">
    <header class="panel-head">
      <h2 class="panel-title">Stage preview</h2>
      <span class="panel-tag">{rehearsal ? 'Rehearsal' : connected ? 'Live output' : 'Offline'}</span>
      <button class={`btn sm ${edit ? 'active' : ''}`} disabled={!connected} aria-pressed={edit}
        onClick={() => { setUi({ edit: !edit }); drag.current = null; setDraft(null); }}> {edit ? 'Done positioning' : 'Position fixtures'}</button>
    </header>
    <div class={`stage-surface ${edit ? 'editing' : ''}`} role="group"
      aria-label="Stage layout, viewed from the audience"
      style={surfaceStyle}>
      <span class="stage-back">BACK OF STAGE</span>
      {/* A bar's cells first, so its number and every lamp sit on top. */}
      {drawn.map((fix, i) => {
        if (!rig.cellMaps[i]) return null;
        const { start, count } = rig.ranges[i];
        const colours = preview
          ? preview.slice(start, start + count).map(colorToCss)
          : connected ? (fixtureCellColors(fix, s, dmx) || []) : [];
        return <span key={`cells-${fix.id}`} class="stage-cells" aria-hidden="true">
          {rig.points.slice(start, start + count).map((point, c) => (
            <i key={c} class="stage-cell" style={{ ...placeAt(point), '--light': colours[c] || '#222' }} />
          ))}
        </span>;
      })}
      {drawn.map((fix, i) => {
        const point = positions[i];
        const { start, count } = rig.ranges[i];
        const bar = !!rig.cellMaps[i];
        const color = preview
          ? colorToCss(bar ? meanLight(preview.slice(start, start + count)) : preview[start])
          : connected ? fixtureOutputColor(fix, s, dmx) : '#222';
        // A panel's line is its top edge, as wide as its columns (shared/rig.js).
        const grid = rig.grids[i];
        const line = bar ? lineOf(fix, grid ? grid.columns : count, fix.position ? 0 : unplaced) : null;
        const shape = grid ? `a panel of ${grid.columns} × ${grid.rows} cells` : `a bar of ${count} cells`;
        const turnHelp = bar ? ' [ and ] turn it, minus and equals change its length, 0 resets both.' : '';
        return <button key={fix.id} type="button" class={`stage-fixture ${bar ? 'bar' : ''}`}
          style={{ ...placeAt(point), '--light': color }}
          aria-label={`${fix.label}${bar ? `, ${shape}` : ''}, position ${Math.round(point.x)}, ${Math.round(point.y)}${edit ? `. Arrow keys move, Shift moves faster.${turnHelp}` : ''}`}
          title={`${fix.label} · Universe ${fix.universe ?? 0} / ${fix.address}${bar ? ` · ${grid ? `${grid.columns} × ${grid.rows}` : count} cells` : ''}`}
          onPointerDown={(event) => grab(event, fix.id)}
          onPointerMove={move} onPointerUp={(event) => finish(event, true)}
          onPointerCancel={(event) => finish(event, false)} onLostPointerCapture={(event) => finish(event, false)}
          onKeyDown={(event) => {
            if (!edit) return;
            if (event.key.startsWith('Arrow')) {
              event.preventDefault();
              const step = event.shiftKey ? 10 : 2;
              const next = { x: clamp(point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)),
                y: clamp(point.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)) };
              emitFixture({ id: fix.id, position: next });
              return;
            }
            if (!bar) return;
            const turn = event.shiftKey ? 5 : 15;
            const stretch = event.shiftKey ? 10 : 2;
            let geometry;
            if (event.key === '[' || event.key === '{') geometry = geometryOf(line.length, line.angle - turn);
            else if (event.key === ']' || event.key === '}') geometry = geometryOf(line.length, line.angle + turn);
            else if (event.key === '-' || event.key === '_') geometry = geometryOf(line.length - stretch, line.angle);
            else if (event.key === '=' || event.key === '+') geometry = geometryOf(line.length + stretch, line.angle);
            else if (event.key === '0') geometry = null;
            else return;
            event.preventDefault();
            emitFixture({ id: fix.id, geometry });
          }}><i class="stage-glow" /><span class="stage-lamp">{i + 1}</span><span class="stage-label">{fix.label}</span></button>;
      })}
      {/* In positioning mode, a bar's far end is a handle: drag it round to
          turn the bar, and out or in to lengthen or shorten it. */}
      {edit && drawn.map((fix, i) => {
        if (!rig.cellMaps[i]) return null;
        const centre = positions[i];
        const { count } = rig.ranges[i];
        const grid = rig.grids[i];
        const line = lineOf(fix, grid ? grid.columns : count, fix.position ? 0 : unplaced);
        const rad = (line.angle * Math.PI) / 180;
        const end = { x: centre.x + (line.length / 2) * Math.cos(rad), y: centre.y + (line.length / 2) * Math.sin(rad) };
        return <button key={`turn-${fix.id}`} type="button" class="stage-handle" style={placeAt(end)}
          tabIndex={-1} aria-hidden="true" title={`Turn or stretch ${fix.label}`}
          onPointerDown={(event) => grab(event, fix.id, { turn: true, centre })}
          onPointerMove={move} onPointerUp={(event) => finish(event, true)}
          onPointerCancel={(event) => finish(event, false)} onLostPointerCapture={(event) => finish(event, false)} />;
      })}
      {!fixtures.length && <p class="panel-empty">Add fixtures in the Rig view to build your stage.</p>}
      <span class="stage-audience">AUDIENCE</span>
    </div>
    <p class="look-note">{edit
      ? `Drag fixtures or use arrow keys.${rig.hasPixels ? ' Drag a bar\'s end handle to turn or stretch it.' : ''} Positions are saved with the show.`
      : 'Numbers are patch order. Patterns travel across the stage as placed here, left to right. Colours approximate the output; strobe timing is not simulated.'}</p>
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
