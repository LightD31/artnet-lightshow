// Draws the app's icons (public/icons/*.png) — the lens of a par seen head on,
// on the app's blue — with nothing but zlib: a PNG is a zlib stream of rows
// with a CRC per chunk. Run once after changing the design:
//
//   node scripts/make-icons.js
//
// The SVG (public/icon.svg) is the same picture, for the tab and the browsers
// that take a vector icon.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname, '..', 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [9, 9, 11];          // --bg, zinc-950
const BLUE = [59, 130, 246];    // --accent
const LENS = [239, 246, 255];

/** The colour at a point of the picture, 0..1 across; null where it is transparent. */
function paint(x, y, { maskable }) {
  const cx = x - 0.5;
  const cy = y - 0.5;
  // The tile: full bleed when the platform masks it, a rounded square otherwise.
  if (!maskable) {
    const half = 0.5;
    const r = 0.22;
    const qx = Math.abs(cx) - (half - r);
    const qy = Math.abs(cy) - (half - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    if (outside > 0) return null;
  }
  const d = Math.hypot(cx, cy) / (maskable ? 0.8 : 1);
  if (d < 0.16) return LENS;
  if (d < 0.2) return BG;
  if (d < 0.25) return LENS;
  if (d < 0.29) return BG;
  if (d < 0.34) return BLUE;
  return maskable ? BLUE : BLUE.map((c, i) => Math.round(c * 0.75 + BG[i] * 0.25));
}

function draw(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;   // samples per pixel side, for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = paint((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
]) {
  fs.writeFileSync(path.join(OUT, name), draw(size, opts));
  console.log(`wrote public/icons/${name}`);
}
