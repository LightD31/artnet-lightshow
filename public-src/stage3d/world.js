import { stagePositions } from '../../src/shared/stage.ts';
import { lineOf } from '../../src/shared/rig.ts';

/**
 * The rig in the room: where each light is in metres, which way it points,
 * and what colour of light it gives — the half of the 3D stage that has
 * nothing to do with three.js, so it can be tested without a screen.
 *
 * The plan is the stage seen from above (x across, y from the back of the
 * stage to the audience, both 0–100). The room puts it on a stage twelve
 * metres wide and eight deep, the audience in front of it (+z), and hangs the
 * fixtures by their group:
 *
 *   front, back, none   on the truss, aimed down at the stage and a little
 *                       towards the audience
 *   floor               on the deck, aimed up and a little upstage
 *   room                lamps around the room, at head height: no beam, a bulb
 *
 * A Philips Hue lamp is a bulb wherever it is. A bar's cells hang in a line
 * where the plan draws them; a panel stands upright, its rows running down
 * from the truss.
 */

export const STAGE_W = 12;
export const STAGE_D = 8;
export const TRUSS_H = 4.6;
export const FLOOR_H = 0.18;
export const ROOM_H = 2.2;
export const BEAM_HALF_ANGLE = (11 * Math.PI) / 180;
const TILT = (22 * Math.PI) / 180;
// Uplighters lean a little upstage, at the back of the stage, as they are set.
const FLOOR_TILT = (12 * Math.PI) / 180;
const MAX_BEAM = 14;
const ROW_GAP = 0.5;

/** A point on the plan, in metres on the stage floor: { x, z }. */
export function planToWorld(p) {
  return { x: (p.x / 100 - 0.5) * STAGE_W, z: (p.y / 100 - 0.5) * STAGE_D };
}

const isBulb = (fixture, profile) => fixture.group === 'room'
  || !!(profile && /hue/i.test(`${profile.manufacturer || ''} ${profile.id || ''}`));

/** How far a beam from `from` along `aim` runs before it meets the floor (or the ceiling, going up). */
function beamLength(from, aim) {
  if (aim.y < -1e-6) return Math.min(MAX_BEAM, from.y / -aim.y);
  if (aim.y > 1e-6) return Math.min(MAX_BEAM, (TRUSS_H + 2.5 - from.y) / aim.y);
  return MAX_BEAM;
}

/**
 * Every light of the rig placed in the room, in the rig's unit order
 * (shared/rig.ts): `lamps` — pars and bulbs, one per fixture that is one light
 * — and `cells` — one per cell of a bar or panel. Each carries `unit`, its
 * index into a frame's colours.
 *
 * @param fixtures  the patch
 * @param profiles  profiles by id
 * @param rig       buildRig(fixtures, …)
 */
export function placeRig(fixtures, profiles, rig) {
  const centres = stagePositions(fixtures);
  const unplaced = fixtures.filter((f) => !f.position).length;
  const lamps = [];
  const cells = [];
  // What hangs from the truss, so the truss can be drawn where it is.
  const hung = [];

  fixtures.forEach((fixture, i) => {
    const profile = profiles[fixture.profileId] || null;
    const { start, count } = rig.ranges[i];
    const floor = fixture.group === 'floor';
    const height = floor ? FLOOR_H : fixture.group === 'room' ? ROOM_H : TRUSS_H;

    if (!rig.cellMaps[i]) {
      const at = planToWorld(centres[i]);
      const from = { x: at.x, y: height, z: at.z };
      if (isBulb(fixture, profile)) {
        lamps.push({ unit: start, fixture: fixture.id, kind: 'bulb', position: from, aim: null, length: 0 });
        return;
      }
      if (height === TRUSS_H) hung.push(at);
      const aim = floor
        ? { x: 0, y: Math.cos(FLOOR_TILT), z: -Math.sin(FLOOR_TILT) }
        : { x: 0, y: -Math.cos(TILT), z: Math.sin(TILT) };
      const length = beamLength(from, aim);
      const end = { x: from.x + aim.x * length, y: from.y + aim.y * length, z: from.z + aim.z * length };
      lamps.push({ unit: start, fixture: fixture.id, kind: 'par', position: from, aim, length, end, radius: Math.tan(BEAM_HALF_ANGLE) * length });
      return;
    }

    const grid = rig.grids[i];
    if (grid && profile && Array.isArray(profile.cells)) {
      // A panel stands upright: its columns along its line on the plan, its
      // rows down from the top edge.
      const line = lineOf(fixture, grid.columns, fixture.position ? 0 : unplaced);
      const rad = (line.angle * Math.PI) / 180;
      const across = { x: Math.cos(rad) * STAGE_W / 100, z: Math.sin(rad) * STAGE_D / 100 };
      const width = line.length * Math.hypot(across.x, across.z);
      const cellSize = width / grid.columns;
      const centre = planToWorld(centres[i]);
      const top = floor ? FLOOR_H + grid.rows * cellSize : height;
      if (!floor) hung.push(centre);
      for (let c = 0; c < count; c++) {
        const cell = profile.cells[c] || {};
        const atGrid = cell.at || { x: c % grid.columns, y: Math.floor(c / grid.columns) };
        const u = (atGrid.x + 0.5) / grid.columns - 0.5;
        cells.push({
          unit: start + c, fixture: fixture.id, size: cellSize,
          position: { x: centre.x + u * line.length * across.x, y: top - (atGrid.y + 0.5) * cellSize, z: centre.z + u * line.length * across.z },
        });
      }
      return;
    }

    const lineCells = count;
    const line = lineOf(fixture, lineCells, fixture.position ? 0 : unplaced);
    const rad = (line.angle * Math.PI) / 180;
    const spacing = (line.length / lineCells) * Math.hypot(Math.cos(rad) * STAGE_W / 100, Math.sin(rad) * STAGE_D / 100);
    for (let u = start; u < start + count; u++) {
      const at = planToWorld(rig.points[u]);
      if (height === TRUSS_H) hung.push(at);
      cells.push({ unit: u, fixture: fixture.id, size: Math.max(0.03, Math.min(0.12, spacing * 0.7)), position: { x: at.x, y: height, z: at.z } });
    }
  });

  return { lamps, cells, trusses: trussesFor(hung) };
}

/**
 * The trusses the hung fixtures are on: one bar for each row of them — those
 * within half a metre of each other front to back — across their span, a
 * little above them.
 */
export function trussesFor(points) {
  const rows = [];
  for (const p of [...points].sort((a, b) => a.z - b.z)) {
    const row = rows[rows.length - 1];
    if (row && p.z - row.last <= ROW_GAP) {
      row.zs.push(p.z); row.last = p.z;
      row.from = Math.min(row.from, p.x); row.to = Math.max(row.to, p.x);
    } else {
      rows.push({ zs: [p.z], last: p.z, from: p.x, to: p.x });
    }
  }
  return rows.map((row) => ({
    z: row.zs.reduce((sum, z) => sum + z, 0) / row.zs.length,
    from: row.from - 0.5,
    to: row.to + 0.5,
    y: TRUSS_H + 0.2,
  }));
}

/** The GPU's sRGB-to-linear curve, closely enough for a light's colour. */
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * A light's emitter values (0–255: red, green, blue, white, amber, UV — after
 * its dimmer, as a frame or the preview gives them) as the colour of light it
 * makes, linear RGB 0–1 written into `out` at `at`. The same mix the swatches
 * use (utils.colorToCss): white adds to all three, amber is warm, UV reads
 * violet; a colour past full is scaled down whole, keeping its hue.
 */
export function lightRGB(light, out, at = 0) {
  if (!light) { out[at] = 0; out[at + 1] = 0; out[at + 2] = 0; return 0; }
  const w = light.w || 0;
  const a = light.a || 0;
  const uv = light.uv || 0;
  let r = (light.r || 0) + w + a + uv * 0.2;
  let g = (light.g || 0) + w + a * 0.5;
  let b = (light.b || 0) + w + uv * 0.9;
  const peak = Math.max(r, g, b);
  if (peak > 255) { const k = 255 / peak; r *= k; g *= k; b *= k; }
  out[at] = toLinear(r / 255);
  out[at + 1] = toLinear(g / 255);
  out[at + 2] = toLinear(b / 255);
  return Math.min(1, peak / 255);
}
