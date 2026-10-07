// Count pulses from the musical clock so MIDI output cannot drift on an independent timer.

export const PULSES_PER_BEAT = 24;
const TICK_MS = 4;
const JUMP_PULSES = 2 * PULSES_PER_BEAT;

export interface ClockOutput {
  send(type: 'clock' | 'start' | 'stop'): void;
  close(): void;
}

export interface MidiClockOptions {
  open: (name: string) => ClockOutput | null;
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

  tick(): number {
    const output = this._output;
    if (!output) return 0;
    const beat = this._beatPos();
    if (!Number.isFinite(beat)) return 0;
    const target = Math.floor(beat * PULSES_PER_BEAT);
    if (this._sent === null || target - this._sent > JUMP_PULSES || target < this._sent - PULSES_PER_BEAT / 2) {
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
