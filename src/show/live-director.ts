import { pickPattern, burstFor, goldenStep } from './look.ts';
import type { Character } from './look.ts';
import type { LiveEvent, LiveReading } from '../live-input.ts';

/**
 * The live director: a show for music nobody analysed, played by ear.
 *
 * The auto show plans a whole track ahead from its analysis. When there is no
 * analysis — a track still being analysed, a DJ on gear nothing here can read,
 * a band — the live input still hears the music, and this answers what it
 * hears as it hears it, in the same vocabulary the planned show uses:
 *
 *   the beat         the patterns step on it already: the pattern clock
 *                    follows the live input (conductor.ts `live`);
 *   a section change a new look, chosen by pickPattern from what is playing
 *                    now — cut when the music rises, faded when it falls;
 *   a build-up       the pattern doubles its pace until what it builds to;
 *   a drop           the biggest gesture the moment allows (burstFor), on the
 *                    rise — live there is no waiting to confirm it;
 *   a spike          a short accent, rarely;
 *   silence          the rig goes dark, and comes back with a new look.
 *
 * Every sixteen bars without a change of section the look moves on anyway, so
 * a long passage does not sit on one pattern.
 *
 * What is playing is read off the live bands, each against its own recent
 * peak: there is no whole track to normalise against, so "loud" means loud for
 * the last minute.
 */

/** The saturated wheel of the colour presets, by index (see presets.ts). */
const WHEEL = [0, 1, 2, 3, 4, 5, 6, 7, 8];
// How fast a band's remembered peak fades, per second: about a minute to half.
const PEAK_DECAY_PER_SEC = 0.988;
// How much of a section's character comes from the last second: a few seconds
// of memory, so a single hit does not decide the look.
const CHARACTER_SMOOTHING = 0.15;
const ROTATE_BARS = 16;
const ACCENT_COOLDOWN_MS = 4000;

type Patch = Record<string, unknown>;

export interface LiveDirectorOptions {
  applyPatch: (patch: Patch) => unknown;
  /** The patterns the rig can play. */
  patterns: readonly { id: string }[];
  /** Whether a rig with LED bars can take the pixel patterns. */
  pixels?: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

class LiveDirector {
  declare _apply: (patch: Patch) => unknown;
  declare _available: Set<string>;
  declare _pixels: () => boolean;
  declare _now: () => number;
  declare _setTimer: (fn: () => void, ms: number) => unknown;
  declare _clearTimer: (timer: unknown) => void;
  declare active: boolean;
  declare _peaks: Record<string, number>;
  declare _character: Required<Pick<Character, 'kick' | 'bassline' | 'vocal' | 'hats' | 'texture' | 'energy' | 'pulse'>>;
  declare _lastReadingAt: number;
  declare _bpm: number;
  declare _seed: number;
  declare _hue: number;
  declare _look: Patch | null;
  declare _bars: number;
  declare _silent: boolean;
  declare _building: boolean;
  declare _lastAccentAt: number;
  declare _timers: Set<unknown>;

  constructor({ applyPatch, patterns, pixels = () => false, now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }: LiveDirectorOptions) {
    this._apply = applyPatch;
    this._available = new Set(patterns.map((p) => p.id));
    this._pixels = pixels;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this.active = false;
    this._peaks = {};
    this._character = { kick: 0, bassline: 0, vocal: 0, hats: 0, texture: 0, energy: 0.4, pulse: 0.3 };
    this._lastReadingAt = 0;
    this._bpm = 0;
    this._seed = 0;
    this._hue = 0;
    this._look = null;
    this._bars = 0;
    this._silent = false;
    this._building = false;
    this._lastAccentAt = -Infinity;
    this._timers = new Set();
  }

  /** Take the rig: a first look from what is playing now. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this._bars = 0;
    this._newLook({ fadeMs: 1000 });
  }

  /** Hand the rig back, with nothing of ours left on it. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const t of this._timers) this._clearTimer(t);
    this._timers.clear();
    this._silent = false;
    this._building = false;
    this._apply({ energyOverride: null, beatDivision: 1 });
  }

  /** What the rig is showing, for the UI. */
  status(): { active: boolean; pattern: string | null; silent: boolean } {
    return { active: this.active, pattern: this._look ? String(this._look.pattern) : null, silent: this._silent };
  }

  /** Every hop: keep the character of what is playing up to date. */
  onReading(r: LiveReading): void {
    const now = this._now();
    const dt = this._lastReadingAt ? Math.min(1, (now - this._lastReadingAt) / 1000) : 0;
    this._lastReadingAt = now;
    if (r.bpm > 0) this._bpm = r.bpm;
    const bands = r.bands || {};
    const level = (name: string, value: number | null | undefined) => {
      const v = Math.max(0, Number(value) || 0);
      const peak = Math.max(v, (this._peaks[name] || 0) * PEAK_DECAY_PER_SEC ** dt);
      this._peaks[name] = peak;
      return peak > 1e-9 ? v / peak : 0;
    };
    const sub = level('sub', bands.sub);
    const bass = level('bass', bands.bass);
    const mid = level('mid', bands.mid);
    const high = level('high', bands.high);
    const air = level('air', bands.air ?? bands.presence);
    const energy = level('energy', r.energy);
    const reading = {
      kick: sub * 0.5 + bass * 0.5,
      bassline: bass,
      vocal: mid * 0.7,
      hats: high,
      texture: air,
      energy,
      pulse: r.locked ? 0.75 : 0.3,
    };
    const a = Math.min(1, CHARACTER_SMOOTHING * dt * 10);
    const c = this._character;
    for (const k of Object.keys(reading) as (keyof typeof reading)[]) c[k] = c[k] + (reading[k] - c[k]) * a;

    // Sound after silence: the rig comes back with something new.
    if (this.active && this._silent && energy > 0.2) {
      this._silent = false;
      this._apply({ energyOverride: null });
      this._newLook({ fadeMs: 0 });
    }
  }

  /** How hard the rig should work: mostly how loud it is, and whether it is a dance tempo. */
  _drive(): number {
    const c = this._character;
    const danceTempo = this._bpm >= 110 && this._bpm <= 150 ? 0.15 : 0;
    return Math.max(0, Math.min(1, 0.25 + c.energy * 0.45 + c.kick * 0.15 + danceTempo));
  }

  _barMs(): number {
    return this._bpm > 0 ? (4 * 60000) / this._bpm : 2000;
  }

  /** A new pattern for what is playing, and the palette turned on. */
  _newLook({ fadeMs = 0, rise = false }: { fadeMs?: number; rise?: boolean } = {}): void {
    if (!this.active) return;
    this._seed++;
    // Well apart from the last few, round the wheel.
    this._hue = goldenStep(this._seed, WHEEL.length);
    const character: Character = rise ? { ...this._character, energy: Math.max(0.8, this._character.energy) } : this._character;
    const drive = rise ? Math.max(0.8, this._drive()) : this._drive();
    const pattern = pickPattern({
      character, available: this._available, seed: this._seed, drive,
      dance: this._character.pulse, pixels: this._pixels(),
    });
    const at = (k: number) => WHEEL[(this._hue + k) % WHEEL.length];
    const look: Patch = {
      pattern,
      colorA: at(0), colorB: at(3), colorC: at(5), colorD: at(7),
      beatDivision: 1,
      running: true,
      ...(fadeMs > 0 ? { fadeMs: Math.min(10000, Math.round(fadeMs)) } : {}),
    };
    this._look = look;
    this._bars = 0;
    this._building = false;
    this._apply(look);
  }

  _burst(kind: string, ms: number): void {
    this._apply({ energyOverride: kind });
    const timer = this._setTimer(() => {
      this._timers.delete(timer);
      if (this.active && !this._silent) this._apply({ energyOverride: null });
    }, ms);
    this._timers.add(timer);
  }

  /** A musical event from the live input. */
  onEvent(e: LiveEvent): void {
    if (!this.active) return;
    const now = this._now();
    switch (e.type) {
      case 'BAR':
        if (++this._bars >= ROTATE_BARS && !this._silent) this._newLook({ fadeMs: this._barMs() / 2 });
        break;
      case 'TRANSITION': {
        const rising = !!(e.data && e.data.to === 'high');
        // Into a quieter passage the room is settling, and a cut would jar;
        // into a louder one the change is the moment.
        this._newLook({ fadeMs: rising ? 0 : this._barMs() * 2, rise: rising });
        break;
      }
      case 'BUILDUP':
        if (this._building || this._silent) break;
        this._building = true;
        this._apply({ beatDivision: 2 });
        break;
      case 'DROP': {
        this._newLook({ rise: true });
        const kind = burstFor({ moment: 'drop', character: this._character, score: null, drive: this._drive() });
        this._burst(kind, Math.max(800, Math.min(2500, this._barMs())));
        this._lastAccentAt = now;
        break;
      }
      case 'ENERGY_SPIKE': {
        if (now - this._lastAccentAt < ACCENT_COOLDOWN_MS || this._silent) break;
        const drive = this._drive();
        if (drive < 0.45) break;
        this._lastAccentAt = now;
        this._burst(burstFor({ moment: 'accent', character: this._character, score: null, drive }), 150);
        break;
      }
      case 'SILENCE':
        if (this._silent) break;
        this._silent = true;
        this._building = false;
        // Held, not timed: the rig stays dark until the music comes back.
        this._apply({ energyOverride: 'kill', beatDivision: 1 });
        break;
      default:
        break;
    }
  }
}

export default LiveDirector;
