'use strict';

/**
 * MIDI control surface.
 *
 * The mapping — which message does what — lives in src/server/midi-map.js and
 * is stored in config/midi-map.json. It defaults to a Behringer X-Touch Compact
 * in Standard mode (Layer A), which is what this was built against, but every
 * binding can be relearned from the settings page by pressing the control you
 * want, so any controller works.
 *
 * X-Touch Compact Standard mode, Layer A, for reference:
 *   Encoders EN1-8 turn : CC 10-17, ch 1 (relative: 1-63=CW, 65-127=CCW)
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

const { DEFAULT_MAP } = require('./server/midi-map');
const { ENERGY_EFFECT_IDS, STROBE_FUNCTION_IDS } = require('./server/presets');

let easymidi;
try {
  easymidi = require('easymidi');
} catch (_) {
  console.warn('[MIDI] easymidi not available — run `npm install easymidi` to enable MIDI support.');
}

// Taken from the tables in server/presets.js rather than copied. These drive
// the cycle buttons, so a hand-written copy that fell behind would leave the
// surface cycling an effect the server no longer accepts — silently, since the
// patch validator just drops an unknown id.
const ENERGY_IDS = ENERGY_EFFECT_IDS;
const STROBE_FN_IDS = STROBE_FUNCTION_IDS;

// An armed learn that nobody completes would sit swallowing the next press for
// the rest of the night. Give up on it.
const LEARN_TIMEOUT_MS = 30000;

// After a control sends us a value, hold off echoing that control for a moment.
// A motorised fader that is being moved by hand must not be driven back to
// where the last frame said it was — the operator ends up fighting the motor.
const ECHO_SUPPRESS_MS = 400;

function relDelta(value) {
  // Relative mode 1: 1-63 = CW (+), 65-127 = CCW (-)
  return value > 64 ? value - 128 : value;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

    // Set externally: recallCue needs the cue store, which this module has no
    // business reaching into itself.
    this.recallCue = null;

    this._learn = null;       // { binding, resolve, timer } while learn is armed
    this._learnListeners = [];

    // Control feedback: what we last sent to each CC, and when each last sent
    // to us. Both exist to keep the motors quiet — see _sendControlFeedback.
    this._lastCcOut = new Map();
    this._lastCcIn = new Map();
    this.controlFeedback = true;
  }

  /** Swap the control map. Takes effect on the next message; no reconnect. */
  setMap(map) {
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
  setControlFeedback(enabled) {
    this.controlFeedback = !!enabled;
    this._lastCcOut.clear();
    if (this.controlFeedback) this.sendFeedback();
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
      console.warn('[MIDI] No input port found. Pick one in the settings page.');
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
      this._lastCcOut.clear();
      // Drive the surface to the current show immediately, rather than waiting
      // for the first thing to change.
      this.sendFeedback();
      return true;
    } catch (err) {
      console.error('[MIDI] Failed to open MIDI port:', err.message);
      return false;
    }
  }

  /** The binding for an incoming message, honouring an optional channel filter. */
  _bindingFor(kind, number, channel) {
    const binding = this.map[kind] && this.map[kind][number];
    if (!binding) return null;
    if (binding.channel !== undefined && binding.channel !== channel) return null;
    return binding;
  }

  _bindInput() {
    // this.map is read at dispatch time rather than captured here, so a
    // relearned binding takes effect immediately instead of on the next
    // reconnect.

    // MIDI monitor: one line per incoming message. Invaluable when mapping a
    // controller, unusable during a show — a single encoder sweep is hundreds
    // of lines. Off unless DEBUG_MIDI=1.
    if (process.env.DEBUG_MIDI === '1') {
      this.input.on('noteon',  ({ note, velocity, channel }) =>
        console.log(`[MIDI] noteon  ch=${channel + 1} note=${note} vel=${velocity}  → ${this.map.notes[note] ? this.map.notes[note].action : 'unmapped'}`));
      this.input.on('noteoff', ({ note, channel }) =>
        console.log(`[MIDI] noteoff ch=${channel + 1} note=${note}`));
      this.input.on('cc',      ({ controller, value, channel }) =>
        console.log(`[MIDI] cc      ch=${channel + 1} cc=${controller} val=${value}  → ${this.map.cc[controller] ? this.map.cc[controller].action : 'unmapped'}`));
      this.input.on('pitch',   ({ value, channel }) =>
        console.log(`[MIDI] pitch   ch=${channel + 1} val=${value}`));
    }

    // Note On → button press
    this.input.on('noteon', ({ note, velocity, channel }) => {
      // A learn in progress swallows the message: the operator is telling us
      // which control they mean, not asking for it to fire.
      if (velocity > 0 && this._captureLearn('notes', note, channel)) return;

      const binding = this._bindingFor('notes', note, channel);
      if (!binding) return;
      if (velocity === 0) {
        // Note-off: release momentary actions
        if (binding.action === 'energyHold') this.apply({ energyOverride: null });
        return;
      }
      this._safely(binding, () => this._dispatch(binding));
    });

    // Explicit Note Off for controllers that send it separately
    this.input.on('noteoff', ({ note, channel }) => {
      const binding = this._bindingFor('notes', note, channel);
      if (binding && binding.action === 'energyHold') {
        this.apply({ energyOverride: null });
        this.sendFeedback();
      }
    });

    // CC → encoder (relative) or fader (absolute)
    this.input.on('cc', ({ controller, value, channel }) => {
      if (this._captureLearn('cc', controller, channel)) return;

      // Note the touch even when unmapped: a fader being moved is a fader we
      // should not be driving, whatever it is bound to.
      this._lastCcIn.set(controller, Date.now());

      const binding = this._bindingFor('cc', controller, channel);
      if (!binding) return;
      if (binding.type === 'relative') {
        const delta = relDelta(value) * (binding.scale || 1);
        this._safely(binding, () => this._dispatchContinuous(binding, delta));
      } else {
        this._safely(binding, () => this._dispatchAbsolute(binding, value));
      }
    });
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
  _safely(binding, run) {
    try {
      run();
    } catch (err) {
      console.warn(`[MIDI] ${binding.action} failed: ${err.message}`);
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
  startLearn(binding) {
    this.cancelLearn('superseded');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.cancelLearn('timeout'), LEARN_TIMEOUT_MS);
      timer.unref();
      this._learn = { binding, resolve, timer };
      this._emitLearn({ status: 'armed', binding });
    });
  }

  cancelLearn(reason = 'cancelled') {
    const learn = this._learn;
    if (!learn) return false;
    this._learn = null;
    clearTimeout(learn.timer);
    learn.resolve(null);
    this._emitLearn({ status: reason, binding: learn.binding });
    return true;
  }

  get learning() { return !!this._learn; }

  /** True when this message was consumed by an armed learn. */
  _captureLearn(kind, number, channel) {
    const learn = this._learn;
    if (!learn) return false;
    this._learn = null;
    clearTimeout(learn.timer);

    const captured = { kind, number, channel, binding: learn.binding };
    learn.resolve(captured);
    this._emitLearn({ status: 'captured', ...captured });
    return true;
  }

  /** Register a listener for learn-mode transitions (armed/captured/cancelled). */
  onLearn(fn) { this._learnListeners.push(fn); }

  _emitLearn(event) {
    for (const fn of this._learnListeners) {
      try { fn(event); } catch (err) { console.warn(`[MIDI] learn listener: ${err.message}`); }
    }
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

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
        const fix = s.fixtures[binding.fixture];
        const cur = fix && fix.override;
        const newBo = !(cur && cur.blackout);
        // emitted via separate override channel — handled externally
        this._emitFixOverride(binding.fixture, { enabled: true, r: 0, g: 0, b: 0, w: 0, dim: 0, strobe: 0, blackout: newBo });
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
    }
    this.sendFeedback();
  }

  _dispatchContinuous(binding, delta) {
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
        const fix = s.fixtures[binding.fixture];
        if (!fix) break;
        const cur = (fix.override && fix.override.enabled) ? fix.override.dim : 255;
        this._emitFixOverride(binding.fixture, {
          ...(fix.override || {}), enabled: true, dim: clamp(cur + delta, 0, 255), blackout: false,
        });
        break;
      }
      case 'adjustFixtureMax': {
        const fix = s.fixtures[binding.fixture];
        if (!fix) break;
        const cur = Number.isInteger(fix.maxBrightness) ? fix.maxBrightness : 255;
        this._emitFixMax(binding.fixture, clamp(cur + delta, 0, 255));
        break;
      }
      case 'adjustAutoIntensity':
        // 0-100, not 0-255: the auto show's slider is a percentage.
        this.apply({ autoIntensity: clamp(Math.round((s.autoIntensity ?? 50) + delta), 0, 100) });
        break;
    }
  }

  /** `raw` is the 0-127 the controller sent; each action scales it itself. */
  _dispatchAbsolute(binding, raw) {
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
        const fix = s.fixtures[binding.fixture];
        if (!fix) break;
        this._emitFixOverride(binding.fixture, {
          ...(fix.override || { r: 0, g: 0, b: 0, w: 0, strobe: 0 }),
          enabled: true, dim: level, blackout: false,
        });
        break;
      }
      case 'setFixtureMax':
        // Deliberately does NOT enable the override: scaling a fixture down is
        // not the same as taking it out of the pattern engine.
        if (s.fixtures[binding.fixture]) this._emitFixMax(binding.fixture, level);
        break;
      case 'setAutoIntensity':
        this.apply({ autoIntensity: Math.round((raw / 127) * 100) });
        break;
    }
  }

  // Override callback — set externally to wire into engine
  overrideFixture = null;

  // Brightness-trim callback — likewise. Separate from overrideFixture because
  // the trim is not part of the override.
  setFixtureMax = null;

  _emitFixOverride(id, override) {
    if (this.overrideFixture) this.overrideFixture(id, override);
  }

  _emitFixMax(id, value) {
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
  sendFeedback() {
    if (!this.output) return;
    const s = this.state;

    this._sendControlFeedback();

    for (const [note, binding] of Object.entries(this.map.notes || {})) {
      let lit = null;
      switch (binding.action) {
        case 'setPattern':       lit = binding.value === s.pattern; break;
        case 'setColorA':        lit = binding.value === s.colorA; break;
        case 'setColorB':        lit = binding.value === s.colorB; break;
        case 'setColorC':        lit = binding.value === s.colorC; break;
        case 'setColorD':        lit = binding.value === s.colorD; break;
        case 'setBeatDivision':  lit = Number(binding.value) === s.beatDivision; break;
        case 'setPalette':       lit = binding.value === s.palette; break;
        case 'toggleBlackout':   lit = !!s.masterBlackout; break;
        case 'togglePlay':       lit = !!s.running; break;
        case 'energyHold':       lit = !!s.energyOverride; break;
        case 'toggleFixBlackout': {
          const fix = s.fixtures[binding.fixture];
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
  _feedbackValue(binding) {
    const s = this.state;
    const to127 = (value, max) => Math.max(0, Math.min(127, Math.round((value / max) * 127)));

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
        const fix = s.fixtures[binding.fixture];
        if (!fix) return null;
        // No override means the pattern engine owns the fixture and it is at
        // full — which is where the fader should sit, ready to pull it down.
        const dim = (fix.override && fix.override.enabled) ? fix.override.dim : 255;
        return to127(dim, 255);
      }
      case 'setFixtureMax':
      case 'adjustFixtureMax': {
        const fix = s.fixtures[binding.fixture];
        if (!fix) return null;
        return to127(Number.isInteger(fix.maxBrightness) ? fix.maxBrightness : 255, 255);
      }
      case 'setAutoIntensity':
      case 'adjustAutoIntensity':
        return to127(s.autoIntensity ?? 50, 100);
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
  _sendControlFeedback() {
    if (!this.controlFeedback) return;
    const now = Date.now();

    for (const [cc, binding] of Object.entries(this.map.cc || {})) {
      const value = this._feedbackValue(binding);
      if (value === null) continue;

      const number = Number(cc);
      const touchedAt = this._lastCcIn.get(number) || 0;
      if (now - touchedAt < ECHO_SUPPRESS_MS) continue;
      if (this._lastCcOut.get(number) === value) continue;

      this._lastCcOut.set(number, value);
      try {
        this.output.send('cc', { controller: number, value, channel: binding.channel || 0 });
      } catch (_) { /* the port can vanish mid-show; feedback is not worth dying for */ }
    }
  }

  _ledNote(note, velocity, channel = 0) {
    if (!this.output) return;
    try {
      this.output.send('noteon', { note, velocity, channel });
    } catch (_) { /* the port can vanish mid-show; feedback is not worth dying for */ }
  }

  close() {
    this.cancelLearn('disconnected');
    // Forget what we sent: the next connection has to push the full state so
    // the faders fly to where the show is rather than staying where they lay.
    this._lastCcOut.clear();
    this._lastCcIn.clear();
    if (this.input)  { try { this.input.close();  } catch (_) {} }
    if (this.output) { try { this.output.close(); } catch (_) {} }
    this.enabled = false;
    this._cachedPorts = null;
  }
}

module.exports = MidiController;
