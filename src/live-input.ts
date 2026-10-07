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
  file?: string;
  latencyMs?: number;
  bands?: [number, number][];
}

// Share the Nyquist limit with Disco so capture bands and effect settings cannot drift.
export { BAND_HZ_MAX };
export const MAX_BANDS = 12;

export interface LiveSpectrum {
  power: number;
  rms: number;
  dominantHz: number | null;
  bands: number[];
  fftPower?: number;
}

export type LiveCause = 'start' | 'input' | 'bands';
const CAUSE_RANK: Record<LiveCause, number> = { bands: 0, input: 1, start: 2 };
const worse = (a: LiveCause | null, b: LiveCause): LiveCause => (a !== null && CAUSE_RANK[a] > CAUSE_RANK[b] ? a : b);

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
  spectrum?: LiveSpectrum;
  generation?: number;
  layout?: string;
  cause?: LiveCause;
}

export interface LiveEnvelopePoint {
  t: number;
  flux: number;
  rms: number;
}

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
  listening: boolean;
  source: LiveSource | null;
  device: string | null;
  backend: string | null;
  error: string | null;
  bpm: number;
  locked: boolean;
  levelDb: number | null;
}

const RESTART_MS = 2000;
const RESTART_MAX_MS = 30000;
const STALE_MS = 500;
const OFFSET_WINDOW_MS = 5000;
const ENVELOPE_SEC = 30;
const LOCK_HOLD_MS = 4000;

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
    this._cause = 'start';
    this._carried = null;
    this._layout = '';
  }

  onEvent(fn: LiveInput['_onEvent']): void { this._onEvent = fn; }
  onReading(fn: LiveInput['_onReading']): void { this._onReading = fn; }
  onStatus(fn: LiveInput['_onStatus']): void { this._onStatus = fn; }

  useBands(source: (() => [number, number][]) | null): void { this._bandSource = source; }

  refreshBands(): void {
    if (this._options && !this._stopped) this.start(this._options);
  }

  get running(): boolean { return !this._stopped; }

  get options(): LiveOptions | null {
    if (!this._options) return null;
    const options = { ...this._options };
    if (options.bands) options.bands = copyBands(options.bands);
    return options;
  }

  start(options: LiveOptions): void {
    // Copy before comparing so mutations to a caller-owned array are still detected.
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

  // Reset stream-relative history after restart because the new process counts time from zero.
  _forgetStream(): void {
    this._reading = null;
    this._lockedAt = -Infinity;
    this._offsets = [];
    this._envelope = [];
  }

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
    rl.on('line', (line) => { if (this._proc === proc) this.handleLine(line); });
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
        if (typeof msg.bands === 'string') this._layout = msg.bands;
        break;
      case 'error':
        this._error = typeof msg.message === 'string' ? msg.message : 'live input error';
        console.warn(`[live] ${this._error}`);
        if (msg.fatal) this._restartMs = RESTART_MAX_MS;
        this._emitStatus();
        break;
      case 'end':
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
      if (now - this._lockedAt > LOCK_HOLD_MS) this._lock += 1;
      this._lockedAt = now;
    }
    // Use the least-delayed arrival because pipes and event-loop jitter only add delay.
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

  streamNowMs(): number | null {
    const now = this._now();
    if (!this._isFresh(now) || !this._offsets.length) return null;
    let offset = Infinity;
    for (const o of this._offsets) if (o.offset < offset) offset = o.offset;
    return now - offset - (this._options?.latencyMs || 0);
  }

  getBeatReading(): { beatPos: number; bpm: number; key: number } | null {
    const r = this._reading;
    const streamNow = this.streamNowMs();
    if (!r || streamNow === null || r.beat == null || !(r.bpm > 0)) return null;
    if (!r.locked && this._now() - this._lockedAt > LOCK_HOLD_MS) return null;
    const beatPos = r.beat + ((streamNow / 1000 - r.t) * r.bpm) / 60;
    return Number.isFinite(beatPos) ? { beatPos, bpm: r.bpm, key: this._lock } : null;
  }

  getReading(): LiveReading | null {
    return this._isFresh(this._now()) ? this._reading : null;
  }

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

export interface LiveDevices {
  backend: string | null;
  outputs: string[];
  inputs: string[];
  defaultOutput: string | null;
  defaultInput: string | null;
}

const LIST_TIMEOUT_MS = 20000;

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
