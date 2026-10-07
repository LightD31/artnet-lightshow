// Wire: version u8, count u8; per universe: id u16LE, channel count u16LE, channel bytes.

export const DMX_FRAME_FORMAT = 1;
const MAX_UNIVERSES_IN_FRAME = 255;

export type DmxFrame = Record<number, Uint8Array>;

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
