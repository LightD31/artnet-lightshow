/**
 * MIDI clock out: the pattern clock, twenty-four pulses a beat, to a port.
 *
 * Whatever the rig keeps time by — the show's analysed grid, a CDJ, a known
 * track, the live input, a tap — goes out as MIDI clock too, so a drum machine,
 * a DAW or a visuals app on the same machine (through a loopback port such as
 * loopMIDI) plays in the same time as the lights.
 *
 * Pulses are counted from the clock's beat position rather than timed on their
 * own, so they cannot drift from it: every few milliseconds, as many pulses go
 * out as the beat position has passed since the last. MIDI clock has no way to
 * jump, so when the music does — a seek, a new track — the count is set to the
 * new position and the receiver simply carries on at the tempo it hears.
 */

export const PULSES_PER_BEAT = 24;
// How often the pulses are topped up. A pulse is 20 ms apart at 125 BPM; this
// keeps each within a few milliseconds of its time, as far as the platform's
// timers allow.
const TICK_MS = 4;
// Further than this from the count in one tick is a jump, not a late timer.
const JUMP_PULSES = 2 * PULSES_PER_BEAT;

/** The port, as far as sending clock goes. */
export interface ClockOutput {
  send(type: 'clock' | 'start' | 'stop'): void;
  close(): void;
}

export interface MidiClockOptions {
  /** Open a port by name; null when it is not there. */
  open: (name: string) => ClockOutput | null;
  /** Where the music is, in beats. */
  beatPos: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

class MidiClock {
  declare _open: (name: string) => ClockOutput | null;
  declare _beatPos: () => number;
  declare _setInterval: (fn: () => void, ms: number) => unknown;
  declare _clearInterval: (timer: unknown) => void;
  declare _output: ClockOutput | null;
  declare _port: string | null;
  declare _timer: unknown;
  declare _sent: number | null;
  declare _error: string | null;

  constructor({ open, beatPos, setInterval: si = (fn, ms) => setInterval(fn, ms),
    clearInterval: ci = (t) => clearInterval(t as ReturnType<typeof setInterval>) }: MidiClockOptions) {
    this._open = open;
    this._beatPos = beatPos;
    this._setInterval = si;
    this._clearInterval = ci;
    this._output = null;
    this._port = null;
    this._timer = null;
    this._sent = null;
    this._error = null;
  }

  /** Send clock to `port`, or to nothing when it is blank. */
  setPort(port: string): void {
    if ((port || null) === this._port && (this._output || !port)) return;
    this.stop();
    if (!port) return;
    this._port = port;
    let output: ClockOutput | null = null;
    try {
      output = this._open(port);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
    if (!output) {
      this._error = this._error || `MIDI port "${port}" is not available`;
      console.warn(`[midi clock] ${this._error}`);
      return;
    }
    this._error = null;
    this._output = output;
    this._sent = null;
    output.send('start');
    this._timer = this._setInterval(() => this.tick(), TICK_MS);
    console.log(`[midi clock] sending to ${port}`);
  }

  stop(): void {
    if (this._timer) { this._clearInterval(this._timer); this._timer = null; }
    if (this._output) {
      try { this._output.send('stop'); this._output.close(); } catch { /* port gone */ }
      this._output = null;
    }
    this._port = null;
    this._sent = null;
  }

  /** Send the pulses the beat position has passed. Public for tests. */
  tick(): number {
    const output = this._output;
    if (!output) return 0;
    const beat = this._beatPos();
    if (!Number.isFinite(beat)) return 0;
    const target = Math.floor(beat * PULSES_PER_BEAT);
    if (this._sent === null || target - this._sent > JUMP_PULSES || target < this._sent - PULSES_PER_BEAT / 2) {
      // The first reading, or the music jumped: count from here.
      this._sent = target;
      return 0;
    }
    let sent = 0;
    while (this._sent < target) {
      output.send('clock');
      this._sent++;
      sent++;
    }
    return sent;
  }

  status(): { port: string | null; running: boolean; error: string | null } {
    return { port: this._port, running: !!this._output, error: this._error };
  }
}

export default MidiClock;
