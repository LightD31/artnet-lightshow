import type { PatternContext } from './patterns.ts';


export interface Room {
  n: number;
  u: number[];
  v: number[];
  z: number[];
  x: number[];
  y: number[];
  X: number[];
  Y: number[];
  Z: number[];
  dist: number[];
  turn: number[];
  ringDegrees: number[];
  ring: number[];
  hue: boolean[];
  group: readonly (string | null)[] | null;
  spread: boolean;
  along(headingDeg: number): number[];
  rankAlong(headingDeg: number): number[];
  halves(axis: 'depth' | 'width'): number[];
  channels(count: 2 | 3 | 4 | 5): number[];
  anchorCount(): 2 | 4 | 5;
  waveDistance(angleDeg: number): number[];
  waveLength(angleDeg: number, lambda: number): number;
  hdProject(angleDeg: number): number[];
}

export function xOf(ctx: Pick<PatternContext, 'xs' | 'fixtureCount'>, i: number): number {
  if (ctx.xs) return ctx.xs[i];
  return ctx.fixtureCount > 1 ? i / (ctx.fixtureCount - 1) : 0.5;
}

export function yOf(ctx: Pick<PatternContext, 'ys'>, i: number): number {
  return ctx.ys ? ctx.ys[i] : 0.5;
}

const frac = (v: number): number => v - Math.floor(v);

interface Remembered {
  room: Room;
  xs: readonly number[] | null | undefined;
  ys: readonly number[] | null | undefined;
  hue: readonly boolean[] | null;
}

// Cache several Hue-flag variants so sharing a plan does not rebuild every room each frame.
const rooms = new WeakMap<object, Remembered[]>();
const ROOMS_PER_KEY = 4;
const evenRooms = new Map<number, Room>();

export function roomOf(ctx: Pick<PatternContext, 'fixtureCount' | 'plan' | 'xs' | 'ys' | 'noFlash'>): Room {
  const n = Math.max(1, ctx.fixtureCount);
  const hue = ctx.noFlash ?? null;
  const plan = ctx.plan;
  if (plan && plan.x.length >= n && plan.y.length >= n) {
    return remember(plan, n, null, null, hue,
      () => buildRoom(n, (i) => plan.x[i], (i) => plan.y[i], (i) => plan.z?.[i] ?? 0.5, plan.group, hue));
  }
  const key = ctx.xs ?? ctx.ys ?? hue;
  if (key) {
    return remember(key, n, ctx.xs, ctx.ys, hue,
      () => buildRoom(n, (i) => xOf(ctx, i), (i) => yOf(ctx, i), () => 0.5, null, hue));
  }
  let room = evenRooms.get(n);
  if (!room) {
    if (evenRooms.size > 64) evenRooms.clear();
    room = buildRoom(n, (i) => xOf(ctx, i), () => 0.5, () => 0.5, null);
    evenRooms.set(n, room);
  }
  return room;
}

function remember(key: object, n: number, xs: Remembered['xs'], ys: Remembered['ys'], hue: Remembered['hue'],
  build: () => Room): Room {
  let seen = rooms.get(key);
  if (!seen) { seen = []; rooms.set(key, seen); }
  const hit = seen.find((r) => r.room.n === n && r.xs === xs && r.ys === ys && r.hue === hue);
  if (hit) return hit.room;
  const room = build();
  seen.push({ room, xs, ys, hue });
  if (seen.length > ROOMS_PER_KEY) seen.shift();
  return room;
}

export function buildRoom(n: number, xAt: (i: number) => number, yAt: (i: number) => number, zAt: (i: number) => number,
  group: readonly (string | null)[] | null, hue: readonly boolean[] | null = null): Room {
  let lo = Infinity; let hi = -Infinity; let top = Infinity; let bottom = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, xAt(i)); hi = Math.max(hi, xAt(i));
    top = Math.min(top, yAt(i)); bottom = Math.max(bottom, yAt(i));
  }
  const cx = (lo + hi) / 2;
  const cy = (top + bottom) / 2;
  const spanX = hi - lo;
  const spanY = bottom - top;
  let far = 0;
  for (let i = 0; i < n; i++) far = Math.max(far, Math.hypot(xAt(i) - cx, yAt(i) - cy));
  if (far < 1e-9) far = 1;
  const u: number[] = []; const v: number[] = []; const z: number[] = [];
  const x: number[] = []; const y: number[] = [];
  const dist: number[] = []; const turn: number[] = []; const ringDegrees: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = xAt(i) - cx;
    // Flip plot y into Hue front-positive coordinates while preserving positive zero.
    const dy = cy - yAt(i);
    u.push(spanX > 1e-9 ? dx / (spanX / 2) : 0);
    v.push(spanY > 1e-9 ? dy / (spanY / 2) : 0);
    z.push(Math.max(-1, Math.min(1, zAt(i) * 2 - 1)));
    x.push(dx / far);
    y.push(dy / far);
    dist.push(Math.hypot(dx, dy) / far);
    turn.push(frac(Math.atan2(dx, dy) / (Math.PI * 2)));
    // Truncate wrapped ring angles before sorting so ranks match the preset geometry.
    ringDegrees.push(javaInt(wrap360(((Math.atan2(1, 0) - Math.atan2(v[i], u[i])) * 360) / (Math.PI * 2))));
  }
  const spread = spanX > 0.02 && spanY > 0.02;
  // Use linear order on flat rigs because radial ordering has no meaningful ring.
  const ring = ranksOf(spread ? ringDegrees : (spanX >= spanY ? u : v.map((a) => -a)));
  if (!spread) for (let i = 0; i < n; i++) turn[i] = ring[i] / n;
  const X = u.map((a) => (a + 1) / 2);
  const Y = v.map((a) => (a + 1) / 2);
  const Z = z.map((a) => (a + 1) / 2);
  const hueFlags = hue ? Array.from({ length: n }, (_, i) => !!hue[i]) : new Array<boolean>(n).fill(false);

  const alongCache = new Map<number, number[]>();
  const rankCache = new Map<number, number[]>();
  const halfCache = new Map<string, number[]>();
  const channelCache = new Map<number, number[]>();
  const waveCache = new Map<number, number[]>();
  const projectCache = new Map<number, number[]>();
  const room: Room = {
    n, u, v, z, x, y, X, Y, Z, dist, turn, ringDegrees, ring, hue: hueFlags, group, spread,
    along: (h) => cached(alongCache, h, () => alongOf(room, h)),
    rankAlong: (h) => cached(rankCache, h, () => ranksOf(room.along(h))),
    halves: (axis) => cached(halfCache, axis, () => halfOf(room, axis)),
    channels: (c) => cached(channelCache, c, () => channelsOf(room, c)),
    anchorCount: () => (n <= 3 ? 2 : n <= 7 ? 4 : 5),
    waveDistance: (a) => cached(waveCache, a, () => waveDistanceOf(room, a)),
    waveLength: (a) => waveLengthOf(room, a),
    hdProject: (a) => cached(projectCache, a, () => hdProjectOf(X, Z, a)),
  };
  return room;
}

function cached<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

function ranksOf(values: readonly number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b] || a - b);
  const rank = new Array<number>(values.length);
  order.forEach((i, r) => { rank[i] = r; });
  return rank;
}

function alongOf(room: Room, heading: number): number[] {
  const sin = Math.sin((heading * Math.PI) / 180);
  const cos = Math.cos((heading * Math.PI) / 180);
  let p = room.x.map((x, i) => x * sin + room.y[i] * cos);
  let lo = Math.min(...p);
  let hi = Math.max(...p);
  if (hi - lo < 0.1) {
    const wide = Math.max(...room.x) - Math.min(...room.x) >= Math.max(...room.y) - Math.min(...room.y);
    const axis = wide ? room.x : room.y;
    const towards = wide ? sin : cos;
    const other = wide ? cos : sin;
    const reverse = towards < -1e-9 || (Math.abs(towards) <= 1e-9 && other < 0);
    p = axis.map((a) => (reverse ? -a : a));
    lo = Math.min(...p);
    hi = Math.max(...p);
  }
  return hi - lo > 1e-9 ? p.map((a) => (a - lo) / (hi - lo)) : p.map(() => 0.5);
}

function halfOf(room: Room, axis: 'depth' | 'width'): number[] {
  const n = room.n;
  if (axis === 'depth') {
    return room.rankAlong(0).map((r, i) => {
      const g = room.group ? room.group[i] : null;
      if (g === 'front') return 1;
      if (g === 'back') return 0;
      return r >= Math.floor(n / 2) ? 1 : 0;
    });
  }
  return room.rankAlong(90).map((r) => (r < Math.ceil(n / 2) ? 0 : 1));
}

// Anchor order is sides, sides/front, clockwise corners from front-left, then corners/centre.
const ANCHORS: Record<number, [number, number][]> = {
  2: [[-1, 0], [1, 0]],
  3: [[-1, 0], [0, 1], [1, 0]],
  4: [[-1, 1], [1, 1], [1, -1], [-1, -1]],
  5: [[-1, 1], [1, 1], [1, -1], [-1, -1], [0, 0]],
};

function channelsOf(room: Room, count: number): number[] {
  const n = room.n;
  const anchors = ANCHORS[count] || ANCHORS[4];
  const c = anchors.length;
  const channel = new Array<number>(n).fill(-1);
  const size = new Array<number>(c).fill(0);
  const share = Math.floor(n / c);
  let spare = n % c;
  let remaining = n;
  while (remaining > 0) {
    let progressed = false;
    for (let k = 0; k < c && remaining > 0; k++) {
      if (size[k] > share) continue;
      if (size[k] === share) {
        if (spare <= 0) continue;
        spare--;
      }
      let pick = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (channel[i] >= 0) continue;
        const d = Math.hypot(room.u[i] - anchors[k][0], room.v[i] - anchors[k][1]);
        if (d < best - 1e-12) { best = d; pick = i; }
      }
      if (pick < 0) break;
      channel[pick] = k;
      size[k]++;
      remaining--;
      progressed = true;
    }
    if (!progressed) {
      for (let i = 0; i < n; i++) if (channel[i] < 0) channel[i] = i % c;
      break;
    }
  }
  return channel;
}

// Truncate wave distances mid-calculation to preserve the preset's visible bands.

const WAVE_BUFFER = 0.75;

function javaInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.trunc(Math.max(-2147483648, Math.min(2147483647, value)));
}

function wrap360(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  // Far below zero, jump most of the way first so the loop stays short.
  if (degrees < -3600) degrees %= 360;
  while (degrees < 0) degrees += 360;
  return degrees % 360;
}

function waveOrigin(angle: number): [number, number] {
  if (angle >= 0 && angle <= 90) return [-1 - WAVE_BUFFER, -1 - WAVE_BUFFER];
  if (angle >= 90 && angle <= 180) return [1 + WAVE_BUFFER, -1 - WAVE_BUFFER];
  if (angle >= 180 && angle <= 270) return [1 + WAVE_BUFFER, 1 + WAVE_BUFFER];
  if (angle >= 270 && angle <= 360) return [-1 - WAVE_BUFFER, 1 + WAVE_BUFFER];
  return [0, 0];
}

// Nudge singular headings only after choosing their corner to preserve boundary geometry.
function lineAngle(angle: number): number {
  return angle === 180 ? 1 : angle === 0 ? 181 : angle;
}

function waveDistanceOf(room: Room, heading: number): number[] {
  const angle = wrap360(heading);
  const [ox, oy] = waveOrigin(angle);
  const theta = (lineAngle(angle) * Math.PI) / 180;
  const slope = -1 / Math.tan(theta);
  const offset = ox * slope - oy;
  const norm = Math.sqrt(slope * slope + 1);
  return room.u.map((u, i) => Math.abs(javaInt(-slope * u + room.v[i] + offset)) / norm);
}

function waveLengthOf(room: Room, heading: number): number {
  if (room.n === 0) return WAVE_BUFFER;
  const theta = (lineAngle(wrap360(heading)) * Math.PI) / 180;
  return Math.abs(javaInt(2 * Math.sin(theta))) + Math.abs(javaInt(2 * Math.cos(theta))) + WAVE_BUFFER;
}

function hdProjectOf(X: readonly number[], Z: readonly number[], angle: number): number[] {
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return X.map((x, i) => x * cos + Z[i] * sin);
}
