import { footprintOf } from '../shared/placement.ts';
import type { Colour, Profile } from '../types/rig.ts';

/**
 * Identify: make a fixture show itself on the rig.
 *
 * Patching is done from a table of numbers, and the question it leaves is
 * "which of those lamps is fixture 7?" — or, for a bar, "which end of it is
 * cell 1?". Identify answers both on the rig itself, over whatever the look
 * is doing and through the master and a blackout (it is a setup tool, asked
 * for on purpose, and a lamp that stays dark answers nothing):
 *
 *   a par    blinks white, on and off in a steady rhythm no look has
 *   a bar    lights its first cell green and its last red, with a white dot
 *            running from the one to the other — its wiring order, so a
 *            strip hung backwards, or a panel wired in a snake, shows itself
 *
 * The same picture goes to a WLED that is not in the patch yet (wled.ts), so
 * a device found on the network can be told apart from its neighbours before
 * it is added. A fixture's trim still applies: it is there for the lamp a
 * metre from someone's face.
 */

/** How long identify runs unless asked otherwise, and the most it may. */
export const IDENTIFY_SECONDS = 8;
export const IDENTIFY_MAX_SECONDS = 60;

// A par: lit for the first part of each period. Slow enough to stand out
// from any chase, and well under the three flashes a second the flash limit
// allows.
export const IDENTIFY_BLINK_MS = 700;
const IDENTIFY_LIT_MS = 400;

// A bar: how long the dot takes from the first cell to the last.
export const IDENTIFY_SWEEP_MS = 1500;

const WHITE: Colour = { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 };
const GREEN: Colour = { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 };
const RED: Colour = { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const DARK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

/** One light of the identify picture: its colour and level, 0–255. */
export interface IdentifyLight {
  col: Colour;
  dim: number;
}

/** Is a par lit, `elapsed` ms into identify. */
export function identifyParLit(elapsed: number): boolean {
  const t = ((elapsed % IDENTIFY_BLINK_MS) + IDENTIFY_BLINK_MS) % IDENTIFY_BLINK_MS;
  return t < IDENTIFY_LIT_MS;
}

/** The cell the running dot is on, `elapsed` ms in, for a fixture of `count` cells. */
export function identifyDot(count: number, elapsed: number): number {
  if (count <= 1) return 0;
  const t = ((elapsed % IDENTIFY_SWEEP_MS) + IDENTIFY_SWEEP_MS) % IDENTIFY_SWEEP_MS;
  return Math.min(count - 1, Math.floor((t / IDENTIFY_SWEEP_MS) * count));
}

/**
 * What each of a fixture's lights shows, `elapsed` ms into identify: one
 * light blinking for a par, the marked ends and the running dot for a bar.
 * The ends win over the dot, so they never go out.
 */
export function identifyLights(count: number, elapsed: number): IdentifyLight[] {
  if (count <= 1) return [{ col: WHITE, dim: identifyParLit(elapsed) ? 255 : 0 }];
  const dot = identifyDot(count, elapsed);
  const out: IdentifyLight[] = [];
  for (let c = 0; c < count; c++) {
    if (c === 0) out.push({ col: GREEN, dim: 255 });
    else if (c === count - 1) out.push({ col: RED, dim: 255 });
    else if (c === dot) out.push({ col: WHITE, dim: 255 });
    else out.push({ col: DARK, dim: 0 });
  }
  return out;
}

/**
 * The identify picture as pixel bytes, for a device driven directly (a WLED
 * over DDP): `leds` pixels of three or four bytes, in wiring order.
 */
export function identifyPixels(leds: number, rgbw: boolean, elapsed: number): Uint8Array {
  const width = rgbw ? 4 : 3;
  const out = new Uint8Array(Math.max(0, leds) * width);
  identifyLights(leds, elapsed).forEach(({ col, dim }, i) => {
    if (!dim) return;
    const at = i * width;
    if (rgbw && col === WHITE) {
      out[at + 3] = 255;
      return;
    }
    out[at] = col.r;
    out[at + 1] = col.g;
    out[at + 2] = col.b;
  });
  return out;
}

/** Identify as the renderer takes it: numbered, so each request is adopted once. */
export interface IdentifyRequest {
  seq: number;
  ids: number[];
  /** When it started, on the engine's clock, and how long it runs. */
  at: number;
  ms: number;
}

/** What the pages are told: the fixtures showing themselves, and for how much longer. */
export interface IdentifyStatus {
  ids: number[];
  remainingMs: number;
}

/**
 * The fixtures that sit on any of `universes`: a fixture on one universe, and
 * a strip on every universe it runs over.
 */
export function fixturesOnUniverses<F extends { id: number; address: number; profileId: string }>(
  fixtures: readonly F[], universes: Iterable<number>, profileOf: (f: F) => Profile | null | undefined,
  universeOf: (f: F) => number): number[] {
  const wanted = new Set(universes);
  const out: number[] = [];
  for (const fixture of fixtures) {
    const profile = profileOf(fixture);
    if (!profile) continue;
    if (footprintOf(universeOf(fixture), fixture.address, profile).some((part) => wanted.has(part.universe))) {
      out.push(fixture.id);
    }
  }
  return out;
}

/** A seconds value from a request: whole, 0 (stop) to the limit, else the default. */
export function identifySeconds(value: unknown): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return IDENTIFY_SECONDS;
  return Math.max(0, Math.min(IDENTIFY_MAX_SECONDS, Math.round(n)));
}

/**
 * The identify request in force, kept apart from the engine so the live
 * state can say what is identifying (the pages mark it on the stage plot)
 * without importing the engine.
 */
export function createIdentify({ clock = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }: {
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: never) => void;
} = {}) {
  let request: IdentifyRequest | null = null;
  let seq = 0;
  let timer: unknown = null;
  const listeners: (() => void)[] = [];
  const changed = () => { for (const fn of listeners) fn(); };

  function stopTimer(): void {
    if (timer !== null) clearTimer(timer as never);
    timer = null;
  }

  return {
    /** Identify these fixtures for `seconds` (replacing any identify running); 0 stops. */
    start(ids: readonly number[], seconds: number): IdentifyStatus {
      stopTimer();
      const unique = [...new Set(ids)].filter((id) => Number.isInteger(id));
      if (!unique.length || seconds <= 0) {
        this.stop();
        return this.status();
      }
      request = { seq: ++seq, ids: unique, at: clock(), ms: seconds * 1000 };
      const handle = setTimer(() => {
        timer = null;
        request = null;
        changed();
      }, seconds * 1000);
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
      timer = handle;
      changed();
      return this.status();
    },
    stop(): void {
      stopTimer();
      const was = request;
      // A stop is a request too, so a renderer that adopted the last one lets
      // go on its next frame rather than when that one would have run out.
      request = was ? { seq: ++seq, ids: [], at: clock(), ms: 0 } : null;
      if (was) changed();
    },
    /** What the renderer reads each frame. */
    request(): IdentifyRequest | null { return request; },
    status(): IdentifyStatus {
      if (!request || !request.ids.length) return { ids: [], remainingMs: 0 };
      return { ids: [...request.ids], remainingMs: Math.max(0, Math.round(request.at + request.ms - clock())) };
    },
    onChange(fn: () => void): void { listeners.push(fn); },
  };
}

export type Identify = ReturnType<typeof createIdentify>;

/** How a pixel device is sent a frame: its host, a sequence number, and the bytes. */
export type PixelSend = (target: { host: string; sequence: number; rgbw: boolean }, data: Uint8Array) => unknown;

// A device driven directly is sent its identify picture at this rate: smooth
// enough for the running dot, a fraction of what the rig itself is sent.
const PIXEL_FRAME_MS = 33;

/**
 * Identify for devices that are not in the patch yet (a WLED found on the
 * network): the picture streamed to the device itself for `seconds`. The
 * device goes back to whatever it was doing on its own once the frames stop —
 * WLED's realtime mode times out — so nothing on it is changed to undo.
 */
export function createPixelIdentify({ send, clock = () => performance.now(), every = setInterval, stopEvery = clearInterval }: {
  send: PixelSend;
  clock?: () => number;
  every?: (fn: () => void, ms: number) => unknown;
  stopEvery?: (handle: never) => void;
}) {
  const running = new Map<string, () => void>();
  return {
    /** Stream to `host` (replacing a stream already going there); 0 seconds stops it. */
    start(host: string, { leds, rgbw }: { leds: number; rgbw: boolean }, seconds: number): void {
      running.get(host)?.();
      if (seconds <= 0 || leds < 1) return;
      const start = clock();
      let sequence = 0;
      let handle: unknown = null;
      const stop = () => {
        if (handle !== null) stopEvery(handle as never);
        handle = null;
        if (running.get(host) === stop) running.delete(host);
      };
      const tick = () => {
        const elapsed = clock() - start;
        if (elapsed >= seconds * 1000) { stop(); return; }
        send({ host, sequence: ++sequence, rgbw }, identifyPixels(leds, rgbw, elapsed));
      };
      running.set(host, stop);
      tick();
      handle = every(tick, PIXEL_FRAME_MS);
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') (handle as { unref: () => void }).unref();
    },
    stop(host: string): void { running.get(host)?.(); },
    stopAll(): void { for (const stop of [...running.values()]) stop(); },
    active(): string[] { return [...running.keys()]; },
  };
}
