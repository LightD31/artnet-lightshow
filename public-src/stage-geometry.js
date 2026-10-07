/**
 * The stage plot's geometry: where a point in stage percent is drawn, and
 * back again. Shared by the stage preview and the Rig view's plan, so a
 * fixture is placed, dragged and hit-tested by one set of numbers.
 *
 * The lamp's footprint, and the strips kept clear at the top and bottom for
 * the two edge labels. A stored position is a percentage of the *travel*
 * rather than of the surface, so a lamp at 0 or 100 sits fully inside the box
 * instead of half outside it — which is why every offset below is expressed as
 * an inset from an edge and the span subtracts both.
 *
 * style.css needs the same footprint to size the lamp, so a surface publishes
 * LAMP_W/LAMP_H as custom properties (`surfaceStyle`) and `pointOf` is the
 * exact inverse of `placeAt`.
 */

export const LAMP_W = 56;
export const LAMP_H = 72;
const HEAD = 14;   // the top edge label
const FOOT = 14;   // the audience edge label

const INSET_X = LAMP_W / 2;
const INSET_Y = HEAD + LAMP_H / 2;
const SPAN_X = LAMP_W;
const SPAN_Y = LAMP_H + HEAD + FOOT;

// The plan's edges as the effects read the room (room.ts: v = +1, the top, is the front).
export const STAGE_EDGES = { top: 'Stage · TV wall — front', bottom: 'Audience — back', left: 'Left', right: 'Right' };

export const clamp = (n) => Math.max(0, Math.min(100, n));
export const round1 = (n) => Math.round(n * 10) / 10;

/** The custom properties a surface sets for the stylesheet. */
export const surfaceStyle = { '--stage-lamp-w': `${LAMP_W}px`, '--stage-lamp-h': `${LAMP_H}px` };

/** A point on the plot as a centre, for `style`. */
export const placeAt = (point) => ({
  left: `calc(${INSET_X}px + (100% - ${SPAN_X}px) * ${point.x / 100})`,
  top: `calc(${INSET_Y}px + (100% - ${SPAN_Y}px) * ${point.y / 100})`,
});

/** Where client coordinates fall on a surface's rect, in the percent space positions use. */
export function pointIn(rect, clientX, clientY) {
  if (!rect || !rect.width || !rect.height) return null;
  return {
    x: (clientX - rect.left - INSET_X) / Math.max(1, rect.width - SPAN_X) * 100,
    y: (clientY - rect.top - INSET_Y) / Math.max(1, rect.height - SPAN_Y) * 100,
  };
}

/** A bar's line, turned and stretched, kept inside what the server accepts. */
export function geometryOf(length, angle) {
  let a = angle;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return { length: round1(Math.max(1, Math.min(100, length))), angle: round1(a) };
}

/**
 * The line a bar is drawn along, from where its first cell should be to where
 * its last should be: its centre, and its geometry. The cells sit at the
 * middles of `count` equal parts of the line (shared/rig.ts), so the line is
 * longer than the gap between the end cells by one cell.
 */
export function lineFromEnds(from, to, count) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gap = Math.hypot(dx, dy);
  const n = Math.max(2, count);
  return {
    position: { x: clamp(round1((from.x + to.x) / 2)), y: clamp(round1((from.y + to.y) / 2)) },
    geometry: geometryOf((gap * n) / (n - 1), (Math.atan2(dy, dx) * 180) / Math.PI),
  };
}

/** A value on the snapping grid, when snapping. */
export const snapTo = (value, step) => (step ? Math.round(value / step) * step : value);

/** A point on the plot in pixels from a surface rect's corner: `pointIn`'s inverse. */
export function pxOf(rect, point) {
  return {
    x: INSET_X + (rect.width - SPAN_X) * (point.x / 100),
    y: INSET_Y + (rect.height - SPAN_Y) * (point.y / 100),
  };
}

/** The plot's grid, in percent: where a placed lamp lands unless placed freely. */
export const PLAN_SNAP = 2.5;

/** The plotted area inside a surface (the 0…100 square), for the grid drawn under the lamps. */
export const plotBox = { left: `${INSET_X}px`, top: `${INSET_Y}px`, right: `${SPAN_X - INSET_X}px`, bottom: `${SPAN_Y - INSET_Y}px` };

// Rows from the top of the plot down: src/shared/room.ts reads the top as the
// front (stage, TV) and the audience edge as the back.
const AUTO_ROWS = ['front', null, 'room', 'floor', 'back'];

/**
 * Proposed places: the lamps without a position (every lamp with `all`) in one
 * row per group, spread evenly left to right in patch order. A lamp keeps its height.
 * @returns {{ id: number, position: { x: number, y: number, height?: number } }[]}
 */
export function autoPlace(fixtures, { all = false } = {}) {
  const todo = fixtures.filter((f) => all || !f.position);
  const rowOf = (f) => (AUTO_ROWS.includes(f.group) ? f.group : null);
  const rows = AUTO_ROWS.filter((g) => todo.some((f) => rowOf(f) === g));
  const out = [];
  // Placed lamps (and earlier proposals) keep a grid step clear around them.
  const taken = all ? [] : fixtures.filter((f) => f.position).map((f) => f.position);
  const free = (x, y) => !taken.some((t) => Math.abs(t.x - x) <= PLAN_SNAP && Math.abs(t.y - y) <= PLAN_SNAP);
  const spot = (x0, y0) => {
    for (let dy = 0; dy <= 80; dy += 2 * PLAN_SNAP) {
      for (const y of dy ? [y0 + dy, y0 - dy] : [y0]) {
        if (y < 5 || y > 95) continue;
        for (let dx = 0; dx <= 90; dx += PLAN_SNAP) {
          for (const x of dx ? [x0 + dx, x0 - dx] : [x0]) if (x >= 5 && x <= 95 && free(x, y)) return { x, y };
        }
      }
    }
    return { x: x0, y: y0 };
  };
  rows.forEach((g, r) => {
    const members = todo.filter((f) => rowOf(f) === g);
    const y = snapTo(15 + (70 * (r + 0.5)) / rows.length, PLAN_SNAP);
    members.forEach((f, k) => {
      const position = spot(snapTo(10 + (80 * (k + 0.5)) / members.length, PLAN_SNAP), y);
      taken.push(position);
      if (f.position && Number.isFinite(f.position.height)) position.height = f.position.height;
      out.push({ id: f.id, position });
    });
  });
  const order = new Map(fixtures.map((f, i) => [f.id, i]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}
