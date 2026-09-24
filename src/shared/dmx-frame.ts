/**
 * A frame of DMX as one binary message: what the live page's previews and
 * monitor draw from, thirty times a second (server/protocol.ts).
 *
 * It was a JSON object of number arrays ten times a second — a universe of
 * 512 channels is about 2 KB of text, and at that rate a strobe or a fast
 * chase was invisible in the UI. As bytes a universe is 516, and the page
 * reads it without parsing anything.
 *
 *   byte 0      format (1)
 *   byte 1      how many universes follow
 *   per universe:
 *     2 bytes   its number, little-endian
 *     2 bytes   how many channels, little-endian
 *     n bytes   the channels, 1 first
 *
 * Shared by the server, which encodes, and the page, which decodes.
 */

export const DMX_FRAME_FORMAT = 1;
const MAX_UNIVERSES_IN_FRAME = 255;

/** Channels by universe, as the engine's buffers hold them. */
export type DmxFrame = Record<number, Uint8Array>;

/** One message holding every universe given, in the order given. */
export function encodeDmxFrame(universes: ReadonlyArray<readonly [number, Uint8Array]>): Uint8Array {
  const list = universes.slice(0, MAX_UNIVERSES_IN_FRAME);
  let size = 2;
  for (const [, data] of list) size += 4 + Math.min(0xffff, data.length);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = DMX_FRAME_FORMAT;
  out[1] = list.length;
  let at = 2;
  for (const [universe, data] of list) {
    const length = Math.min(0xffff, data.length);
    view.setUint16(at, universe & 0xffff, true);
    view.setUint16(at + 2, length, true);
    out.set(data.subarray(0, length), at + 4);
    at += 4 + length;
  }
  return out;
}

/**
 * The universes in a message, each a view onto it rather than a copy. Null for
 * anything that is not a frame this format can read, or that runs short.
 */
export function decodeDmxFrame(message: ArrayBuffer | ArrayBufferView): DmxFrame | null {
  const bytes = message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (bytes.length < 2 || bytes[0] !== DMX_FRAME_FORMAT) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: DmxFrame = {};
  let at = 2;
  for (let i = 0; i < bytes[1]; i++) {
    if (at + 4 > bytes.length) return null;
    const universe = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (at + 4 + length > bytes.length) return null;
    out[universe] = bytes.subarray(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return out;
}
