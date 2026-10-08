/**
 * MIDI control surface.
 *
 * The mapping — which message does what — lives in src/server/midi-map.js and
 * is stored in config/midi-map.json. It defaults to a Behringer X-Touch Compact
 * in Standard mode (Layer A), which is what this was built against, but every
 * binding can be relearned from the Settings view by pressing the control you
 * want, so any controller works.
 *
 * X-Touch Compact Standard mode, Layer A, for reference:
 *   Encoders EN1-8 turn : CC 10-17, ch 1 (the position, 0-127, out of the box;
 *                          set to relative, the encoding is worked out from the
 *                          values — see relEvidence)
 *   Encoders EN1-8 push : Note 0-7,  ch 1
 *   Button row 1 (BT1-8)  : Note 16-23, ch 1
 *   Button row 2 (BT9-16) : Note 24-31, ch 1
 *   Faders FD1-9 : CC 1-9, ch 1 (absolute 0-127)
 *
 * LED feedback is sent back via Note On (velocity = colour):
 *   0 = off, 1 = on (fixture-default), 127 = bright on
 * Which notes get lit is derived from the map rather than hardcoded, so
 * feedback follows a relearned layout instead of pointing at the old buttons.
 */

import { DEFAULT_MAP, ACTIONS, defaultTypeFor } from './server/midi-map.ts';
import { createRequire } from 'node:module';

import { COLOR_PRESETS, ENERGY_EFFECT_IDS, STROBE_FUNCTION_IDS, SYNC_OFFSET_LIMIT_MS } from './server/presets.ts';
import { messageOf } from './errors.ts';
import type { MidiBinding, MidiMap } from './server/midi-map.ts';
import type { ShowState } from './server/state.ts';
import type { Override } from './types/rig.ts';

// easymidi is optional, so it is loaded at run time and described here by the
// parts this module uses.
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

/** The ports this machine has. */
export interface MidiPortList {
  inputs: string[];
  outputs: string[];
}

/** A control captured by learn mode. */
export interface LearnCapture {
  kind: 'cc' | 'notes';
  number: number;
  channel: number;
  binding: MidiBinding;
  /** For an encoder: the kind it showed itself to be, as a binding type. */
  type?: 'relative' | 'absolute';
}

/** A learn-mode transition, for every open page. */
export type LearnEvent = { status: string; binding: MidiBinding } & Partial<LearnCapture>;

type RelMode = 'twos' | 'offset';

// Loaded through require so it can stay optional: a missing or broken native
// MIDI binding turns MIDI off rather than stopping the server from starting.
const require = createRequire(import.meta.url);

// Milliseconds per encoder detent when nudging the light/music sync.
const SYNC_NUDGE_MS = 5;

// The ALSA client RtMidi opens behind each of our ports.
const OWN_PORT = /^RtMidi (Input|Output) Client:/;

let easymidi: EasyMidi | undefined;
try {
  easymidi = require('easymidi') as EasyMidi;
} catch (_) {
  console.warn('[MIDI] easymidi not available — run `npm install easymidi` to enable MIDI support.');
}

// Taken from the tables in server/presets.js rather than copied. These drive
// the cycle buttons, so a hand-written copy that fell behind would leave the
// surface cycling an effect the server no longer accepts — silently, since the
// patch validator just drops an unknown id.
const ENERGY_IDS = ENERGY_EFFECT_IDS;
// Well inside the pads' 1200 ms hold lease.
const PAD_RENEW_MS = 400;
// The longest a MIDI hold lasts without its note-off (a controller unplugged
// mid-hold); a held strobe pad stops at safety.strobeMaxLatchSec instead.
export const MIDI_HOLD_MAX_MS = 5 * 60 * 1000;

interface MidiPads {
  /** What the press launched: a hold is renewed, anything else is left alone. */
  press(bank: number, slot: number, owner: string, token: string): { mode?: string; spec?: { kind?: string } } | null | undefined;
  /** Extend a live hold's lease, never launch; whether one was renewed. */
  renew(bank: number, slot: number, owner: string, token: string): boolean;
  release(bank: number, slot: number, owner: string, token: string): unknown;
  /** The strobe's latch cap in ms. */
  strobeMaxMs?(): number;
}
/** A row of the look catalogue as the server sends it (state.ts getCatalogs): a pattern or an effect preset. */
export interface LookRow { id: string; pixel?: boolean; app?: string; rapidFlash?: boolean }

/**
 * What playing a show by hand reaches on the server (integrations sets it);
 * null leaves those controls silent.
 */
export interface MidiBusk {
  /** The patterns and effect presets, as the pages get them. */
  looks(): readonly LookRow[];
  /** Every palette by id, built in and saved, for the palette knob. */
  palettes(): readonly string[];
  /** Whether the photosensitivity acknowledgement is given: until then the fast-flashing effects are skipped. */
  acknowledged(): boolean;
  stopEffects(): unknown;
  strobeBurst(ms: number): unknown;
  strobeRate(): number;
  setStrobeRate(hz: number): unknown;
  strobeMaxRate: number;
  autoShowOn(): boolean;
  toggleAutoShow(): unknown;
}

interface HeldPad { bank: number; slot: number; owner: string; token: string; renew: ReturnType<typeof setInterval> | null }
const STROBE_FN_IDS = STROBE_FUNCTION_IDS;

// An armed learn that nobody completes would sit swallowing the next press for
// the rest of the night. Give up on it.
const LEARN_TIMEOUT_MS = 30000;

// After a control sends us a value, hold off echoing that control for a moment.
// A motorised fader that is being moved by hand must not be driven back to
// where the last frame said it was — the operator ends up fighting the motor.
const ECHO_SUPPRESS_MS = 400;

// ── Touch-sensitive faders ──────────────────────────────────────────────────
//
// A motorised fader with a touch sensor — the X-Touch Compact's nine — is two
// controls on the wire: its position on one CC, and on another CC, 127 the
// moment a finger lands on it and 0 when it lifts. Learn used to take the
// first CC it saw, and touching a fader to move it sends the touch first: the
// fader's binding went to its touch sensor, so touching it threw what it
// controlled to 100% and letting go to 0%, and moving it did nothing.
//
// A fader is known by sending a value between the ends; a touch sensor (or a
// switch) never does. So a fader action is only ever driven by a control that
// has, learn skips the ones that have not, and a touch sensor is paired with
// the fader that starts moving right after it goes to 127 — which also says
// when the motor must leave that fader alone, and heals a map that bound the
// sensor: the binding moves to the fader it belongs to.
const TOUCH_PAIR_MS = 300;

// The actions a fader drives, which only a fader should: from the catalogue.
const FADER_ACTIONS = new Set(ACTIONS.filter((a) => a.input === 'fader').map((a) => a.id));

// ── Relative encoders ───────────────────────────────────────────────────────
//
// An endless encoder sends "moved a bit, this way", and there are two ways to
// spell that. Which one a controller uses is a setting on the device; nothing
// in the MIDI message says which you are being sent.
//
//   two's complement   CW 1, 2, 3 …        CCW 127, 126, 125 …   values hug 0/128
//   binary offset      CW 65, 66, 67 …     CCW 63, 62, 61 …      values hug 64
//
// This only ever decoded two's complement, and Behringer's X-Touch family
// sends binary offset — its MIDI implementation gives increment 65 and
// decrement 1. Read the wrong way round, one detent clockwise came out as
// 65 - 128 = -63 and one anticlockwise as +63: a single click threw the
// parameter to an end stop, which is what "the nudge only goes to the maximum"
// was. With a scale of 4 on the master dimmer it was ±252 per click.
//
// The two encodings put their values in different places, so the stream itself
// says which is in use: nobody hand-turns an encoder 63 detents inside one MIDI
// message, so a value next to 64 can only be binary offset, and one next to 0
// or 127 can only be two's complement. That makes the first detent decisive.
const REL_TWOS: RelMode = 'twos';
const REL_OFFSET: RelMode = 'offset';

// How close to a landmark a value has to be to count as evidence. Wide enough
// for a fast spin (a few detents per message), far narrower than the 63 that
// would be needed for the two encodings to be confused.
const REL_EVIDENCE_BAND = 7;

/** Which encoding this raw value could only have come from, or null. */
function relEvidence(value: number): RelMode | null {
  if (Math.abs(value - 64) <= REL_EVIDENCE_BAND) return REL_OFFSET;
  if (value <= REL_EVIDENCE_BAND || value >= 127 - REL_EVIDENCE_BAND) return REL_TWOS;
  return null;
}

function relDelta(value: number, mode: RelMode): number {
  // Both encodings agree that 64 is "no movement", and neither sends it.
  if (value === 64) return 0;
  if (mode === REL_OFFSET) return value - 64;
  return value > 64 ? value - 128 : value;
}

// ── Encoders that send their position ───────────────────────────────────────
//
// An X-Touch Compact out of the box (or reset in the X-TOUCH Editor) does not
// send its encoders as steps at all: each sends where it is, 0-127, and stops
// at the ends. Read as relative, a turn threw the parameter to an end stop and
// turning back left it there. The device also takes the ring position we send
// as its own, and carries on counting from it.
//
// So an encoder sending its position is taken by the change: we know where it
// is from what it last sent us or what we last sent it, and the difference is
// the number of steps.
//
// Which kind an encoder is, steps or its position, is a setting on the device,
// so it is worked out from what it sends, as the step encoding is. Steps land
// within STEP_REACH of 0, 64 or 127 — a fast spin included — so a value
// further from all three is a position. A position moves a few from where the
// encoder was and never repeats itself away from the ends, so a step-like
// value far from there, or the same one again, is a step.
//
// Until one of those, the binding's type is the guess, and the message is read
// as it says. A steps guess also moves the ring clear of every landmark, so the
// encoder's next message says which — a position counts on from the ring, a
// step lands far from it — and a wrong guess misreads one message, not the
// dozen a position takes to leave a landmark behind (66 read as a step is two
// up from 64). A position guess, the built-in map's, is not probed, or a right
// one would see its ring jump on the first touch; a step encoder misread as
// positions is shown up by its next click, except at an end, where it stalls
// until turned the other way.
type EncoderMode = 'position' | 'steps';

// The most steps a controller's acceleration packs into one message, and
// further than an encoder sending its position moves in one.
const STEP_REACH = 15;

/** How far `value` is from the nearest landmark a step lands next to. */
const fromLandmark = (value: number): number => Math.min(value, Math.abs(value - 64), 127 - value);

// The actions an encoder drives: from the catalogue.
const ENCODER_ACTIONS = new Set(ACTIONS.filter((a) => a.input === 'encoder').map((a) => a.id));

// ── Busking ─────────────────────────────────────────────────────────────────
//
// With the auto show stopped the controller plays the show itself: encoders
// browse the patterns, the effects, the colours and the bars' picture, and
// buttons throw in a random one. A browse wraps round its list; the beat
// division, the fade and the strobe rate stop at their ends. The ring shows
// where in the list the look is, and an encoder sending its position counts
// on from there (see "Encoders that send their position").

const DIVISIONS = [1, 2, 4, 8, 16];
// The crossfade the controller's own look changes go out with, a quarter second a click.
const FADE_STEP_MS = 250;
const FADE_MAX_MS = 4000;
const COLOR_SLOTS = ['colorA', 'colorB', 'colorC', 'colorD'] as const;
type ColorSlot = typeof COLOR_SLOTS[number];
const slotOf = (value: unknown): ColorSlot | null => COLOR_SLOTS.find((slot) => slot === value) ?? null;
// A random colour is one that lights: never the blackout entry.
const LIT_COLORS = COLOR_PRESETS.map((c, i) => ({ c: c as Record<string, unknown>, i }))
  .filter(({ c }) => ['r', 'g', 'b', 'w', 'a', 'uv'].some((k) => Number(c[k]) > 0)).map(({ i }) => i);
const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

// How long a ring moved off its end is left there for the encoder to say what
// it is, before the show's value goes back on it.
const PROBE_HOLD_MS = 3000;

// How long learn waits, after an encoder's first message, for one that says
// which kind it is. Without one the binding keeps the type it was asked with.
const LEARN_CONFIRM_MS = 2000;

/** A ring position clear of every landmark, on the side of `value`. */
const clearRing = (value: number): number => (value >= 64 ? 96 : 32);

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ── MidiController class ──────────────────────────────────────────────────────

class MidiController {
  declare state: ShowState;
  declare apply: (patch: Record<string, unknown>) => unknown;
  declare tap: () => void;
  declare input: MidiInput | null;
  declare output: MidiOutput | null;
  declare map: MidiMap;
  declare enabled: boolean;
  declare recallCue: ((id: string) => unknown) | null;
  declare setPaletteOverride: ((id: string | null) => unknown) | null;
  declare busk: MidiBusk | null;
  declare _fadeMs: number;
  declare _random: () => number;
  declare _learn: {
    binding: MidiBinding;
    resolve: (capture: LearnCapture | null) => void;
    timer: ReturnType<typeof setTimeout>;
    // An encoder caught, waiting for the message that says which kind it is.
    encoder?: { key: string; number: number; channel: number };
  } | null;
  declare _learnListeners: ((event: LearnEvent) => void)[];
  declare _lastCcOut: Map<number, number>;
  declare _lastCcIn: Map<number, number>;
  declare _relModes: Map<string, RelMode>;
  declare _positions: Map<string, number>;
  declare _encModes: Map<string, EncoderMode>;
  declare _probes: Map<string, number>;
  declare controlFeedback: boolean;
  declare _cachedPorts: MidiPortList | null;
  declare _energyEffect: string | undefined;
  declare _moved: Set<string>;
  declare _touchDown: Map<string, number>;
  declare _touchOf: Map<string, string>;
  declare _warnedSwitch: Set<string>;
  declare onRebind: ((from: number, to: number, binding: MidiBinding) => void) | null;
  /** The deck's pads, for padPress (integrations sets it); null leaves those notes silent. */
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

    // Set externally: recallCue needs the cue store, and setPaletteOverride
    // the palette library, which this module has no business reaching into.
    this.recallCue = null;
    this.setPaletteOverride = null;
    this.busk = null;
    this._fadeMs = 0;
    this._random = Math.random;

    this._learn = null;       // { binding, resolve, timer } while learn is armed
    this._learnListeners = [];

    // Control feedback: what we last sent to each CC, and when each last sent
    // to us. Both exist to keep the motors quiet — see _sendControlFeedback.
    this._lastCcOut = new Map();
    this._lastCcIn = new Map();
    // Which relative encoding each encoder has shown itself to use, learned
    // from the values it sends. See relEvidence.
    this._relModes = new Map();
    // Encoders, keyed "channel:cc": where each is if it sends its position,
    // which kind each has shown itself to be, and the rings moved off an end
    // to find out, with when. See "Encoders that send their position".
    this._positions = new Map();
    this._encModes = new Map();
    this._probes = new Map();
    this.controlFeedback = true;
    // Touch-sensitive faders (see TOUCH_PAIR_MS): the controls that have sent a
    // value between the ends, the switch-like ones held at 127 and since when,
    // and which fader each touch sensor belongs to. Keyed "channel:cc".
    this._moved = new Set();
    this._touchDown = new Map();
    this._touchOf = new Map();
    this._warnedSwitch = new Set();
    // Set externally: persists a binding moved off a touch sensor.
    this.onRebind = null;
  }

  /** Swap the control map. Takes effect on the next message; no reconnect. */
  setMap(map: MidiMap | null | undefined): void {
    this.map = map || DEFAULT_MAP;
    // A rebound control shows something different now, so nothing we sent for
    // the old map still describes it.
    this._lastCcOut.clear();
    this.sendFeedback();
  }

  /**
   * Turn motorised-fader and encoder-ring feedback on or off.
   *
   * On by default: a controller without motors simply ignores the CC. It is a
   * setting because a MIDI loopback — a virtual port wired back to our own
   * input — would otherwise echo our feedback in as operator input.
   */
  setControlFeedback(enabled: unknown): void {
    this.controlFeedback = !!enabled;
    this._lastCcOut.clear();
    if (this.controlFeedback) this.sendFeedback();
  }

  listPorts(): MidiPortList {
    if (!easymidi) return { inputs: [], outputs: [] };
    // Cache the result — enumerate once, refresh only on explicit connect/close
    // or when the Settings picker asks (refreshPorts).
    if (this._cachedPorts) return this._cachedPorts;
    try {
      // On ALSA every open port brings an "RtMidi … Client" of ours into the
      // list, and it outlives close(). Picking one wires our feedback back in.
      const pickable = (name: string) => !OWN_PORT.test(name);
      this._cachedPorts = { inputs: easymidi.getInputs().filter(pickable), outputs: easymidi.getOutputs().filter(pickable) };
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

    // Only the ports the operator picked. This used to fall back to the first
    // port matching /x.?touch/i, then to the first port of all, so any surface
    // on the bus could take the show over (the e2e server included).
    if (!inputName) {
      console.log('[MIDI] No input port picked. Pick one under Settings → MIDI controller.');
      return false;
    }

    const { inputs, outputs } = this.refreshPorts();
    if (!inputs.length && !outputs.length) {
      console.warn('[MIDI] No MIDI ports available.');
      return false;
    }

    console.log('[MIDI] Available inputs: ', inputs);
    console.log('[MIDI] Available outputs:', outputs);

    const inName  = inputs.includes(inputName) ? inputName : null;
    const outName = outputName && outputs.includes(outputName) ? outputName : null;

    if (!inName) {
      console.warn(`[MIDI] Input port "${inputName}" is not available. Plug it in, or pick another under Settings → MIDI controller.`);
      return false;
    }
    if (outputName && !outName) {
      console.warn(`[MIDI] Output port "${outputName}" is not available; connecting without feedback.`);
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
      // Drive the surface to the current show immediately, rather than waiting
      // for the first thing to change.
      this.sendFeedback();
      return true;
    } catch (err) {
      console.error('[MIDI] Failed to open MIDI port:', messageOf(err));
      return false;
    }
  }

  /** The binding for an incoming message, honouring an optional channel filter. */
  _bindingFor(kind: 'cc' | 'notes', number: number, channel: number): MidiBinding | null {
    const binding = this.map[kind] && this.map[kind][number];
    if (!binding) return null;
    if (binding.channel !== undefined && binding.channel !== channel) return null;
    return binding;
  }

  _bindInput(): void {
    const input = this.input;
    if (!input) return;
    // this.map is read at dispatch time rather than captured here, so a
    // relearned binding takes effect immediately instead of on the next
    // reconnect.

    // MIDI monitor: one line per incoming message. Invaluable when mapping a
    // controller, unusable during a show — a single encoder sweep is hundreds
    // of lines. Off unless DEBUG_MIDI=1.
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

    // Note On → button press
    input.on('noteon', ({ note, velocity, channel }) => {
      // A learn in progress swallows the message: the operator is telling us
      // which control they mean, not asking for it to fire.
      if (velocity > 0 && this._captureLearn('notes', note, channel)) return;

      if (velocity === 0 && this._releasePad(channel, note)) return;
      const binding = this._bindingFor('notes', note, channel);
      if (!binding) return;
      if (binding.action === 'padPress') {
        if (velocity > 0) this._safely(binding, () => this._pressPad(channel, note, binding));
        return;
      }
      if (velocity === 0) {
        // Note-off: release momentary actions
        if (binding.action === 'energyHold') this.apply({ energyOverride: null });
        return;
      }
      this._safely(binding, () => this._dispatch(binding));
    });

    // Explicit Note Off for controllers that send it separately
    input.on('noteoff', ({ note, channel }) => {
      if (this._releasePad(channel, note)) return;
      const binding = this._bindingFor('notes', note, channel);
      if (binding && binding.action === 'energyHold') {
        this.apply({ energyOverride: null });
        this.sendFeedback();
      }
    });

    // CC → encoder (relative) or fader (absolute)
    input.on('cc', ({ controller, value, channel }) => {
      const key = `${channel}:${controller}`;
      const between = value > 0 && value < 127;
      this._trackTouch(key, controller, channel, value, between);

      // Learning a fader: its touch sensor speaks first, and is not the fader.
      if (this._learn && !between && !this._moved.has(key) && this._learnWantsFader()) return;
      if (this._captureLearn('cc', controller, channel, value)) return;

      // Note the touch even when unmapped: a fader being moved is a fader we
      // should not be driving, whatever it is bound to.
      this._lastCcIn.set(controller, Date.now());

      const binding = this._bindingFor('cc', controller, channel);
      if (!binding) return;
      // Only a control that has shown itself to be a fader drives a fader
      // action: a touch sensor would throw it to the ends.
      if (binding.type !== 'relative' && FADER_ACTIONS.has(binding.action) && !this._moved.has(key)) {
        this._warnSwitch(key, controller, binding);
        return;
      }
      if (ENCODER_ACTIONS.has(binding.action)) {
        const delta = this._encoderSteps(key, controller, channel, binding, value) * (binding.scale || 1);
        // A no-movement message is not an edit: dispatching zero would still
        // clear the palette label and suppress the control's own feedback.
        if (delta !== 0) {
          this._safely(binding, () => this._dispatchContinuous(binding, delta));
        }
      } else if (binding.type !== 'relative') {
        this._safely(binding, () => this._dispatchAbsolute(binding, value));
      }
    });
  }

  /**
   * How many steps an encoder's message is, whichever kind it is.
   *
   * Remembered per control, because a surface can mix encoder types and the
   * answer cannot change while the device is plugged in. A controller
   * reconfigured mid-session shows itself again with its next decisive message.
   */
  _encoderSteps(key: string, controller: number, channel: number, binding: MidiBinding, value: number): number {
    const at = this._positions.get(key);
    this._probes.delete(key);
    const evidence = this._encoderEvidence(at, value);
    if (evidence) this._encModes.set(key, evidence);
    this._positions.set(key, value);

    const steps = (): number => {
      const encoding = relEvidence(value);
      if (encoding) this._relModes.set(key, encoding);
      return relDelta(value, this._relModes.get(key) || REL_TWOS);
    };
    const mode = this._encModes.get(key);
    if (mode === 'position') return at === undefined ? 0 : value - at;
    if (mode === 'steps') return steps();

    // Not shown yet, so the value is next to a landmark: the binding's type is
    // the guess. With nothing to measure from, a position only says where it is.
    if (binding.type !== 'relative') return at === undefined ? 0 : value - at;
    if (at !== undefined) this._probe(key, controller, channel, value);
    return steps();
  }

  /** The kind this message can only have come from, measured from `at`; null if either. */
  _encoderEvidence(at: number | undefined, value: number): EncoderMode | null {
    if (fromLandmark(value) > STEP_REACH) return 'position';
    if (at === undefined) return null;
    if (Math.abs(value - at) > STEP_REACH) return 'steps';
    if (value === at && value !== 0 && value !== 127) return 'steps';
    return null;
  }

  /** The kind an encoder is taken to be: what it has shown, or its binding's guess. */
  _encoderMode(key: string, binding: MidiBinding): EncoderMode {
    return this._encModes.get(key) ?? (binding.type === 'relative' ? 'steps' : 'position');
  }

  /**
   * Move an encoder's ring clear of every landmark, so its next message says
   * which kind it is, and leave it there for PROBE_HOLD_MS. Not with feedback
   * off: whatever echoes it back would be taken for the encoder.
   */
  _probe(key: string, controller: number, channel: number, value: number): void {
    if (!this.output || !this.controlFeedback) return;
    const ring = clearRing(value);
    try {
      this.output.send('cc', { controller, value: ring, channel });
    } catch (_) { return; }
    this._lastCcOut.set(controller, ring);
    this._positions.set(key, ring);
    this._probes.set(key, Date.now());
  }

  /** Is the learn in progress for a fader action? */
  _learnWantsFader(): boolean {
    const binding = this._learn && this._learn.binding;
    return !!binding && binding.type !== 'relative' && FADER_ACTIONS.has(binding.action);
  }

  /**
   * Follow the touch sensors: a switch-like control going to 127 is a finger
   * landing, possibly; the fader that starts moving within TOUCH_PAIR_MS is
   * the one it belongs to. A pairing heals a map that bound the sensor, and
   * a sensor let go hands its fader back to the motor at once.
   */
  _trackTouch(key: string, controller: number, channel: number, value: number, between: boolean): void {
    const now = Date.now();
    // An encoder is no touch sensor, whatever it sends: two's complement turns
    // anticlockwise as 127, over and over, and never says 0.
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
      // Let go: the fader is the motor's again, to where the show now is.
      const fader = this._touchOf.get(key);
      if (fader) {
        this._lastCcOut.delete(Number(fader.split(':')[1]));
        this._sendControlFeedback();
      }
    }
  }

  /** A fader action bound to its fader's touch sensor moves to the fader, when the fader is free. */
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

  /** Say once why a fader action ignores a control that has only sent 0 and 127. */
  _warnSwitch(key: string, controller: number, binding: MidiBinding): void {
    if (this._warnedSwitch.has(key)) return;
    this._warnedSwitch.add(key);
    console.warn(`[MIDI] CC ${controller} is bound to ${binding.action} but has only sent 0 and 127, like a fader's `
      + 'touch sensor or a button — ignored until it moves between the ends. Relearn the fader by moving it.');
  }

  /** Is this fader held by a finger, by what its touch sensor says? */
  _touched(faderCc: number): boolean {
    for (const [touch, fader] of this._touchOf) {
      if (Number(fader.split(':')[1]) === faderCc && this._touchDown.has(touch)) return true;
    }
    return false;
  }

  /**
   * Run a dispatch, surviving a binding the server refuses.
   *
   * The map's `value` is loose on purpose — it is a pattern id, a colour index,
   * a cue id or a palette name depending on the action — so a hand-edited
   * midi-map.json can hold one the server validates and rejects. applyPatch
   * throws in that case, and this handler runs inside an easymidi event
   * callback: unguarded, a single wrong entry in a config file takes the whole
   * server down the first time that button is pressed, mid-show. A warning and
   * a dead button is the right cost.
   */
  _safely(binding: MidiBinding, run: () => void): void {
    try {
      run();
    } catch (err) {
      console.warn(`[MIDI] ${binding.action} failed: ${messageOf(err)}`);
    }
  }

  // ── Learn mode ───────────────────────────────────────────────────────────

  /**
   * Arm learn: the next note or CC that arrives is bound to `binding`.
   *
   * Returns a promise that settles with the captured `{ kind, number, channel,
   * binding }`, or null if it was cancelled or timed out. Arming a second learn
   * cancels the first, so a client that changed its mind cannot leave one armed
   * behind it.
   */
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

  /** True when this message was consumed by an armed learn. */
  _captureLearn(kind: 'cc' | 'notes', number: number, channel: number, value = 0): boolean {
    const learn = this._learn;
    if (!learn) return false;
    if (kind === 'cc' && ENCODER_ACTIONS.has(learn.binding.action)) return this._learnEncoder(learn, number, channel, value);
    // An encoder already caught: the rest of the surface works meanwhile.
    if (learn.encoder) return false;
    this._finishLearn(learn, { kind, number, channel, binding: learn.binding });
    return true;
  }

  /**
   * Learning an encoder: its first message binds it, but which kind it is —
   * steps or its position — is what makes the binding work, and one message
   * seldom says. So the ring is moved clear of every landmark, and the next
   * messages say which (see _encoderEvidence). Without one in LEARN_CONFIRM_MS
   * the binding keeps the type it was asked with.
   */
  _learnEncoder(learn: NonNullable<MidiController['_learn']>, number: number, channel: number, value: number): boolean {
    const key = `${channel}:${number}`;
    if (learn.encoder && learn.encoder.key !== key) return false;

    // Where the encoder was before is not to be trusted: it was not ours to follow.
    const first = !learn.encoder;
    const evidence = this._encoderEvidence(first ? undefined : this._positions.get(key), value);
    this._positions.set(key, value);
    if (first) {
      learn.encoder = { key, number, channel };
      clearTimeout(learn.timer);
      learn.timer = setTimeout(() => this._finishLearnEncoder(learn, null), LEARN_CONFIRM_MS);
      learn.timer.unref?.();
    }
    if (evidence) this._finishLearnEncoder(learn, evidence);
    else if (first) this._probe(key, number, channel, value);
    return true;
  }

  _finishLearnEncoder(learn: NonNullable<MidiController['_learn']>, mode: EncoderMode | null): void {
    const encoder = learn.encoder;
    if (!encoder) return;
    if (mode) this._encModes.set(encoder.key, mode);
    const type = mode === 'position' ? 'absolute'
      : mode === 'steps' ? 'relative'
        : learn.binding.type || defaultTypeFor(learn.binding.action);
    this._finishLearn(learn, { kind: 'cc', number: encoder.number, channel: encoder.channel, binding: learn.binding, type });
  }

  _finishLearn(learn: NonNullable<MidiController['_learn']>, captured: LearnCapture): void {
    // Cancelled or superseded meanwhile: that already answered.
    if (this._learn !== learn) return;
    this._learn = null;
    clearTimeout(learn.timer);
    learn.resolve(captured);
    this._emitLearn({ status: 'captured', ...captured });
  }

  /** Register a listener for learn-mode transitions (armed/captured/cancelled). */
  onLearn(fn: (event: LearnEvent) => void): void { this._learnListeners.push(fn); }

  _emitLearn(event: LearnEvent): void {
    for (const fn of this._learnListeners) {
      try { fn(event); } catch (err) { console.warn(`[MIDI] learn listener: ${messageOf(err)}`); }
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

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
        // Momentary: note-on activates, note-off (handled above) deactivates.
        // A bound effect wins; otherwise this button follows cycleEnergyEffect.
        const effect = binding.value || this._energyEffect || ENERGY_IDS[0];
        this.apply({ energyOverride: effect });
        break;
      }
      case 'cycleEnergyEffect': {
        // Cycle which effect the energy hold button triggers (without activating it)
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
        // Blackout is a gate, not a replacement look. Clearing it restores the
        // prior override; if there was none, return to the pattern engine.
        this._emitFixOverride(fix.id, {
          ...(cur || { enabled: false, r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 255, strobe: 0 }),
          blackout: newBo,
        });
        break;
      }
      case 'recallCue':
        // Wired up by server.js; a rig with no cue store just does nothing.
        if (this.recallCue && binding.value) this.recallCue(String(binding.value));
        break;
      case 'setPalette':
        // One press writes all four colour slots from a named look. The server
        // rejects an id it does not know, which surfaces as a toast rather than
        // a button that silently does nothing.
        if (binding.value) this.apply({ palette: String(binding.value) });
        break;
      case 'togglePaletteOverride': {
        // Over whatever is playing until pressed again. The auto show never
        // sets the override, so this colours the show rather than fighting it.
        if (!binding.value || !this.setPaletteOverride) break;
        const id = String(binding.value);
        this.setPaletteOverride(s.paletteOverrideId === id ? null : id);
        break;
      }
      case 'clearPaletteOverride':
        this.setPaletteOverride?.(null);
        break;
      case 'randomLook': {
        const others = this._lookList(binding.value === 'effect' ? 'effect' : 'pattern').filter((id) => id !== s.pattern);
        if (others.length) this._look(this._pick(others));
        break;
      }
      case 'randomColor': {
        const slot = slotOf(binding.value);
        const others = LIT_COLORS.filter((i) => !slot || i !== s[slot]);
        if (slot && others.length) this.apply({ [slot]: this._pick(others), ...this._fade() });
        break;
      }
      case 'scaleBpm': {
        const factor = Number(binding.value);
        if (factor > 0) this.apply({ bpm: clamp(Math.round(s.bpm * factor * 100) / 100, 20, 300) });
        break;
      }
      case 'stopEffects':
        this.busk?.stopEffects();
        break;
      case 'strobeBurst':
        this.busk?.strobeBurst(Number(binding.value) || 1000);
        break;
      case 'toggleAutoShow':
        this.busk?.toggleAutoShow();
        break;
    }
    this.sendFeedback();
  }

  /**
   * The looks an encoder browses: the rig's patterns (the classic and party
   * ones, not the pixel pictures), or the Hue Dynamics and Light DJ effects —
   * the fast-flashing ones only once the acknowledgement is given.
   */
  _lookList(kind: 'pattern' | 'effect'): string[] {
    const rows = this.busk?.looks() ?? [];
    if (kind === 'pattern') return rows.filter((r) => !r.pixel && !r.app).map((r) => r.id);
    const acknowledged = !!this.busk?.acknowledged();
    return rows.filter((r) => (r.app === 'hd' || r.app === 'ldj') && (acknowledged || !r.rapidFlash)).map((r) => r.id);
  }

  /** The bars' own pictures, "as the whole rig" first. */
  _barsList(): (string | null)[] {
    return [null, ...(this.busk?.looks() ?? []).filter((r) => r.pixel).map((r) => r.id)];
  }

  /** Put a look on, with the controller's fade. */
  _look(id: string): void {
    this.apply({ pattern: id, ...this._fade() });
  }

  _fade(): { fadeMs?: number } {
    return this._fadeMs > 0 ? { fadeMs: this._fadeMs } : {};
  }

  _pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this._random() * list.length))];
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
        // 0-100, not 0-255: the auto show's slider is a percentage.
        this.apply({ autoIntensity: clamp(Math.round((s.autoIntensity ?? 50) + delta), 0, 100) });
        break;
      case 'browsePattern':
      case 'browseEffect': {
        const list = this._lookList(binding.action === 'browsePattern' ? 'pattern' : 'effect');
        if (!list.length) break;
        const at = list.indexOf(s.pattern);
        // Not in the list (the other kind is on): the first turn lands on its first or last.
        this._look(list[at < 0 ? (delta > 0 ? 0 : list.length - 1) : wrapIndex(at + delta, list.length)]);
        break;
      }
      case 'browseColor': {
        const slot = slotOf(binding.value);
        if (slot) this.apply({ [slot]: wrapIndex(s[slot] + delta, COLOR_PRESETS.length), ...this._fade() });
        break;
      }
      case 'browseBeatDivision': {
        const at = Math.max(0, DIVISIONS.indexOf(s.beatDivision));
        this.apply({ beatDivision: DIVISIONS[clamp(at + delta, 0, DIVISIONS.length - 1)] });
        break;
      }
      case 'browseBarsPattern': {
        const list = this._barsList();
        this.apply({ pixelPattern: list[wrapIndex(Math.max(0, list.indexOf(s.pixelPattern)) + delta, list.length)] });
        break;
      }
      case 'browsePalette': {
        const list = this.busk?.palettes() ?? [];
        if (!list.length || !this.setPaletteOverride) break;
        const at = s.paletteOverrideId ? list.indexOf(s.paletteOverrideId) : -1;
        this.setPaletteOverride(list[at < 0 ? (delta > 0 ? 0 : list.length - 1) : wrapIndex(at + delta, list.length)]);
        break;
      }
      case 'adjustFadeTime':
        this._fadeMs = clamp(this._fadeMs + delta * FADE_STEP_MS, 0, FADE_MAX_MS);
        break;
      case 'adjustStrobeRate': {
        const busk = this.busk;
        if (busk) busk.setStrobeRate(clamp(Math.round(busk.strobeRate() + delta), 1, busk.strobeMaxRate));
        break;
      }
      case 'adjustAutoSync':
        // 5 ms a detent. One encoder click of 1 ms would be unusable — you
        // cannot hear a millisecond — and a whole beat per click would overshoot
        // the error every time. Five is small enough to creep up on the right
        // answer and large enough to get there within a song.
        this.apply({
          autoSyncOffsetMs: clamp(
            Math.round((s.autoSyncOffsetMs ?? 0) + delta * SYNC_NUDGE_MS),
            -SYNC_OFFSET_LIMIT_MS, SYNC_OFFSET_LIMIT_MS,
          ),
        });
        break;
    }
  }

  /** `raw` is the 0-127 the controller sent; each action scales it itself. */
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
        // Deliberately does NOT enable the override: scaling a fixture down is
        // not the same as taking it out of the pattern engine.
        if (s.fixtures.some((fixture) => fixture.id === binding.fixture)) this._emitFixMax(binding.fixture as number, level);
        break;
      case 'setAutoIntensity':
        this.apply({ autoIntensity: Math.round((raw / 127) * 100) });
        break;
      case 'setAutoSync':
        // A fader spans the whole range, so centre detent (64) is zero offset.
        this.apply({
          autoSyncOffsetMs: Math.round(((raw - 63.5) / 63.5) * SYNC_OFFSET_LIMIT_MS),
        });
        break;
    }
  }

  // Override callback — set externally to wire into engine
  overrideFixture: ((id: number, override: Partial<Override> | null) => void) | null = null;

  // Brightness-trim callback — likewise. Separate from overrideFixture because
  // the trim is not part of the override.
  setFixtureMax: ((id: number, value: number) => void) | null = null;

  _emitFixOverride(id: number, override: Partial<Override> | null): void {
    if (this.overrideFixture) this.overrideFixture(id, override);
  }

  _emitFixMax(id: number, value: number): void {
    if (this.setFixtureMax) this.setFixtureMax(id, value);
  }

  // ── Feedback to the controller ───────────────────────────────────────────

  /**
   * Push the live state back to the controller: button LEDs, and the position
   * of every continuous control.
   *
   * The second half is what makes a motorised surface worth having. The X-Touch
   * Compact's nine faders are motorised and its eight encoders have LED rings,
   * and both are driven the same way — send the controller the CC it would have
   * sent you, and it moves. Without this the surface only ever *pushed* state:
   * change the master dimmer in the browser and the physical fader stayed where
   * it was, so the next touch snapped the rig back to a stale value.
   */
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
        case 'togglePaletteOverride': lit = !!binding.value && s.paletteOverrideId === String(binding.value); break;
        // Lit while there is something for it to do.
        case 'clearPaletteOverride': lit = !!s.paletteOverride; break;
        case 'toggleAutoShow':   lit = !!this.busk?.autoShowOn(); break;
        case 'toggleBlackout':   lit = !!s.masterBlackout; break;
        // Lit while the clock follows the music, as Play is while it runs.
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

  /**
   * The 0-127 position of whatever a CC binding controls, or null when the
   * action has no position to show (a trigger, an unknown action).
   *
   * Relative encoders get one too: the value does not move the encoder, but on
   * a surface with LED rings it lights the ring to match, which is the same
   * information the fader gives you by being somewhere.
   */
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
        // The inverse of the fader mapping in _dispatchAbsolute: 20-300 BPM.
        return to127(s.bpm - 20, 280);
      case 'setFixtureDim':
      case 'adjustFixtureDim': {
        const fix = s.fixtures.find((fixture) => fixture.id === binding.fixture);
        if (!fix) return null;
        // No override means the pattern engine owns the fixture and it is at
        // full — which is where the fader should sit, ready to pull it down.
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
      case 'browsePattern':
      case 'browseEffect': {
        const list = this._lookList(binding.action === 'browsePattern' ? 'pattern' : 'effect');
        const at = list.indexOf(s.pattern);
        return at < 0 ? null : to127(at, Math.max(1, list.length - 1));
      }
      case 'browseColor': {
        const slot = slotOf(binding.value);
        return slot ? to127(s[slot], COLOR_PRESETS.length - 1) : null;
      }
      case 'browseBeatDivision':
        return to127(Math.max(0, DIVISIONS.indexOf(s.beatDivision)), DIVISIONS.length - 1);
      case 'browseBarsPattern': {
        const list = this._barsList();
        return to127(Math.max(0, list.indexOf(s.pixelPattern)), Math.max(1, list.length - 1));
      }
      case 'browsePalette': {
        const list = this.busk?.palettes() ?? [];
        const at = s.paletteOverrideId ? list.indexOf(s.paletteOverrideId) : -1;
        return at < 0 ? null : to127(at, Math.max(1, list.length - 1));
      }
      case 'adjustFadeTime':
        return to127(this._fadeMs, FADE_MAX_MS);
      case 'adjustStrobeRate':
        return this.busk ? to127(this.busk.strobeRate() - 1, Math.max(1, this.busk.strobeMaxRate - 1)) : null;
      default:
        return null;
    }
  }

  /**
   * Move every mapped continuous control to where the show actually is.
   *
   * Two guards, both about not fighting the operator or the hardware:
   * a control that sent us something in the last moment is being touched, so it
   * is left alone; and a value we already sent is not sent again, because a
   * motor re-driven to its current position at the broadcast rate hums.
   */
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
      const encoder = ENCODER_ACTIONS.has(binding.action) ? `${binding.channel || 0}:${number}` : null;
      // A ring moved off its end stays there until the encoder says what it is.
      if (encoder !== null && now - (this._probes.get(encoder) ?? -Infinity) < PROBE_HOLD_MS) continue;
      // An encoder sending its position counts on from where it was turned to,
      // which is not always where the ring was sent: send it again, so the
      // ring shows the show and the encoder counts from there.
      const drifted = encoder !== null && this._encoderMode(encoder, binding) === 'position'
        && this._positions.get(encoder) !== value;
      if (this._lastCcOut.get(number) === value && !drifted) continue;

      this._lastCcOut.set(number, value);
      if (encoder !== null) this._positions.set(encoder, value);
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

  // The pad is captured at note-on, so the note-off releases that pad even
  // after the map changed; a held note's repeat never presses it again. A
  // once fires and a loop toggles on the note-on alone; only a hold is kept,
  // by a renewal that never relaunches, until the note-off, the ceiling, the
  // hold ending (an off, a stop-all) or the input port going away.
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
      // Let go already: a tick still in flight renews nothing.
      if (this._heldPads.get(key) !== held) return;
      ticks++;
      const renewed = ticks * PAD_RENEW_MS < maxMs && !this._portGone() && !!this.pads?.renew(pad.bank, pad.slot, pad.owner, pad.token);
      if (!renewed) this._releasePad(channel, note);
    }), PAD_RENEW_MS);
    held.renew.unref?.();
  }

  /** Whether the open input port has left the port list (a controller unplugged), read fresh. */
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
    // Forget what we sent: the next connection has to push the full state so
    // the faders fly to where the show is rather than staying where they lay.
    this._lastCcOut.clear();
    this._lastCcIn.clear();
    this._touchDown.clear();
    this._positions.clear();
    this._encModes.clear();
    this._probes.clear();
    if (this.input)  { try { this.input.close();  } catch (_) {} }
    if (this.output) { try { this.output.close(); } catch (_) {} }
    this.enabled = false;
    this._inputName = null;
    this._cachedPorts = null;
  }
}

/**
 * Open an output port by name, for sending something other than control
 * feedback (the MIDI clock). Null when MIDI is unavailable or the port is not
 * there.
 */
function openMidiOutput(name: string): MidiOutput | null {
  if (!easymidi || !name) return null;
  if (!easymidi.getOutputs().includes(name)) return null;
  return new easymidi.Output(name);
}

export { openMidiOutput };
export default MidiController;