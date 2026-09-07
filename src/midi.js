'use strict';

/**
 * MIDI handler for Behringer X-Touch Compact
 *
 * X-Touch Compact Standard mode (default) layout — Layer A:
 *   Encoders EN1-8 turn : CC 10-17, ch 1 (relative: 1-63=CW, 65-127=CCW)
 *   Encoders EN1-8 push : Note 0-7,  ch 1
 *   Button row 1 (BT1-8)  : Note 16-23, ch 1
 *   Button row 2 (BT9-16) : Note 24-31, ch 1
 *   Faders FD1-9 : CC 1-9, ch 1 (absolute 0-127)
 *
 * LED feedback is sent back via Note On (velocity = colour):
 *   0 = off, 1 = on (fixture-default), 127 = bright on
 */

let easymidi;
try {
  easymidi = require('easymidi');
} catch (_) {
  console.warn('[MIDI] easymidi not available — run `npm install easymidi` to enable MIDI support.');
}

// ── Default mapping for X-Touch Compact Layer A ───────────────────────────────

const DEFAULT_MAP = {
  // CC → action
  cc: {
    // Relative encoders EN1-EN8 turn: CC10-CC17
    10: { action: 'adjustBpm',          scale: 1,   type: 'relative' },  // EN1: BPM ±1/step
    11: { action: 'adjustMasterDimmer', scale: 4,   type: 'relative' },  // EN2: Master dim
    12: { action: 'adjustFixtureDim',   fixture: 0, scale: 4, type: 'relative' },
    13: { action: 'adjustFixtureDim',   fixture: 1, scale: 4, type: 'relative' },
    14: { action: 'adjustFixtureDim',   fixture: 2, scale: 4, type: 'relative' },
    15: { action: 'adjustFixtureDim',   fixture: 3, scale: 4, type: 'relative' },
    16: { action: 'adjustStrobeSpeed',  scale: 4,   type: 'relative' },  // EN7: Strobe
    // Absolute faders FD1-FD9: CC1-CC9 (0-127 → 0-255)
    1: { action: 'setFixtureDim',  fixture: 0, type: 'absolute' },
    2: { action: 'setFixtureDim',  fixture: 1, type: 'absolute' },
    3: { action: 'setFixtureDim',  fixture: 2, type: 'absolute' },
    4: { action: 'setFixtureDim',  fixture: 3, type: 'absolute' },
    9: { action: 'setMasterDimmer',             type: 'absolute' },  // FD9: Master
  },
  pitchbend: {},  // Faders now send CC — pitch bend unused
  // Note → action  (Note On with velocity > 0 triggers)
  notes: {
    // Encoder push buttons EN1-EN8: notes 0-7
    0: { action: 'tap' },
    1: { action: 'toggleBlackout' },
    2: { action: 'togglePlay' },
    3: { action: 'toggleFixBlackout', fixture: 0 },
    4: { action: 'toggleFixBlackout', fixture: 1 },
    5: { action: 'toggleFixBlackout', fixture: 2 },
    6: { action: 'toggleFixBlackout', fixture: 3 },
    7: { action: 'energyHold' },      // EN8 push: hold for energy override
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

// MIDI note LED groups for feedback (note → LED note on same device)
const LED_PATTERNS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
const LED_COLORS_A = [26, 27, 28, 29, 30, 31];

function relDelta(value) {
  // Relative mode 1: 1-63 = CW (+), 65-127 = CCW (-)
  return value > 64 ? value - 128 : value;
}

// ── MidiController class ──────────────────────────────────────────────────────

class MidiController {
  constructor(stateRef, applyFn, tapFn) {
    this.state = stateRef;
    this.apply = applyFn;    // fn(patch) — same as socket 'set' event
    this.tap   = tapFn;       // fn() — trigger tap tempo

    this.input  = null;
    this.output = null;
    this.map    = DEFAULT_MAP;
    this.enabled = false;
  }

  listPorts() {
    if (!easymidi) return { inputs: [], outputs: [] };
    // Cache the result — enumerate once, refresh only on explicit connect/close
    if (this._cachedPorts) return this._cachedPorts;
    try {
      this._cachedPorts = { inputs: easymidi.getInputs(), outputs: easymidi.getOutputs() };
    } catch (_) {
      this._cachedPorts = { inputs: [], outputs: [] };
    }
    return this._cachedPorts;
  }

  refreshPorts() {
    this._cachedPorts = null;
    return this.listPorts();
  }

  connect(inputName, outputName) {
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

    // Auto-detect X-Touch Compact if no name given
    const findPort = (list, hint) => {
      if (hint) return list.find(n => n === hint) || null;
      return list.find(n => /x.?touch/i.test(n)) || list[0] || null;
    };

    const inName  = findPort(inputs,  inputName);
    const outName = findPort(outputs, outputName);

    if (!inName) {
      console.warn('[MIDI] No input port found. Pass MIDI_INPUT env var to specify.');
      return false;
    }

    try {
      this.input = new easymidi.Input(inName);
      console.log(`[MIDI] Input:  ${inName}`);

      if (outName) {
        this.output = new easymidi.Output(outName);
        console.log(`[MIDI] Output: ${outName}`);
      }

      this._bindInput();
      this.enabled = true;
      return true;
    } catch (err) {
      console.error('[MIDI] Failed to open MIDI port:', err.message);
      return false;
    }
  }

  _bindInput() {
    const m = this.map;

    // MIDI monitor: one line per incoming message. Invaluable when mapping a
    // controller, unusable during a show — a single encoder sweep is hundreds
    // of lines. Off unless DEBUG_MIDI=1. See AUDIT.md L3.
    if (process.env.DEBUG_MIDI === '1') {
      this.input.on('noteon',  ({ note, velocity, channel }) =>
        console.log(`[MIDI] noteon  ch=${channel+1} note=${note} vel=${velocity}  → ${m.notes[note] ? m.notes[note].action : 'unmapped'}`));
      this.input.on('noteoff', ({ note, channel }) =>
        console.log(`[MIDI] noteoff ch=${channel+1} note=${note}`));
      this.input.on('cc',      ({ controller, value, channel }) =>
        console.log(`[MIDI] cc      ch=${channel+1} cc=${controller} val=${value}  → ${m.cc[controller] ? m.cc[controller].action : 'unmapped'}`));
      this.input.on('pitch',   ({ value, channel }) =>
        console.log(`[MIDI] pitch   ch=${channel+1} val=${value}`));
    }

    // Note On → button press
    this.input.on('noteon', ({ note, velocity }) => {
      const binding = m.notes[note];
      if (!binding) return;
      if (velocity === 0) {
        // Note-off: release momentary actions
        if (binding.action === 'energyHold') this.apply({ energyOverride: null });
        return;
      }
      this._dispatch(binding);
    });

    // Explicit Note Off for controllers that send it separately
    this.input.on('noteoff', ({ note }) => {
      const binding = m.notes[note];
      if (binding && binding.action === 'energyHold') {
        this.apply({ energyOverride: null });
        this.sendFeedback();
      }
    });

    // CC → encoder (relative) or fader (absolute)
    this.input.on('cc', ({ controller, value }) => {
      const binding = m.cc[controller];
      if (!binding) return;
      if (binding.type === 'absolute') {
        const level = Math.round(value / 127 * 255);
        this._dispatchAbsolute(binding, level);
      } else {
        const delta = relDelta(value) * (binding.scale || 1);
        this._dispatchContinuous(binding, delta);
      }
    });
  }

  _dispatch(binding) {
    const s = this.state;
    switch (binding.action) {
      case 'tap':
        this.tap();
        break;
      case 'toggleBlackout':
        this.apply({ masterBlackout: !s.masterBlackout });
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
      case 'energyHold': {
        // Momentary: note-on activates, note-off (handled above) deactivates
        const effect = this._energyEffect || 'white-strobe';
        // If already active with a different effect, switch; otherwise activate
        this.apply({ energyOverride: effect });
        break;
      }
      case 'cycleEnergyEffect': {
        // Cycle which effect the energy hold button triggers (without activating it)
        const ENERGY_IDS = ['white-strobe', 'blinder', 'uv-strobe', 'color-strobe', 'all-on'];
        const curIdx = ENERGY_IDS.indexOf(this._energyEffect || 'white-strobe');
        this._energyEffect = ENERGY_IDS[(curIdx + 1) % ENERGY_IDS.length];
        break;
      }
      case 'cycleStrobeFunction': {
        const STROBE_FN_IDS = ['standard','ramp-up-down','ramp-up-down-rnd','ramp-up','ramp-up-rnd','ramp-down','ramp-down-rnd','random','break'];
        const curIdx = STROBE_FN_IDS.indexOf(s.strobeFunction || 'standard');
        this.apply({ strobeFunction: STROBE_FN_IDS[(curIdx + 1) % STROBE_FN_IDS.length] });
        break;
      }
      case 'toggleFixBlackout': {
        const fix = s.fixtures[binding.fixture];
        const cur = fix && fix.override;
        const newBo = !(cur && cur.blackout);
        // emitted via separate override channel — handled externally
        this._emitFixOverride(binding.fixture, { enabled: true, r: 0, g: 0, b: 0, w: 0, dim: 0, strobe: 0, blackout: newBo });
        break;
      }
    }
    this.sendFeedback();
  }

  _dispatchContinuous(binding, delta) {
    const s = this.state;
    switch (binding.action) {
      case 'adjustBpm':
        this.apply({ bpm: Math.max(20, Math.min(300, s.bpm + delta)) });
        break;
      case 'adjustMasterDimmer':
        this.apply({ masterDimmer: Math.max(0, Math.min(255, s.masterDimmer + delta)) });
        break;
      case 'adjustStrobeSpeed':
        this.apply({ strobeSpeed: Math.max(0, Math.min(255, s.strobeSpeed + delta)) });
        break;
      case 'adjustFixtureDim': {
        const fix = s.fixtures[binding.fixture];
        if (!fix) break;
        const cur = (fix.override && fix.override.enabled) ? fix.override.dim : 255;
        const newDim = Math.max(0, Math.min(255, cur + delta));
        this._emitFixOverride(binding.fixture, {
          ...(fix.override || {}), enabled: true, dim: newDim, blackout: false,
        });
        break;
      }
    }
  }

  _dispatchAbsolute(binding, level) {
    const s = this.state;
    switch (binding.action) {
      case 'setMasterDimmer':
        this.apply({ masterDimmer: level });
        break;
      case 'setFixtureDim': {
        const fix = s.fixtures[binding.fixture];
        if (!fix) break;
        this._emitFixOverride(binding.fixture, {
          ...(fix.override || { r: 0, g: 0, b: 0, w: 0, strobe: 0 }),
          enabled: true, dim: level, blackout: false,
        });
        break;
      }
    }
  }

  // Override callback — set externally to wire into engine
  overrideFixture = null;

  _emitFixOverride(id, override) {
    if (this.overrideFixture) this.overrideFixture(id, override);
  }

  // ── LED feedback ─────────────────────────────────────────────────────────────

  sendFeedback() {
    if (!this.output) return;
    const s = this.state;

    // Pattern buttons (LED_PATTERNS: notes 16-25)
    const PATTERNS = ['solid','chase','chase-rev','ping-pong','strobe','fade','color-cycle','rainbow','twinkle','split'];
    PATTERNS.forEach((p, i) => {
      this._ledNote(LED_PATTERNS[i], p === s.pattern ? 127 : 0);
    });

    // Colour A buttons (LED_COLORS_A: notes 26-31)
    LED_COLORS_A.forEach((note, i) => {
      this._ledNote(note, i === s.colorA ? 127 : 0);
    });

    // Encoder push buttons
    this._ledNote(1, s.masterBlackout   ? 127 : 0);  // Note 1: blackout
    this._ledNote(2, s.running          ? 127 : 0);  // Note 2: play
    this._ledNote(7, s.energyOverride   ? 127 : 0);  // Note 7: energy override active
  }

  _ledNote(note, velocity, channel = 0) {
    if (!this.output) return;
    try {
      this.output.send('noteon', { note, velocity, channel });
    } catch (_) {}
  }

  close() {
    if (this.input)  { try { this.input.close();  } catch (_) {} }
    if (this.output) { try { this.output.close(); } catch (_) {} }
    this.enabled = false;
    this._cachedPorts = null;
  }
}

module.exports = MidiController;
