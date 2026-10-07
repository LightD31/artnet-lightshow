import { footprintOf } from '../shared/placement.ts';
import type { Colour, Profile } from '../types/rig.ts';

export const IDENTIFY_SECONDS = 8;
export const IDENTIFY_MAX_SECONDS = 60;

export const IDENTIFY_BLINK_MS = 700;
const IDENTIFY_LIT_MS = 400;

export const IDENTIFY_SWEEP_MS = 1500;

const WHITE: Colour = { r: 255, g: 255, b: 255, w: 255, a: 0, uv: 0 };
const GREEN: Colour = { r: 0, g: 255, b: 0, w: 0, a: 0, uv: 0 };
const RED: Colour = { r: 255, g: 0, b: 0, w: 0, a: 0, uv: 0 };
const DARK: Colour = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

export interface IdentifyLight {
  col: Colour;
  dim: number;
}

export function identifyParLit(elapsed: number): boolean {
  const t = ((elapsed % IDENTIFY_BLINK_MS) + IDENTIFY_BLINK_MS) % IDENTIFY_BLINK_MS;
  return t < IDENTIFY_LIT_MS;
}

export function identifyDot(count: number, elapsed: number): number {
  if (count <= 1) return 0;
  const t = ((elapsed % IDENTIFY_SWEEP_MS) + IDENTIFY_SWEEP_MS) % IDENTIFY_SWEEP_MS;
  return Math.min(count - 1, Math.floor((t / IDENTIFY_SWEEP_MS) * count));
}

// Let endpoint markers win over the moving dot so a bar’s orientation stays visible.
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

export interface IdentifyRequest {
  seq: number;
  ids: number[];
  at: number;
  ms: number;
}

export interface IdentifyStatus {
  ids: number[];
  remainingMs: number;
}

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

export function identifySeconds(value: unknown): number {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return IDENTIFY_SECONDS;
  return Math.max(0, Math.min(IDENTIFY_MAX_SECONDS, Math.round(n)));
}

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
      // Number stop requests too so the renderer releases identify on its next frame.
      request = was ? { seq: ++seq, ids: [], at: clock(), ms: 0 } : null;
      if (was) changed();
    },
    request(): IdentifyRequest | null { return request; },
    status(): IdentifyStatus {
      if (!request || !request.ids.length) return { ids: [], remainingMs: 0 };
      return { ids: [...request.ids], remainingMs: Math.max(0, Math.round(request.at + request.ms - clock())) };
    },
    onChange(fn: () => void): void { listeners.push(fn); },
  };
}

export type Identify = ReturnType<typeof createIdentify>;

export type PixelSend = (target: { host: string; sequence: number; rgbw: boolean }, data: Uint8Array) => unknown;

const PIXEL_FRAME_MS = 33;

// Use WLED realtime timeout so identification needs no persistent device-setting rollback.
export function createPixelIdentify({ send, clock = () => performance.now(), every = setInterval, stopEvery = clearInterval }: {
  send: PixelSend;
  clock?: () => number;
  every?: (fn: () => void, ms: number) => unknown;
  stopEvery?: (handle: never) => void;
}) {
  const running = new Map<string, () => void>();
  return {
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
