import { COLOR_PRESETS, STROBE_FUNCTIONS } from './presets.ts';
import { HUE_PROFILE_IDS } from './profiles.ts';
import { FRAME_MS } from './frame-clock.ts';
import { PATTERN_FUNCS, paletteOf } from '../shared/patterns.ts';
import { renderLayer } from '../shared/layer.ts';
import { buildRig, rigSignature } from '../shared/rig.ts';
import { cellPlace, channelPlace, stripOf } from '../shared/placement.ts';
// Shared with the browser's rehearsal preview so the two cannot drift.
import { EXPRESSION_REST, blendExpression, emitterValues, blendFixture, cellDrive, HOLD_STROBE } from '../shared/look-math.ts';
import { anchorStep, stepAt, motionAdvance } from '../shared/beat-clock.ts';
import { createFlashLimiter, lightLuminance, strobeCap } from './flash-limit.ts';
import { identifyLights } from './identify.ts';
import { HD_MASTER_DEFAULTS } from '../shared/effects/types.ts';
import { canonical, effectContentKey, handOverStrobes, hdGuarded, relaunchEffect, renderEffectLayer, renderVoices, voiceAnchor, voiceLaunchKey, voiceLayout } from '../shared/effects/layer.ts';
import { energyEffectSpec } from '../shared/effects/catalogue.ts';
import { endSequence, newSequenceRun, renderSequenceLayer, retable } from '../shared/effects/sequence.ts';
import { kindOf, ridesLevel } from '../shared/effects/registry.ts';
import { EffectStepper } from '../shared/effects/stepper.ts';
import { HdFlashGuard, StrobeLampGuard } from '../shared/effects/flash-guard.ts';
import { strobeFrameOf } from '../shared/effects/strobe.ts';
import { seedFrom } from '../shared/effects/hash.ts';
import type { IdentifyRequest } from './identify.ts';
import type { EnergyLook, UnitLight } from '../shared/look-math.ts';
import type { Layout, Rig } from '../shared/rig.ts';
import type { MusicalTime } from './conductor.ts';
import type { PatternAnchor } from './state.ts';
import type { UniverseStore } from './universes.ts';
import type { AudioFrame } from '../shared/effects/audio-frame.ts';
import type { VoiceFrame, VoiceRecord } from '../shared/effects/layer.ts';
import type { EffectInstance } from '../shared/effects/stepper.ts';
import type { SequenceTable, SequenceTransport } from '../shared/effects/sequence.ts';
import type { AudioMode, EffectCommand, EffectSlot, EffectSpec, FrameBase, HdMaster, Seed } from '../shared/effects/types.ts';
import type { ChannelDefault, ChannelMap, Colour, Expression, Override, PixelMap, Profile, PulseReading, ShowDynamics, StageFixture } from '../types/rig.ts';

export type { VoiceFrame } from '../shared/effects/layer.ts';
export { effectContentKey };

export interface RenderFixture extends StageFixture {
  id: number;
  address: number;
  universe: number;
  profileId: string;
  maxBrightness: number;
  override: Override | null;
  hue: boolean;
}

export interface FadeRequest {
  seq: number;
  ms: number;
  at: number;
}

export interface SyncTestRequest {
  seq: number;
  seconds: number;
  at: number;
}

export interface RenderInput {
  running: boolean;
  pattern: string;
  colorA: number;
  colorB: number;
  colorC: number;
  colorD: number;
  split: number | null;
  pixelMap: PixelMap;
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  panelPattern?: string | null;
  beatDivision: number;
  strobeSpeed: number;
  strobeFunction: string;
  masterDimmer: number;
  masterBlackout: boolean;
  flashLimit?: boolean;
  energy: string | null;
  showDynamics: ShowDynamics | null;
  pulse?: PulseReading | null;
  patternAnchor: PatternAnchor | null;
  fade: FadeRequest | null;
  syncTest: SyncTestRequest | null;
  identify?: IdentifyRequest | null;
  universes: number[];
  fixtures: RenderFixture[];
  audio?: AudioFrame | null;
  audioMode?: AudioMode;
  master?: HdMaster;
  effect?: EffectSpec | null;
  effectRevision?: number;
  voices?: VoiceFrame[];
  paletteOverride?: Colour[] | null;
  safety?: RenderSafety;
  hueStrobe?: 'flash' | 'pulse';
  sequenceRevision?: number | null;
  sequenceTransport?: SequenceTransport | null;
}

export interface RenderSafety {
  hdFlashIntervalMs: number;
  acknowledged: boolean;
}

export const RENDER_SAFETY_DEFAULTS: Readonly<RenderSafety> = Object.freeze({ hdFlashIntervalMs: 350, acknowledged: false });

export type FrameInput = RenderInput & Required<Pick<RenderInput,
  'audio' | 'audioMode' | 'master' | 'effect' | 'voices' | 'paletteOverride' | 'safety' | 'hueStrobe' | 'sequenceRevision' | 'sequenceTransport'>>;

export function withInputDefaults(input: RenderInput): FrameInput {
  return {
    ...input,
    audio: input.audio ?? null,
    audioMode: input.audioMode ?? 'tempo',
    master: input.master ?? { ...HD_MASTER_DEFAULTS },
    effect: input.effect ?? null,
    voices: input.voices ?? [],
    paletteOverride: input.paletteOverride ?? null,
    safety: input.safety ?? { ...RENDER_SAFETY_DEFAULTS },
    hueStrobe: input.hueStrobe ?? 'pulse',
    sequenceRevision: input.sequenceRevision ?? null,
    sequenceTransport: input.sequenceTransport ?? null,
  };
}

export interface BaseIntent { pattern: string; revision: number | null; content: string }

export type CommandStatus = 'applied' | 'stale' | 'unavailable' | 'unsupported' | 'invalid' | 'duplicate';
export interface CommandResult { seq: number; status: CommandStatus }

const COMMANDS: readonly EffectCommand[] = ['stop', 'comboBreak', 'toggleDirection', 'fadeToBaseline', 'setPulserBaselineColor'];

export function baseIntentOf(input: Pick<RenderInput, 'pattern' | 'effect' | 'effectRevision'>): BaseIntent | null {
  if (!input.effect) return null;
  return { pattern: input.pattern, revision: input.effectRevision ?? null, content: effectContentKey(input.effect) };
}

function gridPhaseOf(originMs: number): number {
  const phase = ((originMs % FRAME_MS) + FRAME_MS) % FRAME_MS;
  return FRAME_MS - phase < 1e-6 ? 0 : phase;
}

function commandArg(cmd: string, arg: unknown): Colour | null | undefined {
  if (!(COMMANDS as readonly string[]).includes(cmd)) return undefined;
  if (cmd !== 'setPulserBaselineColor') return arg === undefined || arg === null ? null : undefined;
  if (!arg || typeof arg !== 'object') return undefined;
  const c = arg as Record<string, unknown>;
  const byte = (v: unknown, fallback?: number) => {
    const n = v === undefined ? fallback : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 255 ? n : NaN;
  };
  const colour = { r: byte(c.r), g: byte(c.g), b: byte(c.b), w: byte(c.w, 0), a: byte(c.a, 0), uv: byte(c.uv, 0) };
  return Object.values(colour).every((v) => !Number.isNaN(v)) ? colour : undefined;
}

export type FrameStore = Pick<UniverseStore, 'getBuffer' | 'sync' | 'clearAll'>;

interface LightValue {
  col: Colour;
  dim: number;
  strobe: number;
}

interface StrobeRequest {
  raw: number;
  fnId: string;
}

type Dmx = Buffer | Uint8Array;

export interface Renderer {
  frame(input: RenderInput, reading: MusicalTime, now: number, store: FrameStore, gridOriginMs?: number): Rig<RenderFixture>;
  invalidateRig(): void;
  command(seq: number, cmd: string, arg?: unknown, intent?: BaseIntent | null): void;
  takeCommandResults(): CommandResult[];
  rejectCommands(status: CommandStatus): void;
  commandStatus(): { processed: number; applied: number };
  setSequence(table: SequenceTable | null): void;
}

const RANDOM_PATTERNS = new Set(['twinkle', 'sparkle', 'random-flash']);

const SYNC_FLASH_MS = 100;

const blankUnit = (): UnitLight => ({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 });

// Use software strobe only without a hardware channel, and exclude Hue from that fallback.
const SOFT_STROBE_MIN_HZ = 1;
const SOFT_STROBE_MAX_HZ = Math.min(20, 1000 / (2 * FRAME_MS));
const SOFT_FLASH_MAX_MS = 50;

function softStrobeHz(raw: number): number {
  return SOFT_STROBE_MIN_HZ + (Math.min(255, raw) / 255) * (SOFT_STROBE_MAX_HZ - SOFT_STROBE_MIN_HZ);
}

const FLASH_LIMIT_STROBE = strobeCap(softStrobeHz);

function softStrobeLit({ raw, fnId }: StrobeRequest, now: number): boolean {
  const hz = softStrobeHz(raw);
  if (/random|rnd/.test(fnId)) return Math.random() < (hz * FRAME_MS) / 1000;
  const period = 1000 / hz;
  const flash = Math.min(SOFT_FLASH_MAX_MS, Math.max(FRAME_MS, 0.3 * period));
  return ((now % period) + period) % period < flash;
}

// Write both dimmer bytes so fine-channel fixtures retain smooth fades.
function writeDimmer(dmx: Dmx, base: number, ch: ChannelMap, level: number): void {
  if (ch.dimmer === undefined) return;
  const clamped = level > 255 ? 255 : (level > 0 ? level : 0);
  if (ch.dimmerFine === undefined) {
    dmx[base + ch.dimmer] = Math.round(clamped);
    return;
  }
  const v16 = Math.round((clamped / 255) * 65535);
  dmx[base + ch.dimmer] = v16 >> 8;
  dmx[base + ch.dimmerFine] = v16 & 0xff;
}

// Write defaults first so driven channels can override them in the same frame.
function writeDefaults(dmx: Dmx, base: number, defaults: ChannelDefault[] | undefined): void {
  if (!defaults) return;
  for (let i = 0; i < defaults.length; i++) dmx[base + defaults[i].offset] = defaults[i].value;
}

function writeStripDefaults(store: FrameStore, fix: RenderFixture, strip: NonNullable<ReturnType<typeof stripOf>>,
  defaults: ChannelDefault[] | undefined): void {
  if (!defaults) return;
  for (const { offset, value } of defaults) {
    const place = channelPlace(strip, fix.address, offset);
    store.getBuffer(fix.universe + place.universe)[place.index] = value;
  }
}

function createRenderer({ profileOf, profilesRevision = () => 0, now = performance.now() }: {
  profileOf: (fixture: RenderFixture) => Profile;
  profilesRevision?: () => number;
  now?: number;
}): Renderer {
  const unitColors = Array.from({ length: 4 }, blankUnit);
  const twinkle = new Array(4).fill(0);
  const pixelTwinkle = new Array(4).fill(0);
  const panelTwinkle = new Array(4).fill(0);

  // Fade only the base layer so live bursts and pinned fixtures stay immediate.
  const shown: UnitLight[] = [];     // the pattern layer as it went out last frame, per light
  let fade: { start: number; ms: number; from: UnitLight[] } | null = null;
  let syncTest: { start: number; until: number } | null = null;
  let identify: { ids: Set<number>; start: number; until: number } | null = null;
  const adopted = { fade: 0, syncTest: 0, identify: 0 };

  let expression: Expression = { ...EXPRESSION_REST };
  let expressionPhase = 0;
  let lastReading: MusicalTime | null = null;
  let lastNow = now;

  let anchor: PatternAnchor | null = null;
  let givenAnchor: PatternAnchor | null = null;
  let lastRandomKey: string | null = null;
  let lastPixelRandomKey: string | null = null;
  let lastPanelRandomKey: string | null = null;

  let rig: Rig<RenderFixture> | null = null;
  let rigKey = '';
  const limiter = createFlashLimiter();

  // Keep base and voices in one stepper so checkpoints, expiry and resets share their lifetimes.
  const stepper = new EffectStepper();
  const guard = new HdFlashGuard(RENDER_SAFETY_DEFAULTS.hdFlashIntervalMs);
  const strobeGuard = new StrobeLampGuard();
  let lastSweep = -Infinity;
  // Use the frame grid’s phase so render jitter cannot invent extra strobe frames.
  let gridPhase: number | null = null;
  let lastEffectNow: number | null = null;
  const baseKind: (string | null)[] = [];
  let baseKinds = false;
  const topKind: (string | null)[] = [];
  let base: {
    key: string; id: string; kind: string; pattern: string; revision: number | null; content: string;
    seed: Seed; startedAtMs: number;
  } | null = null;
  // Track launch identity separately from musical anchors so seeks preserve wall-clock lifetimes.
  const voiceRecords = new Map<string, VoiceRecord>();
  const strobeTrail = new Set<string>();
  let compat: { energy: string; voice: VoiceFrame } | null = null;
  let baseCells: { key: string; layout: Layout; ids: number[] } | null = null;
  let voiceCells: { key: string; layout: Layout; ids: number[] } | null = null;
  let identityKey = '';

  let sequence: SequenceTable | null = null;
  const seqRun = newSequenceRun();
  const seqLight: (UnitLight | null)[] = [];
  const seqKind: (string | null)[] = [];
  let seqUnits = false;

  const commandQueue: { seq: number; cmd: string; arg?: unknown; intent: BaseIntent | null }[] = [];
  let commandResults: CommandResult[] = [];
  let processedSeq = 0;
  let appliedSeq = 0;

  // Reset effect history on a new grid or patch while adopting each voice launch only once.
  function resetEffects(clock = true): void {
    stepper.reset();
    guard.reset();
    strobeGuard.reset();
    base = null;
    if (!clock) return;
    voiceRecords.clear();
    strobeTrail.clear();
    endSequence(seqRun, stepper);
    lastEffectNow = null;
  }

  function effectNow(now: number, gridOriginMs: number | undefined): number {
    let phase = gridPhase;
    if (gridOriginMs !== undefined && Number.isFinite(gridOriginMs)) phase = gridPhaseOf(gridOriginMs);
    else if (phase === null) phase = gridPhaseOf(now);
    if (gridPhase !== null && Math.abs(phase - gridPhase) > 1e-6) {
      resetEffects();
    }
    gridPhase = phase;
    return now - phase;
  }

  function effectCells(layout: Layout, rigNow: Rig<RenderFixture>, fixtures: RenderFixture[]): { layout: Layout; ids: number[] } {
    const { list } = layout.units;
    const ids = list.map((u) => fixtures[rigNow.units[u].fixture].id);
    const hue = list.map((u) => hueLamp(fixtures[rigNow.units[u].fixture]));
    const noFlash = hue.some(Boolean) ? hue : null;
    return { layout: { ...layout, units: { ...layout.units, noFlash } }, ids };
  }

  function cellsFor(input: FrameInput, rigNow: Rig<RenderFixture>): void {
    const ids = input.fixtures.map((f) => f.id).join(',');
    const identity = `${rigKey}|${ids}`;
    if (identity !== identityKey) {
      if (identityKey) resetEffects(false);
      identityKey = identity;
      baseCells = null;
      voiceCells = null;
    }
    const baseKey = `${input.split}|${input.pixelMap}`;
    if (!baseCells || baseCells.key !== baseKey) baseCells = { key: baseKey, ...effectCells(rigNow.layout(input.split, input.pixelMap), rigNow, input.fixtures) };
    if (!voiceCells) voiceCells = { key: '', ...effectCells(voiceLayout(rigNow), rigNow, input.fixtures) };
  }

  function frameBaseOf(input: FrameInput, reading: MusicalTime, nowMs: number, dtMs: number, acknowledged: boolean,
    manualStrobeActive: boolean): FrameBase {
    return {
      beatPos: reading.beatPos, bpm: reading.bpm, nowMs, dtMs, anchorBeat: 0,
      lookPalette: paletteOf({ colors: [input.colorA, input.colorB, input.colorC, input.colorD].map((i) => COLOR_PRESETS[i]) }),
      paletteOverride: input.paletteOverride, audio: input.audio, audioMode: input.audioMode, master: input.master,
      seed: [0, 0, 0, 0], acknowledged, hueStrobe: input.hueStrobe, manualStrobeActive, expressionLevel: expression.level,
    };
  }

  function baseInstance(input: FrameInput, anchorStepNow: number, division: number, nowMs: number): EffectInstance {
    const spec = input.effect!;
    const id = `base:${input.pattern}:${anchorStepNow}`;
    const content = effectContentKey(spec);
    const revision = input.effectRevision ?? null;
    const key = canonical([id, revision, content, baseCells!.key, anchor?.epoch ?? null]);
    if (!base || base.key !== key) {
      relaunchEffect(stepper, base, id, spec.kind);
      base = { key, id, kind: spec.kind, pattern: input.pattern, revision, content, seed: seedFrom(id), startedAtMs: nowMs };
    }
    return { id, spec, seed: base.seed, anchorBeat: anchorStepNow / division, startedAtMs: base.startedAtMs, targets: null };
  }

  function compatVoice(input: FrameInput, now: number): VoiceFrame | null {
    const energy = input.energy;
    if (!energy) { compat = null; return null; }
    if (compat && compat.energy === energy) return compat.voice;
    const spec = energyEffectSpec(energy);
    if (!spec) { compat = null; return null; }
    const id = `energy:${energy}`;
    compat = { energy, voice: { id, spec, targets: null, tier: energy === HOLD_STROBE ? 'strobe' : 'voice', launchSeq: 0,
      startedAtMs: now, untilMs: null, anchorBeat: 0, seed: seedFrom(id) } };
    return compat.voice;
  }

  function playingVoices(given: RenderInput, input: FrameInput, reading: MusicalTime, now: number, phase: number):
    { voices: VoiceFrame[]; admitted: Set<VoiceFrame> } {
    const admitted = new Set<VoiceFrame>();
    const legacy = given.voices === undefined;
    if (!legacy) compat = null;
    const synthesized = legacy ? compatVoice(input, now) : null;
    const source = legacy ? (synthesized ? [synthesized] : []) : input.voices;
    const seen = new Set<string>();
    const voices: VoiceFrame[] = [];
    const beatNow = reading.anchorBeat !== undefined && Number.isFinite(reading.anchorBeat) ? reading.anchorBeat : reading.beatPos;
    for (const v of source) {
      if (!v || typeof v.id !== 'string' || !v.spec || typeof v.spec.kind !== 'string') continue;
      if (!(Number.isFinite(v.startedAtMs) && now >= v.startedAtMs)) continue;
      if (v.untilMs != null && !(now < v.untilMs)) continue;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      const holdsGrid = (legacy && v === compat?.voice) || v.holdsGrid === true;
      const anchorBeat = voiceAnchor(voiceRecords, stepper, v, voiceLaunchKey(v), reading.epoch, beatNow, holdsGrid);
      const played: VoiceFrame = { ...v, startedAtMs: v.startedAtMs - phase, untilMs: v.untilMs == null ? null : v.untilMs - phase, anchorBeat };
      if (legacy && given.safety === undefined && v === compat?.voice) admitted.add(played);
      voices.push(played);
    }
    for (const id of voiceRecords.keys()) if (!seen.has(id)) voiceRecords.delete(id);
    handOverStrobes(stepper, strobeTrail, voices);
    return { voices, admitted };
  }

  function coversPatch(v: VoiceFrame, ids: readonly number[]): boolean {
    return v.targets === null || v.targets.some((id) => ids.includes(id));
  }

  const NO_COMMANDS = { due: [], decide() {} };

  function takeCommands(input: FrameInput): { due: { seq: number; cmd: EffectCommand; arg?: Colour }[]; decide: (applied: boolean) => void } {
    if (!commandQueue.length) return NO_COMMANDS;
    const queued = commandQueue.splice(0);
    const due: { seq: number; cmd: EffectCommand; arg?: Colour }[] = [];
    const decided: (CommandResult | null)[] = [];
    const def = input.effect ? kindOf(input.effect.kind) : null;
    const now = baseIntentOf(input);
    const taken = new Set<number>();
    for (const c of queued) {
      const refuse = (status: CommandStatus) => { decided.push({ seq: c.seq, status }); };
      if (c.seq <= processedSeq || taken.has(c.seq)) { refuse('duplicate'); continue; }
      taken.add(c.seq);
      const arg = commandArg(c.cmd, c.arg);
      if (arg === undefined) { refuse('invalid'); continue; }
      if (!now || !def) { refuse('unsupported'); continue; }
      if (c.intent && (c.intent.pattern !== now.pattern || c.intent.revision !== now.revision || c.intent.content !== now.content)) {
        refuse('stale'); continue;
      }
      if (!def.command) { refuse('unsupported'); continue; }
      due.push({ seq: c.seq, cmd: c.cmd as EffectCommand, arg: arg === null ? undefined : arg });
      decided.push(null);
    }
    return {
      due,
      decide(applied) {
        let next = 0;
        const results = decided.map((d) => d ?? { seq: due[next++].seq, status: applied ? 'applied' as const : 'unavailable' as const });
        for (const d of results) {
          if (d.status === 'duplicate') continue;
          processedSeq = Math.max(processedSeq, d.seq);
          if (d.status === 'applied') appliedSeq = Math.max(appliedSeq, d.seq);
        }
        commandResults.push(...results);
      },
    };
  }

  function rigFor(fixtures: RenderFixture[]): Rig<RenderFixture> {
    const key = rigSignature(fixtures, profilesRevision());
    if (!rig || key !== rigKey) {
      rig = buildRig(fixtures, profileOf);
      rigKey = key;
    }
    return rig;
  }

  function sizeUnitBuffers(count: number): void {
    while (unitColors.length < count) unitColors.push(blankUnit());
    if (unitColors.length > count) unitColors.length = count;
    while (twinkle.length < count) twinkle.push(0);
    twinkle.length = count;
    while (pixelTwinkle.length < count) pixelTwinkle.push(0);
    pixelTwinkle.length = count;
    while (panelTwinkle.length < count) panelTwinkle.push(0);
    panelTwinkle.length = count;
    while (baseKind.length < count) baseKind.push(null);
    baseKind.length = count;
    while (seqLight.length < count) seqLight.push(null);
    seqLight.length = count;
    while (seqKind.length < count) seqKind.push(null);
    seqKind.length = count;
  }

  function setUnitColor(u: number, color: Colour, dim: number, strobe: number): void {
    unitColors[u] = {
      r: color.r,
      g: color.g,
      b: color.b,
      w: color.w || 0,
      a: color.a || 0,
      uv: color.uv || 0,
      dim,
      strobe,
    };
  }

  function adoptRequests(input: RenderInput): void {
    const f = input.fade;
    if (f && f.seq !== adopted.fade) {
      adopted.fade = f.seq;
      fade = f.ms > 0 ? { start: f.at, ms: f.ms, from: shown.map((c) => ({ ...c })) } : null;
    }
    const s = input.syncTest;
    if (s && s.seq !== adopted.syncTest) {
      adopted.syncTest = s.seq;
      syncTest = { start: s.at, until: s.at + s.seconds * 1000 };
    }
    const id = input.identify;
    if (id && id.seq !== adopted.identify) {
      adopted.identify = id.seq;
      identify = id.ids.length && id.ms > 0 ? { ids: new Set(id.ids), start: id.at, until: id.at + id.ms } : null;
    }
  }

  function identifying(now: number): { ids: Set<number>; start: number } | null {
    if (identify && now >= identify.until) identify = null;
    return identify;
  }

  function writeIdentified(input: RenderInput, store: FrameStore, fix: RenderFixture, cells: ChannelMap[] | null,
    elapsed: number, now: number): void {
    const plain: RenderInput = { ...input, masterDimmer: 255, pattern: '', flashLimit: false };
    const lights = identifyLights(cells ? cells.length : 1, elapsed).map(({ col, dim }) => ({ col, dim, strobe: 0 }));
    if (cells) writeBar(plain, store, fix, cells, lights, null, now);
    else writePar(plain, store, fix, lights[0], null, now);
  }

  // Re-anchor after clock epochs so patterns cannot keep an anchor from the old transport position.
  function patternStep(input: RenderInput, reading: MusicalTime): { step: number; anchor: number; division: number } {
    const division = Math.max(1, input.beatDivision || 1);
    const given = input.patternAnchor;
    if (given && (!givenAnchor || given.step !== givenAnchor.step || given.epoch !== givenAnchor.epoch)) {
      anchor = { step: given.step, epoch: given.epoch };
    }
    givenAnchor = given ? { step: given.step, epoch: given.epoch } : null;
    if (!anchor || anchor.epoch !== reading.epoch) {
      // Use the scene’s scheduled beat after seeking so phase matches uninterrupted playback.
      const from = reading.anchorBeat !== undefined && Number.isFinite(reading.anchorBeat)
        ? reading.anchorBeat : reading.beatPos;
      anchor = { step: anchorStep(from, division), epoch: reading.epoch };
    }
    return { step: stepAt(reading.beatPos, anchor.step, division), anchor: anchor.step, division };
  }

  // Derive pattern steps from musical position so timers and seeks cannot cause phase drift.
  function renderPattern(input: FrameInput, rigNow: Rig<RenderFixture>, reading: MusicalTime): void {
    if (!input.running) return;
    if (baseKinds) { baseKind.fill(null); baseKinds = false; }
    const pixelPattern = rigNow.hasPixels && input.pixelPattern ? input.pixelPattern : null;
    const panelPattern = rigNow.hasPanels && input.panelPattern && PATTERN_FUNCS[input.panelPattern] ? input.panelPattern : null;
    const known = !!PATTERN_FUNCS[input.pattern];
    const knownPixel = !!pixelPattern && !!PATTERN_FUNCS[pixelPattern];
    const look = {
      pattern: input.pattern,
      colors: [input.colorA, input.colorB, input.colorC, input.colorD].map((i) => COLOR_PRESETS[i]),
      split: input.split,
      pixelMap: input.pixelMap,
      pixelPattern,
      pixelSpan: input.pixelSpan ?? null,
      pixelFrom: input.pixelFrom ?? null,
      panelPattern,
    };
    if (!known && !knownPixel && !panelPattern) {
      renderLayer(rigNow, look, null, setUnitColor, { skipPattern: true, skipPixelPattern: true, skipPanelPattern: true });
      return;
    }

    const fixtureCount = input.fixtures.length;
    const { step, anchor: from, division } = patternStep(input, reading);
    const lookKey = `${step}|${input.colorA},${input.colorB},${input.colorC},${input.colorD}|${input.split}|${fixtureCount}`;
    const pixels = `|${rigNow.hasPixels ? rigNow.units.length : ''}|${input.pixelMap}|${panelPattern}`;
    let skipPattern = !known;
    if (known && RANDOM_PATTERNS.has(input.pattern)) {
      const key = `${input.pattern}|${lookKey}${pixels}|${pixelPattern}`;
      skipPattern = key === lastRandomKey;
      lastRandomKey = key;
    }
    let skipPixelPattern = !knownPixel;
    if (knownPixel && RANDOM_PATTERNS.has(pixelPattern)) {
      const key = `${pixelPattern}|${lookKey}${pixels}|${input.pattern}`;
      skipPixelPattern = key === lastPixelRandomKey;
      lastPixelRandomKey = key;
    }
    let skipPanelPattern = !panelPattern;
    if (panelPattern && RANDOM_PATTERNS.has(panelPattern)) {
      const key = `${lookKey}${pixels}|${input.pattern}|${pixelPattern}`;
      skipPanelPattern = key === lastPanelRandomKey;
      lastPanelRandomKey = key;
    }

    renderLayer(rigNow, look, {
      beatPos: reading.beatPos,
      step,
      anchor: from,
      division,
      phase: expressionPhase,
      expression,
      dynamicsOn: !!input.showDynamics,
      pulse: input.pulse ?? null,
      bpm: reading.bpm,
      hueStrobe: input.hueStrobe,
      fixtureCount,
      twinkle,
      pixelTwinkle,
      panelTwinkle,
    }, setUnitColor, { skipPattern, skipPixelPattern, skipPanelPattern });
  }

  function renderBaseEffect(input: FrameInput, rigNow: Rig<RenderFixture>, reading: MusicalTime, fb: FrameBase,
    commands: ReturnType<typeof takeCommands>): void {
    const cells = baseCells!;
    const def = kindOf(input.effect!.kind);
    if (!input.running) {
      let applied = false;
      if (base) {
        stepper.keep(base.id, fb.nowMs);
        const intent = baseIntentOf(input);
        const same = !!intent && base.pattern === intent.pattern && base.revision === intent.revision && base.content === intent.content;
        const held = same && commands.due.length ? stepper.peek(base.id) : null;
        if (held && def?.command) {
          for (const c of commands.due) def.command(held.value, c.cmd, c.arg);
          applied = true;
        }
      }
      commands.decide(applied);
      return;
    }
    const { anchor: from, division } = patternStep(input, reading);
    const instance = baseInstance(input, from, division, fb.nowMs);
    let prepared = false;
    const prepare = (state: unknown) => {
      prepared = true;
      for (const c of commands.due) def!.command!(state, c.cmd, c.arg);
    };
    baseKinds = true;
    renderEffectLayer(rigNow, cells.layout, { ...fb, fixtureIds: cells.ids }, instance, stepper, (u, colour, dim, strobe, kind) => {
      setUnitColor(u, colour, dim, strobe);
      baseKind[u] = kind;
    }, commands.due.length ? prepare : undefined);
    commands.decide(prepared);
    const colourB = COLOR_PRESETS[input.colorB];
    for (const i of cells.layout.wash) {
      const { start, count } = rigNow.ranges[i];
      for (let u = start; u < start + count; u++) {
        setUnitColor(u, colourB, 255, 0);
        baseKind[u] = null;
      }
    }
  }

  function sequencePlays(input: FrameInput): boolean {
    return !!sequence && !!input.sequenceTransport && input.sequenceRevision === sequence.revision;
  }

  // Compose sequence clips separately so uncovered fixtures retain the base look.
  function renderSequence(input: FrameInput, rigNow: Rig<RenderFixture>, fb: FrameBase | null): void {
    if (seqUnits) { seqLight.fill(null); seqKind.fill(null); seqUnits = false; }
    if (!fb || !sequencePlays(input)) {
      if (seqRun.activations.size || seqRun.last || seqRun.shown) endSequence(seqRun, stepper);
      return;
    }
    const cells = voiceCells!;
    seqUnits = renderSequenceLayer(rigNow, cells.layout, { ...fb, fixtureIds: cells.ids }, sequence!, input.sequenceTransport!, seqRun, stepper,
      (u, colour, dim, strobe, kind) => {
        seqLight[u] = { r: colour.r, g: colour.g, b: colour.b, w: colour.w || 0, a: colour.a || 0, uv: colour.uv || 0, dim, strobe };
        seqKind[u] = kind;
      });
  }

  function syncTestEnergy(now: number): EnergyLook | null {
    if (!syncTest) return null;
    if (now >= syncTest.until) { syncTest = null; return null; }
    const lit = (now - syncTest.start) % 1000 < SYNC_FLASH_MS;
    return { col: { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 }, dim: lit ? 255 : 0, strobe: 0 };
  }

  function hueLamp(fix: RenderFixture): boolean {
    return fix.hue || HUE_PROFILE_IDS.has(fix.profileId);
  }

  function lightOf(u: number, fix: RenderFixture, energy: EnergyLook | null, fadeT: number,
    target: ShowDynamics | null): LightValue {
    // Keep the shown base under bursts so later fades do not capture the burst.
    const layer = fade && fade.from[u] ? blendFixture(fade.from[u], unitColors[u], fadeT) : unitColors[u];
    shown[u] = layer;
    const clip = seqUnits ? seqLight[u] : null;
    const below = clip ?? layer;

    let col: Colour; let dim: number; let strobe: number;
    if (energy) {
      col = energy.col; dim = energy.dim; strobe = energy.strobe;
    } else if (fix.override && (fix.override.enabled || fix.override.blackout)) {
      const ov = fix.override;
      if (ov.blackout) {
        col = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 }; dim = 0; strobe = 0;
      } else {
        col = { r: ov.r, g: ov.g, b: ov.b, w: ov.w, a: ov.a || 0, uv: ov.uv || 0 };
        dim = ov.dim !== undefined ? ov.dim : 255;
        strobe = ov.strobe !== undefined ? ov.strobe : 0;
      }
    } else {
      col = { r: below.r, g: below.g, b: below.b, w: below.w, a: below.a || 0, uv: below.uv || 0 };
      dim = below.dim; strobe = below.strobe;
    }

    const pinned = fix.override && fix.override.enabled;
    if (!energy && !pinned && !ridesLevel(clip ? seqKind[u] : baseKind[u])) dim *= expression.level;
    if (target?.level === 0 && !energy && !pinned) dim = 0;
    return { col, dim, strobe };
  }

  // Multiply masters and trim so dim fixtures retain the same proportional response.
  function mastersOf(input: RenderInput, fix: RenderFixture): number {
    return (input.masterDimmer / 255) * (fix.maxBrightness / 255);
  }

  function strobeRequest(input: RenderInput, energy: EnergyLook | null, strobe: number, clip = false): StrobeRequest | null {
    // Force standard strobe for energies and clips so they cannot inherit a prior ramp or break function.
    const own = !!energy || clip;
    let raw = own ? strobe : (input.pattern === 'strobe' ? input.strobeSpeed : strobe);
    if (!(raw > 0)) return null;
    if (input.flashLimit) raw = Math.min(raw, FLASH_LIMIT_STROBE);
    return { raw, fnId: own ? 'standard' : input.strobeFunction };
  }

  function strobeValue(request: StrobeRequest | null): number | null {
    if (!request) return null;
    const fn = STROBE_FUNCTIONS.find((f) => f.id === request.fnId) || STROBE_FUNCTIONS[0];
    return fn.lo + Math.round((request.raw / 255) * (fn.hi - fn.lo));
  }

  // Exclude Hue from hardware-strobe fallback because its bridge cannot follow that rate.
  function strobe(dmx: Dmx, base: number, fix: RenderFixture, ch: ChannelMap, request: StrobeRequest | null,
    now: number): boolean {
    if (ch.strobe !== undefined) {
      const value = strobeValue(request);
      if (value !== null) dmx[base + ch.strobe] = value;
      return true;
    }
    if (!request || hueLamp(fix)) return true;
    return softStrobeLit(request, now);
  }

  function writePar(input: RenderInput, store: FrameStore, fix: RenderFixture, { col, dim, strobe: flash }: LightValue,
    energy: EnergyLook | null, now: number, clip = false): void {
    const dmx = store.getBuffer(fix.universe);
    const base = fix.address - 1;
    const profile = profileOf(fix);
    const ch = profile.channelMap;
    const ms = mastersOf(input, fix);

    writeDefaults(dmx, base, profile.defaults);
    if (!strobe(dmx, base, fix, ch, strobeRequest(input, energy, flash, clip), now)) return;
    writeDimmer(dmx, base, ch, dim * ms);
    writeEmitters(dmx, base, ch, col, ms * (dim / 255));
  }

  function writeBar(input: RenderInput, store: FrameStore, fix: RenderFixture, cells: ChannelMap[], lights: LightValue[],
    energy: EnergyLook | null, now: number, clip = false): void {
    const dmx = store.getBuffer(fix.universe);
    const base = fix.address - 1;
    const profile = profileOf(fix);
    const ch = profile.channelMap;
    const ms = mastersOf(input, fix);
    const strip = stripOf(profile);

    if (strip) writeStripDefaults(store, fix, strip, profile.defaults);
    else writeDefaults(dmx, base, profile.defaults);
    let top = 0;
    let flash = 0;
    for (const light of lights) {
      if (light.dim > top) top = light.dim;
      if (light.strobe > flash) flash = light.strobe;
    }
    if (!strobe(dmx, base, fix, ch, strobeRequest(input, energy, flash, clip), now)) return;
    const fixtureDimmer = ch.dimmer !== undefined;
    writeDimmer(dmx, base, ch, top * ms);

    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      const { col, dim } = lights[c];
      const { cellDim, scale } = cellDrive(dim, top, ms, fixtureDimmer, cell.dimmer !== undefined);
      let out = dmx;
      let at = base;
      if (strip) {
        const place = cellPlace(strip, fix.address, c);
        if (place.universe) out = store.getBuffer(fix.universe + place.universe);
        at = place.shift;
      }
      if (cell.dimmer !== undefined) out[at + cell.dimmer] = cellDim;
      writeEmitters(out, at, cell, col, scale);
    }
  }

  function frame(given: RenderInput, reading: MusicalTime, now: number, store: FrameStore, gridOriginMs?: number): Rig<RenderFixture> {
    const input = withInputDefaults(given);
    const dt = Math.max(0, Math.min(0.25, (now - lastNow) / 1000));
    lastNow = now;
    adoptRequests(input);

    const target = input.showDynamics;
    expression = blendExpression(expression, target, dt);

    const dBeats = lastReading && lastReading.epoch === reading.epoch
      ? Math.min(4, Math.max(0, reading.beatPos - lastReading.beatPos)) : 0;
    lastReading = reading;
    expressionPhase = (expressionPhase + motionAdvance(dBeats, expression.motion)) % 1;

    const rigNow = rigFor(input.fixtures);
    sizeUnitBuffers(rigNow.units.length);

    const effNow = effectNow(now, gridOriginMs);
    const effDt = lastEffectNow === null ? 0 : Math.max(0, effNow - lastEffectNow);
    lastEffectNow = effNow;
    if (effNow - lastSweep >= 1000 || effNow < lastSweep) {
      stepper.sweep(effNow);
      lastSweep = effNow;
    }
    const interval = input.safety.hdFlashIntervalMs;
    guard.setInterval(Number.isFinite(interval) && interval >= 0 ? interval : RENDER_SAFETY_DEFAULTS.hdFlashIntervalMs);

    const { voices, admitted } = playingVoices(given, input, reading, now, gridPhase!);
    const effects = !!input.effect || voices.length > 0 || sequencePlays(input);
    let fb: FrameBase | null = null;
    if (effects) {
      cellsFor(input, rigNow);
      const manualStrobeActive = voices.some((v) => v.spec.kind === 'strobe' && coversPatch(v, voiceCells!.ids));
      fb = frameBaseOf(input, reading, effNow, effDt, input.safety.acknowledged, manualStrobeActive);
    }
    const commands = takeCommands(input);

    if (input.effect) renderBaseEffect(input, rigNow, reading, fb!, commands);
    else {
      commands.decide(false);
      renderPattern(input, rigNow, reading);
    }
    renderSequence(input, rigNow, fb);

    let voiceTop: (EffectSlot | null)[] | null = null;
    if (voices.length && fb) {
      const cells = voiceCells!;
      const winners = renderVoices(rigNow, cells.layout, { ...fb, fixtureIds: cells.ids }, voices, stepper, { admit: admitted });
      voiceTop = new Array<EffectSlot | null>(rigNow.units.length).fill(null);
      const { list } = cells.layout.units;
      for (let k = 0; k < list.length; k++) voiceTop[list[k]] = winners[k];
    }

    // Reconcile universes each frame so readdressed fixtures take effect without another invalidation path.
    store.sync(input.universes);

    // Clear whole universes so removed or readdressed fixtures cannot leave orphan channels latched.
    store.clearAll();

    let fadeT = 1;
    if (fade) {
      fadeT = (now - fade.start) / fade.ms;
      if (fadeT >= 1) fade = null;
    }

    const { fixtures } = input;
    const ident = identifying(now);
    const sync = syncTestEnergy(now);

    if (input.masterBlackout) {
      if (input.flashLimit) limiter.commit(0, now);
      if (guard.brightCount) for (let u = 0; u < rigNow.units.length; u++) guard.clear(u);
      if (strobeGuard.liveCount) for (let u = 0; u < rigNow.units.length; u++) strobeGuard.clear(u);
      if (ident) {
        for (let i = 0; i < fixtures.length; i++) {
          if (ident.ids.has(fixtures[i].id)) writeIdentified(input, store, fixtures[i], rigNow.cellMaps[i], now - ident.start, now);
        }
      }
      return rigNow;
    }
    const all: LightValue[][] = [];
    const owned: (EnergyLook | null)[] = [];
    const clipped: boolean[] = [];
    const watch = !!voiceTop || baseKinds || seqUnits;
    let guarded = false;
    let strobed = false;
    for (let i = 0; i < fixtures.length; i++) {
      const fix = fixtures[i];
      const { start, count } = rigNow.ranges[i];
      const overridden = !!fix.override && (fix.override.enabled || fix.override.blackout);
      const lights: LightValue[] = [];
      let first: EnergyLook | null = sync;
      let clip = false;
      for (let u = start; u < start + count; u++) {
        if (seqUnits && seqLight[u] && !overridden) clip = true;
        const voice = sync || !voiceTop ? null : voiceTop[u];
        const top = sync ?? (voice ? { col: voice.colour, dim: 255 * voice.level, strobe: voice.strobe ?? 0 } : null);
        if (top && !first) first = top;
        lights.push(lightOf(u, fix, top, fadeT, target));
        if (!watch) continue;
        const kind = top ? (voice ? voice.kind ?? null : null) : overridden ? null : seqUnits && seqLight[u] ? seqKind[u] : baseKind[u];
        topKind[u] = kind;
        if (hdGuarded(kind)) guarded = true;
        if (kind === 'strobe') strobed = true;
      }
      owned.push(first);
      clipped.push(clip);
      all.push(lights);
    }
    if (guarded) limitHdRises(input, rigNow, all, effNow);
    else if (guard.brightCount) for (let u = 0; u < rigNow.units.length; u++) guard.clear(u);
    if (strobed) limitStrobeRises(rigNow, all, effNow);
    else if (strobeGuard.liveCount) for (let u = 0; u < rigNow.units.length; u++) strobeGuard.clear(u);
    if (input.flashLimit) limitFlashes(input, all, now);
    else limiter.reset();
    for (let i = 0; i < fixtures.length; i++) {
      const cells = rigNow.cellMaps[i];
      if (ident && ident.ids.has(fixtures[i].id)) writeIdentified(input, store, fixtures[i], cells, now - ident.start, now);
      else if (cells) writeBar(input, store, fixtures[i], cells, all[i], owned[i], now, clipped[i]);
      else writePar(input, store, fixtures[i], all[i][0], owned[i], now, clipped[i]);
    }
    return rigNow;
  }

  // Check HD rises after masters and trim so levels below the bright threshold do not spend a permit.
  function limitHdRises(input: FrameInput, rigNow: Rig<RenderFixture>, all: LightValue[][], nowMs: number): void {
    for (let i = 0; i < input.fixtures.length; i++) {
      const { start } = rigNow.ranges[i];
      const masters = mastersOf(input, input.fixtures[i]);
      const lights = all[i];
      for (let c = 0; c < lights.length; c++) {
        const u = start + c;
        if (!hdGuarded(topKind[u])) { guard.clear(u); continue; }
        const light = lights[c];
        if (guard.apply(u, (light.dim / 255) * masters, nowMs) === 0) light.dim = 0;
      }
    }
  }

  // Share strobe permits across winning instances so handovers cannot raise a lamp early.
  function limitStrobeRises(rigNow: Rig<RenderFixture>, all: LightValue[][], nowMs: number): void {
    const frameIndex = strobeFrameOf(nowMs);
    for (let i = 0; i < all.length; i++) {
      const { start } = rigNow.ranges[i];
      const lights = all[i];
      for (let c = 0; c < lights.length; c++) {
        const u = start + c;
        if (topKind[u] !== 'strobe') { strobeGuard.clear(u); continue; }
        const light = lights[c];
        const level = light.dim / 255;
        const allowed = strobeGuard.apply(u, level, frameIndex);
        if (allowed < level) light.dim = 255 * allowed;
      }
    }
  }

  function rigLuminance(input: RenderInput, all: LightValue[][]): number {
    if (!all.length) return 0;
    let sum = 0;
    for (let i = 0; i < all.length; i++) {
      const lights = all[i];
      let fixture = 0;
      for (const { col, dim } of lights) fixture += lightLuminance(col, dim);
      sum += (fixture / Math.max(1, lights.length)) * mastersOf(input, input.fixtures[i]);
    }
    return sum / all.length;
  }

  function limitFlashes(input: RenderInput, all: LightValue[][], now: number): void {
    const luminance = rigLuminance(input, all);
    const allowed = limiter.target(luminance, now);
    if (luminance > 1e-6 && Math.abs(allowed - luminance) > 1e-4) {
      const scale = allowed / luminance;
      for (const lights of all) for (const light of lights) light.dim = Math.min(255, light.dim * scale);
      limiter.commit(rigLuminance(input, all), now);
    } else {
      limiter.commit(luminance, now);
    }
  }

  return {
    frame,
    invalidateRig() { rig = null; },
    command(seq, cmd, arg, intent = null) {
      commandQueue.push({ seq, cmd, arg, intent });
    },
    takeCommandResults() {
      const out = commandResults;
      commandResults = [];
      return out;
    },
    rejectCommands(status) {
      for (const c of commandQueue.splice(0)) {
        const duplicate = c.seq <= processedSeq;
        if (!duplicate) processedSeq = Math.max(processedSeq, c.seq);
        commandResults.push({ seq: c.seq, status: duplicate ? 'duplicate' : status });
      }
    },
    commandStatus() { return { processed: processedSeq, applied: appliedSeq }; },
    setSequence(table) {
      const ok = !!table && typeof table === 'object' && Number.isFinite(table.revision) && Array.isArray(table.lanes) && Array.isArray(table.clips);
      sequence = ok ? table : null;
      retable(seqRun, sequence, stepper);
    },
  };
}

function writeEmitters(dmx: Dmx, base: number, ch: ChannelMap, col: Colour, scale: number): void {
  const v = emitterValues(col, scale);
  if (ch.red !== undefined)       dmx[base + ch.red]       = v.r;
  if (ch.green !== undefined)     dmx[base + ch.green]     = v.g;
  if (ch.blue !== undefined)      dmx[base + ch.blue]      = v.b;
  if (ch.white !== undefined)     dmx[base + ch.white]     = v.w;
  if (ch.amber !== undefined)     dmx[base + ch.amber]     = v.a;
  if (ch.coolWhite !== undefined) dmx[base + ch.coolWhite] = v.w;
  if (ch.warmWhite !== undefined) dmx[base + ch.warmWhite] = v.a;
  if (ch.uv !== undefined)        dmx[base + ch.uv]        = v.uv;
}

export {
  createRenderer,
  SYNC_FLASH_MS,
  softStrobeHz,
  softStrobeLit,
  writeDimmer,
  SOFT_STROBE_MAX_HZ,
};
