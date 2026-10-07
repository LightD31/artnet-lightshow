// X-Touch Compact Standard mode, Layer A: EN 1–8 turn CC 10–17; push notes 0–7;
// BT 1–8 notes 16–23; BT 9–16 notes 24–31; FD 1–9 CC 1–9; all channel 1.
// LED Note On velocities: 0 off, 1 on, 127 bright; follow the learned binding map.

import { DEFAULT_MAP, ACTIONS } from './server/midi-map.ts';
import { createRequire } from 'node:module';

import { ENERGY_EFFECT_IDS, STROBE_FUNCTION_IDS, SYNC_OFFSET_LIMIT_MS } from './server/presets.ts';
import { messageOf } from './errors.ts';
import type { MidiBinding, MidiMap } from './server/midi-map.ts';
import type { ShowState } from './server/state.ts';
import type { Override } from './types/rig.ts';

interface NoteMessage { note: number; velocity: number; channel: number }
interface CcMessage { controller: number; value: number; channel: number }
interface PitchMessage { value: number; channel: number }

interface MidiInput {
  on(event: 'noteon' | 'noteoff', fn: (message: NoteMessage) => void): void;
  on(event: 'cc', fn: (message: CcMessage) => void): void;
  on(event: 'pitch', fn: (message: PitchMessage) => void): void;
  close(): void;
}

interface MidiOutput {
  send(type: 'cc', message: CcMessage): void;
  send(type: 'noteon', message: NoteMessage): void;
  send(type: 'clock' | 'start' | 'stop'): void;
  close(): void;
}

interface EasyMidi {
  getInputs(): string[];
  getOutputs(): string[];
  Input: new (name: string) => MidiInput;
  Output: new (name: string) => MidiOutput;
}

export interface MidiPortList {
  inputs: string[];
  outputs: string[];
}

export interface LearnCapture {
  kind: 'cc' | 'notes';
  number: number;
  channel: number;
  binding: MidiBinding;
}

export type LearnEvent = { status: string; binding: MidiBinding } & Partial<LearnCapture>;

type RelMode = 'twos' | 'offset';

const require = createRequire(import.meta.url);

const SYNC_NUDGE_MS = 5;

let easymidi: EasyMidi | undefined;
try {
  easymidi = require('easymidi') as EasyMidi;
} catch (_) {
  console.warn('[MIDI] easymidi not available — run `npm install easymidi` to enable MIDI support.');
}

const ENERGY_IDS = ENERGY_EFFECT_IDS;
const PAD_RENEW_MS = 400;
export const MIDI_HOLD_MAX_MS = 5 * 60 * 1000;

interface MidiPads {
  press(bank: number, slot: number, owner: string, token: string): { mode?: string; spec?: { kind?: string } } | null | undefined;
  renew(bank: number, slot: number, owner: string, token: string): boolean;
  release(bank: number, slot: number, owner: string, token: string): unknown;
  strobeMaxMs?(): number;
}
interface HeldPad { bank: number; slot: number; owner: string; token: string; renew: ReturnType<typeof setInterval> | null }
const STROBE_FN_IDS = STROBE_FUNCTION_IDS;

const LEARN_TIMEOUT_MS = 30000;

const ECHO_SUPPRESS_MS = 400;

const TOUCH_PAIR_MS = 300;

const FADER_ACTIONS = new Set(ACTIONS.filter((a) => a.input === 'fader').map((a) => a.id));

// Relative encoders: two’s complement CW 1,2,… / CCW 127,126,…;
// binary offset CW 65,66,… / CCW 63,62,… (some devices send decrement 1).
// Infer encoding from the stream because MIDI carries no encoding flag.
const REL_TWOS: RelMode = 'twos';
const REL_OFFSET: RelMode = 'offset';

const REL_EVIDENCE_BAND = 7;

function relEvidence(value: number): RelMode | null {
  if (Math.abs(value - 64) <= REL_EVIDENCE_BAND) return REL_OFFSET;
  if (value <= REL_EVIDENCE_BAND || value >= 127 - REL_EVIDENCE_BAND) return REL_TWOS;
  return null;
}

function relDelta(value: number, mode: RelMode): number {
  if (value === 64) return 0;
  if (mode === REL_OFFSET) return value - 64;
  return value > 64 ? value - 128 : value;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

class MidiController {
  declare state: ShowState;
  declare apply: (patch: Record<string, unknown>) => unknown;
  declare tap: () => void;
  declare input: MidiInput | null;
  declare output: MidiOutput | null;
  declare map: MidiMap;
  declare enabled: boolean;
  declare recallCue: ((id: string) => unknown) | null;
  declare _learn: { binding: MidiBinding; resolve: (capture: LearnCapture | null) => void; timer: ReturnType<typeof setTimeout> } | null;
  declare _learnListeners: ((event: LearnEvent) => void)[];
  declare _lastCcOut: Map<number, number>;
  declare _lastCcIn: Map<number, number>;
  declare _relModes: Map<string, RelMode>;
  declare controlFeedback: boolean;
  declare _cachedPorts: MidiPortList | null;
  declare _energyEffect: string | undefined;
  declare _moved: Set<string>;
  declare _touchDown: Map<string, number>;
  declare _touchOf: Map<string, string>;
  declare _warnedSwitch: Set<string>;
  declare onRebind: ((from: number, to: number, binding: MidiBinding) => void) | null;
  declare pads: MidiPads | null;
  declare _heldPads: Map<string, HeldPad>;
  declare _inputName: string | null;

  constructor(stateRef: ShowState, applyFn: (patch: Record<string, unknown>) => unknown, tapFn: () => void) {
    this.state = stateRef;
    this.apply = applyFn;    // fn(patch) — same as socket 'set' event
    this.tap   = tapFn;       // fn() — trigger tap tempo
    this.pads = null;
    this._heldPads = new Map();
    this._inputName = null;

    this.input  = null;
    this.output = null;
    this.map    = DEFAULT_MAP;
    this.enabled = false;

    this.recallCue = null;

    this._learn = null;       // { binding, resolve, timer } while learn is armed
    this._learnListeners = [];

    this._lastCcOut = new Map();
    this._lastCcIn = new Map();
    this._relModes = new Map();
    this.controlFeedback = true;
    this._moved = new Set();
    this._touchDown = new Map();
    this._touchOf = new Map();
    this._warnedSwitch = new Set();
    this.onRebind = null;
  }

  setMap(map: MidiMap | null | undefined): void {
    this.map = map || DEFAULT_MAP;
    this._lastCcOut.clear();
    this.sendFeedback();
  }

  setControlFeedback(enabled: unknown): void {
    this.controlFeedback = !!enabled;
    this._lastCcOut.clear();
    if (this.controlFeedback) this.sendFeedback();
  }

  listPorts(): MidiPortList {
    if (!easymidi) return { inputs: [], outputs: [] };
    if (this._cachedPorts) return this._cachedPorts;
    try {
      this._cachedPorts = { inputs: easymidi.getInputs(), outputs: easymidi.getOutputs() };
    } catch (_) {
      this._cachedPorts = { inputs: [], outputs: [] };
    }
    return this._cachedPorts;
  }

  refreshPorts(): MidiPortList {
    this._cachedPorts = null;
    return this.listPorts();
  }

  connect(inputName: string | null, outputName: string | null): boolean {
    if (!easymidi) {
      console.warn('[MIDI] easymidi not loaded — MIDI unavailable.');
      return false;
    }

    const { inputs, outputs } = this.refreshPorts();
    if (!inputs.length && !outputs.length) {
      console.warn('[MIDI] No MIDI ports available.');
      return false;
    }

    console.log('[MIDI] Available inputs: ', inputs);
    console.log('[MIDI] Available outputs:', outputs);

    const findPort = (list: string[], hint: string | null): string | null => {
      if (hint) return list.find(n => n === hint) || null;
      return list.find(n => /x.?touch/i.test(n)) || list[0] || null;
    };

    const inName  = findPort(inputs,  inputName);
    const outName = findPort(outputs, outputName);

    if (!inName) {
      console.warn('[MIDI] No input port found. Pick one under Settings → MIDI controller.');
      return false;
    }

    try {
      this.input = new easymidi.Input(inName);
      this._inputName = inName;
      console.log(`[MIDI] Input:  ${inName}`);

      if (outName) {
        this.output = new easymidi.Output(outName);
        console.log(`[MIDI] Output: ${outName}`);
      }

      this._bindInput();
      this.enabled = true;
      this._lastCcOut.clear();
      this.sendFeedback();
      return true;
    } catch (err) {
      console.error('[MIDI] Failed to open MIDI port:', messageOf(err));
      return false;
    }
  }

  _bindingFor(kind: 'cc' | 'notes', number: number, channel: number): MidiBinding | null {
    const binding = this.map[kind] && this.map[kind][number];
    if (!binding) return null;
    if (binding.channel !== undefined && binding.channel !== channel) return null;
    return binding;
  }

  _bindInput(): void {
    const input = this.input;
    if (!input) return;

    if (process.env.DEBUG_MIDI === '1') {
      input.on('noteon',  ({ note, velocity, channel }) =>
        console.log(`[MIDI] noteon  ch=${channel + 1} note=${note} vel=${velocity}  → ${this.map.notes[note] ? this.map.notes[note].action : 'unmapped'}`));
      input.on('noteoff', ({ note, channel }) =>
        console.log(`[MIDI] noteoff ch=${channel + 1} note=${note}`));
      input.on('cc',      ({ controller, value, channel }) =>
        console.log(`[MIDI] cc      ch=${channel + 1} cc=${controller} val=${value}  → ${this.map.cc[controller] ? this.map.cc[controller].action : 'unmapped'}`));
      input.on('pitch',   ({ value, channel }) =>
        console.log(`[MIDI] pitch   ch=${channel + 1} val=${value}`));
    }

    input.on('noteon', ({ note, velocity, channel }) => {
      if (velocity > 0 && this._captureLearn('notes', note, channel)) return;

      if (velocity === 0 && this._releasePad(channel, note)) return;
      const binding = this._bindingFor('notes', note, channel);
      if (!binding) return;
      if (binding.action === 'padPress') {
        if (velocity > 0) this._safely(binding, () => this._pressPad(channel, note, binding));
        return;
      }
      if (velocity === 0) {
        if (binding.action === 'energyHold') this.apply({ energyOverride: null });
        return;
      }
      this._safely(binding, () => this._dispatch(binding));
    });

    input.on('noteoff', ({ note, channel }) => {
      if (this._releasePad(channel, note)) return;
      const binding = this._bindingFor('notes', note, channel);
      if (binding && binding.action === 'energyHold') {
        this.apply({ energyOverride: null });
        this.sendFeedback();
      }
    });

    input.on('cc', ({ controller, value, channel }) => {
      const key = `${channel}:${controller}`;
      const between = value > 0 && value < 127;
      this._trackTouch(key, controller, channel, value, between);

      if (this._learn && !between && !this._moved.has(key) && this._learnWantsFader()) return;
      if (this._captureLearn('cc', controller, channel)) return;

      this._lastCcIn.set(controller, Date.now());

      const binding = this._bindingFor('cc', controller, channel);
      if (!binding) return;
      if (binding.type !== 'relative' && FADER_ACTIONS.has(binding.action) && !this._moved.has(key)) {
        this._warnSwitch(key, controller, binding);
        return;
      }
      if (binding.type === 'relative') {
        const key = `${channel}:${controller}`;
        const evidence = relEvidence(value);
        if (evidence) this._relModes.set(key, evidence);
        const delta = relDelta(value, this._relModes.get(key) || REL_TWOS)
          * (binding.scale || 1);
        if (delta !== 0) {
          this._safely(binding, () => this._dispatchContinuous(binding, delta));
        }
      } else {
        this._safely(binding, () => this._dispatchAbsolute(binding, value));
      }
    });
  }

  _learnWantsFader(): boolean {
    const binding = this._learn && this._learn.binding;
    return !!binding && binding.type !== 'relative' && FADER_ACTIONS.has(binding.action);
  }

  _trackTouch(key: string, controller: number, channel: number, value: number, between: boolean): void {
    const now = Date.now();
    const bound = this._bindingFor('cc', controller, channel);
    if (bound && (bound.type === 'relative' || !FADER_ACTIONS.has(bound.action))) {
      if (between) this._moved.add(key);
      return;
    }
    if (between) {
      this._moved.add(key);
      for (const [touch, at] of this._touchDown) {
        if (touch === key || this._touchOf.has(touch) || now - at > TOUCH_PAIR_MS) continue;
        this._touchOf.set(touch, key);
        this._heal(touch, key);
      }
      return;
    }
    if (this._moved.has(key)) return;
    if (value === 127) {
      this._touchDown.set(key, now);
    } else {
      this._touchDown.delete(key);
      const fader = this._touchOf.get(key);
      if (fader) {
        this._lastCcOut.delete(Number(fader.split(':')[1]));
        this._sendControlFeedback();
      }
    }
  }

  _heal(touchKey: string, faderKey: string): void {
    const touchCc = Number(touchKey.split(':')[1]);
    const faderCc = Number(faderKey.split(':')[1]);
    const binding = this.map.cc && this.map.cc[touchCc];
    if (!binding || !FADER_ACTIONS.has(binding.action) || binding.type === 'relative') return;
    if (this.map.cc[faderCc]) return;
    console.warn(`[MIDI] CC ${touchCc} is the touch sensor of the fader on CC ${faderCc}: `
      + `its binding (${binding.action}) moves to CC ${faderCc}`);
    const cc: Record<string, MidiBinding> = { ...this.map.cc, [String(faderCc)]: binding };
    delete cc[String(touchCc)];
    this.map = { ...this.map, cc };
    if (this.onRebind) {
      try { this.onRebind(touchCc, faderCc, binding); } catch (err) { console.warn(`[MIDI] could not save the move: ${messageOf(err)}`); }
    }
  }

  _warnSwitch(key: string, controller: number, binding: MidiBinding): void {
    if (this._warnedSwitch.has(key)) return;
    this._warnedSwitch.add(key);
    console.warn(`[MIDI] CC ${controller} is bound to ${binding.action} but has only sent 0 and 127, like a fader's `
      + 'touch sensor or a button — ignored until it moves between the ends. Relearn the fader by moving it.');
  }

  _touched(faderCc: number): boolean {
    for (const [touch, fader] of this._touchOf) {
      if (Number(fader.split(':')[1]) === faderCc && this._touchDown.has(touch)) return true;
    }
    return false;
  }

  _safely(binding: MidiBinding, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.warn(`[MIDI] ${binding.action} failed: ${messageOf(err)}`);
    }
  }

  startLearn(binding: MidiBinding): Promise<LearnCapture | null> {
    this.cancelLearn('superseded');
    return new Promise<LearnCapture | null>((resolve) => {
      const timer = setTimeout(() => this.cancelLearn('timeout'), LEARN_TIMEOUT_MS);
      timer.unref();
      this._learn = { binding, resolve, timer };
      this._emitLearn({ status: 'armed', binding });
    });
  }

  cancelLearn(reason = 'cancelled'): boolean {
    const learn = this._learn;
    if (!learn) return false;
    this._learn = null;
    clearTimeout(learn.timer);
    learn.resolve(null);
    this._emitLearn({ status: reason, binding: learn.binding });
    return true;
  }

  get learning(): boolean { return !!this._learn; }

  _captureLearn(kind: 'cc' | 'notes', number: number, channel: number): boolean {
    const learn = this._learn;
    if (!learn) return false;
    this._learn = null;
    clearTimeout(learn.timer);

    const captured: LearnCapture = { kind, number, channel, binding: learn.binding };
    learn.resolve(captured);
    this._emitLearn({ status: 'captured', ...captured });
    return true;
  }

  onLearn(fn: (event: LearnEvent) => void): void { this._learnListeners.push(fn); }

  _emitLearn(event: LearnEvent): void {
    for (const fn of this._learnListeners) {
      try { fn(event); } catch (err) { console.warn(`[MIDI] learn listener: ${messageOf(err)}`); }
    }
  }

  _dispatch(binding: MidiBinding): void {
    const s = this.state;
    switch (binding.action) {
      case 'tap':
        this.tap();
        break;
      case 'toggleBlackout':
        this.apply({ masterBlackout: !s.masterBlackout });
        break;
      case 'toggleTempoMode':
        this.apply({ tempoMode: s.tempoMode === 'manual' ? 'auto' : 'manual' });
        break;
      case 'togglePlay':
        this.apply({ running: !s.running });
        break;
      case 'setPattern':
        this.apply({ pattern: binding.value });
        break;
      case 'setColorA':
        this.apply({ colorA: binding.value });
        break;
      case 'setColorB':
        this.apply({ colorB: binding.value });
        break;
      case 'setColorC':
        this.apply({ colorC: binding.value });
        break;
      case 'setColorD':
        this.apply({ colorD: binding.value });
        break;
      case 'setBeatDivision':
        this.apply({ beatDivision: Number(binding.value) || 1 });
        break;
      case 'energyHold': {
        const effect = binding.value || this._energyEffect || ENERGY_IDS[0];
        this.apply({ energyOverride: effect });
        break;
      }
      case 'cycleEnergyEffect': {
        const curIdx = ENERGY_IDS.indexOf(this._energyEffect || ENERGY_IDS[0]);
        this._energyEffect = ENERGY_IDS[(curIdx + 1) % ENERGY_IDS.length];
        break;
      }
      case 'cycleStrobeFunction': {
        const curIdx = STROBE_FN_IDS.indexOf(s.strobeFunction || 'standard');
        this.apply({ strobeFunction: STROBE_FN_IDS[(curIdx + 1) % STROBE_FN_IDS.length] });
        break;
      }
      case 'toggleFixBlackout': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        const cur = fix && fix.override;
        const newBo = !(cur && cur.blackout);
        if (!newBo && cur && cur.blackout && !cur.enabled) {
          this._emitFixOverride(fix.id, null);
          break;
        }
        this._emitFixOverride(fix.id, {
          ...(cur || { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }),
          blackout: newBo,
        });
        break;
      }
      case 'recallCue':
        if (this.recallCue && binding.value) this.recallCue(String(binding.value));
        break;
      case 'setPalette':
        if (binding.value) this.apply({ palette: String(binding.value) });
        break;
    }
    this.sendFeedback();
  }

  _dispatchContinuous(binding: MidiBinding, delta: number): void {
    const s = this.state;
    switch (binding.action) {
      case 'adjustBpm':
        this.apply({ bpm: clamp(s.bpm + delta, 20, 300) });
        break;
      case 'adjustMasterDimmer':
        this.apply({ masterDimmer: clamp(s.masterDimmer + delta, 0, 255) });
        break;
      case 'adjustStrobeSpeed':
        this.apply({ strobeSpeed: clamp(s.strobeSpeed + delta, 0, 255) });
        break;
      case 'adjustFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        const cur = (fix.override && fix.override.enabled) ? fix.override.dim ?? 255 : 255;
        this._emitFixOverride(fix.id, {
          ...(fix.override || {}), enabled: true, dim: clamp(cur + delta, 0, 255), blackout: false,
        });
        break;
      }
      case 'adjustFixtureMax': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        const cur = Number.isInteger(fix.maxBrightness) ? fix.maxBrightness as number : 255;
        this._emitFixMax(fix.id, clamp(cur + delta, 0, 255));
        break;
      }
      case 'adjustAutoIntensity':
        this.apply({ autoIntensity: clamp(Math.round((s.autoIntensity ?? 50) + delta), 0, 100) });
        break;
      case 'adjustAutoSync':
        this.apply({
          autoSyncOffsetMs: clamp(
            Math.round((s.autoSyncOffsetMs ?? 0) + delta * SYNC_NUDGE_MS),
            -SYNC_OFFSET_LIMIT_MS, SYNC_OFFSET_LIMIT_MS,
          ),
        });
        break;
    }
  }

  _dispatchAbsolute(binding: MidiBinding, raw: number): void {
    const s = this.state;
    const level = Math.round((raw / 127) * 255);
    switch (binding.action) {
      case 'setMasterDimmer':
        this.apply({ masterDimmer: level });
        break;
      case 'setStrobeSpeed':
        this.apply({ strobeSpeed: level });
        break;
      case 'setBpm':
        this.apply({ bpm: Math.round(20 + (raw / 127) * 280) });
        break;
      case 'setFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) break;
        this._emitFixOverride(fix.id, {
          ...(fix.override || { r: 0, g: 0, b: 0, w: 0, strobe: 0 }),
          enabled: true, dim: level, blackout: false,
        });
        break;
      }
      case 'setFixtureMax':
        if (s.fixtures.some((fixture) => fixture.id === binding.fixture)) this._emitFixMax(binding.fixture as number, level);
        break;
      case 'setAutoIntensity':
        this.apply({ autoIntensity: Math.round((raw / 127) * 100) });
        break;
      case 'setAutoSync':
        this.apply({
          autoSyncOffsetMs: Math.round(((raw - 63.5) / 63.5) * SYNC_OFFSET_LIMIT_MS),
        });
        break;
    }
  }

  overrideFixture: ((id: number, override: Partial<Override> | null) => void) | null = null;

  setFixtureMax: ((id: number, value: number) => void) | null = null;

  _emitFixOverride(id: number, override: Partial<Override> | null): void {
    if (this.overrideFixture) this.overrideFixture(id, override);
  }

  _emitFixMax(id: number, value: number): void {
    if (this.setFixtureMax) this.setFixtureMax(id, value);
  }

  sendFeedback(): void {
    if (!this.output) return;
    const s = this.state;

    this._sendControlFeedback();

    for (const [note, binding] of Object.entries(this.map.notes || {})) {
      let lit: boolean | null;
      switch (binding.action) {
        case 'setPattern':       lit = binding.value === s.pattern; break;
        case 'setColorA':        lit = binding.value === s.colorA; break;
        case 'setColorB':        lit = binding.value === s.colorB; break;
        case 'setColorC':        lit = binding.value === s.colorC; break;
        case 'setColorD':        lit = binding.value === s.colorD; break;
        case 'setBeatDivision':  lit = Number(binding.value) === s.beatDivision; break;
        case 'setPalette':       lit = binding.value === s.palette; break;
        case 'toggleBlackout':   lit = !!s.masterBlackout; break;
        case 'toggleTempoMode':  lit = s.tempoMode !== 'manual'; break;
        case 'togglePlay':       lit = !!s.running; break;
        case 'energyHold':       lit = !!s.energyOverride; break;
        case 'toggleFixBlackout': {
          const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
          lit = !!(fix && fix.override && fix.override.blackout);
          break;
        }
        default: lit = null;    // nothing meaningful to show
      }
      if (lit !== null) this._ledNote(Number(note), lit ? 127 : 0, binding.channel || 0);
    }
  }

  _feedbackValue(binding: MidiBinding): number | null {
    const s = this.state;
    const to127 = (value: number, max: number) => Math.max(0, Math.min(127, Math.round((value / max) * 127)));

    switch (binding.action) {
      case 'setMasterDimmer':
      case 'adjustMasterDimmer':
        return to127(s.masterDimmer, 255);
      case 'setStrobeSpeed':
      case 'adjustStrobeSpeed':
        return to127(s.strobeSpeed, 255);
      case 'setBpm':
      case 'adjustBpm':
        return to127(s.bpm - 20, 280);
      case 'setFixtureDim':
      case 'adjustFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) return null;
        const dim = (fix.override && fix.override.enabled) ? fix.override.dim ?? 255 : 255;
        return to127(dim, 255);
      }
      case 'setFixtureMax':
      case 'adjustFixtureMax': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) return null;
        return to127(Number.isInteger(fix.maxBrightness) ? fix.maxBrightness as number : 255, 255);
      }
      case 'setAutoIntensity':
      case 'adjustAutoIntensity':
        return to127(s.autoIntensity ?? 50, 100);
      case 'setAutoSync':
      case 'adjustAutoSync':
        // Bipolar, so centre the ring rather than parking it at the bottom.
        return to127((s.autoSyncOffsetMs ?? 0) + SYNC_OFFSET_LIMIT_MS, SYNC_OFFSET_LIMIT_MS * 2);
      default:
        return null;
    }
  }

  _sendControlFeedback(): void {
    const output = this.output;
    if (!this.controlFeedback || !output) return;
    const now = Date.now();

    for (const [cc, binding] of Object.entries(this.map.cc || {})) {
      const value = this._feedbackValue(binding);
      if (value === null) continue;

      const number = Number(cc);
      const touchedAt = this._lastCcIn.get(number) || 0;
      if (now - touchedAt < ECHO_SUPPRESS_MS) continue;
      // A finger on it, by its touch sensor: the motor must not fight it.
      if (this._touched(number)) continue;
      if (this._lastCcOut.get(number) === value) continue;

      this._lastCcOut.set(number, value);
      try {
        output.send('cc', { controller: number, value, channel: binding.channel || 0 });
      } catch (_) { /* the port can vanish mid-show; feedback is not worth dying for */ }
    }
  }

  _ledNote(note: number, velocity: number, channel = 0): void {
    if (!this.output) return;
    try {
      this.output.send('noteon', { note, velocity, channel });
    } catch (_) { /* the port can vanish mid-show; feedback is not worth dying for */ }
  }

  _pressPad(channel: number, note: number, binding: MidiBinding): void {
    const key = `${channel}:${note}`;
    if (!this.pads || this._heldPads.has(key) || binding.bank === undefined || binding.slot === undefined) return;
    const pad = { bank: binding.bank, slot: binding.slot, owner: `midi:pad:${key}`, token: `midi:${key}` };
    const voice = this.pads.press(pad.bank, pad.slot, pad.owner, pad.token);
    const held: HeldPad = { ...pad, renew: null };
    this._heldPads.set(key, held);
    if (!voice || voice.mode !== 'hold') return;
    const strobeMs = voice.spec?.kind === 'strobe' ? this.pads.strobeMaxMs?.() : undefined;
    const maxMs = strobeMs !== undefined && Number.isFinite(strobeMs) && strobeMs > 0 ? strobeMs : MIDI_HOLD_MAX_MS;
    let ticks = 0;
    held.renew = setInterval(() => this._safely(binding, () => {
      if (this._heldPads.get(key) !== held) return;
      ticks++;
      const renewed = ticks * PAD_RENEW_MS < maxMs && !this._portGone() && !!this.pads?.renew(pad.bank, pad.slot, pad.owner, pad.token);
      if (!renewed) this._releasePad(channel, note);
    }), PAD_RENEW_MS);
    held.renew.unref?.();
  }

  _portGone(): boolean {
    if (!easymidi || !this._inputName) return false;
    try {
      return !easymidi.getInputs().includes(this._inputName);
    } catch (_) {
      return true;
    }
  }

  _releasePad(channel: number, note: number): boolean {
    const key = `${channel}:${note}`;
    const held = this._heldPads.get(key);
    if (!held) return false;
    if (held.renew) clearInterval(held.renew);
    this._heldPads.delete(key);
    this.pads?.release(held.bank, held.slot, held.owner, held.token);
    return true;
  }

  close(): void {
    for (const key of [...this._heldPads.keys()]) {
      const [channel, note] = key.split(':').map(Number);
      this._releasePad(channel, note);
    }
    this.cancelLearn('disconnected');
    this._lastCcOut.clear();
    this._lastCcIn.clear();
    this._touchDown.clear();
    if (this.input)  { try { this.input.close();  } catch (_) {} }
    if (this.output) { try { this.output.close(); } catch (_) {} }
    this.enabled = false;
    this._inputName = null;
    this._cachedPorts = null;
  }
}

function openMidiOutput(name: string): MidiOutput | null {
  if (!easymidi || !name) return null;
  if (!easymidi.getOutputs().includes(name)) return null;
  return new easymidi.Output(name);
}

export { openMidiOutput };
export default MidiController;