'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

/**
 * The MIDI control map: which message does what.
 *
 * This used to be a hardcoded constant describing one controller — a Behringer
 * X-Touch Compact in Standard mode, Layer A. Anything else was unusable without
 * editing source, which is a strange thing to ask of the person holding the
 * controller. The X-Touch layout is still the default, but it is now just the
 * starting point: bindings are stored in config/midi-map.json and can be
 * relearned from the settings page by pressing the control you want.
 *
 * Shape:
 *   {
 *     cc:    { "<controller>": binding },   // encoders and faders
 *     notes: { "<note>":       binding },   // buttons and encoder pushes
 *   }
 *
 * A binding is `{ action, type?, scale?, value?, fixture?, channel? }`:
 *   type    'relative' (encoder, 1-63 = CW / 65-127 = CCW) or 'absolute'
 *           (fader, 0-127 scaled to 0-255). CC bindings only.
 *   scale   step multiplier for relative encoders.
 *   value   what the action sets: a pattern id, colour index, cue id…
 *   fixture which fixture the action applies to, by index.
 *   channel restrict to one MIDI channel (0-15). Absent matches any, which is
 *           what a single-layer controller wants; a controller whose second
 *           layer repeats the same note numbers on another channel needs it.
 */

// ── Action catalogue ────────────────────────────────────────────────────────
// What a binding may do, with enough metadata for the settings page to render
// a picker: which kind of control suits it, and what (if anything) it needs to
// be told. `param.kind` tells the UI which list to offer.

const ACTIONS = [
  // Buttons
  { id: 'tap',                 label: 'Tap tempo',                   input: 'button' },
  { id: 'togglePlay',          label: 'Play / stop',                 input: 'button' },
  { id: 'toggleBlackout',      label: 'Master blackout',             input: 'button' },
  { id: 'setPattern',          label: 'Select pattern',              input: 'button', param: { key: 'value', kind: 'pattern', label: 'Pattern' } },
  { id: 'setColorA',           label: 'Set colour slot A',           input: 'button', param: { key: 'value', kind: 'color', label: 'Colour' } },
  { id: 'setColorB',           label: 'Set colour slot B',           input: 'button', param: { key: 'value', kind: 'color', label: 'Colour' } },
  { id: 'setColorC',           label: 'Set colour slot C',           input: 'button', param: { key: 'value', kind: 'color', label: 'Colour' } },
  { id: 'setColorD',           label: 'Set colour slot D',           input: 'button', param: { key: 'value', kind: 'color', label: 'Colour' } },
  { id: 'setBeatDivision',     label: 'Set beat division',           input: 'button', param: { key: 'value', kind: 'division', label: 'Division' } },
  { id: 'energyHold',          label: 'Energy override (hold)',      input: 'button', param: { key: 'value', kind: 'energy', label: 'Effect', optional: true } },
  { id: 'cycleEnergyEffect',   label: 'Cycle the held energy effect', input: 'button' },
  { id: 'cycleStrobeFunction', label: 'Cycle strobe function',       input: 'button' },
  { id: 'toggleFixBlackout',   label: 'Fixture blackout',            input: 'button', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'recallCue',           label: 'Recall cue',                  input: 'button', param: { key: 'value', kind: 'cue', label: 'Cue' } },
  { id: 'setPalette',          label: 'Select palette',              input: 'button', param: { key: 'value', kind: 'palette', label: 'Palette' } },

  // Encoders (relative)
  { id: 'adjustBpm',           label: 'Nudge BPM',                   input: 'encoder' },
  { id: 'adjustMasterDimmer',  label: 'Nudge master dimmer',         input: 'encoder' },
  { id: 'adjustStrobeSpeed',   label: 'Nudge strobe speed',          input: 'encoder' },
  { id: 'adjustFixtureDim',    label: 'Nudge fixture dimmer',        input: 'encoder', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'adjustFixtureMax',    label: 'Nudge fixture max brightness', input: 'encoder', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'adjustAutoIntensity', label: 'Nudge auto-show intensity',   input: 'encoder' },

  // Faders (absolute)
  { id: 'setMasterDimmer',     label: 'Master dimmer',               input: 'fader' },
  { id: 'setStrobeSpeed',      label: 'Strobe speed',                input: 'fader' },
  { id: 'setBpm',              label: 'BPM',                         input: 'fader' },
  { id: 'setFixtureDim',       label: 'Fixture dimmer',              input: 'fader', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'setFixtureMax',       label: 'Fixture max brightness',      input: 'fader', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'setAutoIntensity',    label: 'Auto-show intensity',         input: 'fader' },
];

const ACTION_IDS = ACTIONS.map((a) => a.id);
const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/** The control type an action expects, for defaulting a learned CC binding. */
function defaultTypeFor(actionId) {
  const action = ACTION_BY_ID.get(actionId);
  if (!action) return 'absolute';
  return action.input === 'encoder' ? 'relative' : 'absolute';
}

// ── Schema ──────────────────────────────────────────────────────────────────

const bindingSchema = z.object({
  // A custom message because the default lists all twenty-two ids, which is
  // unreadable in the toast this reaches the operator through.
  action: z.enum(ACTION_IDS, { errorMap: () => ({ message: 'is not a known action' }) }),
  type: z.enum(['relative', 'absolute']).optional(),
  scale: z.number().min(0.01).max(64).optional(),
  // Loose on purpose: a value is a pattern id, a colour index, a cue id or a
  // beat division depending on the action, and the dispatcher already no-ops on
  // anything it does not recognise.
  value: z.union([z.string().max(64), z.number()]).optional(),
  fixture: z.number().int().min(0).max(63).optional(),
  channel: z.number().int().min(0).max(15).optional(),
}).strict();

// Keys are the MIDI controller/note number as a string, since that is what a
// JSON object gives us back.
const byNumber = z.record(z.string().regex(/^(?:1[01][0-9]|12[0-7]|[0-9]{1,2})$/), bindingSchema);

const mapSchema = z.object({
  cc: byNumber,
  notes: byNumber,
}).strict();

/** POST /api/midi/learn: the binding to attach to whatever arrives next. */
const learnSchema = bindingSchema;

/** One binding being written or cleared by hand. */
const bindingWriteSchema = z.object({
  kind: z.enum(['cc', 'notes']),
  number: z.number().int().min(0).max(127),
  // Nullable rather than a union with null: a union reports "invalid input"
  // and swallows which field of the binding was actually wrong.
  binding: bindingSchema.nullable(),
}).strict();

// ── The built-in default: Behringer X-Touch Compact, Standard mode, Layer A ──
//
//   Encoders EN1-8 turn : CC 10-17, ch 1 (relative: 1-63=CW, 65-127=CCW)
//   Encoders EN1-8 push : Note 0-7,  ch 1
//   Button row 1 (BT1-8)  : Note 16-23, ch 1
//   Button row 2 (BT9-16) : Note 24-31, ch 1
//   Faders FD1-9 : CC 1-9, ch 1 (absolute 0-127)

const DEFAULT_MAP = {
  cc: {
    // Relative encoders EN1-EN8 turn: CC10-CC17
    10: { action: 'adjustBpm',          type: 'relative', scale: 1 },
    11: { action: 'adjustMasterDimmer', type: 'relative', scale: 4 },
    12: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 0 },
    13: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 1 },
    14: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 2 },
    15: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 3 },
    16: { action: 'adjustStrobeSpeed',  type: 'relative', scale: 4 },
    // Absolute faders FD1-FD9: CC1-CC9 (0-127 → 0-255)
    1: { action: 'setFixtureDim', type: 'absolute', fixture: 0 },
    2: { action: 'setFixtureDim', type: 'absolute', fixture: 1 },
    3: { action: 'setFixtureDim', type: 'absolute', fixture: 2 },
    4: { action: 'setFixtureDim', type: 'absolute', fixture: 3 },
    // FD8 sits next to the master on the X-Touch, which is where the auto
    // show's energy slider belongs: the two faders you reach for are "how
    // bright" and "how hard".
    8: { action: 'setAutoIntensity', type: 'absolute' },
    9: { action: 'setMasterDimmer', type: 'absolute' },
  },
  notes: {
    // Encoder push buttons EN1-EN8: notes 0-7
    0: { action: 'tap' },
    1: { action: 'toggleBlackout' },
    2: { action: 'togglePlay' },
    3: { action: 'toggleFixBlackout', fixture: 0 },
    4: { action: 'toggleFixBlackout', fixture: 1 },
    5: { action: 'toggleFixBlackout', fixture: 2 },
    6: { action: 'toggleFixBlackout', fixture: 3 },
    7: { action: 'energyHold' },
    // Button row 1 (BT1-8, notes 16-23): 8 patterns
    16: { action: 'setPattern', value: 'solid'       },
    17: { action: 'setPattern', value: 'chase'       },
    18: { action: 'setPattern', value: 'chase-rev'   },
    19: { action: 'setPattern', value: 'ping-pong'   },
    20: { action: 'setPattern', value: 'strobe'      },
    21: { action: 'setPattern', value: 'fade'        },
    22: { action: 'setPattern', value: 'color-cycle' },
    23: { action: 'setPattern', value: 'rainbow'     },
    // Button row 2 (BT9-16, notes 24-31): 2 patterns + 6 colour presets
    24: { action: 'setPattern', value: 'twinkle'     },
    25: { action: 'setPattern', value: 'split'       },
    26: { action: 'setColorA', value: 0 },
    27: { action: 'setColorA', value: 1 },
    28: { action: 'setColorA', value: 2 },
    29: { action: 'setColorA', value: 3 },
    30: { action: 'setColorA', value: 4 },
    31: { action: 'setColorA', value: 5 },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class MidiMapStore {
  constructor(file) {
    this.file = file;
    this._map = clone(DEFAULT_MAP);
    this._customised = false;
    this._listeners = [];
  }

  /**
   * Read midi-map.json. A missing file is normal — it only exists once the
   * operator has changed something, and until then the X-Touch default stands.
   * A corrupt one is moved aside rather than deleted, and the default is used,
   * so a bad hand-edit costs you your mapping and not your show.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[midi] cannot read ${this.file}: ${err.message} — using the default map`);
      }
      return this;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this._quarantine(`invalid JSON (${err.message})`);
    }

    const result = mapSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      return this._quarantine(detail);
    }

    this._map = result.data;
    this._customised = true;
    return this;
  }

  _quarantine(reason) {
    const backup = `${this.file}.invalid-${Date.now()}`;
    try {
      fs.renameSync(this.file, backup);
      console.warn(`[midi] ${this.file}: ${reason}`);
      console.warn(`[midi] moved it to ${backup} and fell back to the default map`);
    } catch (err) {
      console.warn(`[midi] ${this.file}: ${reason} (could not move aside: ${err.message})`);
    }
    this._map = clone(DEFAULT_MAP);
    this._customised = false;
    return this;
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this._map, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    this._customised = true;
  }

  /** The live map. Callers must not mutate it — use setBinding/replace. */
  get() { return this._map; }

  /** A copy, for handing to a client. */
  snapshot() {
    return { map: clone(this._map), customised: this._customised };
  }

  /**
   * Bind one message, or clear it with `binding: null`.
   *
   * Binding an action that is already somewhere else *moves* it when it carries
   * the same parameters: relearning "tap tempo" onto a different button should
   * leave one tap button, not two. Bindings that differ by fixture or value are
   * genuinely different controls and are left alone.
   */
  setBinding(kind, number, binding) {
    const key = String(number);
    if (binding === null) {
      delete this._map[kind][key];
    } else {
      const parsed = bindingSchema.parse(binding);
      for (const side of ['cc', 'notes']) {
        for (const [existingKey, existing] of Object.entries(this._map[side])) {
          if (side === kind && existingKey === key) continue;
          if (sameControl(existing, parsed)) delete this._map[side][existingKey];
        }
      }
      this._map[kind][key] = parsed;
    }
    this._persist();
    return this._map;
  }

  /** Replace the whole map — used by an import, or a hand-written file. */
  replace(map) {
    this._map = mapSchema.parse(map);
    this._persist();
    return this._map;
  }

  /** Back to the built-in X-Touch layout, and forget the stored file. */
  reset() {
    this._map = clone(DEFAULT_MAP);
    try {
      fs.unlinkSync(this.file);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[midi] could not remove ${this.file}: ${err.message}`);
    }
    this._customised = false;
    this._notify();
    return this._map;
  }

  /** Called with the new map after every change. */
  onChange(fn) { this._listeners.push(fn); }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(this._map); } catch (err) { console.warn(`[midi] map listener: ${err.message}`); }
    }
  }

  _persist() {
    try {
      this.save();
    } catch (err) {
      console.warn(`[midi] could not save ${this.file}: ${err.message}`);
      const wrapped = new Error(`Could not save the MIDI map: ${err.message}`);
      wrapped.status = 500;
      throw wrapped;
    }
    this._notify();
  }
}

/** Two bindings that drive the same thing, so relearning moves rather than duplicates. */
function sameControl(a, b) {
  return a.action === b.action
    && (a.fixture ?? null) === (b.fixture ?? null)
    && (a.value ?? null) === (b.value ?? null);
}

// Fixed location, for the same reason settings.json is: it is how you find the
// map, not itself a setting. Tests construct their own store.
const MIDI_MAP_FILE = path.join(__dirname, '..', '..', 'config', 'midi-map.json');
const midiMap = new MidiMapStore(MIDI_MAP_FILE).load();

module.exports = {
  midiMap,
  MIDI_MAP_FILE,
  MidiMapStore,
  ACTIONS,
  ACTION_IDS,
  DEFAULT_MAP,
  defaultTypeFor,
  sameControl,
  bindingSchema,
  bindingWriteSchema,
  learnSchema,
  mapSchema,
};
