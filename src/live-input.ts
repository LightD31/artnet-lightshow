/**
 * The live input service, from the server's side.
 *
 * src/live_input.py hears the music as it plays — what this PC itself plays,
 * or a line-in off the booth — and writes a line about it every hop, 86 times
 * a second: where the beat is, the tempo, the levels, and the events the
 * offline analyser would have called (see src/analysis/live.py). This keeps
 * that process running, restarting it when it dies, and reads its lines onto
 * the server's own clock:
 *
 *   - each state line says how much audio has been captured by the time it is
 *     written; the arrival that is least delayed, over the last few seconds,
 *     fixes where stream time sits on the monotonic clock;
 *   - between lines the beat position runs on at the tempo, so the pattern
 *     clock reads a beat position for "now", not for the last hop.
 *
 * Started with `bands`, the service also reports the power in each of them
 * every hop, for the party effects' ears (`LiveReading.spectrum`). With a band
 * source (`useBands`), that source names the bands of every start, whoever
 * starts it: the settings, the return from the Python setup, a band edit.
 * Other bands on the same input are sent to the running service on its stdin,
 * so its stream, its clock and its lock carry on through the change.
 *
 * `latencyMs` is the distance between capture and the room: positive when the
 * room hears the audio later than it is captured (loopback, before the PA),
 * negative when it is captured later than it is heard (a line-in off the
 * booth output, through an interface).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import * as pythonEnv from './python-env.ts';
import { messageOf } from './errors.ts';
import { BAND_HZ_MAX, validBand } from './shared/spectrum-bands.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type LiveSource = 'loopback' | 'input' | 'file';

export interface LiveOptions {
  source: LiveSource;
  device?: string;
  /** For `file`: the audio file, played at its own speed. */
  file?: string;
  latencyMs?: number;
  /** Bands to report the power of, `[lo, hi]` Hz: at most `MAX_BANDS`, 0 ≤ lo < hi ≤ `BAND_HZ_MAX`. */
  bands?: [number, number][];
}

// The highest band edge, Nyquist at the service's 22 050 Hz: one constant
// with the Disco's band settings, so the two cannot drift.
export { BAND_HZ_MAX };
/** As many bands as the service will sum per hop. */
export const MAX_BANDS = 12;

/**
 * One frame's power on Hue Dynamics' scale: `|X|²` per bin of a
 * Hamming-windowed 1024-point FFT of the float samples less their mean (a DC
 * offset is not sound), unnormalised.
 */
export interface LiveSpectrum {
  /** Σx² of the frame's samples, offset included: a different scale from the bins'. */
  power: number;
  rms: number;
  /**
   * The centre of the strongest bin above DC, up to 2 kHz; null when none of
   * those bins carries power, as in a frame of nothing but an offset. Never 0.
   */
  dominantHz: number | null;
  /** Σ|X|² over each requested band's bins (two at least), in the order asked for. */
  bands: number[];
  /** Σ|X|² over every bin of the same FFT. */
  fftPower?: number;
}

/**
 * Why the process a line came from was started, counted from the last
 * process that wrote a line: 'bands' when only the bands changed on an input
 * that was running and its process could not be sent them, 'input' when its
 * source, device or file changed (the bands perhaps with them), 'start' when
 * it started from stopped or again after its process ended. The worst of them
 * wins when a process wrote nothing before the next replaced it.
 */
export type LiveCause = 'start' | 'input' | 'bands';
const CAUSE_RANK: Record<LiveCause, number> = { bands: 0, input: 1, start: 2 };
const worse = (a: LiveCause | null, b: LiveCause): LiveCause => (a !== null && CAUSE_RANK[a] > CAUSE_RANK[b] ? a : b);

/** One hop, as the service reports it. */
export interface LiveReading {
  t: number;
  captured: number;
  beat: number | null;
  bpm: number;
  phase: number | null;
  locked: boolean;
  energy: number | null;
  onset: number | null;
  flux: number | null;
  rms: number | null;
  tension: number | null;
  bands: Record<string, number | null>;
  /** Present when the service was started with `bands`. */
  spectrum?: LiveSpectrum;
  /** Which spawned process the line came from, counting from 1; stamped here, not by the service. */
  generation?: number;
  /** The bands that process summed it over, as `bandsArg` writes them; stamped here too. */
  layout?: string;
  /** Why that process was started (LiveCause); stamped here too. */
  cause?: LiveCause;
}

/** One hop's onset strength and level, in stream time. */
export interface LiveEnvelopePoint {
  t: number;
  flux: number;
  rms: number;
}

/** A musical event, in the offline analyser's vocabulary, in stream time. */
export interface LiveEvent {
  t: number;
  type: string;
  confidence: number;
  intensity: number;
  duration: number;
  effect: string;
  data?: Record<string, unknown>;
}

export interface LiveStatus {
  running: boolean;
  /** Hearing audio now: the process is up and its lines are fresh. */
  listening: boolean;
  source: LiveSource | null;
  device: string | null;
  backend: string | null;
  error: string | null;
  bpm: number;
  locked: boolean;
  /** Recent level, dBFS, for a meter. */
  levelDb: number | null;
}

// A process that dies is started again after this, doubling to the cap while
// it keeps dying.
const RESTART_MS = 2000;
const RESTART_MAX_MS = 30000;
// No state line for this long: the reading is gone.
const STALE_MS = 500;
// The least-delayed arrival over this window places stream time on the clock.
const OFFSET_WINDOW_MS = 5000;
// Recent levels kept for cross-correlation against a track's analysis.
const ENVELOPE_SEC = 30;
// The analyser re-judges its lock on the tempo every two seconds, and a drop or
// a breakdown can cost it one judgement while the grid runs on regardless:
// the beat is still trusted this long after the last locked line.
const LOCK_HOLD_MS = 4000;

/**
 * A copy of `bands`, or a RangeError for a list the service would refuse with a
 * usage error: better at the caller than as a process that keeps exiting.
 */
function copyBands(bands: unknown): [number, number][] | undefined {
  if (bands == null) return undefined;
  if (!Array.isArray(bands) || bands.length > MAX_BANDS) throw new RangeError(`live input: bands is a list of at most ${MAX_BANDS}`);
  return bands.map((band): [number, number] => {
    const [lo, hi] = Array.isArray(band) && band.length === 2 ? band : [];
    if (typeof lo !== 'number' || typeof hi !== 'number' || !validBand(lo, hi)) {
      throw new RangeError(`live input: band ${JSON.stringify(band)} is not [lo, hi] Hz with 0 ≤ lo < hi ≤ ${BAND_HZ_MAX}`);
    }
    return [lo, hi];
  });
}

/** `--bands` as the service reads it, and '' for none; equal strings, equal lists. */
export function bandsArg(bands: readonly (readonly [number, number])[] | undefined): string {
  return (bands || []).map(([lo, hi]) => `${lo}-${hi}`).join(',');
}

type Spawner = (exe: string, args: string[]) => ChildProcessWithoutNullStreams;

class LiveInput {
  declare _now: () => number;
  declare _spawn: Spawner;
  declare _scriptPath: string;
  declare _options: LiveOptions | null;
  declare _proc: ChildProcessWithoutNullStreams | null;
  declare _generation: number;
  declare _rl: readline.Interface | null;
  declare _restartTimer: ReturnType<typeof setTimeout> | null;
  declare _restartMs: number;
  declare _stopped: boolean;
  declare _reading: LiveReading | null;
  declare _readingAt: number;
  declare _lockedAt: number;
  declare _lock: number;
  declare _offsets: { at: number; offset: number }[];
  declare _envelope: LiveEnvelopePoint[];
  declare _ready: { backend: string | null; device: string | null } | null;
  declare _error: string | null;
  declare _onEvent: ((event: LiveEvent) => void) | null;
  declare _onReading: ((reading: LiveReading) => void) | null;
  declare _onStatus: ((status: LiveStatus) => void) | null;
  declare _bandSource: (() => [number, number][]) | null;
  declare _cause: LiveCause;
  declare _carried: LiveCause | null;
  declare _layout: string;

  constructor({ spawner, now, scriptPath }: { spawner?: Spawner; now?: () => number; scriptPath?: string } = {}) {
    this._now = now || (() => performance.now());
    this._spawn = spawner || ((exe, args) => spawn(exe, args, { windowsHide: true }));
    this._scriptPath = scriptPath || path.join(import.meta.dirname, 'live_input.py');
    this._options = null;
    this._proc = null;
    this._generation = 0;
    this._rl = null;
    this._restartTimer = null;
    this._restartMs = RESTART_MS;
    this._stopped = true;
    this._reading = null;
    this._readingAt = 0;
    this._lockedAt = -Infinity;
    this._lock = 0;
    this._offsets = [];
    this._envelope = [];
    this._ready = null;
    this._error = null;
    this._onEvent = null;
    this._onReading = null;
    this._onStatus = null;
    this._bandSource = null;
    // The current process's cause, and what the next launch inherits until
    // a line is read: a stream is only continued by a process that was heard.
    this._cause = 'start';
    this._carried = null;
    // The bands the current process sums now: its --bands, then each list it says it took.
    this._layout = '';
  }

  onEvent(fn: LiveInput['_onEvent']): void { this._onEvent = fn; }
  onReading(fn: LiveInput['_onReading']): void { this._onReading = fn; }
  onStatus(fn: LiveInput['_onStatus']): void { this._onStatus = fn; }

  /**
   * What every start asks for its bands from now on, so no caller can start
   * the service without the list its readers decode. Null goes back to each
   * start's own `bands`.
   */
  useBands(source: (() => [number, number][]) | null): void { this._bandSource = source; }

  /** The band source names other bands now: listen with them, if listening. */
  refreshBands(): void {
    if (this._options && !this._stopped) this.start(this._options);
  }

  get running(): boolean { return !this._stopped; }

  /** What it was last started with, to start it the same way again. */
  get options(): LiveOptions | null {
    if (!this._options) return null;
    const options = { ...this._options };
    if (options.bands) options.bands = copyBands(options.bands);
    return options;
  }

  /**
   * Start listening, or listen differently: other bands on the same input go
   * to the running process, anything else starts a new one. Throws a
   * RangeError for bands the service would refuse.
   */
  start(options: LiveOptions): void {
    // Copied before the comparison: a caller editing its array in place and
    // passing it again must still read as a change.
    const bands = copyBands(this._bandSource ? this._bandSource() : options.bands);
    const running = !!this._options && !this._stopped;
    const sameInput = running && this._options!.source === options.source
      && (this._options!.device || '') === (options.device || '') && (this._options!.file || '') === (options.file || '');
    const same = sameInput && bandsArg(this._options!.bands) === bandsArg(bands);
    this._options = { ...options };
    if (bands?.length) this._options.bands = bands;
    else delete this._options.bands;
    if (same) return;
    if (sameInput && this._send(bands)) return;
    this.stop();
    this._stopped = false;
    this._restartMs = RESTART_MS;
    this._launch(!running ? 'start' : sameInput ? 'bands' : 'input');
  }

  stop(): void {
    const wasRunning = !this._stopped;
    this._stopped = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._rl) { try { this._rl.close(); } catch { /* closed */ } this._rl = null; }
    if (this._proc) { try { this._proc.kill(); } catch { /* gone */ } this._proc = null; }
    this._forgetStream();
    this._ready = null;
    if (wasRunning) this._emitStatus();
  }

  /**
   * A stream ends with its process, and the next one counts from zero: the
   * old arrivals would place it 600 s off after ten minutes of listening, its
   * lock says nothing about a grid it never heard, and its levels would sit
   * in the envelope untrimmed until the new stream time passed them.
   */
  _forgetStream(): void {
    this._reading = null;
    this._lockedAt = -Infinity;
    this._offsets = [];
    this._envelope = [];
  }

  /**
   * Ask the running process to sum `bands` from its next hop on. False when
   * there is none to ask, or it takes no requests: then it has to be started
   * again on them.
   */
  _send(bands: [number, number][] | undefined): boolean {
    const stdin = this._proc?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(`${JSON.stringify({ type: 'bands', bands: bandsArg(bands) })}\n`);
    return true;
  }

  _launch(cause: LiveCause): void {
    if (this._stopped || !this._options) return;
    this._carried = worse(this._carried, cause);
    this._cause = this._carried;
    const o = this._options;
    this._layout = bandsArg(o.bands);
    const args = [this._scriptPath];
    if (o.source === 'file') args.push('--file', o.file || '', '--realtime');
    else args.push('--source', o.source, ...(o.device ? ['--device', o.device] : []));
    if (o.bands?.length) args.push('--bands', bandsArg(o.bands));
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = this._spawn(pythonEnv.pythonExe(), args);
    } catch (err) {
      this._fail(`could not start the live input: ${messageOf(err)}`);
      return;
    }
    this._proc = proc;
    this._generation += 1;
    proc.stdout.setEncoding('utf8');
    const rl = readline.createInterface({ input: proc.stdout });
    this._rl = rl;
    // Nothing from a replaced process counts: a line of its was summed over the
    // old band list, and a late error from it would restart the new one.
    rl.on('line', (line) => { if (this._proc === proc) this.handleLine(line); });
    // A write to a process that has gone fails here, not in _send: its close restarts it.
    proc.stdin?.on('error', () => {});
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { if (stderr.length < 4096) stderr += d.toString(); });
    proc.on('error', (err) => { if (this._proc === proc) this._fail(`live input: ${err.message}`); });
    proc.on('close', (code) => {
      if (this._proc !== proc) return;
      this._proc = null;
      this._forgetStream();
      if (this._stopped) return;
      const tail = stderr.trim().split('\n').slice(-2).join(' | ');
      this._carried = 'start';
      if (!this._error) this._error = `live input exited (code ${code})${tail ? `: ${tail}` : ''}`;
      console.warn(`[live] ${this._error} — restarting in ${this._restartMs / 1000}s`);
      this._scheduleRestart();
      this._emitStatus();
    });
  }

  _fail(message: string): void {
    this._carried = 'start';
    this._error = message;
    console.warn(`[live] ${message}`);
    this._emitStatus();
    this._scheduleRestart();
  }

  _scheduleRestart(): void {
    if (this._stopped || this._restartTimer) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      // A restart asks the band source too: a band edit made while the
      // process was down is not summed over the old list.
      if (this._bandSource && this._options) {
        try {
          const bands = copyBands(this._bandSource());
          if (bands?.length) this._options.bands = bands;
          else delete this._options.bands;
        } catch (err) {
          console.warn(`[live] ${messageOf(err)}; restarting on the bands it had`);
        }
      }
      this._launch('start');
    }, this._restartMs);
    this._restartMs = Math.min(RESTART_MAX_MS, this._restartMs * 2);
  }

  /** One line from the service. Public for tests. */
  handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.type) {
      case 'ready':
        this._ready = { backend: typeof msg.backend === 'string' ? msg.backend : null, device: typeof msg.device === 'string' ? msg.device : null };
        this._error = null;
        this._restartMs = RESTART_MS;
        console.log(`[live] listening to ${this._ready.device || 'the default device'} (${this._ready.backend})`);
        this._emitStatus();
        break;
      case 'state':
        this._takeReading(msg as unknown as LiveReading);
        break;
      case 'event':
        if (msg.event && typeof msg.event === 'object' && this._onEvent) this._onEvent(msg.event as LiveEvent);
        break;
      case 'bands':
        // The bands sent are summed from here on: every line after this one is over them.
        if (typeof msg.bands === 'string') this._layout = msg.bands;
        break;
      case 'error':
        this._error = typeof msg.message === 'string' ? msg.message : 'live input error';
        console.warn(`[live] ${this._error}`);
        // Fatal is a missing library or device: retrying at once will not
        // install it, so only now and then, in case it is plugged in.
        if (msg.fatal) this._restartMs = RESTART_MAX_MS;
        this._emitStatus();
        break;
      case 'end':
        // A file ran out: nothing more to hear until it is started again.
        this._stopped = true;
        this._emitStatus();
        break;
      default:
        break;
    }
  }

  _takeReading(r: LiveReading): void {
    if (!Number.isFinite(r.t) || !Number.isFinite(r.captured)) return;
    const now = this._now();
    const wasListening = this._isFresh(now);
    r.generation = this._generation;
    r.layout = this._layout;
    r.cause = this._cause;
    this._carried = null;
    this._reading = r;
    this._readingAt = now;
    if (r.locked) {
      // Found again after it lapsed (or in a new stream): a new lock, which
      // ends a tempo the operator took by hand from the old one (conductor.ts).
      if (now - this._lockedAt > LOCK_HOLD_MS) this._lock += 1;
      this._lockedAt = now;
    }
    // The least-delayed arrival of the last few seconds: pipes and the event
    // loop only ever add delay, so the smallest offset is the truest.
    const offset = now - r.captured * 1000;
    this._offsets.push({ at: now, offset });
    while (this._offsets.length && now - this._offsets[0].at > OFFSET_WINDOW_MS) this._offsets.shift();
    if (r.flux != null && r.rms != null) {
      this._envelope.push({ t: r.t, flux: r.flux, rms: r.rms });
      while (this._envelope.length && r.t - this._envelope[0].t > ENVELOPE_SEC) this._envelope.shift();
    }
    if (this._onReading) this._onReading(r);
    if (!wasListening) this._emitStatus();
  }

  _isFresh(now: number): boolean {
    return !!this._reading && now - this._readingAt <= STALE_MS;
  }

  /** Stream time, in ms, of what the room hears now; null when not listening. */
  streamNowMs(): number | null {
    const now = this._now();
    if (!this._isFresh(now) || !this._offsets.length) return null;
    let offset = Infinity;
    for (const o of this._offsets) if (o.offset < offset) offset = o.offset;
    return now - offset - (this._options?.latencyMs || 0);
  }

  /**
   * Where the music is, in beats, now: `{ beatPos, bpm, key }` for the pattern
   * clock, or null unless the service is listening and has a grid. `key`
   * counts the locks: it moves on when the beat is found again after it lapsed.
   */
  getBeatReading(): { beatPos: number; bpm: number; key: number } | null {
    const r = this._reading;
    const streamNow = this.streamNowMs();
    if (!r || streamNow === null || r.beat == null || !(r.bpm > 0)) return null;
    if (!r.locked && this._now() - this._lockedAt > LOCK_HOLD_MS) return null;
    const beatPos = r.beat + ((streamNow / 1000 - r.t) * r.bpm) / 60;
    return Number.isFinite(beatPos) ? { beatPos, bpm: r.bpm, key: this._lock } : null;
  }

  /** The newest reading, while it is fresh. */
  getReading(): LiveReading | null {
    return this._isFresh(this._now()) ? this._reading : null;
  }

  /** The last `seconds` of per-hop onset flux and level, oldest first, in stream time. */
  recentEnvelope(seconds = ENVELOPE_SEC): LiveEnvelopePoint[] {
    const last = this._envelope[this._envelope.length - 1];
    if (!last) return [];
    return this._envelope.filter((e) => last.t - e.t <= seconds);
  }

  status(): LiveStatus {
    const r = this.getReading();
    return {
      running: !this._stopped,
      listening: !!r,
      source: this._options ? this._options.source : null,
      device: this._ready?.device ?? (this._options?.device || null),
      backend: this._ready?.backend ?? null,
      error: this._error,
      bpm: r ? r.bpm : 0,
      locked: !!(r && r.locked),
      levelDb: r && r.energy != null && r.energy > 0 ? Math.round(20 * Math.log10(r.energy) * 10) / 10 : null,
    };
  }

  _emitStatus(): void {
    if (this._onStatus) this._onStatus(this.status());
  }
}

/** The audio devices the service can hear, as `python src/live_input.py --list` reports them. */
export interface LiveDevices {
  backend: string | null;
  outputs: string[];
  inputs: string[];
  defaultOutput: string | null;
  defaultInput: string | null;
}

const LIST_TIMEOUT_MS = 20000;

/** Ask the service which devices there are. Rejects when it cannot be run. */
function listLiveDevices({ spawner, scriptPath }: { spawner?: Spawner; scriptPath?: string } = {}): Promise<LiveDevices> {
  const run = spawner || ((exe: string, args: string[]) => spawn(exe, args, { windowsHide: true }));
  const script = scriptPath || path.join(import.meta.dirname, 'live_input.py');
  return new Promise((resolve, reject) => {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = run(pythonEnv.pythonExe(), [script, '--list']);
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('listing the audio devices timed out')); }, LIST_TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => { if (out.length < 1 << 20) out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { if (err.length < 4096) err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').reverse().find((l) => l.includes('"devices"'));
      try {
        const msg = line ? JSON.parse(line) : null;
        if (msg && msg.type === 'devices') {
          resolve({
            backend: msg.backend ?? null,
            outputs: Array.isArray(msg.outputs) ? msg.outputs.map(String) : [],
            inputs: Array.isArray(msg.inputs) ? msg.inputs.map(String) : [],
            defaultOutput: msg.defaultOutput ?? null,
            defaultInput: msg.defaultInput ?? null,
          });
          return;
        }
      } catch { /* reported below */ }
      reject(new Error(`could not list the audio devices (exit ${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`));
    });
  });
}

export { listLiveDevices };
export default LiveInput;
