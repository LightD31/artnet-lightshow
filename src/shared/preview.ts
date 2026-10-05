// Pure rehearsal sampler. Replays a planned timeline so the browser can show
// what a track will look like before the room is full.
//
// It shares its arithmetic with the live engine rather than restating it: the
// pattern functions come from patterns.js, and every curve, burst colour and
// emitter scale comes from shared/look-math.js. An earlier version kept its own
// copies and had already drifted — it showed a cool-white blinder where the rig
// throws warm and a UV wash at a little over half its real level. A rehearsal
// view that is confidently wrong is worse than none.
//
// Two things it deliberately does not reproduce, both operator state rather
// than show state:
//
//   * the grand master and master blackout — rehearsing a track with the rig
//     blacked out is exactly when this view is useful, and an operator who left
//     the master down should still see the show;
//   * strobe, which has no meaning at preview frame rates.
//
// Per-fixture maximum brightness *is* applied, because that is a property of
// where the lamp hangs rather than of what the operator is doing right now.
//
// Time is counted the way the rig counts it (shared/beat-clock.js): in beats of
// the track's analysed grid, with each scene's pattern anchored on the beat it
// was scheduled for. So a chase rehearsed here is on the step the room will
// see at that moment, not on one worked out from elapsed seconds at a rounded
// tempo. A timeline with no grid is counted at its own tempo marks, as the
// rig's free clock would.
//
// It draws the pattern layer through the same function the rig does
// (shared/layer.js), so it answers per light: one entry per par, one per cell
// of an LED bar, in the rig's order (shared/rig.js).
//
// The party effects keep state from frame to frame, so a timeline that plays
// one (a scene whose pattern the caller's `resolveEffect` resolves to an
// effect, or any voice) is stepped instead: through the renderer's own
// effect layer (shared/effects/layer.ts), on the engine's 44 Hz frame grid
// counted from the timeline's zero, with the events due before each frame
// applied first. A frame of that grid is rendered once, whatever is asked;
// a moment between two frames is rendered on a copy of the frame before it,
// which is then thrown away, so how often the browser asks never changes
// what the rehearsal shows. Asked for an earlier moment, it starts again from
// the scene (or seek) before it.
import { PATTERN_FUNCS, paletteOf } from './patterns.ts';
import { renderLayer } from './layer.ts';
import { buildRig, isHueLamp, rigSignature } from './rig.ts';
import { EXPRESSION_REST, resolveEnergyOverride, blendExpression, emitterValues, blendFixture, HOLD_STROBE, holdStrobeFlash, holdStrobeLook } from './look-math.ts';
import { gridFromAnalysis, beatPositionAt, localBpm, anchorStep, stepAt, motionAdvance } from './beat-clock.ts';
import { canonical, effectContentKey, hdGuarded, renderEffectLayer, renderVoices, voiceLayout } from './effects/layer.ts';
import { presetById } from './effects/catalogue.ts';
import { ENERGY_KIND_BY_ID } from './effects/energy.ts';
import { requiresAcknowledgement, validateSpec } from './effects/registry.ts';
import { EffectStepper } from './effects/stepper.ts';
import { HdFlashGuard } from './effects/flash-guard.ts';
import { seedFrom } from './effects/hash.ts';
import { STROBE_FRAME_MS } from './effects/strobe.ts';
import { HD_MASTER_DEFAULTS } from './effects/types.ts';
import type { GridSource } from './beat-clock.ts';
import type { Layout, Rig } from './rig.ts';
import type { UnitLight } from './look-math.ts';
import type { VoiceFrame } from './effects/layer.ts';
import type { EffectInstance } from './effects/stepper.ts';
import type { EffectSlot, EffectSpec, FrameBase, Seed } from './effects/types.ts';
import type { ChannelMap, Colour, Expression, ShowDynamics, StageFixture } from '../types/rig.ts';

/** The look as a planned timeline builds it up, patch by patch. */
export interface PreviewLook {
  pattern: string;
  colorA: number;
  colorB: number;
  colorC: number;
  colorD: number;
  bpm: number;
  beatDivision: number;
  split?: number | null;
  pixelMap?: string | null;
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  panelPattern?: string | null;
  showDynamics?: ShowDynamics | null;
  [key: string]: unknown;
}

/** What a patch event carries: look keys, and how it arrives. */
export type PreviewPatch = Partial<PreviewLook> & {
  fadeMs?: number;
  id?: string;
  durationMs?: number;
};

/**
 * A `voice` event's data: a voice launched at the event's time on fixtures
 * ('shared' is the whole rig), as the renderer is handed one. `effect` is the
 * resolved effect; the seed is seedFrom(id) unless given (a recorded launch).
 */
export interface PreviewVoice {
  id: string;
  effect: EffectSpec;
  targets: 'shared' | number[];
  tier: 'strobe' | 'voice';
  launchSeq: number;
  /** Ends this long after its launch (half-open); absent runs until its `voice-end`. */
  durationMs?: number;
  seed?: Seed;
}

/** A `voice-end` event's data: the voice of this id stops. */
export interface PreviewVoiceEnd {
  id: string;
}

/**
 * One event of a planned timeline: `patch` and `energy` as the auto show
 * plays them; `voice` and `voice-end`; `seek`, where the music jumped (the
 * effects start again there, as the rig's do on a new clock epoch).
 */
export interface PreviewEvent {
  timeMs: number;
  action?: string;
  id?: string;
  durationMs?: number;
  data?: PreviewPatch | PreviewVoice | PreviewVoiceEnd | null;
}

/** A fixture as the preview needs it: where it stands, how bright it may go, and its id for the voices. */
export interface PreviewFixture extends StageFixture {
  id?: number;
  maxBrightness?: number;
}

/** The rig's lights at a moment: one colour per unit, emitter values 0–255. */
export type PreviewSample = (
  positionMs: number,
  fixtures: readonly PreviewFixture[],
  presets: readonly Colour[] | null | undefined,
  rig?: Rig,
) => Colour[];

/** The settings' safety, as the renderer reads it. */
export interface PreviewSafety {
  hdFlashIntervalMs: number;
  acknowledged: boolean;
}

export interface PreviewOptions {
  /**
   * The effect a pattern id plays, as the engine resolves it (the browser has
   * the catalogue and the library). Nothing, as for one of the fork's own
   * patterns, plays the pattern.
   */
  resolveEffect?: ((id: string) => EffectSpec | null | undefined) | null;
  /** How Hue lamps take a flash. Absent is 'pulse', as for a renderer input without it. */
  hueStrobe?: 'flash' | 'pulse';
  /**
   * The settings' safety (350 ms and unacknowledged where a field is left
   * out). Absent altogether, the old energy bursts keep the admission they
   * always had, as on a renderer input without safety.
   */
  safety?: Partial<PreviewSafety> | null;
}

interface Frame {
  timeMs: number;
  beatPos: number;
  look: PreviewLook;
  anchor: number;
  /** The beat the scene the pattern counts from was scheduled on, or null before any. */
  anchorBeat: number | null;
  /** How many scenes (patches naming a pattern) so far: each launches the base again. */
  scene: number;
  burst: { id: string | undefined; end: number } | null;
  expression: Expression;
  motionPhase: number;
  fade: { from: number; start: number; ms: number } | null;
}

interface LayerEntry {
  color: Colour;
  dim: number;
}

const LOOK_KEYS = ['pattern', 'palette', 'split', 'pixelMap', 'pixelPattern', 'panelPattern', 'colorA', 'colorB', 'colorC', 'colorD'];
const COLOUR_KEYS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;

const OPENING: PreviewLook = {
  pattern: 'solid', colorA: 0, colorB: 0, colorC: 0, colorD: 0, bpm: 120, beatDivision: 1,
};

// The engine's frame (server/frame-clock.ts), which the browser cannot import.
const FRAME_MS = STROBE_FRAME_MS;
// Float rounding of grid times: an event at 500 ms is due on the frame at 22 × 1000/44.
const SLACK_MS = 1e-6;
const gridTime = (k: number): number => k * FRAME_MS;
/** The last frame of the grid at or before `ms`. */
const frameAt = (ms: number): number => Math.floor((ms + SLACK_MS) / FRAME_MS);

/** What a stepped frame does with an event once it is due. */
type EventOp = { kind: 'voice'; voice: VoiceFrame } | { kind: 'end'; id: string } | { kind: 'seek' } | null;

/** A `voice` event's voice, checked once; null for one that is not well formed. */
function voiceOf(event: PreviewEvent, beatPos: number): VoiceFrame | null {
  const d = event.data as Partial<PreviewVoice> | null | undefined;
  if (!d || typeof d.id !== 'string' || !d.id) return null;
  if (d.tier !== 'strobe' && d.tier !== 'voice') return null;
  if (!Number.isSafeInteger(d.launchSeq)) return null;
  let targets: number[] | null;
  if (d.targets === 'shared') targets = null;
  else if (Array.isArray(d.targets) && d.targets.every((id) => Number.isSafeInteger(id))) targets = Object.freeze([...d.targets]) as number[];
  else return null;
  let untilMs: number | null = null;
  if (d.durationMs !== undefined) {
    untilMs = event.timeMs + d.durationMs;
    if (!(Number.isFinite(d.durationMs) && d.durationMs > 0 && Number.isFinite(untilMs))) return null;
  }
  let seed: Seed;
  if (d.seed === undefined) seed = seedFrom(d.id);
  else if (Array.isArray(d.seed) && d.seed.length === 4 && d.seed.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff)) {
    seed = [d.seed[0], d.seed[1], d.seed[2], d.seed[3]];
  } else return null;
  let spec: EffectSpec;
  try { spec = validateSpec(d.effect); } catch { return null; }
  // Never changed after this: checkpoints share it.
  return Object.freeze({ id: d.id, spec, targets, tier: d.tier, launchSeq: d.launchSeq as number, startedAtMs: event.timeMs,
    untilMs, anchorBeat: beatPos, seed });
}

/**
 * The effect the renderer plays an energy burst as: the six energies' own
 * kinds and the hold strobe's catalogue row (renderer.ts compatVoice).
 */
function energySpec(energy: string): EffectSpec | null {
  const id = energy === HOLD_STROBE ? HOLD_STROBE
    : Object.hasOwn(ENERGY_KIND_BY_ID, energy) ? ENERGY_KIND_BY_ID[energy as keyof typeof ENERGY_KIND_BY_ID] : null;
  const row = id ? presetById(id) : null;
  return row && !row.legacy ? row.spec : null;
}

// ── What a sample is handed, as content ─────────────────────────────────────
// The rig, the patch, the colour table and the effects belong to the whole
// rehearsed timeline: one that changes rebuilds the stepped history (equal to
// a fresh sampler with it), one rebuilt with the same content keeps it.

/** An object's JSON: read afresh each time, as a caller may change an object it hands over again. */
const contentOf = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

/** Everything a rig built by buildRig draws from its patch and profiles. */
function rigContent(rig: Rig): string {
  // The bars of one profile share their cells' maps: each read once per call.
  const seen = new Map<object, string>();
  const mapOf = (map: ChannelMap) => {
    let text = seen.get(map);
    if (text === undefined) { text = contentOf(map); seen.set(map, text); }
    return text;
  };
  let key = rigSignature(rig.fixtures);
  for (let i = 0; i < rig.fixtures.length; i++) {
    const maps = rig.cellMaps[i];
    key += `#${rig.ranges[i].count};${maps ? maps.map(mapOf).join(',') : ''};${contentOf(rig.grids[i])};${rig.zoned[i] ? 'z' : ''}`;
  }
  return key;
}

/** What the preview reads of each fixture: its id, its trim and whether it is a Hue lamp. */
function fixturesContent(fixtures: readonly PreviewFixture[]): string {
  let key = `${fixtures.length}`;
  for (const f of fixtures) key += `|${f.id ?? ''};${f.maxBrightness ?? 255};${isHueLamp(f) ? 'h' : ''}`;
  return key;
}

/** Specs checked once per content: the resolver may hand over the same effect as a new object each time. */
const checked = new Map<string, EffectSpec | null>();
function checkedSpec(raw: unknown): { spec: EffectSpec | null; key: string } {
  if (!raw || typeof raw !== 'object') return { spec: null, key: 'null' };
  const key = canonical(raw);
  if (!checked.has(key)) {
    if (checked.size >= 512) checked.clear();
    let spec: EffectSpec | null;
    try { spec = validateSpec(raw); } catch { spec = null; }
    checked.set(key, spec);
  }
  return { spec: checked.get(key)!, key };
}

/** The cells of a layout with each cell's fixture id and Hue flag, as the renderer's effects read them. */
interface Cells {
  key: string;
  layout: Layout;
  ids: (number | string)[];
}

interface Env {
  key: string;
  stepped: boolean;
  fixtures: readonly PreviewFixture[];
  presets: readonly Colour[];
  rig: Rig;
  specs: Map<string, EffectSpec | null>;
  hue: boolean[];
  cells: Map<string, Cells>;
}

// ── The stepped history ─────────────────────────────────────────────────────

/** A voice's launch as the renderer keeps it: a new launch under an id starts its state again. */
interface VoiceRecord { launch: string; kind: string; wireAnchor: number; anchor: number; epoch: number }

/** Everything a frame of the grid leaves for the next: a checkpoint is a copy of one. */
interface Walk {
  /** The last frame rendered (its index on the grid), or the one before the first. */
  k: number;
  /** How many timeline events have been applied. */
  cursor: number;
  stepper: EffectStepper;
  guard: HdFlashGuard;
  expression: Expression;
  phase: number;
  lastBeat: number | null;
  lastEpoch: number;
  lastNow: number | null;
  lastSweep: number;
  /** Seek markers so far: the rig's clock epoch. */
  epoch: number;
  base: { key: string; id: string; kind: string; seed: Seed; startedAtMs: number } | null;
  /** The voices launched and not ended, in launch order. */
  voices: Map<string, VoiceFrame>;
  records: Map<string, VoiceRecord>;
  /** The energy burst lane as a voice of its own. */
  compat: { energy: string; voice: VoiceFrame } | null;
  /** The fade in progress: which of the timeline's fades, and the base it froze. */
  fadeOf: Frame['fade'];
  fade: { start: number; ms: number; from: UnitLight[] } | null;
  /** The base layer as it went out on the last frame, per light: what a fade starts from. */
  shown: UnitLight[];
  /** The last frame's lights. */
  output: Colour[] | null;
}

/** A checkpoint's own copy: nothing in it is shared with the walk it came from but what is never changed. */
function copyWalk(w: Walk): Walk {
  return {
    ...w,
    stepper: w.stepper.clone(),
    guard: w.guard.clone(),
    expression: { ...w.expression },
    base: w.base && { ...w.base },
    // Voice frames, fade sources, shown lights and outputs are made afresh and never changed.
    voices: new Map(w.voices),
    records: new Map([...w.records].map(([id, rec]) => [id, { ...rec }])),
    compat: w.compat && { ...w.compat },
    fade: w.fade && { ...w.fade },
    shown: [...w.shown],
  };
}

const emptyWalk = (k: number, intervalMs: number): Walk => ({
  k, cursor: 0, stepper: new EffectStepper(), guard: new HdFlashGuard(intervalMs), expression: { ...EXPRESSION_REST }, phase: 0,
  lastBeat: null, lastEpoch: 0, lastNow: null, lastSweep: -Infinity, epoch: 0, base: null, voices: new Map(), records: new Map(),
  compat: null, fadeOf: null, fade: null, shown: [], output: null,
});

/** A light of the layer, as the renderer keeps one (its setUnitColor). */
const unitLight = (c: Colour, dim: number, strobe = 0): UnitLight => ({
  r: c.r, g: c.g, b: c.b, w: c.w || 0, a: c.a || 0, uv: c.uv || 0, dim, strobe,
});

/**
 * `grid` is the analysis the timeline was planned from — `{ beats, downbeats,
 * meter }`, as the timeline data carries it — or nothing. `options` says how
 * the effects resolve and what the settings are (PreviewOptions).
 */
function createPreviewSampler(events: readonly PreviewEvent[] = [], grid: GridSource | null = null,
  options: PreviewOptions = {}): PreviewSample {
  const beatGrid = gridFromAnalysis(grid);
  const hueStrobe = options.hueStrobe === 'flash' ? 'flash' : 'pulse';
  const safetyGiven = options.safety != null;
  const givenInterval = options.safety?.hdFlashIntervalMs;
  const intervalMs = typeof givenInterval === 'number' && Number.isFinite(givenInterval) && givenInterval >= 0 ? givenInterval : 350;
  const acknowledged = options.safety?.acknowledged === true;

  // In time order, ties in the order given, on a copy: an event with no time is ignored.
  const timeline = events.filter((e) => Number.isFinite(e.timeMs)).sort((a, b) => a.timeMs - b.timeMs);

  let look: PreviewLook = { ...OPENING };
  let anchor = 0;
  let anchorBeat: number | null = null;
  let scene = 0;
  let burst: Frame['burst'] = null;
  // Carried across the walk so each frame records where the continuous channels
  // had got to by the time it fired. The blend below is a first-order lag, and
  // that is exact over any step while the target holds — so one step per event
  // lands on the same value the engine reaches in forty steps a second.
  let expression: Expression = { ...EXPRESSION_REST };
  let motionPhase = 0;
  // The crossfade in progress, as the engine keeps it: which frame was on
  // stage when it began, and when. A new look without a fade cuts it short.
  let fade: Frame['fade'] = null;
  let lastMs = events.length && Number.isFinite(events[0].timeMs) && timeline.length ? timeline[0].timeMs : 0;
  // Without a grid, the beat count the free clock would have reached: each
  // stretch between events at the tempo in force across it.
  let freeBeats = 0;

  const frames: Frame[] = [];
  const ops: EventOp[] = [];
  /** Where the music is at `timeMs`, in beats, within frame `f` (or the walk so far). */
  const beatAt = (timeMs: number, f: Pick<Frame, 'timeMs' | 'beatPos' | 'look'>): number => (beatGrid
    ? beatPositionAt(beatGrid, timeMs)
    : f.beatPos + ((timeMs - f.timeMs) / 60000) * Math.max(20, f.look.bpm || 120));

  for (const event of timeline) {
    const dt = Math.max(0, (event.timeMs - lastMs) / 1000);
    const walked = { timeMs: lastMs, beatPos: freeBeats, look };
    const beatsBefore = beatAt(lastMs, walked);
    const beatPos = beatAt(event.timeMs, walked);
    freeBeats = beatPos;
    motionPhase = (motionPhase + motionAdvance(beatPos - beatsBefore, expression.motion)) % 1;
    expression = blendExpression(expression, look.showDynamics || null, dt);
    lastMs = event.timeMs;

    let op: EventOp = null;
    if (event.action === 'patch') {
      const patch = (event.data || {}) as PreviewPatch;
      const dynamics = patch.showDynamics && { ...look.showDynamics, ...patch.showDynamics };
      look = { ...look, ...patch };
      if (dynamics) look.showDynamics = dynamics;
      // As the rig anchors a scheduled scene (server/patch.js): on the step
      // grid, at the beat the scene was due.
      if (patch.pattern !== undefined || patch.pixelPattern !== undefined || patch.panelPattern !== undefined
        || patch.beatDivision !== undefined) {
        anchor = anchorStep(beatPos, look.beatDivision || 1);
        anchorBeat = beatPos;
      }
      // Every scene that names its pattern launches it again, the same one included.
      if (patch.pattern !== undefined) scene++;
      if ('energyOverride' in patch) burst = null;
      // As the engine: a fade asked for starts one, and a new look or a fade of 0 cuts any in progress.
      if (patch.fadeMs && patch.fadeMs > 0) fade = { from: frames.length - 1, start: event.timeMs, ms: patch.fadeMs };
      else if (patch.fadeMs !== undefined || LOOK_KEYS.some((k) => patch[k] !== undefined)) fade = null;
    } else if (event.action === 'energy') {
      const patch = (event.data || {}) as PreviewPatch;
      burst = { id: patch.id || event.id, end: event.timeMs + (patch.durationMs || event.durationMs || 200) };
    } else if (event.action === 'voice') {
      const voice = voiceOf(event, beatPos);
      if (voice) op = { kind: 'voice', voice };
    } else if (event.action === 'voice-end') {
      const id = (event.data as Partial<PreviewVoiceEnd> | null | undefined)?.id;
      if (typeof id === 'string') op = { kind: 'end', id };
    } else if (event.action === 'seek') {
      op = { kind: 'seek' };
    }
    frames.push({ timeMs: event.timeMs, beatPos, look, anchor, anchorBeat, scene, burst, expression, motionPhase, fade });
    ops.push(op);
  }

  // A voice event anywhere means the timeline owns its voices, as a renderer input with `voices` does.
  const explicitVoices = timeline.some((e) => e.action === 'voice' || e.action === 'voice-end');
  const patterns = [...new Set(frames.map((f) => f.look.pattern))];
  // An event that launches the base again: where a backward sample starts over.
  const keyframe = timeline.map((e, i) => ops[i]?.kind === 'seek' || (e.action === 'patch' && frames[i].scene !== (frames[i - 1]?.scene ?? 0)));

  /** The look's four colours, resolved against the colour table. */
  const coloursOf = (s: PreviewLook, presets: readonly Colour[]): Colour[] => COLOUR_KEYS.map((key) => presets[s[key]] || presets[0]);

  /**
   * The pattern layer at a moment: the pattern and colours through the layer
   * the engine draws, one entry per light of `rig`. A crossfade is the
   * caller's business.
   */
  function drawPattern(f: Frame, positionMs: number, rig: Rig, colors: Colour[], expr: Expression, phase: number, bpm: number): LayerEntry[] {
    const s = f.look;
    const division = Math.max(1, s.beatDivision || 1);
    const beatPos = beatAt(positionMs, f);
    const step = stepAt(beatPos, f.anchor, division);
    const layer: LayerEntry[] = rig.units.map(() => ({ color: colors[0], dim: 0 }));
    // The same layer the engine draws, so a chase rehearsed here travels across
    // the plot exactly as it will across the room — in stage order, around a
    // split look's wash, and along the cells of every bar.
    renderLayer(rig, {
      pattern: PATTERN_FUNCS[s.pattern] ? s.pattern : 'solid',
      colors,
      split: s.split,
      pixelMap: s.pixelMap,
      pixelPattern: s.pixelPattern && PATTERN_FUNCS[s.pixelPattern] ? s.pixelPattern : null,
      pixelSpan: s.pixelSpan ?? null,
      pixelFrom: s.pixelFrom ?? null,
      panelPattern: s.panelPattern && PATTERN_FUNCS[s.panelPattern] ? s.panelPattern : null,
    }, {
      beatPos,
      step,
      anchor: f.anchor,
      division,
      phase,
      expression: expr,
      dynamicsOn: !!s.showDynamics,
      bpm,
      hueStrobe,
      fixtureCount: rig.fixtures.length,
      twinkle: rig.units.map(() => 0),
      pixelTwinkle: rig.units.map(() => 0),
      panelTwinkle: rig.units.map(() => 0),
    }, (u, color, dim) => { layer[u] = { color, dim }; });
    return layer;
  }

  /**
   * What the pattern layer shows at a moment: the pattern and colours, with the
   * two continuous patterns and any crossfade applied — everything the engine
   * computes before a burst, the music's level and the trims go on top. One
   * entry per light of `rig`.
   */
  function patternLayer(index: number, positionMs: number, rig: Rig, presets: readonly Colour[]): {
    layer: LayerEntry[];
    colors: Colour[];
    expr: Expression;
    dyn: ShowDynamics | null;
  } {
    const frame = frames[index];
    const s = frame.look;
    const dyn = s.showDynamics || null;
    const since = Math.max(0, positionMs - frame.timeMs) / 1000;
    const expr = blendExpression(frame.expression, dyn, since);
    const beatPos = beatAt(positionMs, frame);
    const phase = (frame.motionPhase + motionAdvance(beatPos - frame.beatPos, expr.motion)) % 1;
    const colors = coloursOf(s, presets);
    const layer = drawPattern(frame, positionMs, rig, colors, expr, phase, s.bpm);

    // A crossfade starts from the look as it stood when the fade began, frozen
    // there, exactly as the engine snapshots it.
    const f = frame.fade;
    if (f && f.from >= 0 && positionMs < f.start + f.ms) {
      const from = patternLayer(f.from, f.start, rig, presets).layer;
      const t = Math.max(0, positionMs - f.start) / f.ms;
      return {
        layer: layer.map((to, u) => {
          const mixed = blendFixture({ ...from[u].color, dim: from[u].dim, strobe: 0 }, { ...to.color, dim: to.dim, strobe: 0 }, t);
          return { color: mixed, dim: mixed.dim };
        }),
        colors, expr, dyn,
      };
    }
    return { layer, colors, expr, dyn };
  }

  /** The last event at or before `positionMs`, or -1. */
  function frameIndex(positionMs: number): number {
    let lo = 0, hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].timeMs <= positionMs) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  /**
   * The old timeline, patterns and the energy lane, answered for any moment
   * straight from the walk above. A burst the renderer would hold back for
   * the acknowledgement is held back here too, and a Hue lamp takes the hold
   * strobe as the setting says.
   */
  function sampleLegacy(positionMs: number, env: Pick<Env, 'fixtures' | 'presets' | 'rig' | 'hue'>): Colour[] {
    const { fixtures, presets, rig, hue } = env;
    const index = frameIndex(positionMs);
    const frame = frames[index];
    if (!frame) return dark(rig);

    const { layer, colors, expr, dyn } = patternLayer(index, positionMs, rig, presets);
    let burstId = frame.burst && positionMs < frame.burst.end ? frame.burst.id : null;
    if (burstId && safetyGiven && !acknowledged) {
      const spec = energySpec(burstId);
      if (spec && requiresAcknowledgement(spec)) burstId = null;
    }
    const energy = burstId ? resolveEnergyOverride(burstId, colors[0], expr.level) : null;
    // The hold strobe is a burst per light, as the rig renders it: a flash,
    // a Hue lamp's pulse, or nothing between flashes.
    const hold = !energy && burstId === HOLD_STROBE
      ? holdStrobeFlash(beatAt(positionMs, frame), beatGrid ? localBpm(beatGrid, positionMs) : frame.look.bpm)
      : null;
    const palette = hold ? paletteOf({ colors }) : null;

    return layer.map(({ color, dim }, u) => {
      const { fixture: i, cell } = rig.units[u];
      const fixture = fixtures[i];
      const burst = hold && palette ? holdStrobeLook(palette, hold, hue[i] && hueStrobe === 'pulse') : energy;
      if (burst) {
        color = burst.col;
        dim = burst.dim;
      } else {
        dim *= expr.level;
        if (dyn && dyn.level === 0) dim = 0;
      }
      const scale = (dim / 255) * ((fixture.maxBrightness ?? 255) / 255);
      return onlyItsEmitters(emitterValues(color, scale), rig.cellMaps[i]?.[cell]);
    });
  }

  // ── The stepped timeline ──────────────────────────────────────────────────

  let env: Env | null = null;
  // The canonical frames: the walk as far as it has gone, the copies taken
  // at each scene and seek it passed (never changed), and the last moment
  // between two frames asked for.
  let walk: Walk | null = null;
  let keyframes: Walk[] = [];
  let tail: { positionMs: number; output: Colour[] } | null = null;
  const firstFrame = timeline.length ? Math.ceil((timeline[0].timeMs - SLACK_MS) / FRAME_MS) : 0;

  /** The environment of this sample: the same one while its content is the same. */
  function environment(fixtures: readonly PreviewFixture[], presets: readonly Colour[], rig: Rig): Env {
    const specs = new Map<string, EffectSpec | null>();
    let effectsKey = '';
    let anyEffect = false;
    for (const id of patterns) {
      const { spec, key } = options.resolveEffect ? checkedSpec(options.resolveEffect(id)) : { spec: null, key: 'null' };
      specs.set(id, spec);
      if (spec) anyEffect = true;
      effectsKey += `${JSON.stringify(id)}=${key};`;
    }
    if (!(explicitVoices || anyEffect)) {
      // Nothing steps: answered straight from the timeline, nothing kept.
      if (env) { env = null; walk = null; keyframes = []; tail = null; }
      return { key: '', stepped: false, fixtures, presets, rig, specs, hue: fixtures.map(isHueLamp), cells: new Map() };
    }
    const key = `${effectsKey}\n${fixturesContent(fixtures)}\n${rigContent(rig)}\n${presets.map(contentOf).join(',')}`;
    if (env && env.key === key) {
      // The same content: keep the history, but read this call's objects.
      env.fixtures = fixtures; env.presets = presets; env.rig = rig;
      return env;
    }
    env = { key, stepped: true, fixtures, presets, rig, specs, hue: fixtures.map(isHueLamp), cells: new Map() };
    walk = null;
    keyframes = [];
    tail = null;
    return env;
  }

  /** A layout's cells with their current fixture ids and Hue flags, as renderer.ts effectCells. */
  function cellsOf(e: Env, key: string, layout: () => Layout): Cells {
    let cells = e.cells.get(key);
    if (!cells) {
      const base = layout();
      const { list } = base.units;
      const ids = list.map((u) => { const i = e.rig.units[u].fixture; return e.fixtures[i]?.id ?? `#${i}`; });
      const flags = list.map((u) => e.hue[e.rig.units[u].fixture]);
      const noFlash = flags.some(Boolean) ? flags : null;
      cells = { key, layout: { ...base, units: { ...base.units, noFlash } }, ids };
      e.cells.set(key, cells);
    }
    return cells;
  }

  /** Apply every event due by `t` to the walk. */
  function advance(w: Walk, t: number): void {
    while (w.cursor < timeline.length && timeline[w.cursor].timeMs <= t + SLACK_MS) {
      const op = ops[w.cursor++];
      if (!op) continue;
      if (op.kind === 'voice') {
        // A relaunch under an id goes to the end of the table, as a new launch.
        w.voices.delete(op.voice.id);
        w.voices.set(op.voice.id, op.voice);
      } else if (op.kind === 'end') w.voices.delete(op.id);
      else w.epoch++;
    }
  }

  const launchKeys = new WeakMap<VoiceFrame, string>();
  /** What makes a launch new, as renderer.ts playingVoices reads it. */
  function launchOf(v: VoiceFrame): string {
    let launch = launchKeys.get(v);
    if (launch === undefined) {
      launch = v.spec.kind === 'strobe' ? 'strobe' : canonical([v.launchSeq, v.startedAtMs, v.seed, effectContentKey(v.spec)]);
      launchKeys.set(v, launch);
    }
    return launch;
  }

  /**
   * The voices playing at `t`, each on the musical anchor it plays from, as
   * renderer.ts playingVoices: a voice not started or past its deadline plays
   * nothing; a new launch under an id starts its state again (a strobe keeps
   * its permit); a seek moves a voice's anchor to the start of the scene's
   * beat and leaves its wall times. The energy lane rides along as a voice of
   * its own, admitted without the acknowledgement only while no safety is given.
   */
  function playingVoices(w: Walk, t: number, beatPos: number, f: Frame): { voices: VoiceFrame[]; admitted: Set<VoiceFrame> } {
    const energy = f.burst && t < f.burst.end ? f.burst.id ?? null : null;
    if (!energy) w.compat = null;
    else if (!w.compat || w.compat.energy !== energy) {
      const spec = energySpec(energy);
      const id = `energy:${energy}`;
      // The hold strobe stays on the global beat grid (anchor 0), as it always flashed.
      w.compat = spec ? { energy, voice: Object.freeze({ id, spec, targets: null, tier: energy === HOLD_STROBE ? 'strobe' : 'voice',
        launchSeq: 0, startedAtMs: t, untilMs: null, anchorBeat: 0, seed: seedFrom(id) }) } : null;
    }
    const compat = w.compat?.voice ?? null;
    const source = compat ? [...w.voices.values(), compat] : [...w.voices.values()];
    const admitted = new Set<VoiceFrame>();
    const seen = new Set<string>();
    const voices: VoiceFrame[] = [];
    for (const v of source) {
      if (!(t >= v.startedAtMs)) continue;
      if (v.untilMs != null && !(t < v.untilMs)) {
        // Time only runs forward on a walk: an ended voice never plays again.
        if (v !== compat) w.voices.delete(v.id);
        continue;
      }
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      const kind = v.spec.kind;
      const launch = launchOf(v);
      let rec = w.records.get(v.id);
      if (!rec || rec.launch !== launch || rec.kind !== kind) {
        if (!(kind === 'strobe' && (!rec || rec.kind === 'strobe'))) w.stepper.forget(v.id);
        rec = { launch, kind, wireAnchor: v.anchorBeat, anchor: v.anchorBeat, epoch: w.epoch };
        w.records.set(v.id, rec);
      } else if (rec.wireAnchor !== v.anchorBeat) {
        rec.wireAnchor = rec.anchor = v.anchorBeat;
        rec.epoch = w.epoch;
      } else if (rec.epoch !== w.epoch) {
        if (v !== compat) rec.anchor = Math.floor((f.anchorBeat ?? beatPos) + 1e-9);
        rec.epoch = w.epoch;
      }
      const played: VoiceFrame = { ...v, anchorBeat: rec.anchor };
      if (v === compat && !safetyGiven) admitted.add(played);
      voices.push(played);
    }
    for (const id of w.records.keys()) if (!seen.has(id)) w.records.delete(id);
    return { voices, admitted };
  }

  /**
   * One frame of the stepped timeline at `t`, after the events due by then:
   * renderer.ts frame() without the masters, the strobe channel, overrides,
   * the sync test and the flash limit. Its lights only when asked for: a
   * frame stepped through on the way to another leaves only its state.
   */
  function render(w: Walk, t: number, e: Env, lights: boolean): Colour[] | null {
    const { fixtures, presets, rig } = e;
    const f = frames[w.cursor - 1];
    const s = f.look;
    const dt = w.lastNow === null ? 0 : Math.max(0, t - w.lastNow);
    w.lastNow = t;
    const target = s.showDynamics || null;
    w.expression = blendExpression(w.expression, target, Math.min(0.25, dt / 1000));
    const beatPos = beatAt(t, f);
    const dBeats = w.lastBeat !== null && w.lastEpoch === w.epoch ? Math.min(4, Math.max(0, beatPos - w.lastBeat)) : 0;
    w.lastBeat = beatPos;
    w.lastEpoch = w.epoch;
    w.phase = (w.phase + motionAdvance(dBeats, w.expression.motion)) % 1;
    const bpm = beatGrid ? localBpm(beatGrid, t) : Math.max(20, s.bpm || 120);
    if (t - w.lastSweep >= 1000 || t < w.lastSweep) {
      w.stepper.sweep(t);
      w.lastSweep = t;
    }
    w.guard.setInterval(intervalMs);
    // A fade asked for since the last frame starts from what that frame showed.
    if (f.fade !== w.fadeOf) {
      w.fadeOf = f.fade;
      w.fade = f.fade ? { start: f.fade.start, ms: f.fade.ms, from: [...w.shown] } : null;
    }

    const colors = coloursOf(s, presets);
    const spec = e.specs.get(s.pattern) ?? null;
    const { voices, admitted } = playingVoices(w, t, beatPos, f);
    const n = rig.units.length;
    const units: UnitLight[] = new Array<UnitLight>(n);
    const baseKind: (string | null)[] = new Array<string | null>(n).fill(null);
    let fb: FrameBase | null = null;
    let voiceCells: Cells | null = null;
    if (spec || voices.length) {
      voiceCells = cellsOf(e, 'voices', () => voiceLayout(rig));
      const ids = voiceCells.ids;
      // Disco's automatic strobe stands down for any manual strobe playing.
      const manualStrobeActive = voices.some((v) => v.spec.kind === 'strobe' && (v.targets === null || v.targets.some((id) => ids.includes(id))));
      fb = {
        beatPos, bpm, nowMs: t, dtMs: dt, anchorBeat: 0, lookPalette: paletteOf({ colors }), paletteOverride: null,
        audio: null, audioMode: 'tempo', master: { ...HD_MASTER_DEFAULTS }, seed: [0, 0, 0, 0], acknowledged, hueStrobe,
        manualStrobeActive, expressionLevel: w.expression.level,
      };
    }

    if (spec && fb) {
      // The base effect over the look's split cells, launched as the
      // renderer launches it, the split look's wash holding colour B.
      const split = s.split ?? null;
      const pixelMap = s.pixelMap ?? 'stage';
      const cells = cellsOf(e, `${split}|${pixelMap}`, () => rig.layout(split, pixelMap));
      const division = Math.max(1, s.beatDivision || 1);
      const id = `base:${s.pattern}:${f.anchor}`;
      // Every scene and every seek is a new launch, even on the same id.
      const key = canonical([id, f.scene, effectContentKey(spec), cells.key, w.epoch]);
      if (!w.base || w.base.key !== key) {
        if (w.base && w.base.kind === 'strobe' && spec.kind === 'strobe') w.stepper.move(w.base.id, id);
        else {
          if (w.base) w.stepper.forget(w.base.id);
          w.stepper.forget(id);
        }
        w.base = { key, id, kind: spec.kind, seed: seedFrom(id), startedAtMs: t };
      }
      const instance: EffectInstance = { id, spec, seed: w.base.seed, anchorBeat: f.anchor / division, startedAtMs: w.base.startedAtMs, targets: null };
      renderEffectLayer(rig, cells.layout, { ...fb, fixtureIds: cells.ids }, instance, w.stepper, (u, colour, dim, strobe, kind) => {
        units[u] = unitLight(colour, dim, strobe);
        baseKind[u] = kind;
      });
      for (const i of cells.layout.wash) {
        const { start, count } = rig.ranges[i];
        for (let u = start; u < start + count; u++) { units[u] = unitLight(colors[1], 255); baseKind[u] = null; }
      }
    } else {
      const layer = drawPattern(f, t, rig, colors, w.expression, w.phase, bpm);
      for (let u = 0; u < n; u++) units[u] = unitLight(layer[u].color, layer[u].dim);
    }

    // The voice on top of each light, or null where the base shows.
    let voiceTop: (EffectSlot | null)[] | null = null;
    if (voices.length && fb && voiceCells) {
      const winners = renderVoices(rig, voiceCells.layout, { ...fb, fixtureIds: voiceCells.ids }, voices, w.stepper, { admit: admitted });
      voiceTop = new Array<EffectSlot | null>(n).fill(null);
      const { list } = voiceCells.layout.units;
      for (let k = 0; k < list.length; k++) voiceTop[list[k]] = winners[k];
    }

    let fadeT = 1;
    if (w.fade) {
      fadeT = (t - w.fade.start) / w.fade.ms;
      if (fadeT >= 1) w.fade = null;
    }
    const shown: UnitLight[] = new Array<UnitLight>(n);
    const cols: Colour[] = new Array<Colour>(n);
    const dims: number[] = new Array<number>(n);
    const tops: (string | null)[] = new Array<string | null>(n);
    let guarded = false;
    for (let u = 0; u < n; u++) {
      // The base as it goes out, partway through any fade: what the next fade starts from.
      const layer = w.fade && w.fade.from[u] ? blendFixture(w.fade.from[u], units[u], fadeT) : units[u];
      shown[u] = layer;
      const voice = voiceTop ? voiceTop[u] : null;
      if (voice) {
        // A voice stands where the energy burst always stood, at its own level.
        cols[u] = voice.colour;
        dims[u] = 255 * voice.level;
      } else {
        cols[u] = layer;
        dims[u] = target?.level === 0 ? 0 : layer.dim * w.expression.level;
      }
      tops[u] = voice ? voice.kind ?? null : baseKind[u];
      if (hdGuarded(tops[u])) guarded = true;
    }
    w.shown = shown;
    // Hue Dynamics' limit on its own kinds, on what each lamp puts out at its trim (the preview's master is full).
    if (guarded) {
      for (let u = 0; u < n; u++) {
        if (!hdGuarded(tops[u])) { w.guard.clear(u); continue; }
        const trim = (fixtures[rig.units[u].fixture]?.maxBrightness ?? 255) / 255;
        if (w.guard.apply(u, (dims[u] / 255) * trim, t) === 0) dims[u] = 0;
      }
    } else if (w.guard.brightCount) for (let u = 0; u < n; u++) w.guard.clear(u);

    if (!lights) return null;
    const out = new Array<Colour>(n);
    for (let u = 0; u < n; u++) {
      const { fixture: i, cell } = rig.units[u];
      const scale = (dims[u] / 255) * ((fixtures[i]?.maxBrightness ?? 255) / 255);
      out[u] = onlyItsEmitters(emitterValues(cols[u], scale), rig.cellMaps[i]?.[cell]);
    }
    return out;
  }

  /** The keyframe to start from for frame `k`: the last one at or before it. */
  function keyframeBefore(k: number): Walk {
    let lo = 0, hi = keyframes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keyframes[mid].k <= k) lo = mid + 1; else hi = mid;
    }
    return keyframes[lo - 1];
  }

  /**
   * The canonical walk at frame `k` (not before the one before the
   * timeline's first frame), with that frame's lights when `lights` asks.
   */
  function walkTo(k: number, e: Env, lights: boolean): Walk {
    if (!keyframes.length) keyframes.push(emptyWalk(firstFrame - 1, intervalMs));
    if (walk && walk.k === k && (walk.output || !lights)) return walk;
    // A copy is the state after its frame: to see frame k, start before it.
    const from = keyframeBefore(lights ? k - 1 : k);
    // Back in time, or a scene's copy nearer than the walk: start from the copy.
    if (!walk || walk.k > k || (walk.k === k && lights) || from.k > walk.k) walk = copyWalk(from);
    while (walk.k < k) {
      const next = walk.k + 1;
      const t = gridTime(next);
      // Before a frame that launches the base again, keep a copy to come back to.
      let launches = false;
      for (let i = walk.cursor; i < timeline.length && timeline[i].timeMs <= t + SLACK_MS; i++) if (keyframe[i]) { launches = true; break; }
      if (launches && keyframes[keyframes.length - 1].k < walk.k) keyframes.push(copyWalk(walk));
      advance(walk, t);
      walk.output = render(walk, t, e, lights && next === k);
      walk.k = next;
    }
    return walk;
  }

  /** The stepped timeline at `positionMs`. */
  function sampleStepped(positionMs: number, e: Env): Colour[] {
    const k = frameAt(positionMs);
    if (Math.abs(positionMs - gridTime(k)) <= SLACK_MS) return copyOut(walkTo(k, e, true).output!);
    if (tail && tail.positionMs === positionMs) return copyOut(tail.output);
    // Between two frames: the frame before, then this moment on a copy that is thrown away.
    const copy = copyWalk(walkTo(Math.max(k, firstFrame - 1), e, false));
    advance(copy, positionMs);
    const output = render(copy, positionMs, e, true)!;
    tail = { positionMs, output };
    return copyOut(output);
  }

  /**
   * The rig's lights at `positionMs`, as emitter values: one entry per par and
   * one per cell of each bar. `rig` is the rig built with the profiles (see
   * shared/rig.js); without one, every fixture is taken as a single light.
   */
  return (positionMs, fixtures, presets, rig = buildRig(fixtures, () => null)) => {
    // Nothing due yet (or no colours to show): nothing plays.
    if (!presets?.length || !timeline.length || !(timeline[0].timeMs <= positionMs + SLACK_MS)) return dark(rig);
    const e = environment(fixtures, presets, rig);
    if (!e.stepped) return sampleLegacy(positionMs, e);
    return sampleStepped(positionMs, e);
  };
}

/** Every light dark, before the timeline begins. */
const dark = (rig: Rig): Colour[] => rig.units.map(() => ({ r: 0, g: 0, b: 0 }));

/** The caller's own copy of a frame's lights. */
const copyOut = (lights: readonly Colour[]): Colour[] => lights.map((c) => ({ ...c }));

/**
 * A cell's emitters as the rig drives them: only those its channel map has.
 * A strobe panel's white zone shows a red chase as the rig does — dark — and
 * lights for a white strobe.
 */
function onlyItsEmitters(v: ReturnType<typeof emitterValues>, map: ChannelMap | null | undefined): ReturnType<typeof emitterValues> {
  if (!map) return v;
  const has = (...names: string[]) => names.some((n) => map[n] !== undefined);
  if (!has('red', 'green', 'blue', 'white', 'coolWhite', 'amber', 'warmWhite', 'uv')) return v;
  return {
    ...v,
    r: has('red') ? v.r : 0,
    g: has('green') ? v.g : 0,
    b: has('blue') ? v.b : 0,
    w: has('white', 'coolWhite') ? v.w : 0,
    a: has('amber', 'warmWhite') ? v.a : 0,
    uv: has('uv') ? v.uv : 0,
  };
}

export {
  createPreviewSampler,
};
