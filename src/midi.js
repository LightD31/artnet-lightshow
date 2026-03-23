'use strict';

/**
 * MIDI handler for Behringer X-Touch Compact
 *
 * X-Touch Compact Standard mode (default) layout — Layer A:
 *   Encoders 1-8 : CC 1-8, ch 1 (relative: 1-63=CW, 65-127=CCW)
 *   Enc buttons  : Note 0-7,  ch 1
 *   Button row 1 : Note 8-15, ch 1
 *   Button row 2 : Note 16-23, ch 1
 *   Faders 1-9   : Pitch Bend, MIDI ch 1-9 (channel index 0-8)
 *
 * LED feedback is sent back via Note On (velocity = colour):
 *   0 = off, 1 = on (fixture-default), 127 = bright on
 *   Some buttons support colours via velocity (check Behringer docs)
 */

let easymidi;
try {
  easymidi = require('easymidi');
} catch (_) {
  console.warn('[MIDI] easymidi not available — run `npm install easymidi` to enable MIDI support.');
}

// ── Default mapping for X-Touch Compact Layer A ───────────────────────────────

const DEFAULT_MAP = {
  // CC → action  (relative encoders)
  cc: {
    1: { action: 'adjustBpm',          scale: 1    },  // Encoder 1: BPM ±1/step
    2: { action: 'adjustMasterDimmer', scale: 4    },  // Encoder 2: Master dim
    3: { action: 'adjustFixtureDim',   fixture: 0, scale: 4 },
    4: { action: 'adjustFixtureDim',   fixture: 1, scale: 4 },
    5: { action: 'adjustFixtureDim',   fixture: 2, scale: 4 },
    6: { action: 'adjustFixtureDim',   fixture: 3, scale: 4 },
    7: { action: 'adjustStrobeSpeed',  scale: 4    },  // Encoder 7: Strobe
  },
  // Pitch bend channel (0-indexed) → action (absolute fader 0-16383 → 0-255)
  pitchbend: {
    0: { action: 'setFixtureDim',  fixture: 0 },
    1: { action: 'setFixtureDim',  fixture: 1 },
    2: { action: 'setFixtureDim',  fixture: 2 },
    3: { action: 'setFixtureDim',  fixture: 3 },
    8: { action: 'setMasterDimmer' },               // Fader 9: Master
  },
  // Note → action  (Note On with velocity > 0 triggers)
  notes: {
    // Encoder push buttons
    0: { action: 'tap' },
    1: { action: 'toggleBlackout' },
    2: { action: 'togglePlay' },
    3: { action: 'toggleFixBlackout', fixture: 0 },
    4: { action: 'toggleFixBlackout', fixture: 1 },
    5: { action: 'toggleFixBlackout', fixture: 2 },
    6: { action: 'toggleFixBlackout', fixture: 3 },
    // Button row 1 (notes 8-17): 10 patterns
    8:  { action: 'setPattern', value: 'solid'       },
    9:  { action: 'setPattern', value: 'chase'       },
    10: { action: 'setPattern', value: 'chase-rev'   },
    11: { action: 'setPattern', value: 'ping-pong'   },
    12: { action: 'setPattern', value: 'strobe'      },
    13: { action: 'setPattern', value: 'fade'        },
    14: { action: 'setPattern', value: 'color-cycle' },
    15: { action: 'setPattern', value: 'rainbow'     },
    16: { action: 'setPattern', value: 'twinkle'     },
    17: { action: 'setPattern', value: 'split'       },
    7: { action: 'energyHold' },      // Encoder push 8: hold for energy override
    // Button row 2 (notes 18-23): first 6 colour presets → colour A
    18: { action: 'setColorA', value: 0 },
    19: { action: 'setColorA', value: 1 },
    20: { action: 'setColorA', value: 2 },
    21: { action: 'setColorA', value: 3 },
    22: { action: 'setColorA', value: 4 },
    23: { action: 'setColorA', value: 5 },
  },
};

// MIDI note LED groups for feedback (note → LED note on same device)
const LED_PATTERNS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const LED_COLORS_A = [18, 19, 20, 21, 22, 23];

function relDelta(value) {
  // Relative mode 1: 1-63 = CW (+), 65-127 = CCW (-)
  return value > 64 ? value - 128 : value;
}

function pitchToLevel(pitchValue) {
  // easymidi pitch bend: -8192 to +8191
  return Math.round(((pitchValue + 8192) / 16383) * 255);
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

    // Note On → button press
    this.input.on('noteon', ({ note, velocity, channel }) => {
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

    // CC → encoder / knob
    this.input.on('cc', ({ controller, value }) => {
      const binding = m.cc[controller];
      if (!binding) return;
      const delta = relDelta(value) * (binding.scale || 1);
      this._dispatchContinuous(binding, delta);
    });

    // Pitch bend → fader (absolute)
    this.input.on('pitch', ({ value, channel }) => {
      const chIdx = channel; // easymidi: 0-indexed
      const binding = m.pitchbend[chIdx];
      if (!binding) return;
      const level = pitchToLevel(value);
      this._dispatchAbsolute(binding, level);
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
        const ENERGY_IDS = ['white-strobe', 'blinder', 'uv-strobe', 'color-strobe', 'all-on'];
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

    // Pattern buttons (notes 8-17)
    const PATTERNS = ['solid','chase','chase-rev','ping-pong','strobe','fade','color-cycle','rainbow','twinkle','split'];
    PATTERNS.forEach((p, i) => {
      this._ledNote(LED_PATTERNS[i], p === s.pattern ? 127 : 0);
    });

    // Colour A buttons (notes 18-23)
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
