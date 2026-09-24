import { useEffect, useRef, useState } from 'preact/hooks';
import { pick, connectedSig, dmxSig, emitFixture } from '../../state.js';
import { useDmxFeed } from '../../use-dmx.js';
import { stagePositions } from '../../../src/shared/stage.ts';
import { buildRig, lineOf } from '../../../src/shared/rig.ts';
import { fixtureOutputColor, fixtureCellColors } from '../../utils.js';
import { clamp, geometryOf, lineFromEnds, placeAt, pointIn, pxOf, round1, snapTo, surfaceStyle } from '../../stage-geometry.js';
import { rigSelectionSig, selectOnly, toggleSelected, identifyFixtures, stopIdentify } from '../../rig-ui.js';

/**
 * The plan: the rig as it hangs, seen from above with the audience at the
 * bottom — where each fixture is, and which way each bar runs. Patterns
 * travel across it as it is drawn here, so this is the pixel map.
 *
 *   select   click a fixture (Shift or Ctrl adds), drag across empty floor to
 *            pick several, drag them to move them together; a selected bar's
 *            end handle turns and stretches it
 *   draw     for bars: the bar to place lights up on the rig, its first cell
 *            green and its last red — drag on the plan from where the green
 *            end hangs to the red end. The next bar in the patch is picked
 *            and lit, so a truss of bars is mapped one drag at a time
 *
 * With snapping on, positions keep to a 2.5% grid, angles to 15°.
 */

const SNAP_STEP = 2.5;
const SNAP_ANGLE = 15;
const DRAW_IDENTIFY_SECONDS = 60;
const readSnap = () => { try { return localStorage.getItem('lightshow.plan.snap') !== '0'; } catch { return true; } };

/** How many cells a bar's line is measured in: a panel's columns, else its cells. */
const lineCells = (rig, i) => (rig.grids[i] ? rig.grids[i].columns : rig.ranges[i].count);

/** Arrange: the selection along one row, evenly spread, in the order they stand. */
export function rowPositions(points) {
  if (!points.length) return [];
  const order = points.map((p, k) => ({ p, k })).sort((a, b) => a.p.x - b.p.x || a.k - b.k);
  const y = round1(points.reduce((sum, p) => sum + p.y, 0) / points.length);
  let lo = order[0].p.x;
  let hi = order[order.length - 1].p.x;
  if (hi - lo < 1) { lo = 10; hi = 90; }
  const out = new Array(points.length);
  order.forEach(({ k }, j) => {
    out[k] = { x: round1(points.length > 1 ? lo + ((hi - lo) * j) / (points.length - 1) : (lo + hi) / 2), y };
  });
  return out;
}

/**
 * Arrange: bars end to end along one level line, in patch order, centred
 * where they are now — a truss of bars as one long strip. Shortened together
 * when they would not fit across the stage.
 */
export function endToEnd(bars) {
  if (!bars.length) return [];
  const total = bars.reduce((sum, b) => sum + b.length, 0);
  const scale = total > 96 ? 96 / total : 1;
  const span = total * scale;
  const cx = bars.reduce((sum, b) => sum + b.centre.x, 0) / bars.length;
  const y = round1(bars.reduce((sum, b) => sum + b.centre.y, 0) / bars.length);
  let x = Math.max(2, Math.min(98 - span, cx - span / 2));
  return bars.map((b) => {
    const length = b.length * scale;
    const centre = { x: round1(x + length / 2), y };
    x += length;
    return { position: centre, geometry: geometryOf(length, 0) };
  });
}

export function PlanEditor() {
  const s = pick(['fixtures', 'profiles', 'masterDimmer', 'masterBlackout', 'identify']);
  const connected = connectedSig.value;
  const fixtures = s.fixtures || [];
  const selected = rigSelectionSig.value;
  const [tool, setTool] = useState('select');
  const [snap, setSnap] = useState(readSnap);
  const [draft, setDraft] = useState(null);      // Map id → patch, while dragging
  const [band, setBand] = useState(null);        // { from, to } while picking with a band
  const [line, setLine] = useState(null);        // { from, to } while drawing a bar
  const drag = useRef(null);
  const surface = useRef(null);
  useDmxFeed(true);
  const dmx = dmxSig.value;

  useEffect(() => { try { localStorage.setItem('lightshow.plan.snap', snap ? '1' : '0'); } catch { /* private mode */ } }, [snap]);

  const drawnFixtures = draft ? fixtures.map((f) => (draft.has(f.id) ? { ...f, ...draft.get(f.id) } : f)) : fixtures;
  const positions = stagePositions(drawnFixtures);
  const rig = buildRig(drawnFixtures, (f) => (s.profiles && s.profiles[f.profileId]) || null);
  const unplaced = drawnFixtures.filter((f) => !f.position).length;
  const indexOf = new Map(fixtures.map((f, i) => [f.id, i]));
  const identifying = new Set((s.identify && s.identify.ids) || []);
  const isBar = (id) => indexOf.has(id) && !!rig.cellMaps[indexOf.get(id)];
  const drawTarget = selected.length === 1 && isBar(selected[0]) ? selected[0] : null;
  const snapPoint = (p) => (snap ? { x: snapTo(p.x, SNAP_STEP), y: snapTo(p.y, SNAP_STEP) } : p);
  const lineAt = (i) => lineOf(drawnFixtures[i], lineCells(rig, i), drawnFixtures[i].position ? 0 : unplaced);

  // Leaving draw mode, or the plan, lets the bar being drawn go dark again.
  // Escape leaves it wherever focus is: after a drag it is on no lamp.
  useEffect(() => {
    if (tool !== 'draw') return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); setTool('select'); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); stopIdentify(); };
  }, [tool]);
  useEffect(() => { if (tool === 'draw' && !drawTarget) setTool('select'); }, [tool, drawTarget]);
  useEffect(() => { if (!connected) { drag.current = null; setDraft(null); setBand(null); setLine(null); } }, [connected]);

  const startDraw = () => {
    if (!drawTarget) return;
    setTool('draw');
    identifyFixtures([drawTarget], DRAW_IDENTIFY_SECONDS);
  };

  const pointOf = (e) => pointIn(surface.current && surface.current.getBoundingClientRect(), e.clientX, e.clientY);

  const onPointerDown = (e) => {
    if (e.button !== 0 || !connected) return;
    const p = pointOf(e);
    if (!p) return;
    const lamp = e.target.closest && e.target.closest('[data-fixture]');
    const handle = e.target.closest && e.target.closest('[data-handle]');
    const capture = () => surface.current.setPointerCapture(e.pointerId);
    if (tool === 'draw' && drawTarget !== null) {
      e.preventDefault();
      const from = snapPoint(p);
      drag.current = { kind: 'draw', pointerId: e.pointerId, from, id: drawTarget };
      setLine({ from, to: from });
      capture();
      return;
    }
    if (handle) {
      e.preventDefault();
      const id = Number(handle.dataset.handle);
      drag.current = { kind: 'turn', pointerId: e.pointerId, id, centre: positions[indexOf.get(id)] };
      capture();
      return;
    }
    if (lamp) {
      e.preventDefault();
      const id = Number(lamp.dataset.fixture);
      lamp.focus();
      if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelected(id); return; }
      const moving = selected.includes(id) ? selected : [id];
      if (!selected.includes(id)) selectOnly(id);
      drag.current = {
        kind: 'move', pointerId: e.pointerId, start: p, primary: id, moved: false,
        origin: new Map(moving.filter((m) => indexOf.has(m)).map((m) => [m, positions[indexOf.get(m)]])),
      };
      capture();
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    drag.current = { kind: 'band', pointerId: e.pointerId, start: p, additive, base: additive ? selected : [] };
    capture();
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = pointOf(e);
    if (!p) return;
    if (d.kind === 'move') {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) < 0.8) return;
      d.moved = true;
      // The one under the pointer lands on the grid; the rest keep their spacing.
      const o = d.origin.get(d.primary);
      if (snap && o) {
        dx = snapTo(o.x + dx, SNAP_STEP) - o.x;
        dy = snapTo(o.y + dy, SNAP_STEP) - o.y;
      }
      const next = new Map();
      for (const [id, at] of d.origin) next.set(id, { position: { x: clamp(round1(at.x + dx)), y: clamp(round1(at.y + dy)) } });
      d.patch = next;
      setDraft(next);
    } else if (d.kind === 'turn') {
      const dx = p.x - d.centre.x;
      const dy = p.y - d.centre.y;
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      let length = 2 * Math.hypot(dx, dy);
      if (snap) { angle = snapTo(angle, SNAP_ANGLE); length = snapTo(length, SNAP_STEP) || SNAP_STEP; }
      d.patch = new Map([[d.id, { geometry: geometryOf(length, angle) }]]);
      setDraft(d.patch);
    } else if (d.kind === 'band') {
      setBand({ from: d.start, to: p });
    } else if (d.kind === 'draw') {
      d.to = snapPoint(p);
      setLine({ from: d.from, to: d.to });
    }
  };

  const finish = (e, save) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (surface.current && surface.current.hasPointerCapture(e.pointerId)) surface.current.releasePointerCapture(e.pointerId);
    if (save && (d.kind === 'move' || d.kind === 'turn') && d.patch) {
      for (const [id, patch] of d.patch) emitFixture({ id, ...patch });
    }
    if (d.kind === 'band') {
      const b = band;
      setBand(null);
      if (save) {
        const tiny = !b || (Math.abs(b.to.x - b.from.x) < 1 && Math.abs(b.to.y - b.from.y) < 1);
        if (tiny) {
          if (!d.additive) rigSelectionSig.value = [];
        } else {
          const [x0, x1] = [Math.min(b.from.x, b.to.x), Math.max(b.from.x, b.to.x)];
          const [y0, y1] = [Math.min(b.from.y, b.to.y), Math.max(b.from.y, b.to.y)];
          const inside = fixtures.filter((f, i) => positions[i].x >= x0 && positions[i].x <= x1 && positions[i].y >= y0 && positions[i].y <= y1)
            .map((f) => f.id);
          rigSelectionSig.value = [...new Set([...d.base, ...inside])];
        }
      }
    }
    if (d.kind === 'draw') {
      setLine(null);
      const to = d.to || d.from;
      if (save && Math.hypot(to.x - d.from.x, to.y - d.from.y) >= 1) {
        const i = indexOf.get(d.id);
        const placed = lineFromEnds(d.from, to, lineCells(rig, i));
        emitFixture({ id: d.id, ...placed });
        // On to the next bar in the patch, lit so it can be found.
        const next = fixtures.slice(i + 1).find((f) => isBar(f.id));
        if (next) {
          selectOnly(next.id);
          identifyFixtures([next.id], DRAW_IDENTIFY_SECONDS);
        } else {
          setTool('select');
        }
      }
    }
    setDraft(null);
  };

  const onKeyDown = (e, fix, i) => {
    if (e.key === 'Escape') {
      if (tool !== 'draw') rigSelectionSig.value = [];
      return;
    }
    const moving = selected.includes(fix.id) ? selected : [fix.id];
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = snap ? (e.shiftKey ? 4 * SNAP_STEP : SNAP_STEP) : (e.shiftKey ? 5 : 1);
      const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
      const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
      for (const id of moving) {
        const at = positions[indexOf.get(id)];
        if (at) emitFixture({ id, position: { x: clamp(round1(at.x + dx)), y: clamp(round1(at.y + dy)) } });
      }
      return;
    }
    if (!rig.cellMaps[i]) return;
    const l = lineAt(i);
    const turn = e.shiftKey ? 5 : 15;
    const stretch = e.shiftKey ? 10 : 2;
    let geometry;
    if (e.key === '[' || e.key === '{') geometry = geometryOf(l.length, l.angle - turn);
    else if (e.key === ']' || e.key === '}') geometry = geometryOf(l.length, l.angle + turn);
    else if (e.key === '-' || e.key === '_') geometry = geometryOf(l.length - stretch, l.angle);
    else if (e.key === '=' || e.key === '+') geometry = geometryOf(l.length + stretch, l.angle);
    else if (e.key === '0') geometry = null;
    else return;
    e.preventDefault();
    emitFixture({ id: fix.id, geometry });
  };

  // ── Arranging the selection ──
  const chosen = selected.filter((id) => indexOf.has(id));
  const chosenBars = fixtures.filter((f) => chosen.includes(f.id) && isBar(f.id));
  const arrangeRow = () => {
    const points = chosen.map((id) => positions[indexOf.get(id)]);
    rowPositions(points).forEach((position, k) => emitFixture({ id: chosen[k], position }));
  };
  const arrangeEndToEnd = () => {
    const bars = chosenBars.map((f) => {
      const i = indexOf.get(f.id);
      return { id: f.id, length: lineAt(i).length, centre: positions[i] };
    });
    endToEnd(bars).forEach((placed, k) => emitFixture({ id: bars[k].id, ...placed }));
  };
  const resetPlace = () => { for (const id of chosen) emitFixture({ id, position: null, geometry: null }); };

  const rect = surface.current ? surface.current.getBoundingClientRect() : null;
  const drawLabel = drawTarget !== null ? fixtures[indexOf.get(drawTarget)]?.label : '';

  return (
    <section class="panel plan-panel" aria-labelledby="plan-title">
      <header class="panel-head">
        <h2 class="panel-title" id="plan-title">Plan</h2>
        <span class="panel-tag">{fixtures.length} fixture{fixtures.length === 1 ? '' : 's'}{rig.hasPixels ? ` · ${rig.units.length} lights` : ''}</span>
      </header>
      <div class="plan-tools" role="toolbar" aria-label="Plan tools">
        <div class="segmented" role="group" aria-label="Tool">
          <button type="button" class={`segmented-btn ${tool === 'select' ? 'active' : ''}`} aria-pressed={tool === 'select'}
            onClick={() => setTool('select')}>Select</button>
          <button type="button" class={`segmented-btn ${tool === 'draw' ? 'active' : ''}`} aria-pressed={tool === 'draw'}
            disabled={drawTarget === null || !connected} title={drawTarget === null ? 'Select one bar to draw it' : 'Drag from its first cell to its last'}
            onClick={startDraw}>Draw bar</button>
        </div>
        <label class="plan-snap"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap</label>
        <span class="plan-tools-sep" aria-hidden="true" />
        <button type="button" class="btn sm" disabled={!chosen.length || !connected} onClick={() => identifyFixtures(chosen)}>Identify</button>
        <button type="button" class="btn sm" disabled={chosen.length < 2 || !connected} onClick={arrangeRow}
          title="Line the selection up in one row, evenly spaced">Row</button>
        <button type="button" class="btn sm" disabled={chosenBars.length < 2 || !connected} onClick={arrangeEndToEnd}
          title="Put the selected bars end to end, in patch order, as one long line">End to end</button>
        <button type="button" class="btn sm" disabled={!chosen.length || !connected} onClick={resetPlace}
          title="Forget where the selection stands: back to the default spread">Reset</button>
        <span class="plan-count">{chosen.length ? `${chosen.length} selected` : 'Nothing selected'}</span>
      </div>
      {tool === 'draw' && drawTarget !== null && (
        <p class="plan-hint" role="status">
          <strong>{drawLabel}</strong> is lit on the rig: its first cell green, its last red. Drag on the plan from where
          the green end hangs to the red end. Esc stops.
        </p>
      )}
      <div ref={surface} class={`stage-surface plan-surface editing tool-${tool}`} role="group"
        aria-label="Plan of the rig, viewed from above with the audience at the bottom" style={surfaceStyle}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, true)} onPointerCancel={(e) => finish(e, false)}>
        <span class="stage-back">BACK OF STAGE</span>
        {drawnFixtures.map((fix, i) => {
          if (!rig.cellMaps[i]) return null;
          const { start, count } = rig.ranges[i];
          const lit = identifying.has(fix.id) ? { ...s, masterBlackout: false } : s;
          const colours = connected ? (fixtureCellColors(fix, lit, dmx) || []) : [];
          return <span key={`cells-${fix.id}`} class="stage-cells" aria-hidden="true">
            {rig.points.slice(start, start + count).map((point, c) => (
              <i key={c} class={`stage-cell ${c === 0 ? 'first' : ''}`} style={{ ...placeAt(point), '--light': colours[c] || '#222' }} />
            ))}
          </span>;
        })}
        {drawnFixtures.map((fix, i) => {
          const point = positions[i];
          const bar = !!rig.cellMaps[i];
          const lit = identifying.has(fix.id) ? { ...s, masterBlackout: false } : s;
          const color = connected ? fixtureOutputColor(fix, lit, dmx) : '#222';
          const grid = rig.grids[i];
          const shape = grid ? `a panel of ${grid.columns} × ${grid.rows} cells` : bar ? `a bar of ${rig.ranges[i].count} cells` : '';
          const isSelected = selected.includes(fix.id);
          return <button key={fix.id} type="button" data-fixture={fix.id}
            class={`stage-fixture ${bar ? 'bar' : ''} ${isSelected ? 'selected' : ''} ${identifying.has(fix.id) ? 'identifying' : ''}`}
            style={{ ...placeAt(point), '--light': color }}
            aria-pressed={isSelected}
            aria-label={`${fix.label}${shape ? `, ${shape}` : ''}, position ${Math.round(point.x)}, ${Math.round(point.y)}. `
              + `Arrow keys move the selection${bar ? '; [ and ] turn it, minus and equals change its length, 0 resets both' : ''}.`}
            title={`${fix.label} · Universe ${fix.universe ?? 0} / ${fix.address}`}
            onClick={(e) => { if (e.detail === 0) { if (e.shiftKey) toggleSelected(fix.id); else selectOnly(fix.id); } }}
            onKeyDown={(e) => onKeyDown(e, fix, i)}>
            <i class="stage-glow" /><span class="stage-lamp">{i + 1}</span><span class="stage-label">{fix.label}</span>
          </button>;
        })}
        {tool === 'select' && drawnFixtures.map((fix, i) => {
          if (!rig.cellMaps[i] || !selected.includes(fix.id)) return null;
          const centre = positions[i];
          const l = lineAt(i);
          const rad = (l.angle * Math.PI) / 180;
          const end = { x: centre.x + (l.length / 2) * Math.cos(rad), y: centre.y + (l.length / 2) * Math.sin(rad) };
          return <span key={`turn-${fix.id}`} class="stage-handle" style={placeAt(end)} data-handle={fix.id}
            aria-hidden="true" title={`Turn or stretch ${fix.label}`} />;
        })}
        {band && rect && (() => {
          const a = pxOf(rect, band.from);
          const b = pxOf(rect, band.to);
          return <span class="plan-band" aria-hidden="true"
            style={{ left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`, width: `${Math.abs(b.x - a.x)}px`, height: `${Math.abs(b.y - a.y)}px` }} />;
        })()}
        {line && rect && (() => {
          const a = pxOf(rect, line.from);
          const b = pxOf(rect, line.to);
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
          return <>
            <span class="plan-line" aria-hidden="true" style={{ left: `${a.x}px`, top: `${a.y}px`, width: `${length}px`, transform: `rotate(${angle}deg)` }} />
            <span class="plan-end first" aria-hidden="true" style={{ left: `${a.x}px`, top: `${a.y}px` }} />
            <span class="plan-end last" aria-hidden="true" style={{ left: `${b.x}px`, top: `${b.y}px` }} />
          </>;
        })()}
        {!fixtures.length && <p class="panel-empty">Nothing is patched yet. Add fixtures below.</p>}
        <span class="stage-audience">AUDIENCE</span>
      </div>
      <p class="look-note">
        Numbers are patch order; a bar's first cell is outlined. Patterns travel across the rig as it is placed here.
        {rig.hasPixels ? ' Select a bar and Draw it to map which way it runs.' : ''}
      </p>
    </section>
  );
}
