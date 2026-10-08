import fs from 'node:fs';
import { z } from 'zod';
import { HttpError, codeOf, messageOf } from '../errors.ts';
import { configFile } from './config-dir.ts';
import { JsonStore } from './json-store.ts';

/** Something a MIDI control can be bound to. */
export interface MidiAction {
  id: string;
  label: string;
  input: 'button' | 'encoder' | 'fader';
  /** What the binding has to say besides the action: a fixture, a value. */
  param?: { key: 'value' | 'fixture'; kind: string; label: string; optional?: boolean };
}

/**
 * The MIDI control map: which message does what.
 *
 * This used to be a hardcoded constant describing one controller — a Behringer
 * X-Touch Compact in Standard mode, Layer A. Anything else was unusable without
 * editing source, which is a strange thing to ask of the person holding the
 * controller. The X-Touch layout is still the default, but it is now just the
 * starting point: bindings are stored in config/midi-map.json and can be
 * relearned from the Settings view by pressing the control you want.
 *
 * Shape:
 *   {
 *     cc:    { "<controller>": binding },   // encoders and faders
 *     notes: { "<note>":       binding },   // buttons and encoder pushes
 *   }
 *
 * A binding is `{ action, type?, scale?, value?, fixture?, channel? }`:
 *   type    'relative' (encoder, 1-63 = CW / 65-127 = CCW) or 'absolute'
 *           (fader, 0-127 scaled to 0-255; on an encoder action, an encoder
 *           that sends its position, each change a step). For an encoder it
 *           is only the guess until the encoder shows which (see midi.ts).
 *           CC bindings only.
 *   scale   step multiplier for encoders.
 *   value   what the action sets: a pattern id, colour index, cue id…
 *   fixture which fixture the action applies to, by its stable id.
 *   channel restrict to one MIDI channel (0-15). Absent matches any, which is
 *           what a single-layer controller wants; a controller whose second
 *           layer repeats the same note numbers on another channel needs it.
 */

// ── Action catalogue ────────────────────────────────────────────────────────
// What a binding may do, with enough metadata for the Settings view to render
// a picker: which kind of control suits it, and what (if anything) it needs to
// be told. `param.kind` tells the UI which list to offer.

const ACTIONS: MidiAction[] = [
  // Buttons
  { id: 'tap',                 label: 'Tap tempo',                   input: 'button' },
  { id: 'toggleTempoMode',     label: 'Automatic tempo match on / off', input: 'button' },
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
  { id: 'padPress',            label: 'Pad (held while the note is)', input: 'button' },
  { id: 'cycleStrobeFunction', label: 'Cycle strobe function',       input: 'button' },
  { id: 'toggleFixBlackout',   label: 'Fixture blackout',            input: 'button', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'recallCue',           label: 'Recall cue',                  input: 'button', param: { key: 'value', kind: 'cue', label: 'Cue' } },
  { id: 'setPalette',          label: 'Select palette',              input: 'button', param: { key: 'value', kind: 'palette', label: 'Palette' } },
  { id: 'togglePaletteOverride', label: 'Palette override on / off',  input: 'button', param: { key: 'value', kind: 'overridePalette', label: 'Palette' } },
  // Busking: playing a show by hand with the auto show stopped.
  { id: 'randomLook',          label: 'Random pattern or effect',    input: 'button', param: { key: 'value', kind: 'lookKind', label: 'Of' } },
  { id: 'randomColor',         label: 'Random colour',               input: 'button', param: { key: 'value', kind: 'colorSlot', label: 'Slot' } },
  { id: 'clearPaletteOverride', label: 'Palette override off',       input: 'button' },
  { id: 'scaleBpm',            label: 'Double / halve BPM',          input: 'button', param: { key: 'value', kind: 'bpmFactor', label: 'By' } },
  { id: 'stopEffects',         label: 'Stop every effect',           input: 'button' },
  { id: 'strobeBurst',         label: 'Strobe burst',                input: 'button', param: { key: 'value', kind: 'burstMs', label: 'Length', optional: true } },
  { id: 'toggleAutoShow',      label: 'Auto show on / off',          input: 'button' },

  // Encoders (relative, or sending their position)
  { id: 'adjustBpm',           label: 'Nudge BPM',                   input: 'encoder' },
  { id: 'adjustMasterDimmer',  label: 'Nudge master dimmer',         input: 'encoder' },
  { id: 'adjustStrobeSpeed',   label: 'Nudge strobe speed',          input: 'encoder' },
  { id: 'adjustFixtureDim',    label: 'Nudge fixture dimmer',        input: 'encoder', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'adjustFixtureMax',    label: 'Nudge fixture max brightness', input: 'encoder', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'adjustAutoIntensity', label: 'Nudge auto-show intensity',   input: 'encoder' },
  { id: 'adjustAutoSync',      label: 'Nudge light/music sync',       input: 'encoder' },
  { id: 'browsePattern',       label: 'Browse patterns',             input: 'encoder' },
  { id: 'browseEffect',        label: 'Browse effects',              input: 'encoder' },
  { id: 'browseColor',         label: 'Browse colours',              input: 'encoder', param: { key: 'value', kind: 'colorSlot', label: 'Slot' } },
  { id: 'browseBeatDivision',  label: 'Browse beat division',        input: 'encoder' },
  { id: 'browseBarsPattern',   label: 'Browse the bars\' picture',   input: 'encoder' },
  { id: 'browsePalette',       label: 'Browse palette override',     input: 'encoder' },
  { id: 'adjustFadeTime',      label: 'Fade time of look changes',   input: 'encoder' },
  { id: 'adjustStrobeRate',    label: 'Nudge strobe flashes per second', input: 'encoder' },

  // Faders (absolute)
  { id: 'setMasterDimmer',     label: 'Master dimmer',               input: 'fader' },
  { id: 'setStrobeSpeed',      label: 'Strobe speed',                input: 'fader' },
  { id: 'setBpm',              label: 'BPM',                         input: 'fader' },
  { id: 'setFixtureDim',       label: 'Fixture dimmer',              input: 'fader', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'setFixtureMax',       label: 'Fixture max brightness',      input: 'fader', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'setAutoIntensity',    label: 'Auto-show intensity',         input: 'fader' },
  { id: 'setAutoSync',         label: 'Light/music sync offset',     input: 'fader' },
];

const ACTION_IDS = ACTIONS.map((a) => a.id);
const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/** The control type an action expects, for defaulting a learned CC binding. */
function defaultTypeFor(actionId: string): 'relative' | 'absolute' {
  const action = ACTION_BY_ID.get(actionId);
  if (!action) return 'absolute';
  return action.input === 'encoder' ? 'relative' : 'absolute';
}

// ── Schema ──────────────────────────────────────────────────────────────────

const bindingSchema = z.object({
  // A custom message because the default lists every id, which is
  // unreadable in the toast this reaches the operator through.
  action: z.enum(ACTION_IDS as [string, ...string[]], { error: 'is not a known action' }),
  type: z.enum(['relative', 'absolute']).optional(),
  scale: z.number().min(0.01).max(64).optional(),
  // Loose on purpose: a value is a pattern id, a colour index, a cue id or a
  // beat division depending on the action, and the dispatcher already no-ops on
  // anything it does not recognise.
  value: z.union([z.string().max(64), z.number()]).optional(),
  fixture: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional(),
  channel: z.number().int().min(0).max(15).optional(),
  // padPress only: which pad, bank 0-1 and slot 0-7 as the deck numbers them.
  bank: z.number().int().min(0).max(1).optional(),
  slot: z.number().int().min(0).max(7).optional(),
}).strict().superRefine((b, ctx) => {
  if (b.action === 'padPress' && (b.bank === undefined || b.slot === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['bank'], message: 'a pad binding names its bank and slot' });
  }
});

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
//   Encoders EN1-8 turn : CC 10-17, ch 1 (out of the box, the position 0-127,
//                         which the binding's 'absolute' turns into steps.
//                         Set to relative in the X-TOUCH Editor, the encoding
//                         is worked out from the values instead; see midi.ts
//                         relEvidence.)
//   Encoders EN1-8 push : Note 0-7,  ch 1
//   Button row 1 (BT1-8)  : Note 16-23, ch 1
//   Button row 2 (BT9-16) : Note 24-31, ch 1
//   Faders FD1-9 : CC 1-9, ch 1 (absolute 0-127)

/** One control's binding. */
export type MidiBinding = z.output<typeof bindingSchema>;

/** Every binding, by control change and by note number. */
export type MidiMap = z.output<typeof mapSchema>;

type MidiListener = (map: MidiMap) => void;

const DEFAULT_MAP: MidiMap = {
  cc: {
    // Encoders EN1-EN8 turn: CC10-CC17. Out of the box each sends its
    // position, so 'absolute': every change in it is a step (see midi.ts).
    10: { action: 'adjustBpm',          type: 'absolute', scale: 1 },
    11: { action: 'adjustMasterDimmer', type: 'absolute', scale: 4 },
    // EN3-EN6 and FD1-FD4 trim fixtures 1-4 rather than dim them: a dimmer
    // takes the fixture out of the show into its override, and the show is
    // mostly running by itself. A trim scales whatever drives the fixture.
    12: { action: 'adjustFixtureMax',   type: 'absolute', scale: 4, fixture: 0 },
    13: { action: 'adjustFixtureMax',   type: 'absolute', scale: 4, fixture: 1 },
    14: { action: 'adjustFixtureMax',   type: 'absolute', scale: 4, fixture: 2 },
    15: { action: 'adjustFixtureMax',   type: 'absolute', scale: 4, fixture: 3 },
    16: { action: 'adjustStrobeSpeed',  type: 'absolute', scale: 4 },
    // Absolute faders FD1-FD9: CC1-CC9 (0-127 → 0-255)
    1: { action: 'setFixtureMax', type: 'absolute', fixture: 0 },
    2: { action: 'setFixtureMax', type: 'absolute', fixture: 1 },
    3: { action: 'setFixtureMax', type: 'absolute', fixture: 2 },
    4: { action: 'setFixtureMax', type: 'absolute', fixture: 3 },
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
    // Not play/stop: stopped, the rig holds its last frame while the auto show
    // plays on unseen. This picks the energy effect EN8's push fires instead.
    2: { action: 'cycleEnergyEffect' },
    3: { action: 'toggleFixBlackout', fixture: 0 },
    4: { action: 'toggleFixBlackout', fixture: 1 },
    5: { action: 'toggleFixBlackout', fixture: 2 },
    6: { action: 'toggleFixBlackout', fixture: 3 },
    7: { action: 'energyHold' },
    // Button rows 1 and 2 (BT1-16, notes 16-31): palettes over the show, each
    // on until pressed again. Patterns and colour slots picked by hand last
    // only to the auto show's next scene; the override is never the show's.
    // Row 1, two colours
    16: { action: 'togglePaletteOverride', value: 'redCyan'         },
    17: { action: 'togglePaletteOverride', value: 'orangeBlue'      },
    18: { action: 'togglePaletteOverride', value: 'yellowPurple'    },
    19: { action: 'togglePaletteOverride', value: 'greenPink'       },
    20: { action: 'togglePaletteOverride', value: 'redYellow'       },
    21: { action: 'togglePaletteOverride', value: 'greenBlue'       },
    22: { action: 'togglePaletteOverride', value: 'rocketPop'       },
    23: { action: 'togglePaletteOverride', value: 'hdDefault'       },
    // Row 2, three and more
    24: { action: 'togglePaletteOverride', value: 'redOrangeYellow' },
    25: { action: 'togglePaletteOverride', value: 'greenCyanBlue'   },
    26: { action: 'togglePaletteOverride', value: 'cyanBluePurple'  },
    27: { action: 'togglePaletteOverride', value: 'bluePurplePink'  },
    28: { action: 'togglePaletteOverride', value: 'purplePinkRed'   },
    29: { action: 'togglePaletteOverride', value: 'blueDream'       },
    30: { action: 'togglePaletteOverride', value: 'electricSummer'  },
    31: { action: 'togglePaletteOverride', value: 'rainbow'         },
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class MidiMapStore extends JsonStore {
  declare _map: MidiMap;
  declare _customised: boolean;
  declare _listeners: MidiListener[];

  /**
   * midi-map.json. No file is normal — it only exists once the operator has
   * changed something, and until then the X-Touch default stands. A corrupt
   * one is moved aside (JsonStore) and the default used, so a bad hand-edit
   * costs you your mapping and not your show.
   */
  constructor(file: string) {
    super(file, { tag: 'midi', fallback: 'using the default map' });
    this._map = clone(DEFAULT_MAP);
    this._customised = false;
    this._listeners = [];
  }

  load(): this {
    const saved = this.readValid(mapSchema);
    if (saved) {
      this._map = saved;
      this._customised = true;
    }
    return this;
  }

  useDefaults(): void {
    this._map = clone(DEFAULT_MAP);
    this._customised = false;
  }

  save(): void {
    this.writeJson(this._map);
    this._customised = true;
  }

  /** The live map. Callers must not mutate it — use setBinding/replace. */
  get(): MidiMap { return this._map; }

  /** A copy, for handing to a client. */
  snapshot(): { map: MidiMap; customised: boolean } {
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
  setBinding(kind: 'cc' | 'notes', number: number, binding: unknown): MidiMap {
    const key = String(number);
    if (binding === null) {
      delete this._map[kind][key];
    } else {
      const parsed = bindingSchema.parse(binding);
      for (const side of ['cc', 'notes'] as const) {
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
  replace(map: unknown): MidiMap {
    this._map = mapSchema.parse(map);
    this._persist();
    return this._map;
  }

  /** Back to the built-in X-Touch layout, and forget the stored file. */
  reset(): MidiMap {
    this._map = clone(DEFAULT_MAP);
    try {
      fs.unlinkSync(this.file);
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') console.warn(`[midi] could not remove ${this.file}: ${messageOf(err)}`);
    }
    this._customised = false;
    this._notify();
    return this._map;
  }

  /** Called with the new map after every change. */
  onChange(fn: MidiListener): void { this._listeners.push(fn); }

  _notify(): void {
    for (const fn of this._listeners) {
      try { fn(this._map); } catch (err) { console.warn(`[midi] map listener: ${messageOf(err)}`); }
    }
  }

  _persist(): void {
    try {
      this.save();
    } catch (err) {
      console.warn(`[midi] could not save ${this.file}: ${messageOf(err)}`);
      throw new HttpError(500, `Could not save the MIDI map: ${messageOf(err)}`);
    }
    this._notify();
  }
}

/** Two bindings that drive the same thing, so relearning moves rather than duplicates. */
function sameControl(a: MidiBinding, b: MidiBinding): boolean {
  return a.action === b.action
    && (a.fixture ?? null) === (b.fixture ?? null)
    && (a.value ?? null) === (b.value ?? null)
    && (a.bank ?? null) === (b.bank ?? null)
    && (a.slot ?? null) === (b.slot ?? null);
}

// Fixed location, for the same reason settings.json is: it is how you find the
// map, not itself a setting. Tests construct their own store.
const MIDI_MAP_FILE = configFile('midi-map.json');
const midiMap = new MidiMapStore(MIDI_MAP_FILE).load();

export {
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
