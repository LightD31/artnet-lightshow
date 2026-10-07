// Every roll is a pure function of (instance seed, key, event), so a loop
// replays identically and the worker and the preview agree without shared state.

import type { Seed } from './types.ts';

const OFFSET = 0xcbf29ce484222325n, PRIME = 0x100000001b3n, MASK = 0xffffffffffffffffn;

// Hue Dynamics hashes a 128-bit seed, a 32-bit lamp key and a 64-bit event
// index with FNV-1a 64, all little-endian, and keeps the top 53 bits — ported
// exactly so the built-in presets twinkle like the app.
function fnv(seed: Seed, key: number, event: number): bigint {
  let h = OFFSET;
  const eat = (byte: number) => { h ^= BigInt(byte & 0xff); h = (h * PRIME) & MASK; };
  for (const word of seed) for (let i = 0; i < 4; i++) eat(word >>> (8 * i));
  for (let i = 0; i < 4; i++) eat(key >>> (8 * i));
  // A non-finite event (a NaN beat position upstream) hashes as event 0 rather than throwing mid-frame.
  const e = BigInt.asUintN(64, BigInt(Number.isFinite(event) ? Math.trunc(event) : 0));
  for (let i = 0n; i < 8n; i++) eat(Number((e >> (8n * i)) & 0xffn));
  return h;
}

/** 0 ≤ h < 1, after Hue Dynamics' stable per-lamp, per-event roll. */
export function hash01(seed: Seed, key: number, event: number): number {
  return Number(fnv(seed, key, event) >> 11n) * 2 ** -53;
}

/** The instance seed from its key (base:<pattern>:<anchorStep>, voice:<id>, clip:<id>:<lap>, energy:<id>): four FNV-1a 32 words. */
export function seedFrom(text: string, salt = 0): Seed {
  const word = (k: number): number => {
    let h = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(`${salt}:${k}:${text}`)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    return h;
  };
  return [word(0), word(1), word(2), word(3)];
}

/**
 * One of n, never `last` while n > 1 — Light DJ's random pick that excludes the previous one.
 * `key` names the random stream, so two choices of one instance stay independent.
 */
export function pickNotLast(seed: Seed, iter: number, n: number, last: number | null, key = 7): number {
  if (n <= 1) return 0;
  if (last === null || last < 0 || last >= n) return Math.floor(hash01(seed, key, iter) * n) % n;
  const k = Math.floor(hash01(seed, key, iter) * (n - 1)) % (n - 1);
  return k >= last ? k + 1 : k;
}

/** One of n outside `excluded` (Light DJ's Studio and active effects); with all excluded any may go, so it never stalls. */
export function pickExcluding(seed: Seed, iter: number, n: number, excluded: readonly number[]): number {
  if (n <= 1) return 0;
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!excluded.includes(i)) free.push(i);
  const pool = free.length ? free : Array.from({ length: n }, (_, i) => i);
  return pool[Math.floor(hash01(seed, 13, iter) * pool.length) % pool.length];
}

/** A seeded shuffle of 0..n−1, fresh per pass (Light DJ's Scatter Fill). */
export function permutation(seed: Seed, pass: number, n: number): number[] {
  const out = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, i, pass) * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
