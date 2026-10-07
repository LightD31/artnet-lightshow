// Seeded rolls let worker and preview replay identically without sharing state.

import type { Seed } from './types.ts';

const OFFSET = 0xcbf29ce484222325n, PRIME = 0x100000001b3n, MASK = 0xffffffffffffffffn;

// FNV-1a uses little-endian inputs and the top 53 bits to preserve preset rolls.
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

export function hash01(seed: Seed, key: number, event: number): number {
  return Number(fnv(seed, key, event) >> 11n) * 2 ** -53;
}

export function seedFrom(text: string, salt = 0): Seed {
  const word = (k: number): number => {
    let h = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(`${salt}:${k}:${text}`)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    return h;
  };
  return [word(0), word(1), word(2), word(3)];
}

// Separate keys keep independent choices from sharing a random stream.
export function pickNotLast(seed: Seed, iter: number, n: number, last: number | null, key = 7): number {
  if (n <= 1) return 0;
  if (last === null || last < 0 || last >= n) return Math.floor(hash01(seed, key, iter) * n) % n;
  const k = Math.floor(hash01(seed, key, iter) * (n - 1)) % (n - 1);
  return k >= last ? k + 1 : k;
}

export function pickExcluding(seed: Seed, iter: number, n: number, excluded: readonly number[]): number {
  if (n <= 1) return 0;
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!excluded.includes(i)) free.push(i);
  const pool = free.length ? free : Array.from({ length: n }, (_, i) => i);
  return pool[Math.floor(hash01(seed, 13, iter) * pool.length) % pool.length];
}

export function permutation(seed: Seed, pass: number, n: number): number[] {
  const out = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(seed, i, pass) * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
