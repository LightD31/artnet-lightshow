import fs from 'node:fs';
import { z } from 'zod';
import { HttpError, codeOf, messageOf } from '../errors.ts';
import { configFile } from './config-dir.ts';
import { JsonStore } from './json-store.ts';

export interface MidiAction {
  id: string;
  label: string;
  input: 'button' | 'encoder' | 'fader';
  param?: { key: 'value' | 'fixture'; kind: string; label: string; optional?: boolean };
}

const ACTIONS: MidiAction[] = [
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

  { id: 'adjustBpm',           label: 'Nudge BPM',                   input: 'encoder' },
  { id: 'adjustMasterDimmer',  label: 'Nudge master dimmer',         input: 'encoder' },
  { id: 'adjustStrobeSpeed',   label: 'Nudge strobe speed',          input: 'encoder' },
  { id: 'adjustFixtureDim',    label: 'Nudge fixture dimmer',        input: 'encoder', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'adjustFixtureMax',    label: 'Nudge fixture max brightness', input: 'encoder', param: { key: 'fixture', kind: 'fixture', label: 'Fixture' } },
  { id: 'adjustAutoIntensity', label: 'Nudge auto-show intensity',   input: 'encoder' },
  { id: 'adjustAutoSync',      label: 'Nudge light/music sync',       input: 'encoder' },

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

function defaultTypeFor(actionId: string): 'relative' | 'absolute' {
  const action = ACTION_BY_ID.get(actionId);
  if (!action) return 'absolute';
  return action.input === 'encoder' ? 'relative' : 'absolute';
}

const bindingSchema = z.object({
  action: z.enum(ACTION_IDS as [string, ...string[]], { error: 'is not a known action' }),
  type: z.enum(['relative', 'absolute']).optional(),
  scale: z.number().min(0.01).max(64).optional(),
  value: z.union([z.string().max(64), z.number()]).optional(),
  fixture: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional(),
  channel: z.number().int().min(0).max(15).optional(),
  bank: z.number().int().min(0).max(1).optional(),
  slot: z.number().int().min(0).max(7).optional(),
}).strict().superRefine((b, ctx) => {
  if (b.action === 'padPress' && (b.bank === undefined || b.slot === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['bank'], message: 'a pad binding names its bank and slot' });
  }
});

const byNumber = z.record(z.string().regex(/^(?:1[01][0-9]|12[0-7]|[0-9]{1,2})$/), bindingSchema);

const mapSchema = z.object({
  cc: byNumber,
  notes: byNumber,
}).strict();

const learnSchema = bindingSchema;

const bindingWriteSchema = z.object({
  kind: z.enum(['cc', 'notes']),
  number: z.number().int().min(0).max(127),
  binding: bindingSchema.nullable(),
}).strict();

export type MidiBinding = z.output<typeof bindingSchema>;

export type MidiMap = z.output<typeof mapSchema>;

type MidiListener = (map: MidiMap) => void;

const DEFAULT_MAP: MidiMap = {
  cc: {
    10: { action: 'adjustBpm',          type: 'relative', scale: 1 },
    11: { action: 'adjustMasterDimmer', type: 'relative', scale: 4 },
    12: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 0 },
    13: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 1 },
    14: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 2 },
    15: { action: 'adjustFixtureDim',   type: 'relative', scale: 4, fixture: 3 },
    16: { action: 'adjustStrobeSpeed',  type: 'relative', scale: 4 },
    1: { action: 'setFixtureDim', type: 'absolute', fixture: 0 },
    2: { action: 'setFixtureDim', type: 'absolute', fixture: 1 },
    3: { action: 'setFixtureDim', type: 'absolute', fixture: 2 },
    4: { action: 'setFixtureDim', type: 'absolute', fixture: 3 },
    8: { action: 'setAutoIntensity', type: 'absolute' },
    9: { action: 'setMasterDimmer', type: 'absolute' },
  },
  notes: {
    0: { action: 'tap' },
    1: { action: 'toggleBlackout' },
    2: { action: 'togglePlay' },
    3: { action: 'toggleFixBlackout', fixture: 0 },
    4: { action: 'toggleFixBlackout', fixture: 1 },
    5: { action: 'toggleFixBlackout', fixture: 2 },
    6: { action: 'toggleFixBlackout', fixture: 3 },
    7: { action: 'energyHold' },
    16: { action: 'setPattern', value: 'solid'       },
    17: { action: 'setPattern', value: 'chase'       },
    18: { action: 'setPattern', value: 'chase-rev'   },
    19: { action: 'setPattern', value: 'ping-pong'   },
    20: { action: 'setPattern', value: 'strobe'      },
    21: { action: 'setPattern', value: 'fade'        },
    22: { action: 'setPattern', value: 'color-cycle' },
    23: { action: 'setPattern', value: 'rainbow'     },
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class MidiMapStore extends JsonStore {
  declare _map: MidiMap;
  declare _customised: boolean;
  declare _listeners: MidiListener[];

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

  get(): MidiMap { return this._map; }

  snapshot(): { map: MidiMap; customised: boolean } {
    return { map: clone(this._map), customised: this._customised };
  }

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

  replace(map: unknown): MidiMap {
    this._map = mapSchema.parse(map);
    this._persist();
    return this._map;
  }

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

function sameControl(a: MidiBinding, b: MidiBinding): boolean {
  return a.action === b.action
    && (a.fixture ?? null) === (b.fixture ?? null)
    && (a.value ?? null) === (b.value ?? null)
    && (a.bank ?? null) === (b.bank ?? null)
    && (a.slot ?? null) === (b.slot ?? null);
}

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
